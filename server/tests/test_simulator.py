import asyncio
import logging
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from copy import deepcopy
from threading import get_ident
from time import time
from typing import Any

import httpx2
import jwt
import pytest
from botocore.exceptions import ClientError, ReadTimeoutError
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient
from mcp_types import CallToolResult, TextContent, Tool
from pydantic import ValidationError

from app import main
from app.config import Settings
from app.middleware.auth import RateLimiter
from app.models.simulator import ChatReply, ChatRequest, RecallToolCall
from app.routes import simulator as simulator_route
from app.services import memory_service, simulator_service
from app.services.simulator_service import (
    BEDROCK_MAX_OUTPUT_TOKENS,
    MAX_BEDROCK_ROUNDS,
    MAX_TOOL_CALLS,
    PARTIAL_REPLY,
    SYSTEM_PROMPT,
    BedrockTurn,
    InvalidModelOutputError,
    McpToolClient,
    SimulatorServiceError,
    SimulatorTimeoutError,
    UpstreamUnavailableError,
    _bedrock_tools,
    bedrock_messages,
    call_bedrock,
    connect_mcp,
    run_chat,
)

TEST_CLIENT_ID = "test-client"


def message(role: str, content: str = "Hello") -> dict[str, str]:
    return {"role": role, "content": content}


def signed_token(
    issuer: str,
    signing_key: rsa.RSAPrivateKey,
    user_sub: str | None = "alice",
    *,
    scope: str = "homie/mcp:tools",
) -> str:
    now = int(time())
    claims: dict[str, object] = {
        "iss": issuer,
        "token_use": "access",
        "client_id": TEST_CLIENT_ID,
        "scope": scope,
        "iat": now,
        "exp": now + 300,
    }
    if user_sub is not None:
        claims["sub"] = user_sub
    return jwt.encode(claims, signing_key, algorithm="RS256", headers={"kid": "test-key"})


@pytest.fixture
def simulator_client(
    app_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    fake_jwks_endpoint: str,
) -> Iterator[TestClient]:
    monkeypatch.setattr(main.app.state, "api_rate_limiter", RateLimiter(max_requests=120))
    monkeypatch.setattr(
        main.app.state, "simulator_minute_rate_limiter", RateLimiter(max_requests=10)
    )
    monkeypatch.setattr(
        main.app.state,
        "simulator_daily_rate_limiter",
        RateLimiter(max_requests=200, window_seconds=86400),
    )
    yield app_client


def test_chat_request_accepts_valid_conversations_and_trims_content() -> None:
    single_turn = ChatRequest.model_validate({"messages": [message("user", "  Remember this  ")]})
    multi_turn = ChatRequest.model_validate(
        {
            "messages": [
                message("user", "Remember this"),
                message("assistant", "I saved it"),
                message("user", "Where is it?"),
            ]
        }
    )

    assert single_turn.messages[0].content == "Remember this"
    assert [item.role for item in multi_turn.messages] == ["user", "assistant", "user"]


@pytest.mark.parametrize(
    "messages",
    [
        [],
        [message("assistant")],
        [message("system")],
        [message("user"), message("assistant")],
        [message("user"), message("user")],
        [message("user", "")],
        [message("user", "   ")],
        [message("user", "x" * 2001)],
        [message("user") for _ in range(21)],
        [message(role, "x" * 2000) for role in ["user", "assistant"] * 3 + ["user"]],
    ],
)
def test_chat_request_rejects_invalid_transcripts(messages: list[dict[str, str]]) -> None:
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({"messages": messages})


