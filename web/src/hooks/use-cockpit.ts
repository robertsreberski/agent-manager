import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, CockpitApi } from "../lib/api";
import { BrowserSessionError, establishBrowserSession } from "../lib/auth";
import { connectCockpitEvents, type CockpitEvent } from "../lib/sse";
import {
  reconcileSelectedSessionId,
  searchWithSelectedSession,
  searchWithSessionScope,
  sessionMatchesScope,
  sessionScopeFromSearch,
  type SessionScope,
} from "../lib/session-navigation";
import { SessionStateGuard } from "../lib/session-state";
import { idempotencyKey } from "../lib/utils";
import type {
  AttachInstruction,
  AuthSession,
  ConnectionState,
  ControlLease,
  CreateSessionInput,
  Diagnostic,
  HostOption,
  LaunchSessionInput,
  PanePreview,
  SessionView,
  SessionsSnapshot,
  RequestResponse,
  WorkspaceOption,
} from "../types";

const EMPTY_SNAPSHOT: SessionsSnapshot = {
  sessions: [],
  diagnostics: [],
  generatedAt: null,
  seq: null,
  stale: false,
};

export type CockpitAvailability =
  | "connecting"
  | "online"
  | "offline"
  | "locked"
  | "auth-required"
  | "error";

export function mutationsAreReady(
  authenticated: boolean,
  connection: ConnectionState,
  stale: boolean,
  availability: CockpitAvailability,
): boolean {
  return authenticated && connection === "open" && !stale && availability === "online";
}

export function sensitiveBoundaryStatus(error: unknown): 401 | 423 | null {
  if (error instanceof ApiError && (error.status === 401 || error.status === 423)) {
    return error.status;
  }
  if (error instanceof BrowserSessionError && (error.status === 401 || error.status === 423)) {
    return error.status;
  }
  return null;
}

function staleSnapshot(value: SessionsSnapshot): SessionsSnapshot {
  return value.stale ? value : { ...value, stale: true };
}

export const BROWSER_CLIENT_ID_STORAGE_KEY = "agent-manager.browser-client-id.v1";
const SAFE_BROWSER_CLIENT_ID = /^web-[A-Za-z0-9._:-]{4,124}$/;

type SessionStorageLike = Pick<Storage, "getItem" | "setItem">;

function generateBrowserClientId(): string {
  const entropy = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  return `web-${entropy}`;
}

export function getOrCreateBrowserClientId(
  storage: SessionStorageLike | null,
  generate: () => string = generateBrowserClientId,
): string {
  try {
    const stored = storage?.getItem(BROWSER_CLIENT_ID_STORAGE_KEY);
    if (stored && SAFE_BROWSER_CLIENT_ID.test(stored) && stored.length <= 128) {
      return stored;
    }
  } catch {
    // Privacy settings can make even reading sessionStorage throw.
  }

  const generated = generate();
  const clientId = SAFE_BROWSER_CLIENT_ID.test(generated) && generated.length <= 128
    ? generated
    : generateBrowserClientId();
  try {
    storage?.setItem(BROWSER_CLIENT_ID_STORAGE_KEY, clientId);
  } catch {
    // A stable in-memory ID is still safe for this page lifetime.
  }
  return clientId;
}

function currentTabStorage(): SessionStorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// sessionStorage survives navigation/reload within one tab while remaining
// partitioned from independently opened tabs.
export const BROWSER_CLIENT_ID = getOrCreateBrowserClientId(currentTabStorage());

function payloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sortSessions(sessions: SessionView[]): SessionView[] {
  const activityWeight = { waiting: 0, running: 1, idle: 2, unknown: 3, interrupted: 4, failed: 5, completed: 6 };
  return [...sessions].sort((left, right) => {
    if (left.attention.length !== right.attention.length) return right.attention.length - left.attention.length;
    const activityDelta = activityWeight[left.activity] - activityWeight[right.activity];
    if (activityDelta !== 0) return activityDelta;
    return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  });
}

