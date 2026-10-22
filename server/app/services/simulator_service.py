import asyncio
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
from app.models.simulator import ChatMessage, ChatReply

BEDROCK_MAX_OUTPUT_TOKENS = 512
MCP_TIMEOUT_SECONDS = 8.0
EXPECTED_MCP_TOOLS = frozenset({"remember", "recall", "forget"})
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


async def run_chat(messages: list[ChatMessage], access_token: str) -> ChatReply:
    """Run the simulator conversation once Milestone 5 wires the boundaries together."""
    raise UpstreamUnavailableError
