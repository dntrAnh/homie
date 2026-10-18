# P0 Plan 2 — Google (Calendar + Maps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user connect Google once, then see and create Calendar reminders and get preference-aware places and
directions from both the dashboard REST API and the MCP tools.

**Architecture:** One small `google_client` module owns the shared `httpx.Client`, the 400 ms timeout and the
error mapping. `GoogleAuthService` stores an encrypted refresh token per user and hands out cached access tokens.
`CalendarService` and `MapsService` call Google's REST endpoints through `google_client.call()`. Thin REST routers and
four MCP tools sit on top. Every call is scoped to the verified Cognito `sub`.

**Tech Stack:** Python 3.14, FastAPI, httpx (`MockTransport` for tests), PyJWT (HS256 state), cryptography (Fernet),
boto3/moto, pytest · Next.js 16 client (already calls these endpoints).

**Spec:** `docs/superpowers/specs/2026-10-18-google-services-design.md` (decisions D1–D14) and
`docs/superpowers/specs/2026-10-03-p0-design.md` §5, §6, §7, §8.

**Depends on (merge first):** #38 profile API (`ProfileService`, `Timezone`, `Profile.home`), #36 memory MCP server
(`app/mcp_server.py`, `_user_sub`, `mcp`), #39 `Cache-Control: no-store`. Tasks 1–3 only need #38; Task 5 needs #36.

**Deadline:** submission Friday 2026-10-23 12:00 PDT. Tasks are ordered so Tasks 1–3 (calendar) ship a demo on their
own; Maps (Tasks 4–5) can follow.

## Global Constraints

- Every read/write is scoped to the verified token's `sub`; never trust a user id from a body, query or tool argument.
- Google call timeout **0.4 s** (`settings.google_timeout_seconds`), except the OAuth code exchange (5 s). No retry loops.
- MCP tool round-trip **< 500 ms**; no LLM calls inside tools.
- Never log tokens, codes, `state`, addresses, event text or Google response bodies; log exception class + status only.
- Refresh tokens are Fernet-encrypted at rest; access tokens are never stored in DynamoDB.
- Times: store UTC; reminder `when` is wall-clock + IANA zone passed through to Google unchanged (spec §7).
- Calendar `days` 1–14; `find_places` ≤ 5 results; reminder title 1–200 chars, notes ≤ 1000, `remind_minutes_before` 0–40320.
- Rate limits unchanged: REST 120/min via `CurrentUserDependency`, MCP 60/min via `McpAuthGate`.
- Config only via `app/config.py` `settings`; every new env var also goes in `server/.env.example`.
- Use `uv add` for dependencies. Stage explicit paths; ≤ 10 files per commit; never commit `.env`; ask before pushing.

## Review Focus

1. **User revokes homie in their Google account** — the next call gets `invalid_grant`; the `GOOGLE` item is deleted and the user sees "isn't connected" (409 / speakable), never a 500 (test in Task 2).
2. **Google slow, down or throttling** — timeout, 5xx and 429 become the friendly messages with no retry and no 500 (tests in Task 1).
3. **Reminder on a DST boundary** — `2026-11-01T01:30` in `America/Los_Angeles` is sent as that wall-clock time with `timeZone`, not shifted through UTC (test in Task 3).
4. **No home address** — `find_places` / `get_directions` without `near` say "Set your home address in the homie dashboard." (tests in Tasks 4, 5).
5. **Forged or stale OAuth callback** — tampered, expired or wrong-audience `state`, or a Google `error=access_denied`, stores nothing and redirects to `?google=error` (test in Task 2).

---

## Commit checkpoints

Same rules as Plan 1: inspect `git status --short`, stage only the task's listed paths, run
`git diff --cached --name-only` and `git diff --cached --check`, ≤ 10 files per commit, no `.env`, keep the pre-commit
hook, run `uv run pytest`, `uv run ruff check .` and `uv run ruff format --check .` (server) and `bun run lint` +
`bunx tsc --noEmit` (client) for touched packages before declaring a task done. Branch per task group:
`feat/google-oauth` (Tasks 0–2), `feat/google-calendar` (Task 3), `feat/google-maps` (Tasks 4–5),
`feat/client-google` (Task 6).

---

### Task 0: Google Cloud project and settings

**Files:**
- Modify: `server/app/config.py`, `server/.env.example`
- Modify: `server/pyproject.toml`, `server/uv.lock` (via `uv add`)

**Interfaces:**
- Produces: `settings.google_token_key: str`, `settings.oauth_state_secret: str`, `settings.dashboard_url: str`,
  `settings.google_timeout_seconds: float` (plus existing `google_client_id`, `google_client_secret`,
  `google_maps_api_key`, `public_base_url`).

- [ ] **Step 1: Google Cloud console (one owner, manual)**

In a Google Cloud project: enable **Google Calendar API**, **Places API (New)**, **Routes API**, **Geocoding API**.
OAuth consent screen: External, **Testing**, add every teammate's Google account as a test user, scopes
`openid`, `email`, `.../auth/calendar.events`. Create an OAuth client (Web application) with authorized redirect URIs
`http://localhost:8000/api/google/callback` and `https://<aws-api-host>/api/google/callback`. Create one API key
restricted to Places API (New), Routes API and Geocoding API. Put the values in your local `server/.env` only.

- [ ] **Step 2: Add dependencies**

```bash
cd server && uv add httpx cryptography
```

(`httpx` and `cryptography` are already installed transitively; this makes them direct dependencies.)

- [ ] **Step 3: Settings**

Add to `Settings` in `server/app/config.py`, below `google_client_secret`:

```python
    google_token_key: str = ""  # Fernet key; encrypts stored refresh tokens
    oauth_state_secret: str = ""  # HS256 secret for the Google OAuth state parameter
    dashboard_url: str = "http://localhost:3000"
    google_timeout_seconds: float = 0.4
```

Append to `server/.env.example`:

```sh
# Google OAuth state + refresh-token encryption. Generate:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
#   python -c "import secrets; print(secrets.token_urlsafe(48))"
GOOGLE_TOKEN_KEY=
OAUTH_STATE_SECRET=
# Where the OAuth callback sends the browser back to.
DASHBOARD_URL=http://localhost:3000
GOOGLE_TIMEOUT_SECONDS=0.4
```

- [ ] **Step 4: Verify and commit**

Run: `uv run pytest -q && uv run ruff check . && uv run ruff format --check .` — expected: all pass (no behavior change).

```bash
git add server/app/config.py server/.env.example server/pyproject.toml server/uv.lock
git commit -m "chore(server): add Google settings and httpx/cryptography deps"
```

---

### Task 1: Google HTTP client and error mapping

**Files:**
- Create: `server/app/services/google_client.py`
- Modify: `server/app/main.py` (exception handler)
- Modify: `server/tests/conftest.py` (`google` fixture)
- Test: `server/tests/test_google_client.py`

**Interfaces:**
- Produces:
  - `google_client.call(method: str, url: str, *, timeout: float | None = None, **kwargs) -> dict[str, Any]`
  - `GoogleError(Exception)` with `.status: int`, `.message: str`; subclasses `GoogleNotConnectedError` (409),
    `GoogleUnavailableError` (504), `GoogleRateLimitedError` (429), `GoogleRequestError` (502),
    `GoogleNotConfiguredError` (503), `NoHomeLocationError` (409).
  - Test fixture `google` → `GoogleMock` with `.on(method, url, response)` and `.requests: list[httpx.Request]`.

- [ ] **Step 1: Test fixture**

Append to `server/tests/conftest.py`:

```python
import httpx
from cryptography.fernet import Fernet


class GoogleMock:
    """Routes httpx requests by (method, scheme://host/path). Unmocked URLs fail loudly."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Any] = {}
        self.requests: list[httpx.Request] = []

    def on(self, method: str, url: str, response: Any) -> None:
        # response: httpx.Response, an exception instance to raise, or a callable(request) -> Response
        self.routes[(method, url)] = response

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.method, f"{request.url.scheme}://{request.url.host}{request.url.path}")
        response = self.routes.get(key)
        if response is None:
            raise AssertionError(f"Unmocked Google call: {key}")
        if isinstance(response, Exception):
            raise response
        return response(request) if callable(response) else response


@pytest.fixture
def google(monkeypatch: pytest.MonkeyPatch) -> Iterator[GoogleMock]:
    from app.services import google_client

    mock = GoogleMock()
    monkeypatch.setattr(google_client, "_http", httpx.Client(transport=httpx.MockTransport(mock.handler)))
    monkeypatch.setattr(settings, "google_client_id", "cid")
    monkeypatch.setattr(settings, "google_client_secret", "csecret")
    monkeypatch.setattr(settings, "google_maps_api_key", "maps-key")
    monkeypatch.setattr(settings, "google_token_key", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "oauth_state_secret", "s" * 48)
    monkeypatch.setattr(settings, "dashboard_url", "https://dash.example")
    # google_auth_service arrives in Task 2; clear its token cache only once it exists.
    if auth_module := sys.modules.get("app.services.google_auth_service"):
        auth_module._access_tokens.clear()
    yield mock
```

