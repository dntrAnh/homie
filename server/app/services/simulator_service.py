import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal, Protocol

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


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class ModelToolCall:
    tool_call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ModelMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    tool_calls: tuple[ModelToolCall, ...] = ()
    tool_call_id: str | None = None
    tool_name: str | None = None
    is_error: bool = False


@dataclass(frozen=True)
class ModelTurn:
    text: str
    tool_calls: tuple[ModelToolCall, ...] = ()
    finished: bool = False


class ModelProvider(Protocol):
    async def complete(self, messages: list[ModelMessage], tools: list[ToolSpec]) -> ModelTurn: ...


def _serialized_arguments(arguments: dict[str, Any]) -> bytes:
    try:
        return json.dumps(
            arguments, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode()
    except (RecursionError, TypeError, ValueError) as exc:
        raise InvalidModelOutputError from exc


class BedrockRuntimeClient(Protocol):
    def converse(self, **kwargs: Any) -> dict[str, Any]: ...  # TODO


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


def bedrock_messages(messages: list[ModelMessage]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    pending_tool_results: list[dict[str, Any]] = []

    def flush_tool_results() -> None:
        if pending_tool_results:
            converted.append({"role": "user", "content": pending_tool_results.copy()})
            pending_tool_results.clear()

    for message in messages:
        if message.role == "system" or message.role == "tool":
            if message.role == "system":
                continue  # Bedrock receives the system prompt through its `system` field.
            try:
                payload = json.loads(message.content)
            except json.JSONDecodeError as exc:
                raise InvalidModelOutputError from exc
            pending_tool_results.append(
                {
                    "toolResult": {
                        "toolUseId": message.tool_call_id,
                        "content": [{"json": payload}],
                        "status": "error" if message.is_error else "success",
                    }
                }
            )
            continue

        flush_tool_results()
        blocks: list[dict[str, Any]] = [{"text": message.content}] if message.content else []
        blocks.extend(
            {
                "toolUse": {
                    "toolUseId": call.tool_call_id,
                    "name": call.name,
                    "input": call.arguments,
                }
            }
            for call in message.tool_calls
        )
        converted.append({"role": message.role, "content": blocks})

    flush_tool_results()
    return converted


def _validate_bedrock_response(response: object) -> ModelTurn:
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
    texts: list[str] = []
    tool_calls: list[ModelToolCall] = []
    for block in content:
        if set(block) == {"text"} and isinstance(block["text"], str):
            if block["text"].strip():
                texts.append(block["text"].strip())
        elif set(block) == {"toolUse"} and isinstance(block["toolUse"], dict):
            tool_use = block["toolUse"]
            call_id = tool_use.get("toolUseId")
            name = tool_use.get("name")
            arguments = tool_use.get("input")
            if (
                not isinstance(call_id, str)
                or not call_id.strip()
                or not isinstance(name, str)
                or not isinstance(arguments, dict)
                or not all(isinstance(key, str) for key in arguments)
            ):
                raise InvalidModelOutputError
            tool_calls.append(ModelToolCall(call_id, name, arguments))
        else:
            raise InvalidModelOutputError

    if stop_reason == "end_turn" and not texts:
        raise InvalidModelOutputError
    if stop_reason == "tool_use" and not tool_calls:
        raise InvalidModelOutputError
    if stop_reason not in {"end_turn", "tool_use"}:
        raise InvalidModelOutputError
    if any(call.name not in EXPECTED_MCP_TOOLS for call in tool_calls):
        raise InvalidModelOutputError
    seen_ids: set[str] = set()
    for call in tool_calls:
        if not isinstance(call.arguments, dict) or not all(
            isinstance(key, str) for key in call.arguments
        ):
            raise InvalidModelOutputError
        if not call.tool_call_id.strip() or call.tool_call_id in seen_ids:
            raise InvalidModelOutputError
        seen_ids.add(call.tool_call_id)
        if len(_serialized_arguments(call.arguments)) > MAX_TOOL_ARGUMENT_BYTES:
            raise InvalidModelOutputError
    return ModelTurn(
        text="\n".join(texts),
        tool_calls=tuple(tool_calls),
        finished=stop_reason == "end_turn",
    )


def _bedrock_tools(tools: list[ToolSpec]) -> list[dict[str, Any]]:
    names = [tool.name for tool in tools]
    if len(names) != len(EXPECTED_MCP_TOOLS) or set(names) != EXPECTED_MCP_TOOLS:
        raise UpstreamUnavailableError
    return [
        {
            "toolSpec": {
                "name": tool.name,
                "description": tool.description,
                "inputSchema": {"json": tool.input_schema},
            }
        }
        for tool in tools
    ]


async def call_bedrock(
    messages: list[ModelMessage],
    tools: list[ToolSpec],
    *,
    client: BedrockRuntimeClient | None = None,
) -> ModelTurn:
    try:
        runtime_client = client or get_bedrock_client()
        response = await asyncio.to_thread(
            runtime_client.converse,
            modelId=settings.bedrock_model_id,
            messages=bedrock_messages(messages),
            system=[{"text": SYSTEM_PROMPT}],
            inferenceConfig={"maxTokens": BEDROCK_MAX_OUTPUT_TOKENS},
            toolConfig={"tools": _bedrock_tools(tools)},
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


class BedrockProvider:
    async def complete(self, messages: list[ModelMessage], tools: list[ToolSpec]) -> ModelTurn:
        return await call_bedrock(messages, tools)


def _ollama_tools(tools: list[ToolSpec]) -> list[dict[str, Any]]:
    if {tool.name for tool in tools} != EXPECTED_MCP_TOOLS or len(tools) != len(EXPECTED_MCP_TOOLS):
        raise UpstreamUnavailableError
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            },
        }
        for tool in tools
    ]


