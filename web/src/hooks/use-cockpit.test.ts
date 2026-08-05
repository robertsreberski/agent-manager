import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, CockpitApi } from "../lib/api";
import { BrowserSessionError } from "../lib/auth";
import * as authModule from "../lib/auth";
import * as sseModule from "../lib/sse";
import type { ControlLease, HostOption, SessionView, StateEvent, WireStateSnapshot, WorkspaceOption } from "../types";
import { AGENT_MANAGER_BUILD_ID, WireUpgradeRequiredError, WIRE_SCHEMA_VERSION } from "../types";
import { acquireAutomaticLease, applyStateEvent, generateBrowserClientId, isStaleRequestRace, mutationsAreReady, releaseHeldSessionLease, releaseLeasesForPageExit, reloadForWireUpgrade, renewForegroundLease, resolveArchivedSelection, sensitiveBoundaryStatus, sessionNeedsForegroundLease, shouldRenewForegroundLease, useCockpit, WIRE_UPGRADE_RELOAD_STORAGE_KEY } from "./use-cockpit";

function lease(token: string, seconds = 300): ControlLease {
  return { token, clientId: "browser", expiresAt: new Date(Date.now() + seconds * 1_000).toISOString() };
}

const target = { id: "local:codex:one" } as SessionView;
const snapshot: WireStateSnapshot = { schemaVersion: WIRE_SCHEMA_VERSION, buildId: AGENT_MANAGER_BUILD_ID, generatedAt: "2026-08-04T12:00:00Z", seq: 3, stale: false, sessions: [], diagnostics: [] };

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

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
  it("preserves a deep link while the empty discovery snapshot is stale", async () => {
    window.history.replaceState(null, "", `/?session=${encodeURIComponent(target.id)}`);
    const staleSnapshot = { ...snapshot, seq: 4, stale: true };
    vi.spyOn(authModule, "establishBrowserSession").mockResolvedValue({ csrfToken: null, actor: null });
    vi.spyOn(sseModule, "connectCockpitEvents").mockReturnValue(() => undefined);
    vi.spyOn(CockpitApi.prototype, "sessions").mockResolvedValue(staleSnapshot);
    vi.spyOn(CockpitApi.prototype, "workspaces").mockResolvedValue([]);
    vi.spyOn(CockpitApi.prototype, "hosts").mockResolvedValue([]);
    const archivedSessions = vi.spyOn(CockpitApi.prototype, "archivedSessions").mockResolvedValue({
      sessions: [],
      nextCursor: null,
      total: 0,
      query: "",
    });
    const archivedSession = vi.spyOn(CockpitApi.prototype, "archivedSession").mockResolvedValue(null);

    const { result } = renderHook(() => useCockpit());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
      expect(result.current.snapshot).toMatchObject({ seq: 4, stale: true, sessions: [] });
      expect(archivedSessions).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(archivedSession).not.toHaveBeenCalled();
    expect(result.current.selectedId).toBe(target.id);
    expect(new URLSearchParams(window.location.search).get("session")).toBe(target.id);
  });

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
  it("renews only a held foreground lease near expiry without provider-specific takeover", async () => {
    const now = Date.parse("2026-08-05T10:00:00.000Z");
    const fresh = { token: "fresh", clientId: "browser", expiresAt: new Date(now + 30_000).toISOString() };
    const expiring = { token: "expiring", clientId: "browser", expiresAt: new Date(now + 10_000).toISOString() };
    expect(shouldRenewForegroundLease(fresh, now)).toBe(false);
    expect(shouldRenewForegroundLease(expiring, now)).toBe(true);
    expect(shouldRenewForegroundLease({ ...expiring, expiresAt: "not-a-date" }, now)).toBe(false);

    const renewed = { token: "renewed", clientId: "browser", expiresAt: new Date(now + 60_000).toISOString() };
    const acquireLease = vi.fn().mockResolvedValue(renewed);
    await expect(renewForegroundLease({ acquireLease }, target, "browser", expiring, now)).resolves.toBe(renewed);
    expect(acquireLease).toHaveBeenCalledWith(target.id, "browser", "expiring", 60, false);

    acquireLease.mockClear().mockResolvedValue(renewed);
    await renewForegroundLease({ acquireLease }, target, "browser", { ...expiring, expiresAt: new Date(now - 1).toISOString() }, now);
    expect(acquireLease).toHaveBeenCalledWith(target.id, "browser", undefined, 60, false);
  });

  it("keeps control-transition leases alive and never renews an archive", () => {
    const control = (capabilities: SessionView["control"]["capabilities"], archived = false) => ({
      archived,
      control: { capabilities },
    }) as Pick<SessionView, "archived" | "control">;

    expect(sessionNeedsForegroundLease(control(["take-control"]))).toBe(true);
    expect(sessionNeedsForegroundLease(control(["cancel-take-control"]))).toBe(true);
    expect(sessionNeedsForegroundLease(control(["retry-control"]))).toBe(true);
    expect(sessionNeedsForegroundLease(control(["open-editor"]))).toBe(false);
    expect(sessionNeedsForegroundLease(control(["queue"], true))).toBe(false);
  });

  it("waits for an in-flight acquisition before releasing the previous selection", async () => {
    let current: ControlLease | undefined = lease("rotated-from");
    const acquired = lease("late");
    // Selection cleanup cancels the renewal effect before it can remember its
    // rotated result, so the ref still contains the superseded token.
    const pending = Promise.resolve(acquired);
    const releaseLease = vi.fn(async () => undefined);
    const forgetLease = vi.fn(() => { current = undefined; });

    await releaseHeldSessionLease(
      { releaseLease },
      target.id,
      pending,
      () => current,
      forgetLease,
    );

    expect(forgetLease).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledWith(target.id, "late");
    expect(current).toBeUndefined();
  });

  it("preserves a lease if the session is reselected while release is settling", async () => {
    const current = lease("still-selected");
    const releaseLease = vi.fn(async () => undefined);
    const forgetLease = vi.fn();

    await releaseHeldSessionLease(
      { releaseLease },
      target.id,
      Promise.resolve(current),
      () => current,
      forgetLease,
      () => false,
    );

    expect(forgetLease).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });
});

