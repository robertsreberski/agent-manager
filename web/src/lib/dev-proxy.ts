import type { IncomingHttpHeaders } from "node:http";

export const DEV_WEB_ORIGIN = "http://127.0.0.1:43128";
export const DEV_BACKEND_ORIGIN = "http://127.0.0.1:43127";

export function rewriteDevProxyHeaders(
  proxyRequest: { setHeader(name: string, value: string): unknown },
  browserRequest: { headers: IncomingHttpHeaders },
): void {
  // The backend validates its fixed listener authority. Never derive this
  // header from browser-controlled Host or forwarded-host input.
  proxyRequest.setHeader("host", "127.0.0.1:43127");
  // Rewrite only the one origin served by this fixed dev server. Foreign
  // origins pass through unchanged so the backend can reject them.
  if (browserRequest.headers.origin === DEV_WEB_ORIGIN) {
    proxyRequest.setHeader("origin", DEV_BACKEND_ORIGIN);
  }
}
