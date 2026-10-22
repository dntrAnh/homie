from typing import Any

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.models.simulator import ChatReply, ChatRequest, ToolCall
from app.services.simulator_service import (
    InvalidModelOutputError,
    SimulatorServiceError,
    SimulatorTimeoutError,
    UpstreamUnavailableError,
)


def message(role: str, content: str = "Hello") -> dict[str, str]:
    return {"role": role, "content": content}


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