describe("semantic web resume", () => {
  it("dispatches the exact resume action through the normal browser writer lease", async () => {
    const resumable = {
      id: "local:codex:ended",
      provider: "codex",
      providerThreadId: "ended",
      name: "Ended thread",
      hostId: "local",
      hostLabel: "This Mac",
      archived: false,
      status: "completed",
      generation: 7,
      providerTurnId: null,
      cwd: "/workspace",
      workspaceIdentity: null,
      attention: [],
      updatedAt: "2026-08-05T12:00:00.000Z",
      todoProgress: null,
      model: { value: "gpt-live" },
      effort: { value: "high" },
      profile: { value: "execute" },
      control: {
        plane: "resume-only",
        authority: "none",
        coordination: { mode: "shared", nativeAttach: "join", responseResolution: "first-response-wins" },
        recovery: null,
        capabilities: ["resume"],
        withheld: [],
        takeover: null,
      },
    } as unknown as SessionView;
    vi.spyOn(authModule, "establishBrowserSession").mockResolvedValue({ csrfToken: "csrf", actor: "browser" });
    vi.spyOn(CockpitApi.prototype, "sessions").mockResolvedValue({ ...snapshot, seq: 4, sessions: [resumable] });
    vi.spyOn(CockpitApi.prototype, "workspaces").mockResolvedValue([]);
    vi.spyOn(CockpitApi.prototype, "hosts").mockResolvedValue([]);
    vi.spyOn(CockpitApi.prototype, "archivedSessions").mockResolvedValue({ sessions: [], nextCursor: null, total: 0, query: "" });
    vi.spyOn(sseModule, "connectCockpitEvents").mockImplementation((options) => {
      options.onConnection("open");
      return () => undefined;
    });
    vi.spyOn(CockpitApi.prototype, "acquireLease").mockResolvedValue(lease("resume-writer", 60));
    const action = vi.spyOn(CockpitApi.prototype, "action").mockResolvedValue(undefined);

    const { result } = renderHook(() => useCockpit());
    await waitFor(() => expect(result.current.mutationsReady).toBe(true));

    await act(async () => {
      await result.current.resumeInWeb(resumable);
    });

    expect(action).toHaveBeenCalledWith(resumable.id, expect.objectContaining({
      type: "resume",
      expectedGeneration: 7,
      idempotencyKey: expect.any(String),
    }), "resume-writer");
  });
});

