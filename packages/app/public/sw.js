// Minimal passthrough service worker: satisfies the installability criteria
// (PWA "Add to home screen") without ever caching responses — the app is
// auth-protected and a cached 401 or stale HTML would break sessions. All
// requests hit the network; the SW only owns the lifecycle events.
self.addEventListener("install", (event) => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event) => {
  // Network-only passthrough. No caching, ever.
  return
})
