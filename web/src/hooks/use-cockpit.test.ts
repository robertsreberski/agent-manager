import { describe, expect, it, vi } from "vitest";

import { normalizeSession } from "../lib/normalize";
import type { ControlLease } from "../types";
import {
  acquireLeaseInStages,
  autoAcquireCreatedSession,
  BROWSER_CLIENT_ID_STORAGE_KEY,
  getOrCreateBrowserClientId,
} from "./use-cockpit";

function lease(token: string, seconds = 300): ControlLease {
  return {
    token,
    clientId: "browser",
    expiresAt: new Date(Date.now() + seconds * 1_000).toISOString(),
    fullHostArmedUntil: null,
  };
}

function session(fullHostAccess: boolean) {
  return normalizeSession({
    id: fullHostAccess ? "codex:full" : "codex:standard",
    provider: "codex",
    effectiveAccess: { fullHostAccess },
  });
}

describe("acquireLeaseInStages", () => {
  it.each([
    [false, false],
    [true, true],
  ] as const)(
    "retains a 30-second seed before the 300-second renew/arm (fullHost=%s)",
    async (fullHost, finalArm) => {
      const seed = lease("seed", 30);
      const final = lease("rotated", 300);
      const acquireLease = vi.fn()
        .mockResolvedValueOnce(seed)
        .mockResolvedValueOnce(final);
      const retained: ControlLease[] = [];

      await expect(acquireLeaseInStages(
        { acquireLease },
        session(fullHost),
        "browser",
        undefined,
        (value) => retained.push(value),
      )).resolves.toBe(final);

      expect(acquireLease.mock.calls).toEqual([
        [fullHost ? "codex:full" : "codex:standard", "browser", false, undefined, 30],
        [fullHost ? "codex:full" : "codex:standard", "browser", finalArm, "seed", 300],
      ]);
      expect(retained).toEqual([seed]);
    },
  );

  it("retries the rotating step with the retained seed after an ambiguous failure", async () => {
    const seed = lease("seed", 30);
    const acquireLease = vi.fn().mockResolvedValue(lease("recovered"));

    await acquireLeaseInStages(
      { acquireLease },
      session(false),
      "browser",
      seed,
      () => undefined,
    );

    expect(acquireLease).toHaveBeenCalledOnce();
    expect(acquireLease).toHaveBeenCalledWith(
      "codex:standard",
      "browser",
      false,
      "seed",
      300,
    );
  });
});

describe("autoAcquireCreatedSession", () => {
  it("acquires control immediately for a standard managed session", async () => {
    const acquire = vi.fn().mockResolvedValue(lease("ready"));
    const created = session(false);

    await expect(autoAcquireCreatedSession(
      { permissionPreset: "standard" },
      created,
      acquire,
    )).resolves.toBe(true);

    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledWith(created);
  });

  it.each([
    ["full-host" as const, false],
    ["standard" as const, true],
  ])("requires explicit control when preset=%s", async (permissionPreset, fullHost) => {
    const acquire = vi.fn();

    await expect(autoAcquireCreatedSession(
      { permissionPreset },
      session(fullHost),
      acquire,
    )).resolves.toBe(false);

    expect(acquire).not.toHaveBeenCalled();
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