(Also add `import sys` to the conftest imports.)

- [ ] **Step 2: Write the failing tests**

Create `server/tests/test_google_client.py`:

```python
import httpx
import pytest

from app.services.google_client import (
    GoogleRateLimitedError,
    GoogleRequestError,
    GoogleUnavailableError,
    call,
)
from tests.conftest import GoogleMock

URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


def test_returns_json(google: GoogleMock) -> None:
    google.on("GET", URL, httpx.Response(200, json={"items": []}))
    assert call("GET", URL) == {"items": []}


def test_empty_body_returns_empty_dict(google: GoogleMock) -> None:
    google.on("POST", URL, httpx.Response(204))
    assert call("POST", URL) == {}


@pytest.mark.parametrize(
    ("response", "error"),
    [
        (httpx.ReadTimeout("slow"), GoogleUnavailableError),
        (httpx.ConnectError("down"), GoogleUnavailableError),
        (httpx.Response(503), GoogleUnavailableError),
        (httpx.Response(429), GoogleRateLimitedError),
        (httpx.Response(400, json={"error": "bad"}), GoogleRequestError),
    ],
)
def test_maps_failures_to_friendly_errors(google: GoogleMock, response: object, error: type) -> None:
    google.on("GET", URL, response)
    with pytest.raises(error) as exc_info:
        call("GET", URL)
    assert exc_info.value.message  # speakable text, never empty
    assert len(google.requests) == 1  # no retry loop
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_google_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.google_client'`.

- [ ] **Step 4: Implement**

Create `server/app/services/google_client.py`:

```python
import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class GoogleError(Exception):
    status = 503
    message = "Google isn't available right now. Please try again."

    def __init__(self, message: str | None = None) -> None:
        if message:
            self.message = message
        super().__init__(self.message)


class GoogleNotConnectedError(GoogleError):
    status = 409
    message = "Your Google account isn't connected. Open the homie dashboard to connect it."


class GoogleUnavailableError(GoogleError):
    status = 504
    message = "Google didn't respond in time, please try again."


class GoogleRateLimitedError(GoogleError):
    status = 429
    message = "I'm being rate limited by Google, try again in a minute."


class GoogleRequestError(GoogleError):
    status = 502
    message = "Google couldn't complete that request."

    def __init__(self, http_status: int, body: dict[str, Any] | None = None) -> None:
        self.http_status = http_status
        self.body = body or {}  # kept for callers (e.g. invalid_grant); never logged
        super().__init__()


class GoogleNotConfiguredError(GoogleError):
    status = 503
    message = "Google isn't set up on this server yet."


class NoHomeLocationError(GoogleError):
    status = 409
    message = "Set your home address in the homie dashboard."


# dev-note: one process-wide client (connection pooling); tests swap it for a MockTransport client.
_http: httpx.Client | None = None


def _client() -> httpx.Client:
    global _http
    if _http is None:
        _http = httpx.Client(timeout=settings.google_timeout_seconds)
    return _http


def call(method: str, url: str, *, timeout: float | None = None, **kwargs: Any) -> dict[str, Any]:
    """One Google request: no retries; failures become GoogleError subclasses."""
    try:
        response = _client().request(
            method, url, timeout=timeout or settings.google_timeout_seconds, **kwargs
        )
    except httpx.TransportError as exc:  # includes every timeout
        logger.warning("Google %s failed: %s", url.split("?")[0], type(exc).__name__)
        raise GoogleUnavailableError() from exc
    if response.status_code == 429:
        raise GoogleRateLimitedError()
    if response.status_code >= 500:
        logger.warning("Google %s returned %s", url.split("?")[0], response.status_code)
        raise GoogleUnavailableError()
    if response.status_code >= 400:
        logger.warning("Google %s returned %s", url.split("?")[0], response.status_code)
        try:
            body = response.json()
        except ValueError:
            body = {}
        raise GoogleRequestError(response.status_code, body if isinstance(body, dict) else {})
    return response.json() if response.content else {}
```

Add to `server/app/main.py`, next to the other exception handlers:

```python
from app.services.google_client import GoogleError


@app.exception_handler(GoogleError)
async def google_error(request: Request, exc: GoogleError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": exc.message})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_google_client.py -v` — expected: 7 passed. Then the full suite + ruff.

- [ ] **Step 6: Commit**

```bash
git add server/app/services/google_client.py server/app/main.py server/tests/conftest.py server/tests/test_google_client.py
git commit -m "feat(server): add Google HTTP client with timeout and error mapping"
```

---

### Task 2: Google OAuth — connect, callback, status, disconnect, revoke on delete

**Files:**
- Create: `server/app/services/google_auth_service.py`, `server/app/routes/google.py`, `server/app/models/google.py`
- Modify: `server/app/main.py` (router), `server/app/services/profile_service.py` (revoke on delete)
- Test: `server/tests/test_google_auth.py`

**Interfaces:**
- Consumes: `google_client.call`, `GoogleNotConnectedError`, `GoogleNotConfiguredError`, `GoogleRequestError`,
  `get_table()` from `app.services.memory_service`, `CurrentUserDependency`.
- Produces:
  - `GoogleStatus(BaseModel)`: `connected: bool`, `email: str | None = None` (in `app/models/google.py`)
  - `GoogleAuthService(table: Any = None)` with `connect_url(user_sub: str) -> str`,
    `complete(code: str, state: str) -> None`, `status(user_sub: str) -> GoogleStatus`,
    `access_token(user_sub: str) -> str`, `disconnect(user_sub: str) -> None`
  - Constants `AUTH_URL`, `TOKEN_URL`, `REVOKE_URL`, `SCOPES`; module dict `_access_tokens`
  - Routes: `GET /api/google`, `GET /api/google/connect`, `GET /api/google/callback`, `DELETE /api/google`
  - `get_google_auth_service()` dependency in `app/routes/google.py`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_google_auth.py`:

```python
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import settings
from app.routes.google import get_google_auth_service
from app.services.google_auth_service import REVOKE_URL, TOKEN_URL, GoogleAuthService
from tests.conftest import GoogleMock
from tests.test_memories import auth, client  # noqa: F401


def id_token(email: str) -> str:
    return jwt.encode({"email": email}, "irrelevant", algorithm="HS256")


@pytest.fixture
def api(client: TestClient, ddb_table: Any, google: GoogleMock) -> Iterator[TestClient]:  # noqa: F811
    main.app.dependency_overrides[get_google_auth_service] = lambda: GoogleAuthService(table=ddb_table)
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_google_auth_service, None)


