import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { BrowserSessionError } from "../lib/auth";
import type { ControlLease, SessionView, StateEvent, WireStateSnapshot } from "../types";
import { AGENT_MANAGER_BUILD_ID, WireUpgradeRequiredError, WIRE_SCHEMA_VERSION } from "../types";
import { acquireAutomaticLease, applyStateEvent, generateBrowserClientId, isStaleRequestRace, mutationsAreReady, releaseLeasesForPageExit, reloadForWireUpgrade, resolveArchivedSelection, sensitiveBoundaryStatus, WIRE_UPGRADE_RELOAD_STORAGE_KEY } from "./use-cockpit";

function lease(token: string, seconds = 300): ControlLease {
  return { token, clientId: "browser", expiresAt: new Date(Date.now() + seconds * 1_000).toISOString() };
}

const target = { id: "local:codex:one" } as SessionView;
const snapshot: WireStateSnapshot = { schemaVersion: WIRE_SCHEMA_VERSION, buildId: AGENT_MANAGER_BUILD_ID, generatedAt: "2026-08-04T12:00:00Z", seq: 3, stale: false, sessions: [], diagnostics: [] };

describe("strict event reconciliation", () => {
  it("ignores replay and applies opaque-id removal", () => {
    const replay = { schemaVersion: WIRE_SCHEMA_VERSION, buildId: AGENT_MANAGER_BUILD_ID, seq: 3, at: "2026-08-04T12:01:00Z", type: "session.remove", payload: { id: "opaque" } } satisfies StateEvent;
    expect(applyStateEvent(snapshot, replay)).toBe(snapshot);
    const current = { ...snapshot, sessions: [target] };
    const remove = { ...replay, seq: 4, payload: { id: target.id } } satisfies StateEvent;
    expect(applyStateEvent(current, remove).sessions).toEqual([]);
  });
  it("replaces diagnostics atomically", () => {
    const event = { schemaVersion: WIRE_SCHEMA_VERSION, buildId: AGENT_MANAGER_BUILD_ID, seq: 4, at: "2026-08-04T12:01:00Z", type: "diagnostic", payload: { stale: true, diagnostics: [{ provider: "system", level: "warning", message: "offline" }] } } satisfies StateEvent;
    expect(applyStateEvent(snapshot, event)).toMatchObject({ seq: 4, stale: true, diagnostics: event.payload.diagnostics });
  });
});

describe("active-to-archive selection handoff", () => {
  it("keeps the selection while the archive index catches up", async () => {
    const archived = { ...target, archived: true } as SessionView;
    const archivedSession = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(archived);
    await expect(resolveArchivedSelection({ archivedSession }, target.id, { attempts: 3, delayMs: 0 }))
      .resolves.toBe(archived);
    expect(archivedSession).toHaveBeenCalledTimes(2);
  });

  it("clears only after the bounded archive lookup remains absent", async () => {
    const archivedSession = vi.fn().mockResolvedValue(null);
    await expect(resolveArchivedSelection({ archivedSession }, target.id, { attempts: 3, delayMs: 0 }))
      .resolves.toBeNull();
    expect(archivedSession).toHaveBeenCalledTimes(3);
  });
});

describe("internal writer acquisition", () => {
  it("acquires one short writer token irrespective of profile", async () => {
    const acquired = lease("ready", 60);
    const acquireLease = vi.fn().mockResolvedValue(acquired);
    await expect(acquireAutomaticLease({ acquireLease }, target, "browser", undefined)).resolves.toBe(acquired);
    expect(acquireLease).toHaveBeenCalledWith(target.id, "browser", undefined, 60, false);
  });
  it("reuses a fresh token and takes over only explicitly", async () => {
    const current = lease("current", 60);
    const acquireLease = vi.fn();
    await expect(acquireAutomaticLease({ acquireLease }, target, "browser", current)).resolves.toBe(current);
    expect(acquireLease).not.toHaveBeenCalled();
    const expiring = lease("old", 1);
    acquireLease.mockResolvedValue(lease("new"));
    await acquireAutomaticLease({ acquireLease }, target, "browser", expiring, true);
    expect(acquireLease).toHaveBeenCalledWith(target.id, "browser", "old", 60, true);
  });
  it("releases every held writer best-effort with keepalive on page exit", () => {
    const releaseLease = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("page already closing"));
    const result = releaseLeasesForPageExit({ releaseLease }, {
      "local:codex:one": lease("one"),
      "local:claude:two": lease("two"),
    });

    expect(result).toBeUndefined();
    expect(releaseLease).toHaveBeenCalledTimes(2);
    expect(releaseLease).toHaveBeenNthCalledWith(1, "local:codex:one", "one", true);
    expect(releaseLease).toHaveBeenNthCalledWith(2, "local:claude:two", "two", true);
  });
});

describe("browser identity and connectivity", () => {
  it("generates a safe lease identity for this document without storage persistence", () => {
    expect(generateBrowserClientId()).toMatch(/^web-[A-Za-z0-9._:-]{4,124}$/u);
    expect(generateBrowserClientId()).not.toBe(generateBrowserClientId());
  });
  it("hard-reloads exactly once for the same wire mismatch", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); }),
    };
    const reload = vi.fn();
    const mismatch = new WireUpgradeRequiredError({ schemaVersion: 2, buildId: "old" });
    expect(reloadForWireUpgrade(mismatch, storage, reload)).toBe(true);
    expect(reloadForWireUpgrade(mismatch, storage, reload)).toBe(false);
    expect(storage.setItem).toHaveBeenCalledWith(WIRE_UPGRADE_RELOAD_STORAGE_KEY, expect.any(String));
    expect(reload).toHaveBeenCalledOnce();
  });
  it("permits writes only from a fresh authenticated stream", () => {
    expect(mutationsAreReady(true, "open", false, "online")).toBe(true);
    expect(mutationsAreReady(true, "retrying", false, "online")).toBe(false);
    expect(mutationsAreReady(true, "open", true, "online")).toBe(false);
  });
  it("recognizes only authentication as a sensitive boundary", () => {
    expect(sensitiveBoundaryStatus(new ApiError("expired", 401))).toBe(401);
    expect(sensitiveBoundaryStatus(new BrowserSessionError("expired", "unauthorized", 401))).toBe(401);
    expect(sensitiveBoundaryStatus(new ApiError("conflict", 409))).toBeNull();
  });
  it("recognizes only the exact stale-request first-winner race as quiet", () => {
    expect(isStaleRequestRace(new ApiError("already answered", 409, {
      error: { code: "REQUEST_STALE", message: "pending request is no longer active" },
    }))).toBe(true);
    expect(isStaleRequestRace(new ApiError("state changed", 409, {
      error: { code: "STALE_GENERATION", message: "refresh before retrying" },
    }))).toBe(false);
    expect(isStaleRequestRace(new Error("REQUEST_STALE"))).toBe(false);
  });
});
