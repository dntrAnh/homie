from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.models.memory import ChangeResult, RecalledMemory

MessageContent = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
]
ReplyContent = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: MessageContent


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[ChatMessage] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_transcript(self) -> Self:
        if self.messages[0].role != "user":
            raise ValueError("Conversation must start with a user message")
        if self.messages[-1].role != "user":
            raise ValueError("Conversation must end with a user message")
        if any(
            previous.role == current.role
            for previous, current in zip(self.messages, self.messages[1:], strict=False)
        ):
            raise ValueError("Conversation roles must alternate")
        if sum(len(message.content) for message in self.messages) > 12000:
            raise ValueError("Conversation content must not exceed 12000 characters")
        return self


class ToolErrorResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ChangeToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Literal["remember", "forget"]
    arguments: dict[str, Any]
    result: ChangeResult | ToolErrorResult


class RecallToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Literal["recall"]
    arguments: dict[str, Any]
    result: list[RecalledMemory] | ToolErrorResult


ToolCall = Annotated[ChangeToolCall | RecallToolCall, Field(discriminator="name")]


class ChatReply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reply: ReplyContent
    tool_calls: list[ToolCall]
