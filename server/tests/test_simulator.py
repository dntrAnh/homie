import asyncio
from collections.abc import Iterator
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
from mcp_types import Tool
from pydantic import ValidationError

from app import main
from app.config import Settings
from app.middleware.auth import RateLimiter
from app.models.simulator import ChatReply, ChatRequest, ToolCall
from app.routes import simulator as simulator_route
from app.services import memory_service, simulator_service
from app.services.simulator_service import (
    BEDROCK_MAX_OUTPUT_TOKENS,
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
            ToolCall(
                name="recall",
                arguments={"query": "keys"},
                result=[{"id": "memory-1", "content": "Keys are in the drawer"}],
            )
        ],
    )

    assert reply.model_dump() == {
        "reply": "I found one memory.",
        "tool_calls": [
            {
                "name": "recall",
                "arguments": {"query": "keys"},
                "result": [{"id": "memory-1", "content": "Keys are in the drawer"}],
            }
        ],
    }


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (ToolCall, {"name": "recall", "arguments": {}, "result": [], "extra": True}),
        (ChatReply, {"reply": "Done", "tool_calls": [], "extra": True}),
    ],
)
def test_response_models_reject_extra_fields(
    model: type[ToolCall] | type[ChatReply], payload: dict[str, Any]
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


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
    ("error", "status", "detail"),
    [
        (
            InvalidModelOutputError("private model output"),
            502,
            "The simulator returned an invalid response. Please try again.",
        ),
        (
            UpstreamUnavailableError("private upstream error"),
            503,
            "The simulator is temporarily unavailable. Please try again.",
        ),
        (
            SimulatorTimeoutError("private timeout"),
            504,
            "The simulator timed out. Please try again.",
        ),
    ],
)
def test_chat_route_maps_typed_errors_without_leaking_details(
    simulator_client: TestClient,
    fake_jwks_endpoint: str,
    test_signing_key: rsa.RSAPrivateKey,
    monkeypatch: pytest.MonkeyPatch,
    error: SimulatorServiceError,
    status: int,
    detail: str,
) -> None:
    async def fake_run_chat(messages: list[Any], access_token: str) -> ChatReply:
        raise error

    monkeypatch.setattr(simulator_route, "run_chat", fake_run_chat)
    response = simulator_client.post(
        "/api/simulator/chat",
        headers={"Authorization": f"Bearer {signed_token(fake_jwks_endpoint, test_signing_key)}"},
        json={"messages": [message("user")]},
    )

    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert str(error) not in response.text


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