describe("remote host mutations", () => {
  const remoteHost: HostOption = {
    id: "build-host",
    label: "Build host",
    kind: "ssh",
    sshTarget: "dev@build.example",
    status: "online",
    statusMessage: null,
  };
  const remoteWorkspace: WorkspaceOption = {
    id: "workspace-build",
    label: "project",
    path: "/srv/project",
    hostId: remoteHost.id,
    hostLabel: remoteHost.label,
    hostKind: "ssh",
    temporary: false,
  };

  function mockConnectedCockpit(): void {
    vi.spyOn(authModule, "establishBrowserSession").mockResolvedValue({ csrfToken: "csrf", actor: "browser" });
    vi.spyOn(CockpitApi.prototype, "sessions").mockResolvedValue({ ...snapshot, seq: 4 });
    vi.spyOn(CockpitApi.prototype, "archivedSessions").mockResolvedValue({ sessions: [], nextCursor: null, total: 0, query: "" });
    vi.spyOn(sseModule, "connectCockpitEvents").mockImplementation((options) => {
      options.onConnection("open");
      return () => undefined;
    });
  }

  it("adds a host and immediately reloads host and workspace collections", async () => {
    mockConnectedCockpit();
    const hosts = vi.spyOn(CockpitApi.prototype, "hosts")
      .mockResolvedValueOnce([])
      .mockResolvedValue([remoteHost]);
    const workspaces = vi.spyOn(CockpitApi.prototype, "workspaces")
      .mockResolvedValueOnce([])
      .mockResolvedValue([remoteWorkspace]);
    const addHost = vi.spyOn(CockpitApi.prototype, "addHost").mockResolvedValue(remoteHost);

    const { result } = renderHook(() => useCockpit());
    await waitFor(() => {
      expect(result.current.mutationsReady).toBe(true);
      expect(hosts).toHaveBeenCalledOnce();
      expect(workspaces).toHaveBeenCalledOnce();
    });

    await act(async () => {
      await result.current.addHost("  Build host  ", "  dev@build.example  ");
    });

    expect(addHost).toHaveBeenCalledWith("Build host", "dev@build.example");
    expect(hosts).toHaveBeenCalledTimes(2);
    expect(workspaces).toHaveBeenCalledTimes(2);
    expect(result.current.hosts).toEqual([remoteHost]);
    expect(result.current.workspaces).toEqual([remoteWorkspace]);
    expect(result.current.notice).toBe("Build host was added.");
  });

  it("keeps removal pending and drops a removed host's workspaces before reconciliation", async () => {
    mockConnectedCockpit();
    vi.spyOn(CockpitApi.prototype, "hosts")
      .mockResolvedValueOnce([remoteHost])
      .mockResolvedValue([]);
    vi.spyOn(CockpitApi.prototype, "workspaces")
      .mockResolvedValueOnce([remoteWorkspace])
      .mockResolvedValue([]);
    let finishRemoval!: () => void;
    const removeHost = vi.spyOn(CockpitApi.prototype, "removeHost").mockImplementation(() => new Promise<void>((resolve) => {
      finishRemoval = resolve;
    }));

    const { result } = renderHook(() => useCockpit());
    await waitFor(() => {
      expect(result.current.mutationsReady).toBe(true);
      expect(result.current.hosts).toEqual([remoteHost]);
      expect(result.current.workspaces).toEqual([remoteWorkspace]);
    });

    let removal!: Promise<void>;
    act(() => {
      removal = result.current.removeHost(remoteHost.id);
    });
    await waitFor(() => expect(result.current.busy[`host:remove:${remoteHost.id}`]).toBe(true));
    act(() => finishRemoval());
    await act(async () => removal);

    expect(removeHost).toHaveBeenCalledWith(remoteHost.id);
    expect(result.current.busy[`host:remove:${remoteHost.id}`]).toBe(false);
    expect(result.current.hosts).toEqual([]);
    expect(result.current.workspaces).toEqual([]);
    expect(result.current.notice).toBe("Build host was removed from Agent Manager.");
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
