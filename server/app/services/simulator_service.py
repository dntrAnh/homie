import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal, Protocol, cast

import boto3
import httpx2
from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectTimeoutError,
    ReadTimeoutError,
)
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError
from mcp_types import CallToolResult, Tool

from app.config import settings
from app.models.simulator import ChatMessage, ChatReply, ToolCall

BEDROCK_MAX_OUTPUT_TOKENS = 512
MCP_TIMEOUT_SECONDS = 8.0
REQUEST_TIMEOUT_SECONDS = 60.0
MAX_BEDROCK_ROUNDS = 3
MAX_TOOL_CALLS = 4
MAX_TOOL_ARGUMENT_BYTES = 4096
EXPECTED_MCP_TOOLS = frozenset({"remember", "recall", "forget"})
PARTIAL_REPLY = (
    "The simulator completed the tool calls shown, but could not finish its reply. "
    "Review the results before trying again."
)
SYSTEM_PROMPT = (
    "Use only the supplied memory tools. Never claim an action succeeded unless its tool "
    "result confirms success. Explain tool failures plainly."
)


class SimulatorServiceError(Exception):
    """Base class for simulator failures safe for the HTTP route to translate."""


class InvalidModelOutputError(SimulatorServiceError):
    """Bedrock returned a malformed, empty, or incomplete response."""


class UpstreamUnavailableError(SimulatorServiceError):
    """Bedrock or MCP is temporarily unavailable."""


class SimulatorTimeoutError(SimulatorServiceError):
    """Bedrock, MCP, or the overall simulator request timed out."""


class BedrockRuntimeClient(Protocol):
    def converse(self, **kwargs: Any) -> dict[str, Any]: ...  # TODO


@dataclass(frozen=True)
class BedrockTurn:
    message: dict[str, Any]
    stop_reason: Literal["end_turn", "tool_use"]


@dataclass(frozen=True)
class RequestedTool:
    tool_use_id: str
    name: str
    arguments: dict[str, Any]


@cache
def get_bedrock_client() -> BedrockRuntimeClient:
    return boto3.client(
        "bedrock-runtime",
        region_name=settings.aws_region,
        config=Config(
            connect_timeout=3,
            read_timeout=30,
            retries={"total_max_attempts": 3, "mode": "adaptive"},
        ),
    )


def bedrock_messages(messages: list[ChatMessage]) -> list[dict[str, Any]]:
    return [{"role": message.role, "content": [{"text": message.content}]} for message in messages]


def _validate_bedrock_response(response: object) -> BedrockTurn:
    if not isinstance(response, dict):
        raise InvalidModelOutputError
    output = response.get("output")
    message = output.get("message") if isinstance(output, dict) else None
    stop_reason = response.get("stopReason")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise InvalidModelOutputError
    content = message.get("content")
    if (
        not isinstance(content, list)
        or not content
        or not all(isinstance(block, dict) for block in content)
    ):
        raise InvalidModelOutputError
    if stop_reason == "end_turn":
        if not any(
            isinstance(block.get("text"), str) and bool(block["text"].strip()) for block in content
        ):
            raise InvalidModelOutputError
    elif stop_reason == "tool_use":
        if not any(isinstance(block.get("toolUse"), dict) for block in content):
            raise InvalidModelOutputError
    else:
        raise InvalidModelOutputError
    return BedrockTurn(
        message=cast(dict[str, Any], message),
        stop_reason=cast(Literal["end_turn", "tool_use"], stop_reason),
    )


async def call_bedrock(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    *,
    client: BedrockRuntimeClient | None = None,
) -> BedrockTurn:
    try:
        runtime_client = client or get_bedrock_client()
        response = await asyncio.to_thread(
            runtime_client.converse,
            modelId=settings.bedrock_model_id,
            messages=messages,
            system=[{"text": SYSTEM_PROMPT}],
            inferenceConfig={"maxTokens": BEDROCK_MAX_OUTPUT_TOKENS},
            toolConfig={"tools": tools},
        )
    except (ConnectTimeoutError, ReadTimeoutError) as exc:
        raise SimulatorTimeoutError from exc
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ModelTimeoutException":
            raise SimulatorTimeoutError from exc
        raise UpstreamUnavailableError from exc
    except BotoCoreError as exc:
        raise UpstreamUnavailableError from exc
    return _validate_bedrock_response(response)


