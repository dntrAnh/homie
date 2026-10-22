# Mobile and PWA testing

## Deployed test environments

- Frontend (Next.js HTTPS URL): **Not recorded yet — fill in when deployment is assigned.**
- API (AWS HTTPS URL): **Not recorded yet — fill in when deployment is assigned.**
- Deployment owner: **Not assigned.**

For final hosted acceptance, use the deployed Next.js frontend and AWS HTTPS API. A named Cloudflare Tunnel can also expose the local Docker stack over a stable HTTPS origin for phone testing before deployment; it terminates at local Caddy, which routes the frontend and API paths. Do not use a quick tunnel or commit a personal tunnel URL or token.

### Local phone-test tunnel setup

1. Copy `infra/.env.example` to `infra/.env`. Set the named tunnel token, stable HTTPS origin in `NEXT_PUBLIC_API_URL`, and Cognito values from Terraform. The hostname must match the public hostname configured for the named tunnel.
2. Configure the named tunnel's public hostname to forward to `http://caddy:80` on the Docker network. Caddy routes `/api/*`, `/mcp`, and `/health` to FastAPI, and other requests to Next.js.
3. Add the exact HTTPS origin (without a trailing slash) to Terraform `dashboard_urls` using `infra/terraform/phone-test.tfvars.example` as a template, then apply Terraform. This enables Cognito callback/logout URLs and S3 CORS. Add it to server `CORS_ORIGINS` as well.
4. Start the stack with the `phone-test` Compose profile and `infra/.env`. Keep secrets in the local env file only. For local desktop development, keep the default API URL at `http://localhost:8000`.

The phone-test origin is deliberately a placeholder until a domain and tunnel are assigned. Do not apply the example tfvars unchanged. For hosted testing, set `NEXT_PUBLIC_API_URL` to the AWS API's HTTPS base URL instead, and allow the deployed frontend origin in Terraform `dashboard_urls`, server `CORS_ORIGINS`, and S3 CORS where browser uploads are enabled. Set server `PUBLIC_BASE_URL` to the AWS API origin when Google OAuth is configured.

## Device checks

Use Chrome as the primary browser on the team's available phones. Exact device, OS, or browser version inventory is not required. If an iPhone-specific install or sign-in issue occurs in Chrome, reproduce it in Safari.

1. Open the selected named-tunnel or deployed frontend URL over HTTPS and confirm it loads without certificate warnings.
2. Sign in through Cognito Hosted UI and verify the callback returns to `/memories`.
3. Refresh and verify the signed-in session remains available.
4. Install from the browser and launch from the home screen; verify the standalone shell and start URL.
5. Verify mobile tabs, safe-area spacing, keyboard access, and no page-level horizontal scrolling.
6. Exercise API-backed UI flows and confirm requests reach the local API through Caddy (tunnel run) or the AWS API (hosted run).
7. Trigger or simulate an API 401 and confirm the session-expired notice offers reauthentication.
8. Sign out and verify Cognito returns the browser to the allowed frontend origin.

## PWA: offline fallback and cache boundaries

Results from Plan 1 Task 9a (issue #18). Record actual results, not assumed passes.

Production build (`bun run build && bunx next start`), desktop Chrome via Playwright, 2026-10-18:

| Check                                                                                         | Result  |
| --------------------------------------------------------------------------------------------- | ------- |
| `/manifest.webmanifest` served with `id: "/"`, standalone, 192/512 + maskable icons           | ✅ pass |
| `/sw.js` served as JavaScript with `Cache-Control: no-cache, no-store, must-revalidate`       | ✅ pass |
| Worker controls the page after one load                                                       | ✅ pass |
| Cache Storage holds only `homie-public-v1`: `/offline.html`, `/icons/icon-192.png`            | ✅ pass |
| Offline navigation to `/memories` shows only the generic fallback (logo loads)                | ✅ pass |
| Offline `/auth/callback?code=…` is not intercepted (browser network error, no state consumed) | ✅ pass |
| Online 404 is returned as-is, not replaced by the fallback                                    | ✅ pass |

## PWA: still to run (needs hosted HTTPS origin + real devices)

- [ ] Install + cold launch on iOS (Safari) and Android (Chrome); icons and splash look right. iOS install/auth passed on the #50 build (see Results); re-check icons with this build's manifest. Android not run.
- [ ] Settings install help: install button on Chrome/Android, Add to Home Screen steps on iOS, hidden when installed, "Not now" sticks
- [ ] Offline banner appears/disappears in the app shell; writes fail with the offline message
- [ ] Second build with the same worker: a normal refresh loads the new app, no forced reload
- [ ] Bumping `CACHE` in `sw.js` removes the old `homie-public-*` cache after activation
- [ ] Installed-app auth spike → `docs/superpowers/spikes/mobile-pwa-auth.md`. iOS passed 2026-10-21; Android not run.
- [ ] Offline launch + reconnect on a device with this build's `sw.js` (the 2026-10-21 run covered only #50's worker, in desktop Chrome)
- [ ] API-backed flow and a real API 401 driving the session-expired notice (not exercised on 2026-10-21)

