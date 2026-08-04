const APP_SHELL_PATHS = new Set(["/", "/index.html"]);
const SAFE_PRECACHE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".ico",
  ".js",
  ".png",
  ".svg",
  ".webmanifest",
  ".woff",
  ".woff2",
]);

interface NavigationRequestLike {
  url: string;
  method: string;
  mode: string;
}

function decodedPathname(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return null;
  }
}

function isSensitivePath(pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) return true;
  if (pathname.endsWith(".map")) return true;
  return /^\/(?:actions?|auth|events?|healthz|sse)(?:\/|$)/u.test(pathname);
}

/** Only root-shell document navigations are eligible for offline fallback. */
export function shouldHandleAppNavigation(
  request: NavigationRequestLike,
  appOrigin: string,
): boolean {
  if (request.method !== "GET" || request.mode !== "navigate") return false;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== appOrigin || url.username || url.password) return false;
  const pathname = decodedPathname(url);
  return pathname !== null
    && APP_SHELL_PATHS.has(pathname)
    && !isSensitivePath(pathname);
}

/** Defense in depth around Workbox's generated precache manifest. */
export function shouldPrecacheUrl(candidate: string, appOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate, `${appOrigin}/`);
  } catch {
    return false;
  }
  if (url.origin !== appOrigin || url.username || url.password || url.search) return false;
  const pathname = decodedPathname(url);
  if (pathname === null || isSensitivePath(pathname)) return false;
  const extensionStart = pathname.lastIndexOf(".");
  if (extensionStart < 0) return false;
  return SAFE_PRECACHE_EXTENSIONS.has(pathname.slice(extensionStart));
}
