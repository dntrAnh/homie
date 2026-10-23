// Offline fallback only (spec §9). Caches nothing private: no app shell, API,
// auth, tokens or media. Bump CACHE when offline.html or its assets change.
const CACHE = "homie-public-v1"
const ASSETS = ["/offline.html", "/icons/icon-192.png"]
const BYPASS = /^\/(api|auth|mcp|\.well-known)(\/|$)/

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("homie-public-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  )
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode !== "navigate") {
    // Only the fallback page's own assets get an offline copy.
    if (ASSETS.includes(url.pathname))
      event.respondWith(fetch(request).catch(() => caches.match(request)))
    return
  }
  // Top-level page loads only. RSC fetches, API calls and callbacks pass through untouched.
  if (BYPASS.test(url.pathname)) return
  // Network errors only: real 401/403/500 responses are returned as-is.
  event.respondWith(fetch(request).catch(() => caches.match("/offline.html")))
})