def _ollama_messages(messages: list[ModelMessage]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "tool":
            entry = {"role": "tool", "content": message.content}
            if message.tool_name is not None:
                entry["tool_name"] = message.tool_name
            converted.append(entry)
            continue

        entry: dict[str, Any] = {"role": message.role, "content": message.content}
        if message.tool_calls:
            entry["tool_calls"] = [
                {
                    "function": {
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                }
                for call in message.tool_calls
            ]
        converted.append(entry)
    return converted


def _ollama_model_turn(response: object, *, turn_index: int) -> ModelTurn:
    if not isinstance(response, dict):
        raise InvalidModelOutputError
    message = response.get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise InvalidModelOutputError
    content = message.get("content", "")
    if not isinstance(content, str):
        raise InvalidModelOutputError

    raw_calls = message.get("tool_calls", [])
    if not isinstance(raw_calls, list):
        raise InvalidModelOutputError
    calls: list[ModelToolCall] = []
    for index, raw_call in enumerate(raw_calls):
        function = raw_call.get("function") if isinstance(raw_call, dict) else None
        if not isinstance(function, dict):
            raise InvalidModelOutputError
        name = function.get("name")
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError as exc:
                raise InvalidModelOutputError from exc
        if (
            not isinstance(name, str)
            or name not in EXPECTED_MCP_TOOLS
            or not isinstance(arguments, dict)
            or not all(isinstance(key, str) for key in arguments)
        ):
            raise InvalidModelOutputError
        try:
            canonical_arguments = json.dumps(
                arguments,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
        except (RecursionError, TypeError, ValueError) as exc:
            raise InvalidModelOutputError from exc
        digest = hashlib.sha256(
            f"{turn_index}:{index}:{name}:{canonical_arguments}".encode()
        ).hexdigest()[:20]
        calls.append(ModelToolCall(f"ollama-{turn_index}-{index}-{digest}", name, arguments))

    if calls:
        return ModelTurn(text=content.strip(), tool_calls=tuple(calls), finished=False)
    if not content.strip():
        raise InvalidModelOutputError
    return ModelTurn(text=content.strip(), finished=True)


class OllamaProvider:
    async def complete(self, messages: list[ModelMessage], tools: list[ToolSpec]) -> ModelTurn:
        timeout = httpx2.Timeout(55.0, connect=5.0)
        try:
            async with httpx2.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    f"{settings.ollama_host.rstrip('/')}/api/chat",
                    json={
                        "model": settings.simulator_ollama_model,
                        "messages": _ollama_messages(messages),
                        "tools": _ollama_tools(tools),
                        "stream": False,
                        "options": {
                            "num_predict": BEDROCK_MAX_OUTPUT_TOKENS,
                            "num_ctx": 4096,
                            "num_batch": 128,
                        },
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except (TimeoutError, httpx2.TimeoutException) as exc:
            raise SimulatorTimeoutError from exc
        except httpx2.HTTPError as exc:
            raise UpstreamUnavailableError from exc
        except (ValueError, TypeError, RecursionError) as exc:
            raise InvalidModelOutputError from exc
        if not isinstance(payload, dict):
            raise InvalidModelOutputError
        return _ollama_model_turn(payload, turn_index=len(messages))


def get_model_provider() -> ModelProvider:
    if settings.simulator_provider == "ollama":
        return OllamaProvider()
    return BedrockProvider()


async def call_model(
    messages: list[ModelMessage],
    tools: list[ToolSpec],
    *,
    provider: ModelProvider | None = None,
) -> ModelTurn:
    return await (provider or get_model_provider()).complete(messages, tools)


McpHttpClientFactory = Callable[[str], httpx2.AsyncClient]


def _create_mcp_http_client(access_token: str) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=httpx2.Timeout(MCP_TIMEOUT_SECONDS),
    )


def _tool_specs(tools: list[Tool]) -> list[ToolSpec]:
    names = [tool.name for tool in tools]
    if len(names) != len(EXPECTED_MCP_TOOLS) or set(names) != EXPECTED_MCP_TOOLS:
        raise UpstreamUnavailableError
    return [
        ToolSpec(
            name=tool.name,
            description=tool.description or f"Run the {tool.name} memory tool.",
            input_schema=tool.input_schema,
        )
        for tool in tools
    ]


@dataclass
class McpToolClient:
    session: ClientSession
    tools: list[ToolSpec]

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
            yield McpToolClient(session=session, tools=_tool_specs(listed.tools))
    except SimulatorServiceError:
        raise
    except TimeoutError as exc:
        raise SimulatorTimeoutError from exc
    except (MCPError, RuntimeError, OSError, httpx2.HTTPError) as exc:
        raise UpstreamUnavailableError from exc


def _tool_requests(
    turn: ModelTurn,
    *,
    seen_tool_use_ids: set[str],
    completed_calls: int,
) -> list[RequestedTool]:
    if turn.finished or not turn.tool_calls:
        raise InvalidModelOutputError

    requests: list[RequestedTool] = []
    batch_ids: set[str] = set()
    for tool_use in turn.tool_calls:
        tool_use_id = tool_use.tool_call_id
        name = tool_use.name
        arguments = tool_use.arguments
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
        serialized = _serialized_arguments(arguments)
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
    conversation = [ModelMessage(role="system", content=SYSTEM_PROMPT)] + [
        ModelMessage(role=message.role, content=message.content) for message in messages
    ]
    seen_tool_use_ids: set[str] = set()

    async with connect_mcp(access_token) as mcp:
        for _ in range(MAX_BEDROCK_ROUNDS):
            turn = await call_model(conversation, mcp.tools)
            conversation.append(
                ModelMessage(role="assistant", content=turn.text, tool_calls=turn.tool_calls)
            )
            if turn.finished:
                return ChatReply(
                    reply=turn.text,
                    tool_calls=confirmed_calls,
                )

            requests = _tool_requests(
                turn,
                seen_tool_use_ids=seen_tool_use_ids,
                completed_calls=len(confirmed_calls),
            )
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
                conversation.append(
                    ModelMessage(
                        role="tool",
                        content=json.dumps(payload, ensure_ascii=False, allow_nan=False),
                        tool_call_id=request.tool_use_id,
                        tool_name=request.name,
                        is_error=result.is_error,
                    )
                )

    raise InvalidModelOutputError


async def run_chat(messages: list[ChatMessage], access_token: str) -> ChatReply:
    """Coordinate bounded provider tool use through the authenticated MCP endpoint."""
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