def connect(api: TestClient, google: GoogleMock, user: str = "alice") -> None:
    url = api.get("/api/google/connect", headers=auth(user)).json()["url"]
    state = parse_qs(urlsplit(url).query)["state"][0]
    google.on("POST", TOKEN_URL, httpx.Response(200, json={
        "access_token": "at-1", "expires_in": 3599, "refresh_token": "rt-secret",
        "scope": "openid email https://www.googleapis.com/auth/calendar.events",
        "id_token": id_token(f"{user}@example.com"),
    }))
    response = api.get(f"/api/google/callback?code=c&state={state}", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "https://dash.example/settings?google=connected"


def test_connect_url_targets_google_with_offline_access(api: TestClient) -> None:
    url = api.get("/api/google/connect", headers=auth()).json()["url"]
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    query = parse_qs(urlsplit(url).query)
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    assert query["redirect_uri"] == [f"{settings.public_base_url}/api/google/callback"]


def test_full_connect_status_disconnect(api: TestClient, google: GoogleMock, ddb_table: Any) -> None:
    assert api.get("/api/google", headers=auth()).json() == {"connected": False, "email": None}
    connect(api, google)
    assert api.get("/api/google", headers=auth()).json() == {
        "connected": True, "email": "alice@example.com"
    }
    stored = ddb_table.get_item(Key={"pk": "USER#alice", "sk": "GOOGLE"})["Item"]
    assert "rt-secret" not in str(stored)  # encrypted at rest
    assert api.get("/api/google", headers=auth("bob")).json()["connected"] is False  # per-user

    google.on("POST", REVOKE_URL, httpx.Response(200))
    assert api.delete("/api/google", headers=auth()).status_code == 204
    assert api.get("/api/google", headers=auth()).json()["connected"] is False
    assert api.delete("/api/google", headers=auth()).status_code == 204  # idempotent


@pytest.mark.parametrize("bad", ["tampered", "expired", "wrong-aud", "denied"])
def test_bad_callback_stores_nothing(api: TestClient, google: GoogleMock, bad: str) -> None:
    claims = {"sub": "alice", "aud": "google-connect", "exp": int(time.time()) + 600}
    if bad == "expired":
        claims["exp"] = int(time.time()) - 1
    if bad == "wrong-aud":
        claims["aud"] = "other"
    state = jwt.encode(claims, settings.oauth_state_secret, algorithm="HS256")
    query = f"code=c&state={state}"
    if bad == "tampered":
        query = f"code=c&state={state[:-2]}xx"
    if bad == "denied":
        query = f"error=access_denied&state={state}"
    response = api.get(f"/api/google/callback?{query}", follow_redirects=False)
    assert response.headers["location"] == "https://dash.example/settings?google=error"
    assert google.requests == []  # never exchanged a code
    assert api.get("/api/google", headers=auth()).json()["connected"] is False


def test_revoked_refresh_token_disconnects(api: TestClient, google: GoogleMock, ddb_table: Any) -> None:
    connect(api, google)
    service = GoogleAuthService(table=ddb_table)
    from app.services import google_auth_service
    google_auth_service._access_tokens.clear()  # force a refresh
    google.on("POST", TOKEN_URL, httpx.Response(400, json={"error": "invalid_grant"}))
    from app.services.google_client import GoogleNotConnectedError
    with pytest.raises(GoogleNotConnectedError):
        service.access_token("alice")
    assert api.get("/api/google", headers=auth()).json()["connected"] is False


def test_access_token_is_cached(api: TestClient, google: GoogleMock, ddb_table: Any) -> None:
    connect(api, google)
    service = GoogleAuthService(table=ddb_table)
    before = len(google.requests)
    assert service.access_token("alice") == "at-1"
    assert len(google.requests) == before  # served from the callback's cached token


def test_not_configured(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "google_client_id", "")
    response = api.get("/api/google/connect", headers=auth())
    assert response.status_code == 503


def test_requires_auth(api: TestClient) -> None:
    assert api.get("/api/google").status_code == 401
    assert api.get("/api/google/connect").status_code == 401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_google_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.routes.google'`.

- [ ] **Step 3: Implement the model**

Create `server/app/models/google.py`:

```python
from pydantic import BaseModel


class GoogleStatus(BaseModel):
    connected: bool
    email: str | None = None
```

- [ ] **Step 4: Implement the service**

Create `server/app/services/google_auth_service.py`:

```python
import time
from datetime import UTC, datetime
from threading import Lock
from typing import Any
from urllib.parse import urlencode

import jwt
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings
from app.models.google import GoogleStatus
from app.services.google_client import (
    GoogleError,
    GoogleNotConfiguredError,
    GoogleNotConnectedError,
    GoogleRequestError,
    call,
)
from app.services.memory_service import get_table

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
SCOPES = "openid email https://www.googleapis.com/auth/calendar.events"
STATE_AUDIENCE = "google-connect"

# dev-note: per-process access-token cache (like the rate limiter); move to a shared store if scaled out.
_access_tokens: dict[str, tuple[str, float]] = {}
_lock = Lock()


def _redirect_uri() -> str:
    return f"{settings.public_base_url}/api/google/callback"


def _fernet() -> Fernet:
    if not settings.google_token_key:
        raise GoogleNotConfiguredError()
    return Fernet(settings.google_token_key)


def _require_config() -> None:
    if not (settings.google_client_id and settings.google_client_secret and settings.oauth_state_secret):
        raise GoogleNotConfiguredError()


def _cache(user_sub: str, tokens: dict[str, Any]) -> str:
    token = tokens["access_token"]
    expires_at = time.monotonic() + int(tokens.get("expires_in", 3600)) - 60
    with _lock:
        _access_tokens[user_sub] = (token, expires_at)
    return token


class GoogleAuthService:
    def __init__(self, table: Any = None) -> None:
        self.table = table if table is not None else get_table()

    def _key(self, user_sub: str) -> dict[str, str]:
        return {"pk": f"USER#{user_sub}", "sk": "GOOGLE"}

    def _item(self, user_sub: str) -> dict[str, Any] | None:
        return self.table.get_item(Key=self._key(user_sub), ConsistentRead=True).get("Item")

    def _forget(self, user_sub: str) -> None:
        with _lock:
            _access_tokens.pop(user_sub, None)
        self.table.delete_item(Key=self._key(user_sub))

    def connect_url(self, user_sub: str) -> str:
        _require_config()
        state = jwt.encode(
            {"sub": user_sub, "aud": STATE_AUDIENCE, "exp": int(time.time()) + 600},
            settings.oauth_state_secret,
            algorithm="HS256",
        )
        params = {
            "client_id": settings.google_client_id,
            "redirect_uri": _redirect_uri(),
            "response_type": "code",
            "scope": SCOPES,
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
        }
        return f"{AUTH_URL}?{urlencode(params)}"

    def complete(self, code: str, state: str) -> None:
        """Finish the OAuth callback. Raises ValueError for a bad state, GoogleError for Google failures."""
        _require_config()
        try:
            claims = jwt.decode(
                state, settings.oauth_state_secret, algorithms=["HS256"], audience=STATE_AUDIENCE
            )
        except jwt.PyJWTError as exc:
            raise ValueError("invalid state") from exc
        user_sub = str(claims["sub"])
        tokens = call(
            "POST",
            TOKEN_URL,
            timeout=5,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": _redirect_uri(),
                "grant_type": "authorization_code",
            },
        )
        refresh = tokens.get("refresh_token")
        if not refresh:
            raise GoogleError("Google didn't grant offline access. Please connect again.")
        email = None
        if tokens.get("id_token"):
            # Received directly from Google's token endpoint over TLS (OIDC Core 3.1.3.7).
            email = jwt.decode(tokens["id_token"], options={"verify_signature": False}).get("email")
        item: dict[str, Any] = {
            **self._key(user_sub),
            "refresh_token": _fernet().encrypt(refresh.encode()).decode(),
            "scopes": tokens.get("scope", SCOPES),
            "connected_at": datetime.now(UTC).isoformat(),
        }
        if email:
            item["email"] = email
        self.table.put_item(Item=item)
        _cache(user_sub, tokens)

    def status(self, user_sub: str) -> GoogleStatus:
        item = self._item(user_sub)
        return GoogleStatus(connected=bool(item), email=item.get("email") if item else None)

    def access_token(self, user_sub: str) -> str:
        with _lock:
            cached = _access_tokens.get(user_sub)
        if cached and cached[1] > time.monotonic():
            return cached[0]
        item = self._item(user_sub)
        if not item:
            raise GoogleNotConnectedError()
        try:
            refresh = _fernet().decrypt(item["refresh_token"].encode()).decode()
        except InvalidToken:
            # Key rotated or corrupted: the stored token is unusable.
            self._forget(user_sub)
            raise GoogleNotConnectedError() from None
        try:
            tokens = call(
                "POST",
                TOKEN_URL,
                data={
                    "client_id": settings.google_client_id,
                    "client_secret": settings.google_client_secret,
                    "refresh_token": refresh,
                    "grant_type": "refresh_token",
                },
            )
        except GoogleRequestError as exc:
            if exc.body.get("error") == "invalid_grant":  # user revoked homie in Google
                self._forget(user_sub)
                raise GoogleNotConnectedError() from exc
            raise
        return _cache(user_sub, tokens)

    def disconnect(self, user_sub: str) -> None:
        """Revoke (best effort) and forget the user's Google connection. Safe to repeat."""
        item = self._item(user_sub)
        if item:
            try:
                refresh = _fernet().decrypt(item["refresh_token"].encode()).decode()
                call("POST", REVOKE_URL, data={"token": refresh})
            except (GoogleError, InvalidToken):
                pass  # still forget locally; the user can revoke from their Google account
        self._forget(user_sub)
```

- [ ] **Step 5: Implement the routes**

Create `server/app/routes/google.py`:

```python
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from fastapi.responses import RedirectResponse

from app.config import settings
from app.middleware.auth import CurrentUserDependency
from app.models.google import GoogleStatus
from app.services.google_auth_service import GoogleAuthService
from app.services.google_client import GoogleError

router = APIRouter(prefix="/api/google", tags=["google"])


def get_google_auth_service() -> GoogleAuthService:
    return GoogleAuthService()


ServiceDependency = Annotated[GoogleAuthService, Depends(get_google_auth_service)]


@router.get("", response_model=GoogleStatus)
def google_status(user: CurrentUserDependency, service: ServiceDependency) -> GoogleStatus:
    return service.status(user.sub)


@router.get("/connect")
def google_connect(user: CurrentUserDependency, service: ServiceDependency) -> dict[str, str]:
    # JSON, not a 302: a page navigation can't carry the Bearer token (spec §7).
    return {"url": service.connect_url(user.sub)}


@router.get("/callback")
def google_callback(
    service: ServiceDependency,
    state: str = "",
    code: str = "",
    error: str = "",
) -> RedirectResponse:
    # Unauthenticated by design: Google redirects the browser here. `state` identifies the user.
    outcome = "error"
    if code and state and not error:
        try:
            service.complete(code, state)
            outcome = "connected"
        except (ValueError, GoogleError):
            pass
    return RedirectResponse(f"{settings.dashboard_url}/settings?google={outcome}")


@router.delete("", status_code=204)
def google_disconnect(user: CurrentUserDependency, service: ServiceDependency) -> Response:
    service.disconnect(user.sub)
    return Response(status_code=204)
```

Register in `server/app/main.py` after the existing routers: `from app.routes import google` (add to the existing
import line) and `app.include_router(google.router)`.

- [ ] **Step 6: Revoke on delete-all-data**

In `server/app/services/profile_service.py`, `delete_all_user_data`, replace the Google dev-note with:

```python
        # Revoke before the GOOGLE item disappears with the rest of USER#{sub}.
        GoogleAuthService(self.table).disconnect(user_sub)
```

and add `from app.services.google_auth_service import GoogleAuthService` at the top. Add to
`server/tests/test_profile.py`:

```python
def test_delete_me_revokes_google(api: TestClient, google: GoogleMock, ddb_table: Any) -> None:
    from app.services.google_auth_service import REVOKE_URL
    from app.services.google_auth_service import _fernet

    ddb_table.put_item(Item={
        "pk": "USER#alice", "sk": "GOOGLE",
        "refresh_token": _fernet().encrypt(b"rt").decode(), "scopes": "x", "connected_at": "t",
    })
    google.on("POST", REVOKE_URL, httpx.Response(200))
    assert api.delete("/api/me", headers=auth()).status_code == 204
    assert [r.url.path for r in google.requests] == ["/revoke"]
    assert "Item" not in ddb_table.get_item(Key={"pk": "USER#alice", "sk": "GOOGLE"})
```

(with `import httpx` and `from tests.conftest import GoogleMock` at the top of that file).

- [ ] **Step 7: Run tests to verify they pass**

Run: `uv run pytest tests/test_google_auth.py tests/test_profile.py -v` — expected: all pass. Then full suite + ruff.

- [ ] **Step 8: Commit**

```bash
git add server/app/models/google.py server/app/services/google_auth_service.py server/app/routes/google.py \
  server/app/main.py server/app/services/profile_service.py server/tests/test_google_auth.py server/tests/test_profile.py
git commit -m "feat(server): Google OAuth connect, status, disconnect and revoke on delete"
```

---

### Task 3: Calendar — events and reminders (REST)

**Files:**
- Create: `server/app/services/calendar_service.py`, `server/app/routes/calendar.py`
- Modify: `server/app/models/google.py`, `server/app/main.py` (router)
- Test: `server/tests/test_calendar.py`

**Interfaces:**
- Consumes: `GoogleAuthService.access_token`, `google_client.call`, `MemoryService.list_memories(sub, kind="todo", limit=200)`,
  `ProfileService.get_profile(sub).timezone`, `Timezone` from `app.models.user`, `Memory`.
- Produces:
  - `CalendarEvent(BaseModel)`: `id, title, start, end: str`, `all_day: bool`, `location: str | None`, `html_link: str`,
    `created_by_homie: bool`, `todos: list[Memory]`
  - `ReminderCreate(BaseModel)`: `title`, `when`, `timezone`, `notes: str | None`, `remind_minutes_before: int = 60`
  - `CalendarService(table: Any = None)` with `list_events(user_sub: str, days: int) -> list[CalendarEvent]` and
    `create_reminder(user_sub: str, data: ReminderCreate) -> CalendarEvent`; constant `EVENTS_URL`
  - Routes `GET /api/calendar/events?days=` (1–14, default 14), `POST /api/calendar/reminders` → 201

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_calendar.py`:

```python
import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.routes.calendar import get_calendar_service
from app.services import google_auth_service
from app.services.calendar_service import EVENTS_URL, CalendarService
from app.services.memory_service import MemoryService
from tests.conftest import GoogleMock
from tests.test_memories import auth, client  # noqa: F401


@pytest.fixture
def api(client: TestClient, ddb_table: Any, google: GoogleMock) -> Iterator[TestClient]:  # noqa: F811
    main.app.dependency_overrides[get_calendar_service] = lambda: CalendarService(table=ddb_table)
    # Pretend alice is connected with a cached access token.
    google_auth_service._access_tokens["alice"] = ("at", float("inf"))
    ddb_table.put_item(Item={"pk": "USER#alice", "sk": "PROFILE", "timezone": "America/Los_Angeles",
                             "travel_mode": "DRIVE"})
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_calendar_service, None)


