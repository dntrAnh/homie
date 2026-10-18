# Mobile PWA testing

Results from Plan 1 Task 9a (issue #18). Record actual results, not assumed passes.

## Offline fallback and cache boundaries

Production build (`bun run build && bunx next start`), desktop Chrome via Playwright, 2026-10-18:

| Check | Result |
|---|---|
| `/manifest.webmanifest` served with `id: "/"`, standalone, 192/512 + maskable icons | ✅ pass |
| `/sw.js` served as JavaScript with `Cache-Control: no-cache, no-store, must-revalidate` | ✅ pass |
| Worker controls the page after one load | ✅ pass |
| Cache Storage holds only `homie-public-v1`: `/offline.html`, `/icons/icon-192.png` | ✅ pass |
| Offline navigation to `/memories` shows only the generic fallback (logo loads) | ✅ pass |
| Offline `/auth/callback?code=…` is not intercepted (browser network error, no state consumed) | ✅ pass |
| Online 404 is returned as-is, not replaced by the fallback | ✅ pass |

## Still to run (needs hosted HTTPS origin + real devices)

- [ ] Install + cold launch on iOS (Safari) and Android (Chrome); icons and splash look right
- [ ] Settings install help: install button on Chrome/Android, Add to Home Screen steps on iOS, hidden when installed, "Not now" sticks
- [ ] Offline banner appears/disappears in the app shell; writes fail with the offline message
- [ ] Second build with the same worker: a normal refresh loads the new app, no forced reload
- [ ] Bumping `CACHE` in `sw.js` removes the old `homie-public-*` cache after activation
- [ ] Installed-app auth spike → `docs/superpowers/spikes/mobile-pwa-auth.md`