function replaceNavigationUrl(search: string): void {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search}${window.location.hash}`,
  );
}

function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  const envelope = error.body as Record<string, unknown>;
  const nested = envelope.error && typeof envelope.error === "object"
    ? envelope.error as Record<string, unknown>
    : envelope;
  return typeof nested.code === "string" ? nested.code : null;
}

function leaseConflictExpiry(error: unknown): string | null | undefined {
  if (apiErrorCode(error) !== "LEASE_CONFLICT") return undefined;
  const body = error instanceof ApiError && error.body && typeof error.body === "object"
    ? error.body as Record<string, unknown>
    : {};
  const nested = body.error && typeof body.error === "object"
    ? body.error as Record<string, unknown>
    : body;
  const details = nested.details && typeof nested.details === "object"
    ? nested.details as Record<string, unknown>
    : {};
  return typeof details.expiresAt === "string" ? details.expiresAt : null;
}

export async function acquireAutomaticLease(
  api: Pick<CockpitApi, "acquireLease">,
  session: SessionView,
  clientId: string,
  current: ControlLease | undefined,
  takeover = false,
): Promise<ControlLease> {
  if (
    !takeover
    && current
    && new Date(current.expiresAt).getTime() > Date.now() + 5_000
  ) {
    return current;
  }
  const currentToken = current && new Date(current.expiresAt).getTime() > Date.now()
    ? current.token
    : undefined;
  return api.acquireLease(session.id, clientId, currentToken, 60, takeover);
}

export function useCockpit() {
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<CockpitAvailability>("connecting");
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [hasSuccessfulSnapshot, setHasSuccessfulSnapshot] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [hosts, setHosts] = useState<HostOption[]>([]);
  const [scope, setScopeState] = useState<SessionScope>(() => (
    sessionScopeFromSearch(window.location.search)
  ));
  const [selectedId, setSelectedIdState] = useState<string | null>(() => {
    return new URLSearchParams(window.location.search).get("session");
  });
  const [leases, setLeases] = useState<Record<string, ControlLease>>({});
  const [controlConflicts, setControlConflicts] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const api = useMemo(() => (auth ? new CockpitApi(auth) : null), [auth]);
  const apiRef = useRef(api);
  apiRef.current = api;
  const snapshotRef = useRef<SessionsSnapshot>(EMPTY_SNAPSHOT);
  const leasesRef = useRef<Record<string, ControlLease>>({});
  const leaseOperationsRef = useRef(new Map<string, Promise<ControlLease>>());
  const stateGuardRef = useRef(new SessionStateGuard());
  const recoveryRef = useRef<Promise<boolean> | null>(null);

  const commitSnapshot = useCallback((next: SessionsSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    replaceNavigationUrl(searchWithSelectedSession(window.location.search, id));
  }, []);

  const setScopeAndSelectedId = useCallback((nextScope: SessionScope, id: string | null) => {
    setScopeState(nextScope);
    setSelectedIdState(id);
    const scopedSearch = searchWithSessionScope(window.location.search, nextScope);
    replaceNavigationUrl(searchWithSelectedSession(scopedSearch, id));
  }, []);

  const clearSensitiveState = useCallback(() => {
    commitSnapshot(EMPTY_SNAPSHOT);
    stateGuardRef.current = new SessionStateGuard();
    setWorkspaces([]);
    setHosts([]);
    setLeases({});
    leasesRef.current = {};
    leaseOperationsRef.current.clear();
    setControlConflicts({});
    setBusy({});
    setNotice(null);
    setActionError(null);
    setHasSuccessfulSnapshot(false);
    setSelectedId(null);
  }, [commitSnapshot, setSelectedId]);

  const markDisconnected = useCallback(() => {
    if (snapshotRef.current.sessions.length > 0) {
      commitSnapshot(staleSnapshot(snapshotRef.current));
    }
  }, [commitSnapshot]);

  const handleFailure = useCallback((error: unknown): boolean => {
    const boundary = sensitiveBoundaryStatus(error);
    if (boundary !== null) {
      clearSensitiveState();
      setAuth(null);
      setConnection("offline");
      setAvailability(boundary === 423 ? "locked" : "auth-required");
      setAuthError(error instanceof Error ? error.message : "This browser session is no longer valid.");
      return true;
    }
    if (
      (error instanceof BrowserSessionError && error.kind === "offline")
      || error instanceof TypeError
      || (typeof navigator !== "undefined" && navigator.onLine === false)
    ) {
      markDisconnected();
      setConnection("offline");
      setAvailability("offline");
      setAuthError(null);
      return true;
    }
    return false;
  }, [clearSensitiveState, markDisconnected]);

  const recoverBrowserSession = useCallback((): Promise<boolean> => {
    if (recoveryRef.current) return recoveryRef.current;
    const recovery = establishBrowserSession()
      .then((session) => {
        setAuth(session);
        setAuthError(null);
        setAvailability("online");
        return true;
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) {
          setAvailability("error");
          setAuthError(error instanceof Error ? error.message : "Authentication failed.");
        }
        return false;
      })
      .finally(() => {
        recoveryRef.current = null;
      });
    recoveryRef.current = recovery;
    return recovery;
  }, [handleFailure]);

  const refresh = useCallback(async () => {
    if (!apiRef.current) return;
    const request = stateGuardRef.current.beginRequest();
    try {
      const next = await apiRef.current.sessions();
      commitSnapshot(stateGuardRef.current.applyRestSnapshot(snapshotRef.current, next, request));
      setHasSuccessfulSnapshot(true);
    } catch (error) {
      handleFailure(error);
      throw error;
    }
  }, [commitSnapshot, handleFailure]);

  useEffect(() => {
    void recoverBrowserSession();
  }, [recoverBrowserSession]);

  useEffect(() => {
    const syncNavigation = () => {
      const params = new URLSearchParams(window.location.search);
      setScopeState(sessionScopeFromSearch(window.location.search));
      setSelectedIdState(params.get("session"));
    };
    window.addEventListener("popstate", syncNavigation);
    return () => window.removeEventListener("popstate", syncNavigation);
  }, []);

  useEffect(() => {
    const onOffline = () => {
      markDisconnected();
      setConnection("offline");
      setAvailability("offline");
    };
    const onResume = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) {
        void recoverBrowserSession();
      }
    };
    window.addEventListener("online", onResume);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      window.removeEventListener("online", onResume);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [markDisconnected, recoverBrowserSession]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const sessionsRequest = stateGuardRef.current.beginRequest();
    void Promise.all([
      api.sessions(),
      api.workspaces().catch(() => [] as WorkspaceOption[]),
      api.hosts().catch(() => [] as HostOption[]),
    ])
      .then(([nextSnapshot, nextWorkspaces, nextHosts]) => {
        if (cancelled) return;
        commitSnapshot(stateGuardRef.current.applyRestSnapshot(
          snapshotRef.current,
          nextSnapshot,
          sessionsRequest,
        ));
        setHasSuccessfulSnapshot(true);
        setWorkspaces(nextWorkspaces);
        setHosts(nextHosts);
        setAvailability("online");
        setAuthError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (!handleFailure(error)) {
          setAvailability("error");
          setAuthError(error instanceof Error ? error.message : "Could not load local sessions.");
        }
      });

    function onEvent(event: CockpitEvent) {
      const applied = stateGuardRef.current.applyEvent(snapshotRef.current, event);
      if (!applied.accepted) return;
      let nextSnapshot = applied.snapshot;
      switch (event.type) {
        case "snapshot":
          setHasSuccessfulSnapshot(true);
          break;
        case "session.upsert":
        case "session.remove":
          break;
        case "action.updated": {
          const payload = payloadRecord(event.payload);
          const status = typeof payload.status === "string"
            ? payload.status
            : typeof payload.action === "object" && payload.action
              ? String((payload.action as Record<string, unknown>).status ?? "")
              : "";
          if (status === "succeeded" || status === "queued") {
            setNotice(status === "queued" ? "Message queued." : "Action completed.");
          }
          if (status === "failed" || status === "unknown") {
            setActionError(status === "unknown" ? "The action outcome is unknown. It was not replayed." : "The action failed.");
          }
          break;
        }
        case "diagnostic": {
          const payload = payloadRecord(event.payload);
          if (typeof payload.message === "string") {
            const diagnostic: Diagnostic = {
              provider: payload.provider === "codex" || payload.provider === "claude" || payload.provider === "system"
                ? payload.provider
                : "system",
              level: payload.level === "error" ? "error" : "warning",
              message: payload.message,
            };
            nextSnapshot = {
              ...nextSnapshot,
              diagnostics: [...nextSnapshot.diagnostics, diagnostic],
            };
          }
          break;
        }
      }
      commitSnapshot(nextSnapshot);
    }

    const disconnect = connectCockpitEvents({
      clientId: BROWSER_CLIENT_ID,
      onEvent,
      onConnection: (nextConnection) => {
        setConnection(nextConnection);
        if (nextConnection === "open") {
          setAvailability("online");
        } else if (nextConnection === "retrying" || nextConnection === "offline") {
          markDisconnected();
          if (nextConnection === "offline") setAvailability("offline");
        }
      },
      onReconnect: () => void refresh().catch(() => undefined),
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [api, commitSnapshot, handleFailure, markDisconnected, refresh]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const refreshTargets = (): void => {
      void Promise.all([api.hosts(), api.workspaces()]).then(([nextHosts, nextWorkspaces]) => {
        if (cancelled) return;
        setHosts(nextHosts);
        setWorkspaces(nextWorkspaces);
      }).catch(() => undefined);
    };
    const timer = window.setInterval(refreshTargets, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api]);

  useEffect(() => {
    if (!auth || (connection !== "retrying" && connection !== "offline")) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) {
        void recoverBrowserSession();
      }
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [auth, connection, recoverBrowserSession]);

  const sessions = useMemo(() => sortSessions(snapshot.sessions), [snapshot.sessions]);
  const reconciledSelectedId = reconcileSelectedSessionId({
    sessions,
    scope,
    selectedId,
    hasSuccessfulSnapshot,
  });

  const setScope = useCallback((nextScope: SessionScope) => {
    const nextSelectedId = reconcileSelectedSessionId({
      sessions,
      scope: nextScope,
      selectedId,
      hasSuccessfulSnapshot,
    });
    setScopeAndSelectedId(nextScope, nextSelectedId);
  }, [hasSuccessfulSnapshot, selectedId, sessions, setScopeAndSelectedId]);

  useEffect(() => {
    if (reconciledSelectedId !== selectedId) {
      setSelectedId(reconciledSelectedId);
    }
  }, [reconciledSelectedId, selectedId, setSelectedId]);

  const selectedGeneration = reconciledSelectedId
    ? snapshot.sessions.find((session) => session.id === reconciledSelectedId)?.generation ?? null
    : null;

  useEffect(() => {
    if (!api || !reconciledSelectedId) return;
    let cancelled = false;
    const request = stateGuardRef.current.beginRequest();
    void api.session(reconciledSelectedId)
      .then((session) => {
        if (!cancelled) {
          commitSnapshot(stateGuardRef.current.applyRestSession(
            snapshotRef.current,
            session,
            request,
          ));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) handleFailure(error);
      });
    return () => {
      cancelled = true;
    };
  }, [api, commitSnapshot, handleFailure, reconciledSelectedId, selectedGeneration]);

  useEffect(() => {
    if (Object.keys(leases).length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setLeases((current) => {
        const active = Object.entries(current).filter(([, lease]) => new Date(lease.expiresAt).getTime() > now);
        if (active.length === Object.keys(current).length) return current;
        const next = Object.fromEntries(active);
        leasesRef.current = next;
        return next;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [leases]);

  const selectedSession = sessions.find((session) => (
    session.id === reconciledSelectedId && sessionMatchesScope(session, scope)
  )) ?? null;
  const mutationsReady = mutationsAreReady(auth !== null, connection, snapshot.stale, availability);

  const withBusy = useCallback(async <T,>(key: string, operation: () => Promise<T>): Promise<T> => {
    setBusy((current) => ({ ...current, [key]: true }));
    setActionError(null);
    try {
      return await operation();
    } catch (error) {
      const handled = handleFailure(error);
      if (!handled || sensitiveBoundaryStatus(error) === null) {
        const message = error instanceof Error ? error.message : "The action failed.";
        setActionError(message);
      }
      throw error;
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }, [handleFailure]);

  const rememberLease = useCallback((sessionId: string, lease: ControlLease) => {
    leasesRef.current = { ...leasesRef.current, [sessionId]: lease };
    setLeases(leasesRef.current);
    setControlConflicts((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const forgetLease = useCallback((sessionId: string) => {
    if (!(sessionId in leasesRef.current)) return;
    const next = { ...leasesRef.current };
    delete next[sessionId];
    leasesRef.current = next;
    setLeases(next);
  }, []);

  const ensureLease = useCallback(async (
    session: SessionView,
    takeover = false,
  ): Promise<ControlLease> => {
    if (!api || !mutationsReady) throw new Error("Reconnect before sending an action.");
    const pending = leaseOperationsRef.current.get(session.id);
    if (pending && !takeover) return pending;

    const operation = withBusy(`lease:${session.id}`, () => acquireAutomaticLease(
      api,
      session,
      BROWSER_CLIENT_ID,
      leasesRef.current[session.id],
      takeover,
    )).then((lease) => {
      rememberLease(session.id, lease);
      return lease;
    }).catch((error: unknown) => {
      const expiresAt = leaseConflictExpiry(error);
      if (expiresAt !== undefined) {
        setControlConflicts((current) => ({
          ...current,
          [session.id]: expiresAt,
        }));
        setActionError("This session is active in another browser.");
      }
      throw error;
    }).finally(() => {
      if (leaseOperationsRef.current.get(session.id) === operation) {
        leaseOperationsRef.current.delete(session.id);
      }
    });
    leaseOperationsRef.current.set(session.id, operation);
    return operation;
  }, [api, mutationsReady, rememberLease, withBusy]);

  const perform = useCallback(async (
    session: SessionView,
    action: Parameters<CockpitApi["action"]>[1],
  ) => {
    if (!api || !mutationsReady) throw new Error("Reconnect before sending an action.");
    await withBusy(`action:${session.id}`, async () => {
      let lease = await ensureLease(session);
      try {
        await api.action(session.id, action, lease.token);
      } catch (error) {
        const expiresAt = leaseConflictExpiry(error);
        if (expiresAt !== undefined) {
          setControlConflicts((current) => ({ ...current, [session.id]: expiresAt }));
          setActionError("This session is active elsewhere.");
          throw error;
        }
        if (apiErrorCode(error) !== "LEASE_INVALID") throw error;
        forgetLease(session.id);
        lease = await ensureLease(session);
        await api.action(session.id, action, lease.token);
      }
    });
  }, [api, ensureLease, forgetLease, mutationsReady, withBusy]);

  const takeOverControl = useCallback(async (session: SessionView) => {
    await ensureLease(session, true);
    setNotice("This browser is now active for the session.");
  }, [ensureLease]);

  const sendMessage = useCallback(async (session: SessionView, text: string, delivery: "queue" | "steer") => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await perform(session, {
      type: "send",
      delivery,
      text: trimmed,
      expectedGeneration: session.generation,
      ...(session.runId ? { expectedRunId: session.runId } : {}),
      idempotencyKey: idempotencyKey(),
    });
    setNotice(delivery === "steer" ? "Steering message sent." : "Message queued.");
  }, [perform]);

  const respond = useCallback(async (session: SessionView, requestId: string, response: RequestResponse) => {
    await perform(session, {
      type: "respond",
      requestId,
      response,
      expectedGeneration: session.generation,
      idempotencyKey: idempotencyKey(),
    });
    setNotice("Response sent.");
  }, [perform]);

  const interrupt = useCallback(async (session: SessionView) => {
    await perform(session, {
      type: "interrupt",
      expectedGeneration: session.generation,
      ...(session.runId ? { expectedRunId: session.runId } : {}),
      idempotencyKey: idempotencyKey(),
    });
    setNotice("Interrupt requested.");
  }, [perform]);

  const setMode = useCallback(async (session: SessionView, mode: "planning" | "execution") => {
    await perform(session, {
      type: "set-mode",
      mode,
      expectedGeneration: session.generation,
      idempotencyKey: idempotencyKey(),
    });
    setNotice(`Mode change to ${mode} requested.`);
  }, [perform]);

  const createSession = useCallback(async (input: LaunchSessionInput) => {
    if (!api || !mutationsReady) throw new Error("Reconnect before creating a session.");
    const session = await withBusy("create", async () => {
      const workspace = await api.resolveWorkspace(input.hostId, input.workspacePath);
      setWorkspaces((current) => [
        workspace,
        ...current.filter((entry) => entry.id !== workspace.id),
      ]);
      const request: CreateSessionInput = {
        provider: input.provider,
        workspaceId: workspace.id,
        ...(input.name ? { name: input.name } : {}),
        initialMessage: input.initialMessage,
        mode: input.mode,
        accessMode: input.accessMode,
        idempotencyKey: input.idempotencyKey,
      };
      return api.createSession(request);
    });
    commitSnapshot(stateGuardRef.current.applyLocalSession(snapshotRef.current, session));
    setScopeAndSelectedId("managed", session.id);
    setNotice("Managed session created.");
    return session;
  }, [api, commitSnapshot, mutationsReady, setScopeAndSelectedId, withBusy]);

  const completeWorkspacePath = useCallback(async (hostId: string, path: string) => {
    if (!api) return [];
    return api.completeDirectories(hostId, path);
  }, [api]);

  const releaseAllLeases = useCallback(async (): Promise<void> => {
    if (Object.values(busy).some(Boolean)) {
      throw new Error("Wait for the current action before updating.");
    }
    if (!api || !mutationsReady) {
      throw new Error("Reconnect before releasing control for an update.");
    }
    // The auth session is shared by this browser's tabs. Release at the
    // server boundary even when this tab has no local lease record, so a stale
    // background tab cannot remain writable across a PWA code takeover.
    await withBusy("lease:all", () => api.releaseBrowserLeases());
    leasesRef.current = {};
    setLeases({});
    setControlConflicts({});
  }, [api, busy, mutationsReady, withBusy]);

  const loadPreview = useCallback(async (session: SessionView): Promise<PanePreview> => {
    if (!api) throw new Error("The cockpit is not connected.");
    try {
      return await api.preview(session.id);
    } catch (error) {
      handleFailure(error);
      throw error;
    }
  }, [api, handleFailure]);

  const loadAttach = useCallback(async (session: SessionView): Promise<AttachInstruction> => {
    if (!api) throw new Error("The cockpit is not connected.");
    try {
      return await api.attach(session.id);
    } catch (error) {
      handleFailure(error);
      throw error;
    }
  }, [api, handleFailure]);

  return {
    ready: auth !== null,
    actor: auth?.actor ?? null,
    authError,
    availability,
    snapshot,
    sessions,
    selectedSession,
    selectedId: reconciledSelectedId,
    setSelectedId,
    scope,
    setScope,
    connection,
    mutationsReady,
    hosts,
    workspaces,
    busy,
    notice,
    clearNotice: () => setNotice(null),
    actionError,
    clearActionError: () => setActionError(null),
    refresh,
    retryConnection: recoverBrowserSession,
    controlConflict: selectedSession ? controlConflicts[selectedSession.id] ?? undefined : undefined,
    takeOverControl,
    releaseAllLeases,
    hasBusyAction: Object.values(busy).some(Boolean),
    sendMessage,
    respond,
    interrupt,
    setMode,
    createSession,
    completeWorkspacePath,
    loadPreview,
    loadAttach,
  };
}
