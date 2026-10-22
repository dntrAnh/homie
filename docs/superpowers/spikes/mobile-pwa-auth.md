# Spike: Installed-app authentication on mobile

## Scope

Validate Cognito Hosted UI + PKCE in the installed Homie PWA on the team's iOS and Android devices. Browser-to-app sign-in transfer is not required; a fresh sign-in launched from the installed app is acceptable. Never record access tokens, callback query values, or private user data here.

## Test environment

- Frontend HTTPS origin: **Ephemeral Cloudflare Quick Tunnel origin in front of the local Docker stack; the personal tunnel URL is not recorded.** Used on 2026-10-21 because the team has no Cloudflare-managed domain yet; a named tunnel or hosted staging origin is still unassigned. Offline scenarios were additionally verified against the same production build at `http://localhost:3000` in desktop Chrome (service workers are permitted on localhost), after the tunnel was retired.
- API target: **Local FastAPI API through local Caddy** (Docker `phone-test` profile) for the device scenarios. No AWS HTTPS API is deployed yet — the Terraform provisions Cognito, DynamoDB, and S3 only, with no API endpoint. The same FastAPI was also run on the host against the **real AWS Cognito pool and DynamoDB table (`homie-dev`)** on 2026-10-21, where authenticated memory create/read/update passed and a test memory was persisted in the real table (verified by a direct DynamoDB `get-item`), so the AWS data plane is verified even though no AWS-hosted API endpoint exists.
- Test date: **2026-10-21.**
- Test owner: **Amelia Do**
- Device availability: **Verified** — iPhone with Safari (browser + installed PWA) and a MacBook Air with Chrome were available and used. **No Android device was available**; all Android scenarios remain not run.
- Overall status: **Partially verified; acceptance remains incomplete.** All iOS authentication scenarios passed on 2026-10-21. Android is unverified, the offline scenarios are verified only in desktop Chrome simulation (not yet on a device), and a stable named-tunnel/staging acceptance run is still outstanding.

## Results

| Scenario | iOS installed app | Android installed app | Expected result |
|---|---|---|---|
| Install from browser | Pass — installed from Safari via Share → Add to Home Screen; app opens in standalone mode from the home-screen icon. | Not run — no Android device available. | Correct name/icon; opens in standalone mode. |
| Cold launch after successful sign-in | Pass — relaunching the installed app restored the installed-app session; no redirect loop. | Not run | Existing valid session is restored and the app opens without a redirect loop. |
| Fresh sign-in started from installed app | Pass — the first launch of the installed app required a fresh sign-in inside the app (the browser session did not transfer); Cognito Hosted UI sign-in completed and landed in a usable app state, and that session is the one later cold launches restored. | Not run | Cognito Hosted UI returns through the PKCE callback to usable installed app state. |
| OAuth callback/state handling | Pass — the PKCE callback completed inside the installed app; no tokens appear in the callback URL (authorization code flow), and no API responses, tokens, or OAuth callbacks are cached by the service worker. | Not run | Callback completes in the installed app; no tokens are placed in URLs or service-worker messages. |
| Sign out | Pass — sign out from Settings cleared the local session and Cognito returned to the allowed frontend origin, signed out. | Not run | Local session/query state is cleared and Cognito returns to the allowed HTTPS origin. |
| Expired session | Pass (simulated) — no screen calls the API yet, so a genuine in-app 401 cannot occur; the client's `homie:session-expired` event was dispatched manually in desktop Chrome, the session-expired notice appeared, and its Sign in action reauthenticated successfully with no redirect loop. The API itself returns real 401s (verified: unauthenticated `GET /api/memories` through the tunnel/Caddy returned 401 and was logged server-side). A genuine token expiry was not waited out. | Not run | Reauthentication is offered without a redirect loop or loss of unsaved work. |
| Offline launch after online visit | Verified in simulation — in desktop Chrome DevTools (Offline) against the same production build at `http://localhost:3000`, with the service worker registered, navigating to `/memories` served the generic offline fallback page ("You're offline — your private information isn't available offline") with no private data. Not yet run on the iPhone itself; the tunnel origin had been retired before this check. | Not run | Only the generic offline fallback appears; no private memory data is available. |
| Reconnect and retry | Verified in simulation — after re-enabling the network in DevTools, the fallback page's **Try again** action reloaded the online app on `/memories` with the session intact and no redirect loop. On-device rerun still pending (see above). | Not run | Retry loads the online app and authenticated requests work after session validation. |
| Background and resume | Pass — the session remained usable across refresh and across a full close + reopen of the installed app (a stronger condition than backgrounding); brief background/resume without closing was not isolated as a separate step. | Not run | Session remains usable or reauthentication is handled safely. |

## Blockers and follow-up

- A stable HTTPS frontend/API origin is still unassigned: the 2026-10-21 run used an ephemeral quick tunnel because no team member has a Cloudflare-managed domain. Assign a named tunnel or the hosted staging origin and repeat acceptance there; the quick-tunnel results above are a demo workaround, not named-tunnel/hosted acceptance.
- Run the full matrix on an Android phone when a device is available. If iOS installation or authentication fails in Chrome, reproduce in Safari (this run used Safari on iOS, per the install requirements).
- Re-run "Offline launch" and "Reconnect and retry" on the iPhone installed app against the next HTTPS origin (they are currently verified only in desktop Chrome simulation).
- Re-run "Expired session" end-to-end once a screen actually calls the API, so a genuine API 401 (not a dispatched event) drives the session-expired notice.
- Results of the same run are also recorded in [docs/mobile-pwa-testing.md](../../mobile-pwa-testing.md). Do not record credentials or token values.