McpHttpClientFactory = Callable[[str], httpx2.AsyncClient]


def _create_mcp_http_client(access_token: str) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=httpx2.Timeout(MCP_TIMEOUT_SECONDS),
    )


def _bedrock_tools(tools: list[Tool]) -> list[dict[str, Any]]:
    names = [tool.name for tool in tools]
    if len(names) != len(EXPECTED_MCP_TOOLS) or set(names) != EXPECTED_MCP_TOOLS:
        raise UpstreamUnavailableError
    return [
        {
            "toolSpec": {
                "name": tool.name,
                "description": tool.description or f"Run the {tool.name} memory tool.",
                "inputSchema": {"json": tool.input_schema},
            }
        }
        for tool in tools
    ]


@dataclass
class McpToolClient:
    session: ClientSession
    bedrock_tools: list[dict[str, Any]]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> CallToolResult:
        if name not in EXPECTED_MCP_TOOLS:
            raise UpstreamUnavailableError
        try:
            async with asyncio.timeout(MCP_TIMEOUT_SECONDS):
                result = await self.session.call_tool(name, arguments)
        except TimeoutError as exc:
            raise SimulatorTimeoutError from exc
        except (MCPError, RuntimeError, OSError, httpx2.HTTPError) as exc:
            raise UpstreamUnavailableError from exc
        if not isinstance(result, CallToolResult):
            raise UpstreamUnavailableError
        return result


@asynccontextmanager
async def connect_mcp(
    access_token: str,
    *,
    http_client_factory: McpHttpClientFactory | None = None,
) -> AsyncIterator[McpToolClient]:
    factory = http_client_factory or _create_mcp_http_client
    url = f"{settings.public_base_url.rstrip('/')}/mcp"
    try:
        client = factory(access_token)
        async with (
            client,
            streamable_http_client(url, http_client=client, terminate_on_close=False) as streams,
            ClientSession(*streams, read_timeout_seconds=MCP_TIMEOUT_SECONDS) as session,
        ):
            async with asyncio.timeout(MCP_TIMEOUT_SECONDS):
                await session.initialize()
            async with asyncio.timeout(MCP_TIMEOUT_SECONDS):
                listed = await session.list_tools()
            yield McpToolClient(session=session, bedrock_tools=_bedrock_tools(listed.tools))
    except SimulatorServiceError:
        raise
    except TimeoutError as exc:
        raise SimulatorTimeoutError from exc
    except (MCPError, RuntimeError, OSError, httpx2.HTTPError) as exc:
        raise UpstreamUnavailableError from exc


def _final_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if not isinstance(content, list):
        raise InvalidModelOutputError
    texts: list[str] = []
    for block in content:
        if not isinstance(block, dict) or set(block) != {"text"}:
            raise InvalidModelOutputError
        text = block["text"]
        if not isinstance(text, str):
            raise InvalidModelOutputError
        if text.strip():
            texts.append(text.strip())
    if not texts:
        raise InvalidModelOutputError
    return "\n".join(texts)