@pytest.mark.parametrize(
    "payload",
    [
        {"messages": [message("user")], "unexpected": True},
        {"messages": [{**message("user"), "unexpected": True}]},
    ],
)
def test_chat_request_rejects_extra_fields(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ChatRequest.model_validate(payload)


def test_chat_reply_matches_client_contract() -> None:
    reply = ChatReply(
        reply="I found one memory.",
        tool_calls=[
            RecallToolCall(
                name="recall",
                arguments={"query": "keys"},
                result=[
                    {
                        "id": "memory-1",
                        "content": "Keys are in the drawer",
                        "kind": "item_location",
                        "tags": [],
                        "created_at": "2026-10-22T12:00:00+00:00",
                    }
                ],
            )
        ],
    )

    assert reply.model_dump() == {
        "reply": "I found one memory.",
        "tool_calls": [
            {
                "name": "recall",
                "arguments": {"query": "keys"},
                "result": [
                    {
                        "id": "memory-1",
                        "content": "Keys are in the drawer",
                        "kind": "item_location",
                        "tags": [],
                        "created_at": "2026-10-22T12:00:00+00:00",
                    }
                ],
            }
        ],
    }


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (RecallToolCall, {"name": "recall", "arguments": {}, "result": [], "extra": True}),
        (ChatReply, {"reply": "Done", "tool_calls": [], "extra": True}),
    ],
)
def test_response_models_reject_extra_fields(
    model: type[RecallToolCall] | type[ChatReply], payload: dict[str, Any]
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize(
    "tool_call",
    [
        {"name": "remember", "arguments": {}, "result": []},
        {
            "name": "recall",
            "arguments": {},
            "result": {"status": "success", "memory_id": "memory-1"},
        },
        {"name": "recall", "arguments": {}},
        {"name": "unknown", "arguments": {}, "result": {"error": "No."}},
    ],
)
def test_chat_reply_rejects_results_that_do_not_match_the_tool(
    tool_call: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        ChatReply.model_validate({"reply": "Done", "tool_calls": [tool_call]})


def test_bedrock_model_id_has_approved_default_and_env_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BEDROCK_MODEL_ID", raising=False)
    assert Settings(_env_file=None).bedrock_model_id == "us.anthropic.claude-sonnet-5-5"

    monkeypatch.setenv("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-5-5")
    assert Settings(_env_file=None).bedrock_model_id == "global.anthropic.claude-sonnet-5-5"


def test_simulator_service_errors_have_one_typed_boundary() -> None:
    assert issubclass(InvalidModelOutputError, SimulatorServiceError)
    assert issubclass(UpstreamUnavailableError, SimulatorServiceError)
    assert issubclass(SimulatorTimeoutError, SimulatorServiceError)


def test_chat_route_forwards_exact_authenticated_token(
    simulator_client: TestClient,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = signed_token(fake_jwks_endpoint, test_signing_key)
    captured: dict[str, Any] = {}

    async def fake_run_chat(messages: list[Any], access_token: str) -> ChatReply:
        captured["messages"] = messages
        captured["access_token"] = access_token
        return ChatReply(reply="Ready.", tool_calls=[])

    monkeypatch.setattr(simulator_route, "run_chat", fake_run_chat)
    response = simulator_client.post(
        "/api/simulator/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"messages": [message("user", "Remember this")]},
    )

    assert response.status_code == 200
    assert response.json() == {"reply": "Ready.", "tool_calls": []}
    assert captured["access_token"] == token
    assert [item.model_dump() for item in captured["messages"]] == [
        {"role": "user", "content": "Remember this"}
    ]


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"scope": "homie/mcp:service", "user_sub": "alice"},
        {"scope": "homie/mcp:tools", "user_sub": None},
    ],
)
def test_chat_route_requires_linked_user_tools_token(
    simulator_client: TestClient,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
    headers: dict[str, Any],
) -> None:
    called = False

    async def fake_run_chat(messages: list[Any], access_token: str) -> ChatReply:
        nonlocal called
        called = True
        return ChatReply(reply="Unexpected", tool_calls=[])

    monkeypatch.setattr(simulator_route, "run_chat", fake_run_chat)
    request_headers: dict[str, str] = {}
    if headers:
        token = signed_token(
            fake_jwks_endpoint,
            test_signing_key,
            headers["user_sub"],
            scope=headers["scope"],
        )
        request_headers["Authorization"] = f"Bearer {token}"

    response = simulator_client.post(
        "/api/simulator/chat",
        headers=request_headers,
        json={"messages": [message("user")]},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or missing authentication token."}
    assert called is False


def test_chat_route_rejects_invalid_body_before_service(
    simulator_client: TestClient,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    async def fake_run_chat(messages: list[Any], access_token: str) -> ChatReply:
        nonlocal called
        called = True
        return ChatReply(reply="Unexpected", tool_calls=[])

    monkeypatch.setattr(simulator_route, "run_chat", fake_run_chat)
    response = simulator_client.post(
        "/api/simulator/chat",
        headers={"Authorization": f"Bearer {signed_token(fake_jwks_endpoint, test_signing_key)}"},
        json={"messages": [message("user", " ")]},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Invalid request fields."
    assert called is False


@pytest.mark.parametrize(
    ("error", "status", "detail", "error_type"),
    [
        (
            InvalidModelOutputError("private model output"),
            502,
            "The simulator returned an invalid response. Please try again.",
            "invalid_model_output",
        ),
        (
            UpstreamUnavailableError("private upstream error"),
            503,
            "The simulator is temporarily unavailable. Please try again.",
            "upstream_unavailable",
        ),
        (
            SimulatorTimeoutError("private timeout"),
            504,
            "The simulator timed out. Please try again.",
            "timeout",
        ),
    ],
)
def test_chat_route_maps_typed_errors_without_leaking_details(
    simulator_client: TestClient,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: SimulatorServiceError,
    status: int,
    detail: str,
    error_type: str,
) -> None:
    async def fake_run_chat(messages: list[Any], access_token: str) -> ChatReply:
        raise error

    monkeypatch.setattr(simulator_route, "run_chat", fake_run_chat)
    token = signed_token(fake_jwks_endpoint, test_signing_key)
    caplog.set_level(logging.WARNING, logger=simulator_route.__name__)
    response = simulator_client.post(
        "/api/simulator/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"messages": [message("user")]},
    )

    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert str(error) not in response.text
    failure_records = [
        record
        for record in caplog.records
        if getattr(record, "event_name", None) == "simulator_request_failed"
    ]
    assert len(failure_records) == 1
    record = failure_records[0]
    assert record.error_type == error_type
    assert record.status_code == status
    assert record.component == "simulator"
    assert record.exc_info is None
    assert str(error) not in caplog.text
    assert token not in caplog.text
    assert "Hello" not in caplog.text


def test_chat_minute_rate_limit_is_per_user_and_stops_service(
    simulator_client: TestClient,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_run_chat(messages: list[Any], access_token: str) -> ChatReply:
        nonlocal calls
        calls += 1
        return ChatReply(reply="Ready", tool_calls=[])

    monkeypatch.setattr(simulator_route, "run_chat", fake_run_chat)
    monkeypatch.setattr(
        main.app.state, "simulator_minute_rate_limiter", RateLimiter(max_requests=1)
    )
    alice = {"Authorization": f"Bearer {signed_token(fake_jwks_endpoint, test_signing_key)}"}
    bob = {
        "Authorization": (
            f"Bearer {signed_token(fake_jwks_endpoint, test_signing_key, user_sub='bob')}"
        )
    }

    assert (
        simulator_client.post(
            "/api/simulator/chat", headers=alice, json={"messages": [message("user")]}
        ).status_code
        == 200
    )
    limited = simulator_client.post(
        "/api/simulator/chat", headers=alice, json={"messages": [message("user")]}
    )
    assert limited.status_code == 429
    assert limited.headers["Retry-After"] == "60"
    assert (
        simulator_client.post(
            "/api/simulator/chat", headers=bob, json={"messages": [message("user")]}
        ).status_code
        == 200
    )
    assert calls == 2


def test_chat_daily_rate_limit_has_daily_retry_after(
    simulator_client: TestClient,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    now = [100.0]

    async def fake_run_chat(messages: list[Any], access_token: str) -> ChatReply:
        nonlocal calls
        calls += 1
        return ChatReply(reply="Ready", tool_calls=[])

    monkeypatch.setattr(simulator_route, "run_chat", fake_run_chat)
    monkeypatch.setattr("app.middleware.auth.monotonic", lambda: now[0])
    monkeypatch.setattr(
        main.app.state,
        "simulator_daily_rate_limiter",
        RateLimiter(
            max_requests=1,
            window_seconds=86400,
            detail="Simulator rolling 24-hour limit reached. Please try again later.",
        ),
    )
    headers = {"Authorization": f"Bearer {signed_token(fake_jwks_endpoint, test_signing_key)}"}

    assert (
        simulator_client.post(
            "/api/simulator/chat", headers=headers, json={"messages": [message("user")]}
        ).status_code
        == 200
    )
    now[0] += 3600
    limited = simulator_client.post(
        "/api/simulator/chat", headers=headers, json={"messages": [message("user")]}
    )
    assert limited.status_code == 429
    assert limited.headers["Retry-After"] == "82800"
    assert limited.json() == {
        "detail": "Simulator rolling 24-hour limit reached. Please try again later."
    }
    assert calls == 1


def test_rate_limiter_retry_after_tracks_oldest_retained_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [100.0]
    monkeypatch.setattr("app.middleware.auth.monotonic", lambda: now[0])
    limiter = RateLimiter(max_requests=2, window_seconds=60)

    limiter.check("alice")
    now[0] = 110.0
    limiter.check("alice")
    now[0] = 130.25

    with pytest.raises(HTTPException) as exc_info:
        limiter.check("alice")

    assert exc_info.value.headers == {"Retry-After": "30"}


def test_bedrock_client_uses_bounded_adaptive_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    fake_client = object()

    def fake_boto_client(service_name: str, **kwargs: Any) -> object:
        captured["service_name"] = service_name
        captured.update(kwargs)
        return fake_client

    simulator_service.get_bedrock_client.cache_clear()
    monkeypatch.setattr(simulator_service.boto3, "client", fake_boto_client)
    try:
        assert simulator_service.get_bedrock_client() is fake_client
    finally:
        simulator_service.get_bedrock_client.cache_clear()

    config = captured["config"]
    assert captured["service_name"] == "bedrock-runtime"
    assert captured["region_name"] == "us-east-1"
    assert config.connect_timeout == 3
    assert config.read_timeout == 30
    assert config.retries == {"total_max_attempts": 3, "mode": "adaptive"}


def test_bedrock_boundary_builds_bounded_converse_request_in_worker_thread() -> None:
    caller_thread = get_ident()

    class FakeBedrock:
        def __init__(self) -> None:
            self.kwargs: dict[str, Any] = {}
            self.thread = caller_thread

        def converse(self, **kwargs: Any) -> dict[str, Any]:
            self.kwargs = kwargs
            self.thread = get_ident()
            return {
                "stopReason": "end_turn",
                "output": {"message": {"role": "assistant", "content": [{"text": "Done."}]}},
            }

    request = ChatRequest(messages=[message("user", "Remember this")])
    messages = bedrock_messages(request.messages)
    tools = [
        {
            "toolSpec": {
                "name": "remember",
                "description": "Save a memory",
                "inputSchema": {"json": {"type": "object"}},
            }
        }
    ]
    fake = FakeBedrock()

    turn = asyncio.run(call_bedrock(messages, tools, client=fake))

    assert turn == BedrockTurn(
        message={"role": "assistant", "content": [{"text": "Done."}]},
        stop_reason="end_turn",
    )
    assert fake.thread != caller_thread
    assert fake.kwargs == {
        "modelId": "us.anthropic.claude-sonnet-5-5",
        "messages": [{"role": "user", "content": [{"text": "Remember this"}]}],
        "system": [{"text": SYSTEM_PROMPT}],
        "inferenceConfig": {"maxTokens": BEDROCK_MAX_OUTPUT_TOKENS},
        "toolConfig": {"tools": tools},
    }


def test_bedrock_boundary_accepts_tool_use_envelope() -> None:
    class FakeBedrock:
        def converse(self, **kwargs: Any) -> dict[str, Any]:
            return {
                "stopReason": "tool_use",
                "output": {
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "toolUse": {
                                    "toolUseId": "call-1",
                                    "name": "recall",
                                    "input": {"query": "keys"},
                                }
                            }
                        ],
                    }
                },
            }

    turn = asyncio.run(call_bedrock([], [], client=FakeBedrock()))

    assert turn.stop_reason == "tool_use"


@pytest.mark.parametrize(
    "response",
    [
        None,
        {},
        {"stopReason": "end_turn", "output": {"message": {"role": "user", "content": []}}},
        {
            "stopReason": "end_turn",
            "output": {"message": {"role": "assistant", "content": []}},
        },
        {
            "stopReason": "end_turn",
            "output": {"message": {"role": "assistant", "content": [{"text": "  "}]}},
        },
        {
            "stopReason": "tool_use",
            "output": {"message": {"role": "assistant", "content": [{"text": "No tool"}]}},
        },
        {
            "stopReason": "max_tokens",
            "output": {"message": {"role": "assistant", "content": [{"text": "Partial"}]}},
        },
    ],
)
def test_bedrock_boundary_rejects_invalid_responses(response: object) -> None:
    class FakeBedrock:
        def converse(self, **kwargs: Any) -> Any:
            return response

    with pytest.raises(InvalidModelOutputError):
        asyncio.run(call_bedrock([], [], client=FakeBedrock()))


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (ReadTimeoutError(endpoint_url="https://bedrock.example"), SimulatorTimeoutError),
        (
            ClientError(
                {"Error": {"Code": "ModelTimeoutException", "Message": "private"}},
                "Converse",
            ),
            SimulatorTimeoutError,
        ),
        (
            ClientError(
                {"Error": {"Code": "AccessDeniedException", "Message": "private"}},
                "Converse",
            ),
            UpstreamUnavailableError,
        ),
    ],
)
def test_bedrock_boundary_maps_sdk_errors(
    error: Exception, expected: type[SimulatorServiceError]
) -> None:
    class FakeBedrock:
        def converse(self, **kwargs: Any) -> dict[str, Any]:
            raise error

    with pytest.raises(expected):
        asyncio.run(call_bedrock([], [], client=FakeBedrock()))


