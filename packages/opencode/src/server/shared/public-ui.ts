// Static UI assets the browser fetches without app-managed credentials: the
// HTML document, its module scripts, CSS, fonts, images and manifest files. A
// phone on the LAN opens the share link (which carries ?auth_token=) and the
// browser then requests every /src/* and /assets/* dependency without that
// token, so these paths must bypass auth or the page 401s and the browser pops
// a Basic-auth dialog. Only the API surface (mounted under /api, /global, /event,
// /pty-connect, ...) requires credentials; those prefixes are never treated as
// public here.
const PUBLIC_UI_PREFIXES = ["/src/", "/assets/", "/favicon", "/apple-touch-icon", "/social-share", "/sprite"]

export const PUBLIC_UI_PATHS = new Set<string>([
  "/",
  "/index.html",
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
  "/sw.js",
  "/oc-theme-preload.js",
])

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  return PUBLIC_UI_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
