import { describe, expect, it, vi } from "vitest";

import { normalizeSession } from "../lib/normalize";
import type { ControlLease } from "../types";
import {
  acquireAutomaticLease,
  BROWSER_CLIENT_ID_STORAGE_KEY,
  getOrCreateBrowserClientId,
  mutationsAreReady,
  sensitiveBoundaryStatus,
} from "./use-cockpit";
import { ApiError } from "../lib/api";
import { BrowserSessionError } from "../lib/auth";

function lease(token: string, seconds = 300): ControlLease {
  return {
    token,
    clientId: "browser",
    expiresAt: new Date(Date.now() + seconds * 1_000).toISOString(),
  };
}

function session(accessMode: "sandboxed" | "bypass-permissions" = "sandboxed") {
  return normalizeSession({
    id: accessMode === "bypass-permissions" ? "codex:bypass" : "codex:sandboxed",
    provider: "codex",
    effectiveAccess: { accessMode },
  });
}

describe("acquireAutomaticLease", () => {
  it.each(["sandboxed", "bypass-permissions"] as const)(
    "acquires the same short background lease for %s sessions",
    async (accessMode) => {
      const acquired = lease("ready", 60);
      const acquireLease = vi.fn().mockResolvedValue(acquired);
      const target = session(accessMode);

      await expect(acquireAutomaticLease(
        { acquireLease },
        target,
        "browser",
        undefined,
      )).resolves.toBe(acquired);

      expect(acquireLease).toHaveBeenCalledWith(target.id, "browser", undefined, 60, false);
    },
  );

  it("reuses a fresh lease without surfacing renewal UI", async () => {
    const current = lease("current", 60);
    const acquireLease = vi.fn();
    await expect(acquireAutomaticLease(
      { acquireLease },
      session(),
      "browser",
      current,
    )).resolves.toBe(current);
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("uses an explicit takeover only after the user resolves a browser conflict", async () => {
    const current = lease("current", 1);
    const acquireLease = vi.fn().mockResolvedValue(lease("taken-over"));
    await acquireAutomaticLease({ acquireLease }, session(), "browser", current, true);
    expect(acquireLease).toHaveBeenCalledWith(
      "codex:sandboxed",
      "browser",
      "current",
      60,
      true,
    );
  });
});

describe("getOrCreateBrowserClientId", () => {
  it("reuses a valid ID from this tab's session storage", () => {
    const stored = "web-12345678-1234-1234-1234-123456789abc";
    const storage = {
      getItem: vi.fn().mockReturnValue(stored),
      setItem: vi.fn(),
    };
    const generate = vi.fn().mockReturnValue("web-unused-value");

    expect(getOrCreateBrowserClientId(storage, generate)).toBe(stored);
    expect(storage.getItem).toHaveBeenCalledWith(BROWSER_CLIENT_ID_STORAGE_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("replaces an invalid stored value with a safe generated ID", () => {
    const storage = {
      getItem: vi.fn().mockReturnValue("web-unsafe?client=collision"),
      setItem: vi.fn(),
    };

    expect(getOrCreateBrowserClientId(storage, () => "web-safe-tab-1234")).toBe("web-safe-tab-1234");
    expect(storage.setItem).toHaveBeenCalledWith(
      BROWSER_CLIENT_ID_STORAGE_KEY,
      "web-safe-tab-1234",
    );
  });

  it("falls back to a page-lifetime ID when storage access throws", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new DOMException("blocked", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("blocked", "SecurityError");
      }),
    };

    expect(getOrCreateBrowserClientId(storage, () => "web-memory-only-1234")).toBe(
      "web-memory-only-1234",
    );
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it("keeps independently scoped tab stores independent", () => {
    const firstValues = new Map<string, string>();
    const secondValues = new Map<string, string>();
    const firstStorage = {
      getItem: (key: string) => firstValues.get(key) ?? null,
      setItem: (key: string, value: string) => firstValues.set(key, value),
    };
    const secondStorage = {
      getItem: (key: string) => secondValues.get(key) ?? null,
      setItem: (key: string, value: string) => secondValues.set(key, value),
    };

    expect(getOrCreateBrowserClientId(firstStorage, () => "web-first-tab-1234")).toBe(
      "web-first-tab-1234",
    );
    expect(getOrCreateBrowserClientId(secondStorage, () => "web-second-tab-1234")).toBe(
      "web-second-tab-1234",
    );
  });
});

describe("cockpit connectivity guards", () => {
  it("allows mutations only with an authenticated, open, authoritative snapshot", () => {
    expect(mutationsAreReady(true, "open", false, "online")).toBe(true);
    expect(mutationsAreReady(true, "retrying", false, "online")).toBe(false);
    expect(mutationsAreReady(true, "open", true, "online")).toBe(false);
    expect(mutationsAreReady(false, "open", false, "online")).toBe(false);
    expect(mutationsAreReady(true, "open", false, "offline")).toBe(false);
  });

  it("recognizes API and browser-session privacy boundaries", () => {
    expect(sensitiveBoundaryStatus(new ApiError("expired", 401))).toBe(401);
    expect(sensitiveBoundaryStatus(new BrowserSessionError("locked", "locked", 423))).toBe(423);
    expect(sensitiveBoundaryStatus(new ApiError("conflict", 409))).toBeNull();
    expect(sensitiveBoundaryStatus(new TypeError("offline"))).toBeNull();
  });

});
