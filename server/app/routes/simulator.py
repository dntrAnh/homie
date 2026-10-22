from fastapi import APIRouter, HTTPException, Request

from app.middleware.auth import CurrentUserDependency, bearer_token
from app.models.simulator import ChatReply, ChatRequest
from app.services.simulator_service import (
    InvalidModelOutputError,
    SimulatorTimeoutError,
    UpstreamUnavailableError,
    run_chat,
)

router = APIRouter(prefix="/api/simulator", tags=["simulator"])


@router.post(
    "/chat",
    response_model=ChatReply,
    responses={
        401: {"description": "Invalid or missing authentication token"},
        422: {"description": "Invalid request fields"},
        429: {"description": "Simulator rate limit reached"},
        502: {"description": "Invalid model response"},
        503: {"description": "Bedrock or MCP unavailable"},
        504: {"description": "Bedrock, MCP, or request timeout"},
    },
)
async def chat(data: ChatRequest, request: Request, user: CurrentUserDependency) -> ChatReply:
    if user.sub is None:  # Narrow the authenticated dependency's type for static analysis.
        raise HTTPException(401, "Invalid or missing authentication token.")

    request.app.state.simulator_minute_rate_limiter.check(user.sub)
    request.app.state.simulator_daily_rate_limiter.check(user.sub)
    access_token = bearer_token(request)

    try:
        return await run_chat(data.messages, access_token)
    except InvalidModelOutputError as exc:
        raise HTTPException(
            502, "The simulator returned an invalid response. Please try again."
        ) from exc
    except UpstreamUnavailableError as exc:
        raise HTTPException(
            503, "The simulator is temporarily unavailable. Please try again."
        ) from exc
    except SimulatorTimeoutError as exc:
        raise HTTPException(504, "The simulator timed out. Please try again.") from exc
