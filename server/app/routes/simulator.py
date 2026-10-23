import logging

from fastapi import APIRouter, HTTPException, Request

from app.middleware.auth import CurrentUserDependency, bearer_token
from app.models.simulator import ChatReply, ChatRequest
from app.services.simulator_service import (
    InvalidModelOutputError,
    SimulatorTimeoutError,
    UpstreamUnavailableError,
    run_chat,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/simulator", tags=["simulator"])


def _log_simulator_failure(error_type: str, status_code: int) -> None:
    logger.warning(
        "Simulator request failed (error_type=%s status_code=%d)",
        error_type,
        status_code,
        extra={
            "event_name": "simulator_request_failed",
            "error_type": error_type,
            "status_code": status_code,
            "component": "simulator",
        },
    )


@router.post(
    "/chat",
    response_model=ChatReply,
    responses={
        401: {"description": "Invalid or missing authentication token"},
        422: {"description": "Invalid request fields"},
        429: {"description": "Simulator rate limit reached"},
        502: {"description": "Invalid model response"},
        503: {"description": "Model provider or MCP unavailable"},
        504: {"description": "Model provider, MCP, or request timeout"},
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
        _log_simulator_failure("invalid_model_output", 502)
        raise HTTPException(
            502, "The simulator returned an invalid response. Please try again."
        ) from exc
    except UpstreamUnavailableError as exc:
        _log_simulator_failure("upstream_unavailable", 503)
        raise HTTPException(
            503, "The simulator is temporarily unavailable. Please try again."
        ) from exc
    except SimulatorTimeoutError as exc:
        _log_simulator_failure("timeout", 504)
        raise HTTPException(504, "The simulator timed out. Please try again.") from exc