EVENT = {
    "id": "ev1", "summary": "Dentist", "htmlLink": "https://calendar.google.com/e/ev1",
    "start": {"dateTime": "2026-10-20T09:00:00-07:00"}, "end": {"dateTime": "2026-10-20T09:30:00-07:00"},
    "location": "1 Main St",
}


def test_lists_events_with_linked_todos(api: TestClient, google: GoogleMock, ddb_table: Any) -> None:
    MemoryService(table=ddb_table).create_memory("alice", "Bring insurance card", "todo", [], "ev1")
    MemoryService(table=ddb_table).create_memory("bob", "Not mine", "todo", [], "ev1")
    google.on("GET", EVENTS_URL, httpx.Response(200, json={"items": [
        EVENT,
        {"id": "ev2", "status": "cancelled", "start": {"date": "2026-10-21"}, "end": {"date": "2026-10-22"}},
        {"id": "ev3", "start": {"date": "2026-10-21"}, "end": {"date": "2026-10-22"},
         "extendedProperties": {"private": {"homie": "1"}}},
    ]}))
    response = api.get("/api/calendar/events?days=7", headers=auth())
    assert response.status_code == 200
    events = response.json()
    assert [e["id"] for e in events] == ["ev1", "ev3"]
    assert [t["content"] for t in events[0]["todos"]] == ["Bring insurance card"]
    assert events[1]["todos"] == []
    assert events[1]["all_day"] is True and events[1]["created_by_homie"] is True
    assert events[1]["title"] == "(No title)"
    params = google.requests[-1].url.params
    assert params["timeZone"] == "America/Los_Angeles"
    assert params["singleEvents"] == "true"
    assert google.requests[-1].headers["authorization"] == "Bearer at"


@pytest.mark.parametrize("days", [0, 15])
def test_days_bounds(api: TestClient, days: int) -> None:
    assert api.get(f"/api/calendar/events?days={days}", headers=auth()).status_code == 422