## Results

Record the actual test origin, API target (local or AWS), deployment/tunnel owner, test date, pass/fail results, and blockers after device checks. Do not record credentials, access tokens, or private user data. No device acceptance results are claimed until these checks have actually been run.

### Run — 2026-10-21 (PR #50 build)

Run on #50's build, before it was folded into this PWA implementation. Checks 1–5 and 8 exercise the shared Cognito/PKCE auth and install flow. The offline/reconnect results ran against #50's service worker, not `public/sw.js` here, so they are re-listed under "PWA: still to run". On that build Memories was a placeholder, which is why check 6 was not exercised, and its shell had two tabs, not five. Re-check 5 and 6 on this build.

- Test origin: local Docker stack (Next.js + FastAPI behind Caddy, `phone-test` profile) exposed over an ephemeral Cloudflare Quick Tunnel; the personal tunnel URL is not recorded, per the rule above. A quick tunnel was used as a demo workaround because the team has no Cloudflare-managed domain yet, so this run is **not** named-tunnel or hosted acceptance.
- API target: local (FastAPI through local Caddy) for the device checks; real AWS services (Cognito pool + DynamoDB table `homie-dev`) for the data-plane verification in the additional checks below.
- Tunnel/deployment owner: @dntrAnh.
- Test date: 2026-10-21.
- Devices/browsers: iPhone + Safari (browser and installed PWA); MacBook Air + Chrome (localhost sign-in, console-simulated 401, and DevTools offline simulation). No Android device was available.

Results:

1. HTTPS load without certificate warnings — **Pass.**
2. Cognito Hosted UI sign-in; callback returns to `/memories` — **Pass** (iPhone/Safari and MacBook/Chrome). A fresh sign-in was also completed inside the installed app, and that session is the one later launches restored.
3. Session remains after refresh, and after a full close + reopen — **Pass.**
4. Install from the browser; home-screen launch in standalone mode with the correct start URL — **Pass.** The installed app retained its session on relaunch.
5. Mobile tabs, safe-area spacing, no page-level horizontal scrolling — **Pass.** Keyboard access: not applicable in the current UI (no text inputs on the available screens).
6. API-backed UI flow — **Not exercised through the UI:** the Memories screen is currently a static placeholder and made no API request (confirmed in source and by the absence of API requests in the server log). The API path itself was verified directly instead: unauthenticated `GET /api/memories` through the tunnel and Caddy returned `401 Unauthorized` and appeared in the server log.
7. API 401 session-expired notice — **Pass (simulated).** The client's session-expired event was dispatched manually; the notice appeared and its Sign in action reauthenticated successfully. A genuine in-app 401 cannot occur until a screen calls the API (see check 6).
8. Sign out; Cognito returns to the allowed frontend origin — **Pass.**

Additional checks (from issue #18, verified the same day against the same production build at `http://localhost:3000` in desktop Chrome, after the tunnel was retired):

- Offline fallback — **Pass in simulation.** With the service worker registered and DevTools set to Offline, navigating to `/memories` served the generic offline fallback page; no private memory data was shown. `GET /sw.js`, `/manifest.webmanifest`, and `/offline.html` all returned 200 from the running build.
- Reconnect and retry — **Pass in simulation.** After re-enabling the network, the fallback page's Try again action reloaded the online app with the session intact.
- Real AWS data plane — **Pass.** With the same FastAPI run on the host pointed at the real DynamoDB table (no local endpoint override) and a real Cognito access token: a no-token request returned 401; `POST /api/memories` created a memory; list and get-by-id returned it; `PATCH` updated its tags; and a direct `aws dynamodb get-item` (bypassing the API) read the raw record from `homie-dev`. The memory was intentionally left in the table, and the API-wired Memories page rendered it in the app.

Blockers and follow-up:

- Named-tunnel or hosted acceptance is still outstanding; assign a team domain (Cloudflare-managed DNS) or a deployed frontend/API origin and repeat acceptance there.
- Android device checks have not been run (no device available).
- Re-run checks 6–7 end-to-end once a UI screen actually calls the API.
- Re-run the offline and reconnect checks on the iPhone installed app against the next HTTPS origin (currently verified only in desktop Chrome simulation).
- Detailed installed-app authentication results are recorded in [docs/superpowers/spikes/mobile-pwa-auth.md](superpowers/spikes/mobile-pwa-auth.md).
