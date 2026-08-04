import { describe, expect, it } from "vitest";

import { shouldHandleAppNavigation, shouldPrecacheUrl } from "./route-policy";

const origin = "https://manager.example.test";

function navigation(url: string, overrides: Partial<{ method: string; mode: string }> = {}) {
  return { url, method: "GET", mode: "navigate", ...overrides };
}

describe("service-worker route policy", () => {
  it("handles only same-origin root-shell navigations", () => {
    expect(shouldHandleAppNavigation(navigation(`${origin}/`), origin)).toBe(true);
    expect(shouldHandleAppNavigation(navigation(`${origin}/?scope=wants-you`), origin)).toBe(true);
    expect(shouldHandleAppNavigation(navigation(`${origin}/?draft=1`), origin)).toBe(true);
    expect(shouldHandleAppNavigation(navigation(`${origin}/index.html`), origin)).toBe(true);

    expect(shouldHandleAppNavigation(navigation(`${origin}/sessions/unknown`), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/api/v1/sessions`), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/auth/bootstrap`), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/actions/run`), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/healthz`), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/events`), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/bundle.js.map`), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation("https://other.example.test/"), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/`, { method: "POST" }), origin)).toBe(false);
    expect(shouldHandleAppNavigation(navigation(`${origin}/`, { mode: "cors" }), origin)).toBe(false);
  });

  it("precaches only known, same-origin public shell assets", () => {
    expect(shouldPrecacheUrl("index.html", origin)).toBe(true);
    expect(shouldPrecacheUrl("assets/index-AbCd1234.js", origin)).toBe(true);
    expect(shouldPrecacheUrl("assets/index-AbCd1234.css", origin)).toBe(true);
    expect(shouldPrecacheUrl("manifest.webmanifest", origin)).toBe(true);
    expect(shouldPrecacheUrl("pwa-192x192.png", origin)).toBe(true);

    expect(shouldPrecacheUrl("api/v1/sessions.json", origin)).toBe(false);
    expect(shouldPrecacheUrl("auth/session.html", origin)).toBe(false);
    expect(shouldPrecacheUrl("assets/index-AbCd1234.js.map", origin)).toBe(false);
    expect(shouldPrecacheUrl("private-session.json", origin)).toBe(false);
    expect(shouldPrecacheUrl("assets/index-AbCd1234.js?token=secret", origin)).toBe(false);
    expect(shouldPrecacheUrl("https://other.example.test/index.html", origin)).toBe(false);
  });
});