def mcp_tool(name: str) -> Tool:
    return Tool.model_validate(
        {
            "name": name,
            "description": f"Use {name}",
            "inputSchema": {"type": "object", "properties": {}},
        }
    )


def test_mcp_catalog_converts_only_expected_tools_for_bedrock() -> None:
    tools = [mcp_tool("remember"), mcp_tool("recall"), mcp_tool("forget")]

    converted = _bedrock_tools(tools)

    assert [item["toolSpec"]["name"] for item in converted] == [
        "remember",
        "recall",
        "forget",
    ]
    assert converted[0]["toolSpec"]["inputSchema"] == {"json": {"type": "object", "properties": {}}}


@pytest.mark.parametrize(
    "tools",
    [
        [mcp_tool("remember"), mcp_tool("recall")],
        [mcp_tool("remember"), mcp_tool("recall"), mcp_tool("unknown")],
        [mcp_tool("remember"), mcp_tool("remember"), mcp_tool("forget")],
        [mcp_tool("remember"), mcp_tool("recall"), mcp_tool("forget"), mcp_tool("extra")],
    ],
)
def test_mcp_catalog_rejects_missing_duplicate_or_unexpected_tools(tools: list[Tool]) -> None:
    with pytest.raises(UpstreamUnavailableError):
        _bedrock_tools(tools)


