# homie P0 — Google Services Design

Status: draft for review · 2026-10-18 · implements the Google parts of the
[P0 design spec](2026-10-03-p0-design.md) (§5 `GOOGLE` item, §6 Google tools, §7 Google/Calendar REST rows).
Plan: [Plan 2 — Google](../plans/2026-10-18-p0-plan-2-google.md).

## 1. Goal

A signed-in user connects their Google account once from Settings. After that:

- the dashboard calendar shows the next 1–14 days of their primary Google Calendar, with linked to-do memories;
- they (or the assistant via MCP) can create reminders that land in Google Calendar at the exact local time they meant;
- the assistant can suggest places that fit their stored preferences and give directions from home;
- Settings shows the connection state and can disconnect; deleting the account revokes Google access.

## 2. Scope

**In:** Google OAuth (connect, callback, status, disconnect, revoke), Calendar `events.list` / `events.insert` on the
**primary** calendar, Places API (New) Text Search, Routes API `computeRoutes`, Geocoding API for the profile home
address, the four MCP tools `create_reminder`, `upcoming_events`, `find_places`, `get_directions`, and the REST rows in
spec §7.

**Out (P0):** other calendars, editing/deleting existing events, push notifications/webhooks, incremental sync, caching
event or place results, phone geolocation, Google Maps JS on the client, place photos.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Call Google's REST endpoints with `httpx` directly; no Google SDKs. | Five endpoints total; lets one module own timeouts and error mapping; no heavy deps. |
| D2 | One shared `httpx.Client`, **400 ms** timeout per call (`GOOGLE_TIMEOUT_SECONDS`), no automatic retries. The OAuth code exchange on callback uses 5 s. | Spec §6 latency budget; callback is a page load, not a tool call. |
| D3 | Refresh tokens are encrypted with Fernet (`GOOGLE_TOKEN_KEY`) before they reach DynamoDB. Access tokens live only in process memory until ~60 s before expiry. | A table export or log never yields a usable Google credential. Single-instance cache is fine for P0 (same as the rate limiter). |
| D4 | OAuth `state` is an HS256 JWT `{sub, aud: "google-connect", exp: now+10 min}` signed with `OAUTH_STATE_SECRET`. | Binds the callback to the user who started it without server-side state. Replay inside 10 min can only re-link the same user's own account. |
| D5 | Scopes: `openid email https://www.googleapis.com/auth/calendar.events`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`. The email comes from the `id_token` returned by Google's token endpoint over TLS (not signature-verified; OIDC Core §3.1.3.7). | Smallest scope that can read and create events; `prompt=consent` guarantees a refresh token on reconnect. |
| D6 | `GET /api/google/connect` returns `200 {url}`; `/api/google/callback` is unauthenticated, validated by `state`, and redirects to `{DASHBOARD_URL}/settings?google=connected` or `?google=error`. | Already agreed in spec §7 (#35). |
| D7 | Google returns `invalid_grant` on refresh → delete the `GOOGLE` item and treat the user as disconnected. | User revoked access in their Google account; the next status call shows "Not connected". |
| D8 | Reminders: `when` is wall-clock time + IANA `timezone` and is passed to Google as `start.dateTime` + `start.timeZone` without UTC conversion. Timed reminders are 30 min long with one popup `remind_minutes_before` (default 60, 0–40320). | Spec §7 reminder contract. |
| D9 | **All-day reminders use the calendar's default reminders (`useDefault: true`).** | Amends spec §6 "all-day → 9:00 local day-of": the Calendar API counts all-day popups in minutes *before* 00:00 (0–40320), so "9:00 on the day" can't be expressed. The user's own Google default is the least surprising substitute. |
| D10 | Homie-created events carry `extendedProperties.private.homie = "1"` (spec §5 "Not stored"); `created_by_homie` is read from it. | Lets the dashboard badge them without storing events. |
| D11 | Linked to-dos: `todo` memories whose `event_id` equals the Google event `id`. Read from the newest 200 memories (same window as `recall`). | No new index; matches the accepted P0 search window. |
| D12 | Profile home geocoding happens on `PUT /api/me/profile`. Unknown address → 422 "We couldn't find that address." Google down → save the address with null coordinates; Maps calls geocode it lazily. | A slow Google never blocks saving Settings. |
| D13 | Place ranking: pick the `preference` memory with the most token overlap with the query, add up to 3 of its other keywords to the text query, then stable-sort results by keyword hits in name/types; `why` quotes that preference when a result matched. | Spec §6 place ranking, made deterministic. |
| D14 | Places search is biased to a 5 km circle around the origin; at most 5 results; Routes travel modes map 1:1 from `PROFILE.travel_mode`. | Spec §5/§6. |

## 4. Data

`USER#{sub}` / `GOOGLE`: `refresh_token` (Fernet ciphertext, str), `email` (str or absent), `scopes` (str),
`connected_at` (UTC ISO-8601). Nothing else from Google is stored.

## 5. Errors

One exception family in `app/services/google_client.py`; REST maps `status`, MCP returns `message` as speakable text.

| Exception | REST | Message |
|---|---|---|
| `GoogleNotConnectedError` | 409 | Your Google account isn't connected. Open the homie dashboard to connect it. |
| `GoogleUnavailableError` (timeout, network, 5xx) | 504 | Google didn't respond in time, please try again. |
| `GoogleRateLimitedError` (429, `OVER_QUERY_LIMIT`) | 429 | I'm being rate limited by Google, try again in a minute. |
| `NoHomeLocationError` | 409 | Set your home address in the homie dashboard. |
| `GoogleRequestError` (other 4xx) | 502 | Google couldn't complete that request. |
| `GoogleNotConfiguredError` (no client ID/key) | 503 | Google isn't set up on this server yet. |

Logs record the exception class and HTTP status only — never request/response bodies, tokens, addresses or event text.

## 6. Configuration

New settings (also in `server/.env.example`): `GOOGLE_TOKEN_KEY` (Fernet key), `OAUTH_STATE_SECRET` (≥ 32 random
bytes), `DASHBOARD_URL` (default `http://localhost:3000`), `GOOGLE_TIMEOUT_SECONDS` (default `0.4`). Existing:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MAPS_API_KEY`, `PUBLIC_BASE_URL`.

Google Cloud (manual, one owner): enable Calendar API, Places API (New), Routes API, Geocoding API; OAuth consent
screen in **Testing** with the team as test users; a Web OAuth client with redirect URI
`{PUBLIC_BASE_URL}/api/google/callback` (localhost and the AWS HTTPS origin); one API key restricted to Places, Routes
and Geocoding.

## 7. Acceptance

- Connect → consent → back on Settings showing "Connected · email"; disconnect revokes and shows "Not connected".
- Revoking homie in the Google account page makes the next calendar call return 409 and Settings show "Not connected".
- A reminder for `2026-11-01T01:30` in `America/Los_Angeles` appears at 1:30 a.m. that day in Google Calendar.
- `upcoming_events`, `find_places`, `get_directions` each answer in < 500 ms server time on the deployed API (warm).
- Account deletion revokes the Google token before deleting the `GOOGLE` item.