def test_reminder_keeps_wall_clock_across_dst(api: TestClient, google: GoogleMock) -> None:
    def created(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(200, json={"id": "new", "htmlLink": "h", **body})

    google.on("POST", EVENTS_URL, created)
    response = api.post("/api/calendar/reminders", headers=auth(), json={
        "title": "Renew pass", "when": "2026-11-01T01:30", "timezone": "America/Los_Angeles",
    })
    assert response.status_code == 201
    sent = json.loads(google.requests[-1].content)
    assert sent["start"] == {"dateTime": "2026-11-01T01:30:00", "timeZone": "America/Los_Angeles"}
    assert sent["end"] == {"dateTime": "2026-11-01T02:00:00", "timeZone": "America/Los_Angeles"}
    assert sent["reminders"] == {"useDefault": False, "overrides": [{"method": "popup", "minutes": 60}]}
    assert sent["extendedProperties"] == {"private": {"homie": "1"}}
    assert response.json()["created_by_homie"] is True


def test_all_day_reminder_uses_calendar_defaults(api: TestClient, google: GoogleMock) -> None:
    google.on("POST", EVENTS_URL, lambda r: httpx.Response(200, json={"id": "n", **json.loads(r.content)}))
    api.post("/api/calendar/reminders", headers=auth(),
             json={"title": "Milk expires", "when": "2026-10-31", "timezone": "UTC"})
    sent = json.loads(google.requests[-1].content)
    assert sent["start"] == {"date": "2026-10-31"} and sent["end"] == {"date": "2026-11-01"}
    assert sent["reminders"] == {"useDefault": True}


@pytest.mark.parametrize("body", [
    {"title": " ", "when": "2026-10-31", "timezone": "UTC"},
    {"title": "x", "when": "next tuesday", "timezone": "UTC"},
    {"title": "x", "when": "2026-10-31", "timezone": "Mars/Base"},
    {"title": "x", "when": "2026-10-31T09:00", "timezone": "UTC", "remind_minutes_before": -5},
    {"title": "x", "when": "2026-10-31", "timezone": "UTC", "user_sub": "bob"},
])
def test_reminder_validation(api: TestClient, body: dict[str, Any]) -> None:
    assert api.post("/api/calendar/reminders", headers=auth(), json=body).status_code == 422


def test_not_connected_is_409(api: TestClient) -> None:
    google_auth_service._access_tokens.clear()
    response = api.get("/api/calendar/events", headers=auth())
    assert response.status_code == 409
    assert "isn't connected" in response.json()["detail"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_calendar.py -v` — expected: FAIL, `No module named 'app.routes.calendar'`.

- [ ] **Step 3: Models**

Append to `server/app/models/google.py`:

```python
from datetime import date, datetime
from typing import Annotated

from pydantic import ConfigDict, Field, StringConstraints, field_validator

from app.models.memory import Memory
from app.models.user import Timezone


class CalendarEvent(BaseModel):
    id: str
    title: str
    start: str  # RFC 3339 with offset, or YYYY-MM-DD when all_day
    end: str
    all_day: bool
    location: str | None = None
    html_link: str
    created_by_homie: bool
    todos: list[Memory] = Field(default_factory=list)


class ReminderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    # Local wall-clock YYYY-MM-DDTHH:MM[:SS] (no offset) or YYYY-MM-DD for all-day (spec §7).
    when: str
    timezone: Timezone
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = None
    remind_minutes_before: int = Field(default=60, ge=0, le=40320)

    @field_validator("when")
    @classmethod
    def parse_when(cls, value: str) -> str:
        value = value.strip()
        try:
            if len(value) == 10:
                return date.fromisoformat(value).isoformat()
            parsed = datetime.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("Use YYYY-MM-DD or YYYY-MM-DDTHH:MM") from exc
        if parsed.tzinfo is not None:
            raise ValueError("Send local time without an offset, plus `timezone`")
        return parsed.isoformat(timespec="seconds")
```

- [ ] **Step 4: Service**

Create `server/app/services/calendar_service.py`:

```python
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.models.google import CalendarEvent, ReminderCreate
from app.models.memory import Memory
from app.services.google_auth_service import GoogleAuthService
from app.services.google_client import call
from app.services.memory_service import MemoryService, get_table
from app.services.profile_service import ProfileService

EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
REMINDER_MINUTES = 30


def _to_event(item: dict[str, Any], todos: dict[str, list[Memory]]) -> CalendarEvent:
    start, end = item.get("start", {}), item.get("end", {})
    all_day = "date" in start
    return CalendarEvent(
        id=item["id"],
        title=item.get("summary") or "(No title)",
        start=start.get("date") or start.get("dateTime", ""),
        end=end.get("date") or end.get("dateTime", ""),
        all_day=all_day,
        location=item.get("location"),
        html_link=item.get("htmlLink", ""),
        created_by_homie=item.get("extendedProperties", {}).get("private", {}).get("homie") == "1",
        todos=todos.get(item["id"], []),
    )


class CalendarService:
    def __init__(self, table: Any = None) -> None:
        self.table = table if table is not None else get_table()
        self.auth = GoogleAuthService(self.table)

    def _headers(self, user_sub: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.auth.access_token(user_sub)}"}

    def list_events(self, user_sub: str, days: int) -> list[CalendarEvent]:
        zone = ZoneInfo(ProfileService(self.table).get_profile(user_sub).timezone)
        start = datetime.now(zone).replace(hour=0, minute=0, second=0, microsecond=0)
        data = call(
            "GET",
            EVENTS_URL,
            headers=self._headers(user_sub),
            params={
                "timeMin": start.isoformat(),
                "timeMax": (start + timedelta(days=days)).isoformat(),
                "timeZone": zone.key,
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": 250,
            },
        )
        # dev-note: linked to-dos come from the newest 200 memories (same window as recall).
        todos: dict[str, list[Memory]] = defaultdict(list)
        for memory in MemoryService(self.table).list_memories(user_sub, kind="todo", limit=200):
            if memory.event_id:
                todos[memory.event_id].append(memory)
        return [
            _to_event(item, todos)
            for item in data.get("items", [])
            if item.get("status") != "cancelled"
        ]

    def create_reminder(self, user_sub: str, data: ReminderCreate) -> CalendarEvent:
        body: dict[str, Any] = {
            "summary": data.title,
            "extendedProperties": {"private": {"homie": "1"}},
        }
        if data.notes:
            body["description"] = data.notes
        if len(data.when) == 10:
            day = date.fromisoformat(data.when)
            body["start"] = {"date": day.isoformat()}
            body["end"] = {"date": (day + timedelta(days=1)).isoformat()}
            # Google counts all-day popups before 00:00, so "9:00 on the day" can't be expressed (spec D9).
            body["reminders"] = {"useDefault": True}
        else:
            start = datetime.fromisoformat(data.when)
            end = start + timedelta(minutes=REMINDER_MINUTES)
            # Wall-clock + zone straight to Google: no UTC conversion, DST stays correct.
            body["start"] = {"dateTime": start.isoformat(), "timeZone": data.timezone}
            body["end"] = {"dateTime": end.isoformat(), "timeZone": data.timezone}
            body["reminders"] = {
                "useDefault": False,
                "overrides": [{"method": "popup", "minutes": data.remind_minutes_before}],
            }
        item = call("POST", EVENTS_URL, headers=self._headers(user_sub), json=body)
        return _to_event(item, {})
```

- [ ] **Step 5: Routes**

Create `server/app/routes/calendar.py`:

```python
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.middleware.auth import CurrentUserDependency
from app.models.google import CalendarEvent, ReminderCreate
from app.services.calendar_service import CalendarService

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


def get_calendar_service() -> CalendarService:
    return CalendarService()


ServiceDependency = Annotated[CalendarService, Depends(get_calendar_service)]


@router.get("/events", response_model=list[CalendarEvent])
def list_events(
    user: CurrentUserDependency,
    service: ServiceDependency,
    days: Annotated[int, Query(ge=1, le=14)] = 14,
) -> list[CalendarEvent]:
    return service.list_events(user.sub, days)


@router.post("/reminders", response_model=CalendarEvent, status_code=201)
def create_reminder(
    data: ReminderCreate, user: CurrentUserDependency, service: ServiceDependency
) -> CalendarEvent:
    return service.create_reminder(user.sub, data)
```

Register in `server/app/main.py` (`calendar` in the routes import, `app.include_router(calendar.router)`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_calendar.py -v` — expected: all pass. Then full suite + ruff.

- [ ] **Step 7: Commit**

```bash
git add server/app/models/google.py server/app/services/calendar_service.py server/app/routes/calendar.py \
  server/app/main.py server/tests/test_calendar.py
git commit -m "feat(server): Google Calendar events and reminders REST API"
```

---

### Task 4: Maps — geocode home, find places, directions

**Files:**
- Create: `server/app/services/maps_service.py`
- Modify: `server/app/models/google.py`, `server/app/services/profile_service.py` (geocode on PUT)
- Test: `server/tests/test_maps.py`, `server/tests/test_profile.py`

**Interfaces:**
- Consumes: `google_client.call`, `GoogleNotConfiguredError`, `NoHomeLocationError`, `GoogleError`,
  `ProfileService.get_profile`, `MemoryService.list_memories(sub, kind="preference", limit=200)`,
  `MemoryService._tokens(text) -> set[str]` (existing static tokenizer with stopwords).
- Produces:
  - `Place(BaseModel)`: `name, address: str`, `rating: float | None`, `price_level: str | None`, `open_now: bool | None`,
    `maps_url: str`, `why: str | None`
  - `Directions(BaseModel)`: `duration_minutes: int`, `distance_km: float`, `mode: TravelMode`,
    `steps_summary: list[str]` (≤ 5), `maps_url: str`
  - `MapsService(table: Any = None)` with `geocode(address: str) -> tuple[float, float] | None`,
    `find_places(user_sub: str, query: str, near: str | None = None) -> list[Place]`,
    `get_directions(user_sub: str, destination: str, mode: TravelMode | None = None) -> Directions`;
    constants `GEOCODE_URL`, `PLACES_URL`, `ROUTES_URL`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_maps.py`:

```python
import json
from typing import Any

import httpx
import pytest

from app.services.google_client import GoogleRateLimitedError, NoHomeLocationError
from app.services.maps_service import GEOCODE_URL, PLACES_URL, ROUTES_URL, MapsService
from app.services.memory_service import MemoryService
from tests.conftest import GoogleMock

HOME = {"pk": "USER#alice", "sk": "PROFILE", "timezone": "UTC", "travel_mode": "WALK",
        "home": {"address": "1 Main St"}}


def geocode_ok(lat: float = 40.0, lng: float = -74.0) -> httpx.Response:
    return httpx.Response(200, json={"status": "OK", "results": [
        {"geometry": {"location": {"lat": lat, "lng": lng}}}]})


def test_geocode(google: GoogleMock, ddb_table: Any) -> None:
    google.on("GET", GEOCODE_URL, geocode_ok())
    assert MapsService(ddb_table).geocode("1 Main St") == (40.0, -74.0)
    google.on("GET", GEOCODE_URL, httpx.Response(200, json={"status": "ZERO_RESULTS", "results": []}))
    assert MapsService(ddb_table).geocode("nowhere") is None
    google.on("GET", GEOCODE_URL, httpx.Response(200, json={"status": "OVER_QUERY_LIMIT"}))
    with pytest.raises(GoogleRateLimitedError):
        MapsService(ddb_table).geocode("x")


def test_no_home_says_so(google: GoogleMock, ddb_table: Any) -> None:
    with pytest.raises(NoHomeLocationError):
        MapsService(ddb_table).find_places("alice", "coffee")
    with pytest.raises(NoHomeLocationError):
        MapsService(ddb_table).get_directions("alice", "the library")


def test_find_places_uses_preference_and_explains(google: GoogleMock, ddb_table: Any) -> None:
    ddb_table.put_item(Item=HOME)  # no lat/lng yet → geocoded lazily
    MemoryService(table=ddb_table).create_memory("alice", "I love oat milk coffee", "preference", [], None)
    google.on("GET", GEOCODE_URL, geocode_ok())
    google.on("POST", PLACES_URL, httpx.Response(200, json={"places": [
        {"displayName": {"text": "Bean Bar"}, "formattedAddress": "2 Main St", "types": ["cafe"],
         "googleMapsUri": "https://maps.google.com/?cid=1"},
        {"displayName": {"text": "Oat & Co"}, "formattedAddress": "3 Main St", "rating": 4.6,
         "priceLevel": "PRICE_LEVEL_MODERATE", "currentOpeningHours": {"openNow": True},
         "googleMapsUri": "https://maps.google.com/?cid=2"},
    ]}))
    places = MapsService(ddb_table).find_places("alice", "coffee")
    sent = json.loads(google.requests[-1].content)
    assert "oat" in sent["textQuery"] and sent["maxResultCount"] == 5
    assert sent["locationBias"]["circle"]["center"] == {"latitude": 40.0, "longitude": -74.0}
    assert google.requests[-1].headers["x-goog-api-key"] == "maps-key"
    assert [p.name for p in places] == ["Oat & Co", "Bean Bar"]  # preference match ranked first
    assert places[0].why == "You said: I love oat milk coffee"
    assert places[0].open_now is True and places[1].why is None


def test_directions_default_mode_and_summary(google: GoogleMock, ddb_table: Any) -> None:
    ddb_table.put_item(Item={**HOME, "home": {"address": "1 Main St", "lat": 40, "lng": -74}})
    steps = [{"navigationInstruction": {"instructions": f"Step {i}"}} for i in range(8)]
    google.on("POST", ROUTES_URL, httpx.Response(200, json={"routes": [
        {"duration": "754s", "distanceMeters": 1234, "legs": [{"steps": steps}]}]}))
    directions = MapsService(ddb_table).get_directions("alice", "City Library")
    sent = json.loads(google.requests[-1].content)
    assert sent["travelMode"] == "WALK"
    assert sent["destination"] == {"address": "City Library"}
    assert directions.duration_minutes == 13 and directions.distance_km == 1.2
    assert directions.steps_summary == [f"Step {i}" for i in range(5)]
    assert "travelmode=walking" in directions.maps_url


def test_no_route(google: GoogleMock, ddb_table: Any) -> None:
    ddb_table.put_item(Item={**HOME, "home": {"address": "1 Main St", "lat": 40, "lng": -74}})
    google.on("POST", ROUTES_URL, httpx.Response(200, json={}))
    from app.services.google_client import GoogleError
    with pytest.raises(GoogleError, match="couldn't find a route"):
        MapsService(ddb_table).get_directions("alice", "Atlantis")
```

Add to `server/tests/test_profile.py` (uses its existing `api` fixture plus `google`):

```python
def test_put_geocodes_home(api: TestClient, google: GoogleMock) -> None:
    from app.services.maps_service import GEOCODE_URL

    google.on("GET", GEOCODE_URL, httpx.Response(200, json={"status": "OK", "results": [
        {"geometry": {"location": {"lat": 1.5, "lng": 2.5}}}]}))
    body = api.put("/api/me/profile", headers=auth(), json={"home": {"address": "1 Main St"}}).json()
    assert body["home"] == {"address": "1 Main St", "lat": 1.5, "lng": 2.5}


def test_put_unknown_address_is_422(api: TestClient, google: GoogleMock) -> None:
    from app.services.maps_service import GEOCODE_URL

    google.on("GET", GEOCODE_URL, httpx.Response(200, json={"status": "ZERO_RESULTS", "results": []}))
    response = api.put("/api/me/profile", headers=auth(), json={"home": {"address": "zzz"}})
    assert response.status_code == 422
    assert response.json()["detail"] == "We couldn't find that address."


def test_put_saves_address_when_google_is_down(api: TestClient, google: GoogleMock) -> None:
    from app.services.maps_service import GEOCODE_URL

    google.on("GET", GEOCODE_URL, httpx.ReadTimeout("slow"))
    body = api.put("/api/me/profile", headers=auth(), json={"home": {"address": "1 Main St"}}).json()
    assert body["home"] == {"address": "1 Main St", "lat": None, "lng": None}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_maps.py -v` — expected: FAIL, `No module named 'app.services.maps_service'`.

- [ ] **Step 3: Models**

Append to `server/app/models/google.py` (also add `TravelMode` to the `app.models.user` import):

```python
class Place(BaseModel):
    name: str
    address: str
    rating: float | None = None
    price_level: str | None = None
    open_now: bool | None = None
    maps_url: str
    why: str | None = None


class Directions(BaseModel):
    duration_minutes: int
    distance_km: float
    mode: TravelMode
    steps_summary: list[str]
    maps_url: str
```

- [ ] **Step 4: Service**

Create `server/app/services/maps_service.py`:

```python
from typing import Any
from urllib.parse import urlencode

from app.config import settings
from app.models.google import Directions, Place
from app.models.user import TravelMode
from app.services.google_client import (
    GoogleError,
    GoogleNotConfiguredError,
    GoogleRateLimitedError,
    NoHomeLocationError,
    call,
)
from app.services.memory_service import MemoryService, get_table
from app.services.profile_service import ProfileService

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
PLACES_URL = "https://places.googleapis.com/v1/places:searchText"
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
PLACES_FIELDS = ",".join(
    f"places.{f}"
    for f in ("displayName", "formattedAddress", "rating", "priceLevel",
              "currentOpeningHours.openNow", "googleMapsUri", "types")
)
ROUTES_FIELDS = "routes.duration,routes.distanceMeters,routes.legs.steps.navigationInstruction.instructions"
URL_MODES = {"DRIVE": "driving", "WALK": "walking", "BICYCLE": "bicycling", "TRANSIT": "transit"}
SEARCH_RADIUS_M = 5000.0


def _key() -> str:
    if not settings.google_maps_api_key:
        raise GoogleNotConfiguredError()
    return settings.google_maps_api_key


class MapsService:
    def __init__(self, table: Any = None) -> None:
        self.table = table if table is not None else get_table()

    def geocode(self, address: str) -> tuple[float, float] | None:
        data = call("GET", GEOCODE_URL, params={"address": address, "key": _key()})
        # Geocoding reports failures in the body with HTTP 200.
        if data.get("status") == "OVER_QUERY_LIMIT":
            raise GoogleRateLimitedError()
        if data.get("status") != "OK" or not data.get("results"):
            return None
        location = data["results"][0]["geometry"]["location"]
        return float(location["lat"]), float(location["lng"])

    def _home(self, user_sub: str) -> tuple[float, float]:
        home = ProfileService(self.table).get_profile(user_sub).home
        if home is None:
            raise NoHomeLocationError()
        if home.lat is not None and home.lng is not None:
            return home.lat, home.lng
        # Saved while Google was down (spec D12): geocode now.
        coords = self.geocode(home.address)
        if coords is None:
            raise NoHomeLocationError()
        return coords

    def find_places(self, user_sub: str, query: str, near: str | None = None) -> list[Place]:
        origin = (self.geocode(near) if near else None) or self._home(user_sub)
        query_tokens = MemoryService._tokens(query)
        # Spec D13: the preference sharing the most words with the query adds up to 3 keywords.
        best, extra = None, []
        for pref in MemoryService(self.table).list_memories(user_sub, kind="preference", limit=200):
            tokens = MemoryService._tokens(" ".join([pref.content, *pref.tags]))
            overlap = len(tokens & query_tokens)
            if overlap and (best is None or overlap > best[0]):
                best = (overlap, pref, sorted(tokens - query_tokens)[:3])
        if best:
            extra = best[2]
        data = call(
            "POST",
            PLACES_URL,
            headers={"X-Goog-Api-Key": _key(), "X-Goog-FieldMask": PLACES_FIELDS},
            json={
                "textQuery": " ".join([query, *extra]),
                "maxResultCount": 5,
                "locationBias": {"circle": {
                    "center": {"latitude": origin[0], "longitude": origin[1]},
                    "radius": SEARCH_RADIUS_M,
                }},
            },
        )
        scored = []
        for item in data.get("places", [])[:5]:
            name = item.get("displayName", {}).get("text", "")
            haystack = " ".join([name, *item.get("types", [])]).lower()
            hits = sum(word in haystack for word in extra)
            scored.append((hits, Place(
                name=name,
                address=item.get("formattedAddress", ""),
                rating=item.get("rating"),
                price_level=item.get("priceLevel"),
                open_now=item.get("currentOpeningHours", {}).get("openNow"),
                maps_url=item.get("googleMapsUri", ""),
                why=f"You said: {best[1].content}" if best and hits else None,
            )))
        scored.sort(key=lambda pair: -pair[0])  # stable: Google's order breaks ties
        return [place for _, place in scored]

    def get_directions(
        self, user_sub: str, destination: str, mode: TravelMode | None = None
    ) -> Directions:
        origin = self._home(user_sub)
        mode = mode or ProfileService(self.table).get_profile(user_sub).travel_mode
        body: dict[str, Any] = {
            "origin": {"location": {"latLng": {"latitude": origin[0], "longitude": origin[1]}}},
            "destination": {"address": destination},
            "travelMode": mode,
        }
        if mode == "DRIVE":
            body["routingPreference"] = "TRAFFIC_AWARE"
        data = call(
            "POST",
            ROUTES_URL,
            headers={"X-Goog-Api-Key": _key(), "X-Goog-FieldMask": ROUTES_FIELDS},
            json=body,
        )
        if not data.get("routes"):
            raise GoogleError("I couldn't find a route there. Try a more specific place.")
        route = data["routes"][0]
        steps = [
            step["navigationInstruction"]["instructions"]
            for leg in route.get("legs", [])
            for step in leg.get("steps", [])
            if step.get("navigationInstruction", {}).get("instructions")
        ]
        maps_url = "https://www.google.com/maps/dir/?" + urlencode({
            "api": 1,
            "origin": f"{origin[0]},{origin[1]}",
            "destination": destination,
            "travelmode": URL_MODES[mode],
        })
        return Directions(
            duration_minutes=round(int(route.get("duration", "0s").rstrip("s")) / 60),
            distance_km=round(route.get("distanceMeters", 0) / 1000, 1),
            mode=mode,
            steps_summary=steps[:5],
            maps_url=maps_url,
        )
```

- [ ] **Step 5: Geocode on profile save**

In `server/app/services/profile_service.py` `put_profile`, replace the `# dev-note: stores the address only…` branch:

```python
        if "home" in changes:
            home = changes["home"]
            if home:
                try:
                    coords = MapsService(self.table).geocode(home["address"])
                except GoogleError:
                    coords = None  # spec D12: save now, Maps geocodes lazily
                else:
                    if coords is None:
                        raise AddressNotFoundError()
                if coords:
                    home = {**home, "lat": coords[0], "lng": coords[1]}
```

Add at the top of `profile_service.py`:

```python
class AddressNotFoundError(Exception):
    pass
```

and import `MapsService` / `GoogleError` **inside** `put_profile` (`from app.services.maps_service import MapsService`)
to avoid the `maps_service → profile_service` import cycle. Register a handler in `server/app/main.py`:

```python
from app.services.profile_service import AddressNotFoundError


@app.exception_handler(AddressNotFoundError)
async def address_not_found(request: Request, exc: AddressNotFoundError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": "We couldn't find that address."})
```

Existing `test_profile.py` tests that PUT a home address now hit Geocoding: add the `google` fixture to the profile
`api` fixture and register `google.on("GET", GEOCODE_URL, httpx.ReadTimeout("offline"))` there by default so they
keep asserting `lat`/`lng` = `None`; the three new tests override it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_maps.py tests/test_profile.py -v` — expected: all pass. Then full suite + ruff.

- [ ] **Step 7: Commit**

```bash
git add server/app/models/google.py server/app/services/maps_service.py server/app/services/profile_service.py \
  server/app/main.py server/tests/test_maps.py server/tests/test_profile.py
git commit -m "feat(server): Google Maps places, directions and home geocoding"
```

---

### Task 5: MCP tools — `create_reminder`, `upcoming_events`, `find_places`, `get_directions`

**Files:**
- Modify: `server/app/mcp_server.py`
- Test: `server/tests/test_mcp_google.py`

**Interfaces:**
- Consumes: `mcp`, `_user_sub(ctx)` and the `ToolError` conventions from #36's `app/mcp_server.py`;
  `CalendarService`, `MapsService`, `ReminderCreate`, `ProfileService`, `GoogleError`.
- Produces: four tools; each returns a pydantic model (`CalendarEvent`, `list[CalendarEvent]`, `list[Place]`,
  `Directions`) and raises `ToolError(<speakable text>)` on every failure.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_mcp_google.py`. Reuse #36's MCP test helpers (read `tests/test_mcp.py` first; it defines the
authenticated `tools/call` helper). The shape below assumes a helper `call_tool(client, name, arguments, user="alice")
-> dict` returning the JSON-RPC `result`; adapt the import to the helper's real name.

```python
from typing import Any

import httpx
import pytest

from app.services import google_auth_service
from app.services.calendar_service import EVENTS_URL
from tests.conftest import GoogleMock
from tests.test_mcp import call_tool, mcp_client  # noqa: F401  (adapt to #36's helper names)


@pytest.fixture(autouse=True)
def connected(google: GoogleMock, ddb_table: Any) -> None:
    google_auth_service._access_tokens["alice"] = ("at", float("inf"))
    ddb_table.put_item(Item={"pk": "USER#alice", "sk": "PROFILE", "timezone": "America/Chicago",
                             "travel_mode": "DRIVE"})


def test_create_reminder_uses_profile_timezone(mcp_client: Any, google: GoogleMock) -> None:
    google.on("POST", EVENTS_URL, lambda r: httpx.Response(200, json={"id": "n", "htmlLink": "h"}))
    result = call_tool(mcp_client, "create_reminder", {"title": "Call mom", "when": "2026-10-20T18:00"})
    assert not result.get("isError")
    assert b'"timeZone":"America/Chicago"' in google.requests[-1].content.replace(b" ", b"")


def test_upcoming_events_bounds(mcp_client: Any) -> None:
    result = call_tool(mcp_client, "upcoming_events", {"days": 30})
    assert result["isError"] is True


def test_google_failure_is_speakable(mcp_client: Any, google: GoogleMock) -> None:
    google.on("GET", EVENTS_URL, httpx.ReadTimeout("slow"))
    result = call_tool(mcp_client, "upcoming_events", {"days": 1})
    assert result["isError"] is True
    assert "Google didn't respond in time" in result["content"][0]["text"]


def test_find_places_without_home(mcp_client: Any) -> None:
    result = call_tool(mcp_client, "find_places", {"query": "coffee"})
    assert "Set your home address" in result["content"][0]["text"]


def test_tools_listed(mcp_client: Any) -> None:
    names = {t["name"] for t in mcp_client.list_tools()}  # adapt to #36's helper
    assert {"create_reminder", "upcoming_events", "find_places", "get_directions"} <= names
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_mcp_google.py -v` — expected: FAIL (unknown tools).

- [ ] **Step 3: Implement the tools**

Append to `server/app/mcp_server.py` (match #36's style for argument typing; plain `str`/`int` types are enough here
because none of these arguments are JSON-like):

```python
from app.models.google import CalendarEvent, Directions, Place, ReminderCreate
from app.services.calendar_service import CalendarService
from app.services.google_client import GoogleError
from app.services.maps_service import MapsService
from app.services.profile_service import ProfileService


@mcp.tool()
def create_reminder(
    ctx: Context,
    title: str,
    when: str,
    notes: str | None = None,
    remind_minutes_before: int = 60,
) -> CalendarEvent:
    """Add a reminder to the user's Google Calendar. Use for deadlines, expiry dates and "remind me to…".
    `when` is the user's local time: YYYY-MM-DDTHH:MM, or YYYY-MM-DD for an all-day reminder."""
    user_sub = _user_sub(ctx)
    try:
        service = CalendarService()
        data = ReminderCreate(
            title=title,
            when=when,
            timezone=ProfileService(service.table).get_profile(user_sub).timezone,
            notes=notes,
            remind_minutes_before=remind_minutes_before,
        )
        return service.create_reminder(user_sub, data)
    except ValidationError as exc:  # already imported by #36
        raise ToolError("I couldn't tell when that is. Please say the date and time again.") from exc
    except GoogleError as exc:
        raise ToolError(exc.message) from exc


@mcp.tool()
def upcoming_events(ctx: Context, days: int = 1) -> list[CalendarEvent]:
    """List the user's calendar events for today and the next few days (1-14), with linked to-dos.
    Use when the user asks what's coming up or what they need to remember for an event."""
    user_sub = _user_sub(ctx)
    if not 1 <= days <= 14:
        raise ToolError("I can look 1 to 14 days ahead.")
    try:
        return CalendarService().list_events(user_sub, days)
    except GoogleError as exc:
        raise ToolError(exc.message) from exc


@mcp.tool()
def find_places(ctx: Context, query: str, near: str | None = None) -> list[Place]:
    """Suggest up to 5 places matching the request, ranked by the user's stored preferences.
    Searches near home unless `near` (an address or area) is given."""
    user_sub = _user_sub(ctx)
    if not query.strip() or len(query) > 200:
        raise ToolError("What kind of place are you looking for?")
    try:
        return MapsService().find_places(user_sub, query.strip(), near and near.strip()[:200])
    except GoogleError as exc:
        raise ToolError(exc.message) from exc


@mcp.tool()
def get_directions(ctx: Context, destination: str, mode: str | None = None) -> Directions:
    """Travel time and a short route summary from home to a destination.
    `mode` is DRIVE, WALK, BICYCLE or TRANSIT; defaults to the user's preferred travel mode."""
    user_sub = _user_sub(ctx)
    if not destination.strip() or len(destination) > 200:
        raise ToolError("Where would you like to go?")
    if mode is not None and mode not in ("DRIVE", "WALK", "BICYCLE", "TRANSIT"):
        raise ToolError("I can give driving, walking, cycling or transit directions.")
    try:
        return MapsService().get_directions(user_sub, destination.strip(), mode)
    except GoogleError as exc:
        raise ToolError(exc.message) from exc
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_mcp_google.py -v` — expected: all pass. Then full suite + ruff.

- [ ] **Step 5: Commit**

```bash
git add server/app/mcp_server.py server/tests/test_mcp_google.py
git commit -m "feat(server): Google Calendar and Maps MCP tools"
```

---

### Task 6: Client — OAuth return, not-connected handling

**Files:**
- Modify: `client/src/app/(app)/settings/page.tsx`, `client/src/lib/api.ts`

**Interfaces:**
- Consumes: `GET /api/google`, `/api/google/connect`, callback redirect `?google=connected|error`; REST 409/504/429
  `{detail}` messages.

- [ ] **Step 1: Show the OAuth outcome once on Settings**

In `SettingsPage` add (with `useEffect` from React, `useRouter` from `next/navigation`, `toast` already imported):

```tsx
  const router = useRouter()
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("google")
    if (!outcome) return
    if (outcome === "connected") toast.success("Google Calendar connected")
    else toast.error("Couldn't connect Google. Try again.")
    router.replace("/settings") // drop the param so a refresh doesn't repeat the toast
  }, [router])
```

- [ ] **Step 2: Use the server's plain-language `detail` for Google errors**

In `client/src/lib/api.ts`, replace `if (!res.ok) throw new ApiError(res.status, messageFor(res.status))` with:

```ts
      if (!res.ok) {
        // Google errors (409/429/502/503/504) carry a speakable `detail`; prefer it.
        const detail = await res
          .json()
          .then((b: { detail?: unknown }) => b.detail)
          .catch(() => undefined)
        throw new ApiError(
          res.status,
          typeof detail === "string" && res.status !== 422 ? detail : messageFor(res.status),
        )
      }
```

- [ ] **Step 3: Verify**

Run: `bun run lint && bunx tsc --noEmit`. Manually: with the server running and Google configured, Settings →
Connect Google Calendar → consent → back on Settings with the toast and "Connected · email"; Calendar shows events;
Create reminder lands in Google Calendar at the typed local time; Disconnect → "Not connected".

- [ ] **Step 4: Commit**

```bash
git add "client/src/app/(app)/settings/page.tsx" client/src/lib/api.ts
git commit -m "feat(client): handle Google OAuth return and server error details"
```

---

### Task 7: End-to-end check and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-p0-design.md` (§6 all-day note → link D9), `server/README.md`
- Create: `docs/google-testing.md`

- [ ] **Step 1: Spec amendment**

In P0 spec §6, change the `create_reminder` row's "(default 60; all-day → 9:00 local day-of)" to
"(default 60; all-day → calendar default reminders, see [Google design D9](2026-10-18-google-services-design.md))".

- [ ] **Step 2: Manual run against real Google (dev stack)**

Record actual results in `docs/google-testing.md` as a table (check, result, notes):
connect/consent/return; status shows email; calendar lists 14 days with a linked to-do; reminder at
`2026-11-01T01:30 America/Los_Angeles` shows at 1:30 a.m.; all-day reminder; revoke homie at
<https://myaccount.google.com/permissions> → next calendar call 409 and Settings shows "Not connected";
`find_places "coffee"` with a coffee preference; `get_directions` for each travel mode; account deletion revokes;
server timing of each MCP tool (warm) with `curl -w '%{time_total}'`, target < 0.5 s.

- [ ] **Step 3: README**

Add a "Google setup" section to `server/README.md` pointing at Task 0 Step 1 and listing the four new env vars.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-03-p0-design.md docs/google-testing.md server/README.md
git commit -m "docs: record Google integration results and setup"
```