def test_mcp_tool_client_rejects_unapproved_names_without_calling_session() -> None:
    class FakeSession:
        called = False

        async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
            self.called = True

    session = FakeSession()
    client = McpToolClient(session=session, bedrock_tools=[])  # type: ignore[arg-type]

    with pytest.raises(UpstreamUnavailableError):
        asyncio.run(client.call_tool("unknown", {}))
    assert session.called is False


def test_mcp_tool_client_maps_protocol_errors_and_timeouts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingSession:
        async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
            raise RuntimeError("private protocol error")

    failing = McpToolClient(session=FailingSession(), bedrock_tools=[])  # type: ignore[arg-type]
    with pytest.raises(UpstreamUnavailableError):
        asyncio.run(failing.call_tool("recall", {}))

    class SlowSession:
        async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
            await asyncio.sleep(0.05)

    monkeypatch.setattr(simulator_service, "MCP_TIMEOUT_SECONDS", 0.001)
    slow = McpToolClient(session=SlowSession(), bedrock_tools=[])  # type: ignore[arg-type]
    with pytest.raises(SimulatorTimeoutError):
        asyncio.run(slow.call_tool("recall", {}))


def test_mcp_boundary_uses_forwarded_token_and_real_in_process_endpoint(
    app_client: TestClient,
    ddb_table: Any,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = signed_token(fake_jwks_endpoint, test_signing_key)
    captured: dict[str, str] = {}
    monkeypatch.setattr(memory_service, "get_table", lambda: ddb_table)
    monkeypatch.setattr(main.app.state, "mcp_rate_limiter", RateLimiter(max_requests=60))

    def client_factory(access_token: str) -> httpx2.AsyncClient:
        captured["token"] = access_token
        return httpx2.AsyncClient(
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=httpx2.Timeout(8),
            transport=httpx2.ASGITransport(app=main.app),
        )

    async def scenario() -> tuple[list[str], Any]:
        async with connect_mcp(token, http_client_factory=client_factory) as mcp:
            names = [item["toolSpec"]["name"] for item in mcp.bedrock_tools]
            recalled = await mcp.call_tool("recall", {"query": "nothing"})
            return names, recalled.structured_content

    names, recalled = asyncio.run(scenario())

    assert captured["token"] == token
    assert set(names) == {"remember", "recall", "forget"}
    assert recalled == {"memories": []}


# Mock full bedrock and test full chat orchestration


class ScriptedMcpClient:
    def __init__(self, results: list[CallToolResult | Exception]) -> None:
        self.bedrock_tools: list[dict[str, Any]] = []
        self.results = results
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> CallToolResult:
        self.calls.append((name, arguments))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def successful_tool_result(payload: dict[str, Any]) -> CallToolResult:
    return CallToolResult(content=[], structuredContent=payload)


def tool_turn(*tool_uses: dict[str, Any]) -> BedrockTurn:
    return BedrockTurn(
        message={
            "role": "assistant",
            "content": [{"toolUse": tool_use} for tool_use in tool_uses],
        },
        stop_reason="tool_use",
    )


def text_turn(text: str = "Done.") -> BedrockTurn:
    return BedrockTurn(
        message={"role": "assistant", "content": [{"text": text}]},
        stop_reason="end_turn",
    )


def install_scripted_boundaries(
    monkeypatch: pytest.MonkeyPatch,
    turns: list[BedrockTurn | Exception],
    results: list[CallToolResult | Exception],
) -> tuple[ScriptedMcpClient, list[list[dict[str, Any]]]]:
    mcp = ScriptedMcpClient(results)
    conversations: list[list[dict[str, Any]]] = []

    @asynccontextmanager
    async def fake_connect(access_token: str) -> AsyncIterator[ScriptedMcpClient]:
        assert access_token == "exact-token"
        yield mcp

    async def fake_call_bedrock(
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        **kwargs: Any,
    ) -> BedrockTurn:
        conversations.append(deepcopy(messages))
        turn = turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return turn

    monkeypatch.setattr(simulator_service, "connect_mcp", fake_connect)
    monkeypatch.setattr(simulator_service, "call_bedrock", fake_call_bedrock)
    return mcp, conversations


def test_run_chat_returns_text_without_tool_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    mcp, conversations = install_scripted_boundaries(monkeypatch, [text_turn(" Ready. ")], [])
    request = ChatRequest(messages=[message("user", "Hello")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply == ChatReply(reply="Ready.", tool_calls=[])
    assert mcp.calls == []
    assert conversations == [bedrock_messages(request.messages)]


def test_run_chat_executes_multiple_tool_rounds_and_preserves_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = {
        "id": "memory-1",
        "content": "Keys are in the drawer",
        "kind": "item_location",
        "tags": [],
        "created_at": "2026-10-22T12:00:00+00:00",
    }
    turns = [
        tool_turn(
            {"toolUseId": "call-1", "name": "remember", "input": {"content": "Keys"}},
            {"toolUseId": "call-2", "name": "recall", "input": {"query": "keys"}},
        ),
        tool_turn({"toolUseId": "call-3", "name": "forget", "input": {"memory_id": "memory-1"}}),
        text_turn("All set."),
    ]
    results = [
        successful_tool_result({"status": "success", "memory_id": "memory-1"}),
        successful_tool_result({"memories": [memory]}),
        successful_tool_result({"status": "success", "memory_id": "memory-1"}),
    ]
    mcp, conversations = install_scripted_boundaries(monkeypatch, turns, results)
    request = ChatRequest(messages=[message("user", "Manage my keys")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.reply == "All set."
    assert [call.name for call in reply.tool_calls] == ["remember", "recall", "forget"]
    assert reply.model_dump()["tool_calls"][1]["result"] == [memory]
    assert mcp.calls == [
        ("remember", {"content": "Keys"}),
        ("recall", {"query": "keys"}),
        ("forget", {"memory_id": "memory-1"}),
    ]
    first_results = conversations[1][-1]["content"]
    assert first_results[1]["toolResult"]["content"] == [{"json": {"memories": [memory]}}]
    assert first_results[1]["toolResult"]["status"] == "success"


@pytest.mark.parametrize(
    ("turn", "payload"),
    [
        (
            tool_turn({"toolUseId": "call-1", "name": "remember", "input": {"content": "Keys"}}),
            {"memories": []},
        ),
        (
            tool_turn({"toolUseId": "call-1", "name": "recall", "input": {"query": "keys"}}),
            {"memories": [{"id": "memory-1", "content": "Missing required fields"}]},
        ),
    ],
)
def test_run_chat_rejects_mcp_results_that_do_not_match_the_tool_contract(
    monkeypatch: pytest.MonkeyPatch,
    turn: BedrockTurn,
    payload: dict[str, Any],
) -> None:
    install_scripted_boundaries(monkeypatch, [turn], [successful_tool_result(payload)])
    request = ChatRequest(messages=[message("user")])

    with pytest.raises(UpstreamUnavailableError):
        asyncio.run(run_chat(request.messages, "exact-token"))


@pytest.mark.parametrize(
    "uses",
    [
        [{"toolUseId": "", "name": "recall", "input": {"query": "keys"}}],
        [
            {"toolUseId": "same", "name": "recall", "input": {"query": "keys"}},
            {"toolUseId": "same", "name": "recall", "input": {"query": "keys"}},
        ],
        [{"toolUseId": 123, "name": "recall", "input": {"query": "keys"}}],
        [{"toolUseId": "call-1", "name": "unknown", "input": {}}],
        [{"toolUseId": "call-1", "name": "recall", "input": "keys"}],
        [{"toolUseId": "call-1", "name": "recall", "input": {"query": "x" * 4097}}],
    ],
)
def test_run_chat_rejects_invalid_tool_batch_before_side_effects(
    monkeypatch: pytest.MonkeyPatch,
    uses: list[dict[str, Any]],
) -> None:
    mcp, _ = install_scripted_boundaries(monkeypatch, [tool_turn(*uses)], [])
    request = ChatRequest(messages=[message("user")])

    with pytest.raises(InvalidModelOutputError):
        asyncio.run(run_chat(request.messages, "exact-token"))

    assert mcp.calls == []


def test_run_chat_rejects_reused_tool_id_across_rounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    turns = [
        tool_turn({"toolUseId": "same", "name": "recall", "input": {"query": "keys"}}),
        tool_turn({"toolUseId": "same", "name": "recall", "input": {"query": "keys"}}),
    ]
    results = [successful_tool_result({"memories": []})]
    mcp, _ = install_scripted_boundaries(monkeypatch, turns, results)
    request = ChatRequest(messages=[message("user")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.reply == PARTIAL_REPLY
    assert len(reply.tool_calls) == 1
    assert len(mcp.calls) == 1


def test_run_chat_rejects_excess_tool_calls_before_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uses = [
        {"toolUseId": f"call-{index}", "name": "recall", "input": {"query": "keys"}}
        for index in range(MAX_TOOL_CALLS + 1)
    ]
    mcp, _ = install_scripted_boundaries(monkeypatch, [tool_turn(*uses)], [])
    request = ChatRequest(messages=[message("user")])

    with pytest.raises(InvalidModelOutputError):
        asyncio.run(run_chat(request.messages, "exact-token"))

    assert mcp.calls == []


def test_run_chat_enforces_cumulative_tool_budget_before_next_side_effect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_batch = [
        {"toolUseId": f"call-{index}", "name": "recall", "input": {"query": str(index)}}
        for index in range(MAX_TOOL_CALLS)
    ]
    turns = [
        tool_turn(*first_batch),
        tool_turn({"toolUseId": "excess", "name": "recall", "input": {"query": "extra"}}),
    ]
    results = [successful_tool_result({"memories": []}) for _ in first_batch]
    mcp, _ = install_scripted_boundaries(monkeypatch, turns, results)
    request = ChatRequest(messages=[message("user")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.reply == PARTIAL_REPLY
    assert len(reply.tool_calls) == MAX_TOOL_CALLS
    assert len(mcp.calls) == MAX_TOOL_CALLS


def test_run_chat_returns_partial_reply_when_round_budget_is_exhausted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    turns = [
        tool_turn({"toolUseId": f"call-{index}", "name": "recall", "input": {"query": str(index)}})
        for index in range(MAX_BEDROCK_ROUNDS)
    ]
    results = [successful_tool_result({"memories": []}) for _ in turns]
    mcp, _ = install_scripted_boundaries(monkeypatch, turns, results)
    request = ChatRequest(messages=[message("user")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.reply == PARTIAL_REPLY
    assert len(reply.tool_calls) == MAX_BEDROCK_ROUNDS
    assert len(mcp.calls) == MAX_BEDROCK_ROUNDS


def test_run_chat_returns_partial_reply_after_confirmed_call_then_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    turns = [
        tool_turn({"toolUseId": "call-1", "name": "remember", "input": {"content": "Keys"}}),
        UpstreamUnavailableError("private Bedrock error"),
    ]
    results = [successful_tool_result({"status": "success", "memory_id": "memory-1"})]
    _, _ = install_scripted_boundaries(monkeypatch, turns, results)
    request = ChatRequest(messages=[message("user")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.reply == PARTIAL_REPLY
    assert [call.name for call in reply.tool_calls] == ["remember"]
    assert "private" not in reply.model_dump_json()


def test_run_chat_returns_partial_reply_when_later_mcp_call_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    turns = [
        tool_turn(
            {"toolUseId": "call-1", "name": "remember", "input": {"content": "Keys"}},
            {"toolUseId": "call-2", "name": "recall", "input": {"query": "keys"}},
        )
    ]
    results = [
        successful_tool_result({"status": "success", "memory_id": "memory-1"}),
        UpstreamUnavailableError("private MCP error"),
    ]
    mcp, _ = install_scripted_boundaries(monkeypatch, turns, results)
    request = ChatRequest(messages=[message("user")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.reply == PARTIAL_REPLY
    assert [call.name for call in reply.tool_calls] == ["remember"]
    assert len(mcp.calls) == 2
    assert "private" not in reply.model_dump_json()


def test_run_chat_returns_tool_errors_to_bedrock_for_explanation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    turns = [
        tool_turn({"toolUseId": "call-1", "name": "forget", "input": {"memory_id": "missing"}}),
        text_turn("I couldn't find that memory."),
    ]
    results = [
        CallToolResult(
            content=[TextContent(type="text", text="I couldn't find that memory.")],
            isError=True,
        )
    ]
    _, conversations = install_scripted_boundaries(monkeypatch, turns, results)
    request = ChatRequest(messages=[message("user")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.model_dump()["tool_calls"][0]["result"] == {
        "error": "I couldn't find that memory."
    }
    tool_result = conversations[1][-1]["content"][0]["toolResult"]
    assert tool_result["status"] == "error"
    assert tool_result["content"] == [{"json": {"error": "I couldn't find that memory."}}]


def test_run_chat_enforces_overall_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mcp = ScriptedMcpClient([])

    @asynccontextmanager
    async def fake_connect(access_token: str) -> AsyncIterator[ScriptedMcpClient]:
        yield mcp

    async def slow_bedrock(*args: Any, **kwargs: Any) -> BedrockTurn:
        await asyncio.sleep(0.05)
        return text_turn()

    monkeypatch.setattr(simulator_service, "connect_mcp", fake_connect)
    monkeypatch.setattr(simulator_service, "call_bedrock", slow_bedrock)
    monkeypatch.setattr(simulator_service, "REQUEST_TIMEOUT_SECONDS", 0.001)
    request = ChatRequest(messages=[message("user")])

    with pytest.raises(SimulatorTimeoutError):
        asyncio.run(run_chat(request.messages, "exact-token"))


def test_run_chat_returns_partial_reply_on_timeout_after_confirmed_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mcp = ScriptedMcpClient(
        [successful_tool_result({"status": "success", "memory_id": "memory-1"})]
    )
    calls = 0

    @asynccontextmanager
    async def fake_connect(access_token: str) -> AsyncIterator[ScriptedMcpClient]:
        yield mcp

    async def timed_bedrock(*args: Any, **kwargs: Any) -> BedrockTurn:
        nonlocal calls
        calls += 1
        if calls == 1:
            return tool_turn(
                {"toolUseId": "call-1", "name": "remember", "input": {"content": "Keys"}}
            )
        await asyncio.sleep(0.05)
        return text_turn()

    monkeypatch.setattr(simulator_service, "connect_mcp", fake_connect)
    monkeypatch.setattr(simulator_service, "call_bedrock", timed_bedrock)
    monkeypatch.setattr(simulator_service, "REQUEST_TIMEOUT_SECONDS", 0.01)
    request = ChatRequest(messages=[message("user")])

    reply = asyncio.run(run_chat(request.messages, "exact-token"))

    assert reply.reply == PARTIAL_REPLY
    assert [call.name for call in reply.tool_calls] == ["remember"]


def test_simulator_end_to_end_scopes_real_mcp_workflow_to_forwarded_user(
    simulator_client: TestClient,
    ddb_table: Any,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class WorkflowBedrock:
        def __init__(self) -> None:
            self.next_id = 1
            self.pending_tools: dict[str, str] = {}
            self.received_results: list[tuple[str, dict[str, Any]]] = []

        def converse(self, **kwargs: Any) -> dict[str, Any]:
            last_message = kwargs["messages"][-1]
            last_block = last_message["content"][0]
            if "toolResult" in last_block:
                tool_result = last_block["toolResult"]
                payload = tool_result["content"][0]["json"]
                name = self.pending_tools.pop(tool_result["toolUseId"])
                self.received_results.append((name, payload))
                return {
                    "stopReason": "end_turn",
                    "output": {
                        "message": {
                            "role": "assistant",
                            "content": [{"text": f"Completed {name}."}],
                        }
                    },
                }

            prompt = last_block["text"]
            if prompt.startswith("Remember"):
                name = "remember"
                arguments = {
                    "content": "Keys are in the kitchen drawer",
                    "kind": "item_location",
                }
            elif prompt.startswith("Recall"):
                name = "recall"
                arguments = {"query": "keys"}
            elif prompt.startswith("Forget "):
                name = "forget"
                arguments = {"memory_id": prompt.removeprefix("Forget ")}
            else:
                raise AssertionError(f"Unexpected prompt: {prompt}")

            tool_use_id = f"workflow-{self.next_id}"
            self.next_id += 1
            self.pending_tools[tool_use_id] = name
            return {
                "stopReason": "tool_use",
                "output": {
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "toolUse": {
                                    "toolUseId": tool_use_id,
                                    "name": name,
                                    "input": arguments,
                                }
                            }
                        ],
                    }
                },
            }

    bedrock = WorkflowBedrock()
    monkeypatch.setattr(memory_service, "get_table", lambda: ddb_table)
    monkeypatch.setattr(main.app.state, "mcp_rate_limiter", RateLimiter(max_requests=60))
    monkeypatch.setattr(simulator_service, "get_bedrock_client", lambda: bedrock)

    def in_process_mcp_client(access_token: str) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=httpx2.Timeout(8),
            transport=httpx2.ASGITransport(app=main.app),
        )

    monkeypatch.setattr(simulator_service, "_create_mcp_http_client", in_process_mcp_client)
    alice_headers = {
        "Authorization": f"Bearer {signed_token(fake_jwks_endpoint, test_signing_key)}"
    }
    bob_headers = {
        "Authorization": (
            f"Bearer {signed_token(fake_jwks_endpoint, test_signing_key, user_sub='bob')}"
        )
    }

    remembered = simulator_client.post(
        "/api/simulator/chat",
        headers=alice_headers,
        json={"messages": [message("user", "Remember my keys")]},
    )
    assert remembered.status_code == 200, remembered.text
    memory_id = remembered.json()["tool_calls"][0]["result"]["memory_id"]
    assert ddb_table.get_item(Key={"pk": "USER#alice", "sk": f"MEM#{memory_id}"}).get("Item")
    assert not ddb_table.get_item(Key={"pk": "USER#bob", "sk": f"MEM#{memory_id}"}).get("Item")

    bob_recalled = simulator_client.post(
        "/api/simulator/chat",
        headers=bob_headers,
        json={"messages": [message("user", "Recall keys for Bob")]},
    )
    assert bob_recalled.status_code == 200, bob_recalled.text
    assert bob_recalled.json()["tool_calls"][0]["result"] == []

    alice_recalled = simulator_client.post(
        "/api/simulator/chat",
        headers=alice_headers,
        json={"messages": [message("user", "Recall keys for Alice")]},
    )
    assert alice_recalled.status_code == 200, alice_recalled.text
    recalled_memories = alice_recalled.json()["tool_calls"][0]["result"]
    assert [item["id"] for item in recalled_memories] == [memory_id]
    assert recalled_memories[0]["content"] == "Keys are in the kitchen drawer"

    forgotten = simulator_client.post(
        "/api/simulator/chat",
        headers=alice_headers,
        json={"messages": [message("user", f"Forget {memory_id}")]},
    )
    assert forgotten.status_code == 200, forgotten.text
    assert forgotten.json()["tool_calls"][0]["result"] == {
        "status": "success",
        "memory_id": memory_id,
    }
    assert not ddb_table.get_item(Key={"pk": "USER#alice", "sk": f"MEM#{memory_id}"}).get("Item")

    recall_results = [payload for name, payload in bedrock.received_results if name == "recall"]
    assert recall_results[0] == {"memories": []}
    assert recall_results[1]["memories"][0]["id"] == memory_id
