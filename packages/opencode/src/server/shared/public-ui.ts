// Static UI assets the browser fetches without app-managed credentials: the
// HTML document, its module scripts, CSS, fonts, images and manifest files. A
// phone on the LAN opens the share link (which carries ?auth_token=) and the
// browser then requests every /src/* and /assets/* dependency without that
// token, so these paths must bypass auth or the page 401s and the browser pops
// a Basic-auth dialog.
//
// Only the API surface requires credentials. The UI is a single-page app under
// the catch-all /* route, so its client-side routes (/session/..., /workbench,
// ...) are NOT enumerable — refreshing any of them must serve index.html
// without auth, otherwise a deep-link refresh on LAN pops the Basic dialog.
// Treat every non-API GET as public UI instead.
const API_PREFIXES = ["/api", "/global", "/event", "/pty-connect", "/control", "/doc"]

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false
  return true
}