def _tool_requests(
    message: dict[str, Any],
    *,
    seen_tool_use_ids: set[str],
    completed_calls: int,
) -> list[RequestedTool]:
    content = message.get("content")
    if not isinstance(content, list):
        raise InvalidModelOutputError

    requests: list[RequestedTool] = []
    batch_ids: set[str] = set()
    for block in content:
        if not isinstance(block, dict):
            raise InvalidModelOutputError
        if set(block) == {"text"}:
            if not isinstance(block["text"], str):
                raise InvalidModelOutputError
            continue
        if set(block) != {"toolUse"} or not isinstance(block["toolUse"], dict):
            raise InvalidModelOutputError

        tool_use = block["toolUse"]
        tool_use_id = tool_use.get("toolUseId")
        name = tool_use.get("name")
        arguments = tool_use.get("input")
        if (
            not isinstance(tool_use_id, str)
            or not tool_use_id.strip()
            or tool_use_id in seen_tool_use_ids
            or tool_use_id in batch_ids
            or not isinstance(name, str)
            or name not in EXPECTED_MCP_TOOLS
            or not isinstance(arguments, dict)
            or not all(isinstance(key, str) for key in arguments)
        ):
            raise InvalidModelOutputError
        try:
            serialized = json.dumps(
                arguments,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        except (RecursionError, TypeError, ValueError) as exc:
            raise InvalidModelOutputError from exc
        if len(serialized) > MAX_TOOL_ARGUMENT_BYTES:
            raise InvalidModelOutputError

        batch_ids.add(tool_use_id)
        requests.append(
            RequestedTool(
                tool_use_id=tool_use_id,
                name=name,
                arguments=arguments,
            )
        )

    if not requests or completed_calls + len(requests) > MAX_TOOL_CALLS:
        raise InvalidModelOutputError
    seen_tool_use_ids.update(batch_ids)
    return requests


def _mcp_result_payload(result: CallToolResult) -> dict[str, Any]:
    if result.result_type != "complete":
        raise UpstreamUnavailableError
    if result.is_error:
        messages = [
            part.text.strip()
            for part in result.content
            if getattr(part, "type", None) == "text"
            and isinstance(getattr(part, "text", None), str)
            and part.text.strip()
        ]
        if not messages:
            raise UpstreamUnavailableError
        return {"error": " ".join(messages)}
    if not isinstance(result.structured_content, dict):
        raise UpstreamUnavailableError
    try:
        json.dumps(result.structured_content, ensure_ascii=False, allow_nan=False)
    except (RecursionError, TypeError, ValueError) as exc:
        raise UpstreamUnavailableError from exc
    return result.structured_content


def _ui_result(name: str, payload: dict[str, Any], *, is_error: bool) -> Any:
    if name != "recall" or is_error:
        return payload
    memories = payload.get("memories")
    if not isinstance(memories, list):
        raise UpstreamUnavailableError
    return memories


async def _orchestrate_chat(
    messages: list[ChatMessage],
    access_token: str,
    confirmed_calls: list[ToolCall],
) -> ChatReply:
    conversation = bedrock_messages(messages)
    seen_tool_use_ids: set[str] = set()

    async with connect_mcp(access_token) as mcp:
        # main loop of client
        for _ in range(MAX_BEDROCK_ROUNDS):
            turn = await call_bedrock(conversation, mcp.bedrock_tools)
            conversation.append(turn.message)
            if turn.stop_reason == "end_turn":
                return ChatReply(
                    reply=_final_text(turn.message),
                    tool_calls=confirmed_calls,
                )

            requests = _tool_requests(
                turn.message,
                seen_tool_use_ids=seen_tool_use_ids,
                completed_calls=len(confirmed_calls),
            )
            bedrock_results: list[dict[str, Any]] = []
            for request in requests:
                result = await mcp.call_tool(request.name, request.arguments)
                payload = _mcp_result_payload(result)
                confirmed_calls.append(
                    ToolCall(
                        name=request.name,
                        arguments=request.arguments,
                        result=_ui_result(request.name, payload, is_error=result.is_error),
                    )
                )
                bedrock_results.append(
                    {
                        "toolResult": {
                            "toolUseId": request.tool_use_id,
                            "content": [{"json": payload}],
                            "status": "error" if result.is_error else "success",
                        }
                    }
                )
            conversation.append({"role": "user", "content": bedrock_results})

    raise InvalidModelOutputError


async def run_chat(messages: list[ChatMessage], access_token: str) -> ChatReply:
    """Coordinate bounded Bedrock tool use through the authenticated MCP endpoint."""
    confirmed_calls: list[ToolCall] = []
    try:
        async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
            return await _orchestrate_chat(messages, access_token, confirmed_calls)
    except TimeoutError as exc:
        if confirmed_calls:
            return ChatReply(reply=PARTIAL_REPLY, tool_calls=confirmed_calls)
        raise SimulatorTimeoutError from exc
    except SimulatorServiceError:
        if confirmed_calls:
            return ChatReply(reply=PARTIAL_REPLY, tool_calls=confirmed_calls)
        raise
