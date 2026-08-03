import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CockpitApi } from "../lib/api";
import { establishBrowserSession } from "../lib/auth";
import { connectCockpitEvents, type CockpitEvent } from "../lib/sse";
import { SessionStateGuard } from "../lib/session-state";
import { idempotencyKey } from "../lib/utils";
import type {
  AttachInstruction,
  AuthSession,
  ConnectionState,
  ControlLease,
  CreateSessionInput,
  Diagnostic,
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
const CLIENT_ID = getOrCreateBrowserClientId(currentTabStorage());

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

export async function acquireLeaseInStages(
  api: Pick<CockpitApi, "acquireLease">,
  session: SessionView,
  clientId: string,
  current: ControlLease | undefined,
  retain: (lease: ControlLease) => void,
): Promise<ControlLease> {
  let seed = current && new Date(current.expiresAt).getTime() > Date.now()
    ? current
    : undefined;
  if (!seed) {
    seed = await api.acquireLease(session.id, clientId, false, undefined, 30);
    // Keep the short token even if the rotating 300-second renewal response is
    // lost. The broker can recover that immediate previous token briefly.
    retain(seed);
  }
  return api.acquireLease(
    session.id,
    clientId,
    session.effectiveAccess.fullHostAccess,
    seed.token,
    300,
  );
}

export async function autoAcquireCreatedSession(
  input: Pick<CreateSessionInput, "permissionPreset">,
  session: SessionView,
  acquire: (session: SessionView) => Promise<unknown>,
): Promise<boolean> {
  // Full-host access always remains behind the explicit Arm control dialog,
  // even if a provider response disagrees with the requested preset.
  if (input.permissionPreset !== "standard" || session.effectiveAccess.fullHostAccess) {
    return false;
  }
  await acquire(session);
  return true;
}

export function useCockpit() {
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedId, setSelectedIdState] = useState<string | null>(() => {
    return new URLSearchParams(window.location.search).get("session");
  });
  const [leases, setLeases] = useState<Record<string, ControlLease>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const api = useMemo(() => (auth ? new CockpitApi(auth) : null), [auth]);
  const apiRef = useRef(api);
  apiRef.current = api;
  const snapshotRef = useRef<SessionsSnapshot>(EMPTY_SNAPSHOT);
  const stateGuardRef = useRef(new SessionStateGuard());

  const commitSnapshot = useCallback((next: SessionsSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("session", id);
    else url.searchParams.delete("session");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  const refresh = useCallback(async () => {
    if (!apiRef.current) return;
    const request = stateGuardRef.current.beginRequest();
    const next = await apiRef.current.sessions();
    commitSnapshot(stateGuardRef.current.applyRestSnapshot(snapshotRef.current, next, request));
  }, [commitSnapshot]);

  useEffect(() => {
    let cancelled = false;
    void establishBrowserSession()
      .then((session) => {
        if (!cancelled) setAuth(session);
      })
      .catch((error: unknown) => {
        if (!cancelled) setAuthError(error instanceof Error ? error.message : "Authentication failed.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const sessionsRequest = stateGuardRef.current.beginRequest();
    void Promise.all([
      api.sessions(),
      api.workspaces().catch(() => [] as WorkspaceOption[]),
    ])
      .then(([nextSnapshot, nextWorkspaces]) => {
        if (cancelled) return;
        commitSnapshot(stateGuardRef.current.applyRestSnapshot(
          snapshotRef.current,
          nextSnapshot,
          sessionsRequest,
        ));
        setWorkspaces(nextWorkspaces);
      })
      .catch((error: unknown) => {
        if (!cancelled) setAuthError(error instanceof Error ? error.message : "Could not load local sessions.");
      });

    function onEvent(event: CockpitEvent) {
      const applied = stateGuardRef.current.applyEvent(snapshotRef.current, event);
      if (!applied.accepted) return;
      let nextSnapshot = applied.snapshot;
      switch (event.type) {
        case "snapshot":
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
      clientId: CLIENT_ID,
      onEvent,
      onConnection: setConnection,
      onReconnect: () => void refresh().catch(() => undefined),
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [api, commitSnapshot, refresh]);

  const selectedGeneration = selectedId
    ? snapshot.sessions.find((session) => session.id === selectedId)?.generation ?? null
    : null;

  useEffect(() => {
    if (!api || !selectedId) return;
    let cancelled = false;
    const request = stateGuardRef.current.beginRequest();
    void api.session(selectedId)
      .then((session) => {
        if (!cancelled) {
          commitSnapshot(stateGuardRef.current.applyRestSession(
            snapshotRef.current,
            session,
            request,
          ));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, commitSnapshot, selectedGeneration, selectedId]);

  useEffect(() => {
    if (Object.keys(leases).length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setLeases((current) => {
        const active = Object.entries(current).filter(([, lease]) => new Date(lease.expiresAt).getTime() > now);
        return active.length === Object.keys(current).length ? current : Object.fromEntries(active);
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [leases]);

  const sessions = useMemo(() => sortSessions(snapshot.sessions), [snapshot.sessions]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !sessions.some((session) => session.id === selectedId)) {
      setSelectedId(sessions[0]!.id);
    }
  }, [selectedId, sessions, setSelectedId]);

  const selectedSession = sessions.find((session) => session.id === selectedId) ?? null;

  const withBusy = useCallback(async <T,>(key: string, operation: () => Promise<T>): Promise<T> => {
    setBusy((current) => ({ ...current, [key]: true }));
    setActionError(null);
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The action failed.";
      setActionError(message);
      throw error;
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }, []);

  const acquireLease = useCallback(async (session: SessionView) => {
    if (!api) throw new Error("The cockpit is not connected.");
    const lease = await withBusy(`lease:${session.id}`, async () => {
      return acquireLeaseInStages(
        api,
        session,
        CLIENT_ID,
        leases[session.id],
        (retained) => setLeases((value) => ({ ...value, [session.id]: retained })),
      );
    });
    setLeases((current) => ({ ...current, [session.id]: lease }));
    setNotice(session.effectiveAccess.fullHostAccess ? "Full-host controls armed for five minutes." : "Control acquired for five minutes.");
    return lease;
  }, [api, leases, withBusy]);

  const releaseLease = useCallback(async (session: SessionView) => {
    if (!api) return;
    const lease = leases[session.id];
    if (!lease) return;
    await withBusy(`lease:${session.id}`, () => api.releaseLease(session.id, lease.token));
    setLeases((current) => {
      const next = { ...current };
      delete next[session.id];
      return next;
    });
    setNotice("Control released.");
  }, [api, leases, withBusy]);

  const validLease = useCallback((session: SessionView): ControlLease | null => {
    const lease = leases[session.id];
    if (!lease || new Date(lease.expiresAt).getTime() <= Date.now()) return null;
    if (
      session.effectiveAccess.fullHostAccess
      && (!lease.fullHostArmedUntil || new Date(lease.fullHostArmedUntil).getTime() <= Date.now())
    ) {
      return null;
    }
    return lease;
  }, [leases]);

  const perform = useCallback(async (
    session: SessionView,
    action: Parameters<CockpitApi["action"]>[1],
  ) => {
    if (!api) throw new Error("The cockpit is not connected.");
    const lease = validLease(session);
    if (!lease) {
      const message = "Take control of this session before sending an action.";
      setActionError(message);
      throw new Error(message);
    }
    await withBusy(`action:${session.id}`, () => api.action(session.id, action, lease.token));
  }, [api, validLease, withBusy]);

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

  const createSession = useCallback(async (input: CreateSessionInput) => {
    if (!api) throw new Error("The cockpit is not connected.");
    const session = await withBusy("create", () => api.createSession(input));
    commitSnapshot(stateGuardRef.current.applyLocalSession(snapshotRef.current, session));
    setSelectedId(session.id);
    let acquired = false;
    try {
      acquired = await autoAcquireCreatedSession(input, session, acquireLease);
    } catch {
      // Creation already succeeded. Keep that result and surface the lease
      // error rather than causing the launch dialog to retry creation.
    }
    setNotice(acquired
      ? "Managed session created with control ready for five minutes."
      : "Managed session created.");
    return session;
  }, [acquireLease, api, commitSnapshot, setSelectedId, withBusy]);

  const loadPreview = useCallback(async (session: SessionView): Promise<PanePreview> => {
    if (!api) throw new Error("The cockpit is not connected.");
    return api.preview(session.id);
  }, [api]);

  const loadAttach = useCallback(async (session: SessionView): Promise<AttachInstruction> => {
    if (!api) throw new Error("The cockpit is not connected.");
    return api.attach(session.id);
  }, [api]);

  return {
    ready: auth !== null,
    actor: auth?.actor ?? null,
    authError,
    snapshot,
    sessions,
    selectedSession,
    selectedId,
    setSelectedId,
    connection,
    workspaces,
    leases,
    validLease,
    busy,
    notice,
    clearNotice: () => setNotice(null),
    actionError,
    clearActionError: () => setActionError(null),
    refresh,
    acquireLease,
    releaseLease,
    sendMessage,
    respond,
    interrupt,
    setMode,
    createSession,
    loadPreview,
    loadAttach,
  };
}
