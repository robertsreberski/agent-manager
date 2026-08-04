import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  CockpitApi,
  type PlanFileResponse,
  type ProviderSettingsOptionsResponse,
  type SelectedAttentionDetailsResponse,
  type SelectedSessionFactsResponse,
  type SelectedTodoDetailResponse,
  type SessionSettingsOptionsResponse,
  type SetupReadModel,
  type TranscriptSearchResponse,
} from "../lib/api";
import { BrowserSessionError, establishBrowserSession } from "../lib/auth";
import { connectCockpitEvents } from "../lib/sse";
import {
  hostFilterFromSearch,
  reconcileSelectedSessionId,
  searchWithHostFilter,
  searchWithSelectedSession,
  searchWithSessionScope,
  sessionScopeFromSearch,
  type SessionScope,
} from "../lib/session-navigation";
import { idempotencyKey } from "../lib/utils";
import { decideOfflineFlush, enqueueOfflineMessage, type OfflineMessage, type OutboxSessionState } from "../components/system/offline-outbox";
import type {
  AttachInstruction,
  AuthSession,
  ConnectionState,
  ControlCapability,
  ControlLease,
  ExecutionProfile,
  HostOption,
  LaunchSessionInput,
  PanePreview,
  ReasoningEffort,
  RequestResponse,
  SessionAction,
  SessionView,
  StateEvent,
  WireStateSnapshot,
  WorkspaceOption,
} from "../types";
import { AGENT_MANAGER_BUILD_ID, WireUpgradeRequiredError, WIRE_SCHEMA_VERSION } from "../types";

const EMPTY_SNAPSHOT: WireStateSnapshot = {
  schemaVersion: WIRE_SCHEMA_VERSION,
  buildId: AGENT_MANAGER_BUILD_ID,
  sessions: [],
  diagnostics: [],
  generatedAt: new Date(0).toISOString(),
  seq: 0,
  stale: true,
};

export type CockpitAvailability = "connecting" | "online" | "offline" | "auth-required" | "upgrade-required" | "error";

export function mutationsAreReady(authenticated: boolean, connection: ConnectionState, stale: boolean, availability: CockpitAvailability): boolean {
  return authenticated && connection === "open" && !stale && availability === "online";
}

export function sensitiveBoundaryStatus(error: unknown): 401 | null {
  if (error instanceof ApiError && error.status === 401) return 401;
  if (error instanceof BrowserSessionError && error.status === 401) return 401;
  return null;
}

const SAFE_BROWSER_CLIENT_ID = /^web-[A-Za-z0-9._:-]{4,124}$/;
type UpgradeStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function generateBrowserClientId(): string {
  const entropy = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  const candidate = `web-${entropy}`;
  return SAFE_BROWSER_CLIENT_ID.test(candidate) && candidate.length <= 128
    ? candidate
    : `web-${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
}

function currentTabStorage(): UpgradeStorageLike | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

/** One writer identity per document. Duplicate tabs must never share a lease owner. */
export const BROWSER_CLIENT_ID = generateBrowserClientId();

export const WIRE_UPGRADE_RELOAD_STORAGE_KEY = "agent-manager.wire-upgrade-reload.v1";

function wireUpgradeFingerprint(error: WireUpgradeRequiredError): string {
  return JSON.stringify({ expected: error.expected, received: error.received });
}

/** Returns true only when this mismatch initiated the tab's one guarded reload. */
export function reloadForWireUpgrade(
  error: WireUpgradeRequiredError,
  storage: UpgradeStorageLike | null = currentTabStorage(),
  reload: () => void = () => window.location.reload(),
): boolean {
  const fingerprint = wireUpgradeFingerprint(error);
  try {
    if (storage?.getItem(WIRE_UPGRADE_RELOAD_STORAGE_KEY) === fingerprint) return false;
    storage?.setItem(WIRE_UPGRADE_RELOAD_STORAGE_KEY, fingerprint);
  } catch { /* page-lifetime reload still applies */ }
  reload();
  return true;
}

export function clearWireUpgradeReloadGuard(
  storage: UpgradeStorageLike | null = currentTabStorage(),
): void {
  try { storage?.removeItem(WIRE_UPGRADE_RELOAD_STORAGE_KEY); } catch { /* storage is optional */ }
}

function sortSessions(sessions: readonly SessionView[]): SessionView[] {
  const weight: Record<SessionView["status"], number> = { waiting: 0, running: 1, failed: 2, idle: 3, unknown: 4, interrupted: 5, completed: 6 };
  return [...sessions].sort((left, right) => Number(right.attention.length > 0) - Number(left.attention.length > 0)
    || weight[left.status] - weight[right.status]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id));
}

function replaceNavigationUrl(search: string): void {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
}

export function applyStateEvent(current: WireStateSnapshot, event: StateEvent): WireStateSnapshot {
  if (event.seq <= current.seq) return current;
  switch (event.type) {
    case "snapshot":
      return event.payload.seq >= current.seq ? event.payload : current;
    case "session.upsert":
      return { ...current, seq: event.seq, generatedAt: event.at, sessions: [...current.sessions.filter((session) => session.id !== event.payload.id), event.payload] };
    case "session.remove":
      return { ...current, seq: event.seq, generatedAt: event.at, sessions: current.sessions.filter((session) => session.id !== event.payload.id) };
    case "diagnostic":
      return { ...current, seq: event.seq, generatedAt: event.at, stale: event.payload.stale, diagnostics: event.payload.diagnostics };
    case "action.updated":
      return { ...current, seq: event.seq, generatedAt: event.at };
  }
}

function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  const outer = error.body as Record<string, unknown>;
  const value = outer.error && typeof outer.error === "object" ? outer.error as Record<string, unknown> : outer;
  return typeof value.code === "string" ? value.code : null;
}

export function isStaleRequestRace(error: unknown): boolean {
  return apiErrorCode(error) === "REQUEST_STALE";
}

function conflictExpiry(error: unknown): string | null | undefined {
  if (apiErrorCode(error) !== "LEASE_CONFLICT") return undefined;
  const outer = error instanceof ApiError && error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : {};
  const nested = outer.error && typeof outer.error === "object" ? outer.error as Record<string, unknown> : outer;
  const details = nested.details && typeof nested.details === "object" ? nested.details as Record<string, unknown> : {};
  return typeof details.expiresAt === "string" ? details.expiresAt : null;
}

export async function acquireAutomaticLease(api: Pick<CockpitApi, "acquireLease">, session: SessionView, clientId: string, current: ControlLease | undefined, takeover = false): Promise<ControlLease> {
  if (!takeover && current && Date.parse(current.expiresAt) > Date.now() + 5_000) return current;
  const currentToken = current && Date.parse(current.expiresAt) > Date.now() ? current.token : undefined;
  return api.acquireLease(session.id, clientId, currentToken, 60, takeover);
}

interface PageExitLeaseApi {
  releaseLease(sessionId: string, token: string, keepalive?: boolean): Promise<void>;
}

/** Starts best-effort keepalive releases synchronously while the document still exists. */
export function releaseLeasesForPageExit(
  api: PageExitLeaseApi,
  leases: Readonly<Record<string, ControlLease>>,
): void {
  for (const [sessionId, lease] of Object.entries(leases)) {
    void api.releaseLease(sessionId, lease.token, true).catch(() => undefined);
  }
}

function outboxState(session: SessionView): OutboxSessionState {
  return {
    id: session.id,
    providerTurnId: session.providerTurnId,
    profile: session.profile.value,
    status: session.status,
    exactRequestIds: session.attention.flatMap((item) => item.id && item.confidence === "exact" ? [item.id] : []),
    capabilities: session.control.capabilities,
    generation: session.generation,
  };
}

function requiredCapability(type: SessionAction["type"], delivery?: "queue" | "steer"): ControlCapability {
  if (type === "send") return delivery ?? "queue";
  if (type === "respond") return "respond";
  if (type === "interrupt") return "interrupt";
  return type;
}

function expectedState(session: SessionView, key = idempotencyKey()) {
  return {
    expectedGeneration: session.generation,
    ...(session.providerTurnId ? { expectedProviderTurnId: session.providerTurnId } : {}),
    idempotencyKey: key,
  };
}

export interface OfflineReviewMessage extends OfflineMessage { reason: string }

export function useCockpit() {
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<CockpitAvailability>("connecting");
  const [snapshot, setSnapshot] = useState<WireStateSnapshot>(EMPTY_SNAPSHOT);
  const [hasSuccessfulSnapshot, setHasSuccessfulSnapshot] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [hosts, setHosts] = useState<HostOption[]>([]);
  const [scope, setScopeState] = useState<SessionScope>(() => sessionScopeFromSearch(window.location.search));
  const [hostFilter, setHostFilterState] = useState<ReadonlySet<string>>(() => hostFilterFromSearch(window.location.search));
  const [selectedId, setSelectedIdState] = useState<string | null>(() => new URLSearchParams(window.location.search).get("session"));
  const [leases, setLeases] = useState<Record<string, ControlLease>>({});
  const [controlConflicts, setControlConflicts] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<readonly OfflineMessage[]>([]);
  const [offlineReview, setOfflineReview] = useState<readonly OfflineReviewMessage[]>([]);
  const api = useMemo(() => auth ? new CockpitApi(auth) : null, [auth]);
  const apiRef = useRef(api); apiRef.current = api;
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const leasesRef = useRef<Record<string, ControlLease>>({});
  const leaseOperationsRef = useRef(new Map<string, Promise<ControlLease>>());
  const recoveryRef = useRef<Promise<boolean> | null>(null);

  const commitSnapshot = useCallback((next: WireStateSnapshot) => { snapshotRef.current = next; setSnapshot(next); }, []);
  const markDisconnected = useCallback(() => commitSnapshot({ ...snapshotRef.current, stale: true }), [commitSnapshot]);

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    replaceNavigationUrl(searchWithSelectedSession(window.location.search, id));
  }, []);
  const setScope = useCallback((next: SessionScope) => {
    setScopeState(next);
    replaceNavigationUrl(searchWithSessionScope(window.location.search, next));
  }, []);
  const setHostFilter = useCallback((next: ReadonlySet<string>) => {
    setHostFilterState(new Set(next));
    replaceNavigationUrl(searchWithHostFilter(window.location.search, next));
  }, []);

  const clearSensitiveState = useCallback(() => {
    commitSnapshot(EMPTY_SNAPSHOT); setWorkspaces([]); setHosts([]); setLeases({}); leasesRef.current = {};
    leaseOperationsRef.current.clear(); setControlConflicts({}); setBusy({}); setOutbox([]); setOfflineReview([]);
    setNotice(null); setActionError(null); setHasSuccessfulSnapshot(false); setSelectedId(null);
  }, [commitSnapshot, setSelectedId]);

  const handleFailure = useCallback((error: unknown): boolean => {
    if (error instanceof WireUpgradeRequiredError) {
      markDisconnected(); setConnection("offline"); setAvailability("upgrade-required");
      setAuthError(reloadForWireUpgrade(error)
        ? "Agent Manager was updated. Reloading this cockpit to adopt the matching build…"
        : `${error.message} Run \`pnpm deploy\` on the controller, then reload this tab.`);
      return true;
    }
    if (sensitiveBoundaryStatus(error) === 401) {
      clearSensitiveState(); setAuth(null); setConnection("offline"); setAvailability("auth-required");
      setAuthError(error instanceof Error ? error.message : "This browser session is no longer valid."); return true;
    }
    if ((error instanceof BrowserSessionError && error.kind === "offline") || error instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      markDisconnected(); setConnection("offline"); setAvailability("offline"); setAuthError(null); return true;
    }
    return false;
  }, [clearSensitiveState, markDisconnected]);

  const recoverBrowserSession = useCallback((): Promise<boolean> => {
    if (recoveryRef.current) return recoveryRef.current;
    const recovery = establishBrowserSession().then((session) => {
      setAuth(session); setAuthError(null); setAvailability("online"); return true;
    }).catch((error: unknown) => {
      if (!handleFailure(error)) { setAvailability("error"); setAuthError(error instanceof Error ? error.message : "Authentication failed."); }
      return false;
    }).finally(() => { recoveryRef.current = null; });
    recoveryRef.current = recovery;
    return recovery;
  }, [handleFailure]);

  const refresh = useCallback(async () => {
    if (!apiRef.current) return;
    const next = await apiRef.current.sessions();
    clearWireUpgradeReloadGuard();
    if (next.seq >= snapshotRef.current.seq) commitSnapshot(next);
    setHasSuccessfulSnapshot(true);
  }, [commitSnapshot]);

  useEffect(() => { void recoverBrowserSession(); }, [recoverBrowserSession]);
  useEffect(() => {
    function syncNavigation() {
      setScopeState(sessionScopeFromSearch(window.location.search));
      setHostFilterState(hostFilterFromSearch(window.location.search));
      setSelectedIdState(new URLSearchParams(window.location.search).get("session"));
    }
    window.addEventListener("popstate", syncNavigation); return () => window.removeEventListener("popstate", syncNavigation);
  }, []);
  useEffect(() => {
    function offline() { markDisconnected(); setConnection("offline"); setAvailability("offline"); }
    function resume() { if (document.visibilityState === "visible" && navigator.onLine !== false) void recoverBrowserSession(); }
    window.addEventListener("online", resume); window.addEventListener("offline", offline); document.addEventListener("visibilitychange", resume);
    return () => { window.removeEventListener("online", resume); window.removeEventListener("offline", offline); document.removeEventListener("visibilitychange", resume); };
  }, [markDisconnected, recoverBrowserSession]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void Promise.all([api.sessions(), api.workspaces().catch(() => []), api.hosts().catch(() => [])]).then(([next, nextWorkspaces, nextHosts]) => {
      if (cancelled) return;
      clearWireUpgradeReloadGuard();
      if (next.seq >= snapshotRef.current.seq) commitSnapshot(next);
      setHasSuccessfulSnapshot(true); setWorkspaces(nextWorkspaces); setHosts(nextHosts); setAvailability("online"); setAuthError(null);
    }).catch((error: unknown) => {
      if (!cancelled && !handleFailure(error)) { setAvailability("error"); setAuthError(error instanceof Error ? error.message : "Could not load sessions."); }
    });
    const disconnect = connectCockpitEvents({
      clientId: BROWSER_CLIENT_ID,
      onEvent: (event) => {
        clearWireUpgradeReloadGuard();
        commitSnapshot(applyStateEvent(snapshotRef.current, event));
        if (event.type === "snapshot") setHasSuccessfulSnapshot(true);
        if (event.type === "action.updated") {
          if (event.payload.status === "queued") setNotice("Message queued.");
          else if (event.payload.status === "succeeded") setNotice("Action completed.");
          else if (event.payload.status === "failed" || event.payload.status === "unknown") setActionError(event.payload.error?.message ?? (event.payload.status === "unknown" ? "The action outcome is unknown and was not replayed." : "The action failed."));
        }
      },
      onConnection: (next) => {
        setConnection(next);
        if (next === "open") setAvailability("online");
        else { markDisconnected(); if (next === "offline") setAvailability("offline"); }
      },
      onReconnect: () => void refresh().catch(() => undefined),
      onUpgradeRequired: (error) => { handleFailure(error); },
    });
    return () => { cancelled = true; disconnect(); };
  }, [api, commitSnapshot, handleFailure, markDisconnected, refresh]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const timer = window.setInterval(() => void Promise.all([api.hosts(), api.workspaces()]).then(([nextHosts, nextWorkspaces]) => {
      if (!cancelled) { setHosts(nextHosts); setWorkspaces(nextWorkspaces); }
    }).catch(() => undefined), 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const leaseApi = api;
    function releasePageWriters() {
      const held = leasesRef.current;
      leasesRef.current = {};
      leaseOperationsRef.current.clear();
      setLeases({});
      releaseLeasesForPageExit(leaseApi, held);
    }
    window.addEventListener("pagehide", releasePageWriters);
    window.addEventListener("beforeunload", releasePageWriters);
    return () => {
      window.removeEventListener("pagehide", releasePageWriters);
      window.removeEventListener("beforeunload", releasePageWriters);
    };
  }, [api]);

  const sessions = useMemo(() => sortSessions(snapshot.sessions), [snapshot.sessions]);
  const reconciledSelectedId = reconcileSelectedSessionId({ sessions, selectedId, hasSuccessfulSnapshot });
  useEffect(() => { if (reconciledSelectedId !== selectedId) setSelectedId(reconciledSelectedId); }, [reconciledSelectedId, selectedId, setSelectedId]);
  const selectedSession = sessions.find((session) => session.id === reconciledSelectedId) ?? null;
  const mutationsReady = mutationsAreReady(auth !== null, connection, snapshot.stale, availability);

  const withBusy = useCallback(async <T,>(key: string, operation: () => Promise<T>): Promise<T> => {
    setBusy((value) => ({ ...value, [key]: true })); setActionError(null);
    try { return await operation(); }
    catch (error) { if (!handleFailure(error) && !isStaleRequestRace(error)) setActionError(error instanceof Error ? error.message : "The action failed."); throw error; }
    finally { setBusy((value) => ({ ...value, [key]: false })); }
  }, [handleFailure]);

  const rememberLease = useCallback((sessionId: string, lease: ControlLease) => {
    leasesRef.current = { ...leasesRef.current, [sessionId]: lease }; setLeases(leasesRef.current);
    setControlConflicts((value) => { const next = { ...value }; delete next[sessionId]; return next; });
  }, []);
  const forgetLease = useCallback((sessionId: string) => {
    const next = { ...leasesRef.current }; delete next[sessionId]; leasesRef.current = next; setLeases(next);
  }, []);
  const ensureLease = useCallback(async (session: SessionView, takeover = false): Promise<ControlLease> => {
    if (!api || !mutationsReady) throw new Error("Reconnect before sending an action.");
    const pending = leaseOperationsRef.current.get(session.id); if (pending && !takeover) return pending;
    const operation = withBusy(`writer:${session.id}`, () => acquireAutomaticLease(api, session, BROWSER_CLIENT_ID, leasesRef.current[session.id], takeover))
      .then((lease) => { rememberLease(session.id, lease); return lease; })
      .catch((error: unknown) => { const expiry = conflictExpiry(error); if (expiry !== undefined) { setControlConflicts((value) => ({ ...value, [session.id]: expiry })); setActionError("Another browser window is steering this session."); } throw error; })
      .finally(() => { if (leaseOperationsRef.current.get(session.id) === operation) leaseOperationsRef.current.delete(session.id); });
    leaseOperationsRef.current.set(session.id, operation); return operation;
  }, [api, mutationsReady, rememberLease, withBusy]);

  const perform = useCallback(async (session: SessionView, action: SessionAction) => {
    if (!api || !mutationsReady) throw new Error("Reconnect before sending an action.");
    const capability = requiredCapability(action.type, action.type === "send" ? action.delivery : undefined);
    if (!session.control.capabilities.includes(capability)) throw new Error(session.control.withheld.find((item) => item.capability === capability)?.reason ?? "This control plane does not support that action.");
    try {
      await withBusy(`action:${session.id}`, async () => {
        let writer = await ensureLease(session);
        try { await api.action(session.id, action, writer.token); }
        catch (error) {
          const expiry = conflictExpiry(error);
          if (expiry !== undefined) { setControlConflicts((value) => ({ ...value, [session.id]: expiry })); throw error; }
          if (apiErrorCode(error) !== "LEASE_INVALID") throw error;
          forgetLease(session.id); writer = await ensureLease(session); await api.action(session.id, action, writer.token);
        }
      });
    } catch (error) {
      if (!isStaleRequestRace(error)) throw error;
      // Another surface or the provider won this exact request race. Reconcile
      // the controls without turning a normal first-winner outcome into a toast.
      await refresh().catch(() => undefined);
    }
  }, [api, ensureLease, forgetLease, mutationsReady, refresh, withBusy]);

  const sendMessage = useCallback(async (session: SessionView, text: string, delivery: "queue" | "steer") => {
    const trimmed = text.trim(); if (!trimmed) return;
    if (!session.control.capabilities.includes(delivery)) throw new Error(session.control.withheld.find((item) => item.capability === delivery)?.reason ?? `This session cannot ${delivery} messages.`);
    const key = idempotencyKey();
    if (!mutationsReady) {
      setOutbox((current) => enqueueOfflineMessage(current, { id: key, sessionId: session.id, text: trimmed, delivery, idempotencyKey: key, baseline: outboxState(session), queuedAt: new Date().toISOString() }));
      setNotice("Message held locally until the cockpit reconnects."); return;
    }
    await perform(session, { type: "send", delivery, text: trimmed, ...expectedState(session, key) });
  }, [mutationsReady, perform]);

  const respond = useCallback((session: SessionView, requestId: string, response: RequestResponse) => perform(session, { type: "respond", requestId, response, ...expectedState(session) }), [perform]);
  const interrupt = useCallback((session: SessionView) => perform(session, { type: "interrupt", ...expectedState(session) }), [perform]);
  const setProfile = useCallback((session: SessionView, profile: ExecutionProfile) => perform(session, { type: "set-profile", profile, ...expectedState(session) }), [perform]);
  const setModel = useCallback((session: SessionView, model: string) => perform(session, { type: "set-model", model, ...expectedState(session) }), [perform]);
  const setEffort = useCallback((session: SessionView, effort: ReasoningEffort) => perform(session, { type: "set-effort", effort, ...expectedState(session) }), [perform]);
  const removeQueued = useCallback((session: SessionView, messageId: string) => perform(session, { type: "remove-queued", messageId, ...expectedState(session) }), [perform]);
  const lifecycleAction = useCallback((session: SessionView, type: "archive" | "end" | "delete") => perform(session, { type, ...expectedState(session) }), [perform]);
  const openEditor = useCallback((session: SessionView, relativePath: string) => perform(session, { type: "open-editor", relativePath, ...expectedState(session) }), [perform]);
  const takeOverControl = useCallback(async (session: SessionView) => { await ensureLease(session, true); setNotice("This browser window can now steer the session."); }, [ensureLease]);

  useEffect(() => {
    if (!mutationsReady || outbox.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const message of outbox) {
        if (cancelled) return;
        const current = snapshotRef.current.sessions.find((session) => session.id === message.sessionId) ?? null;
        const decision = decideOfflineFlush(message, current ? outboxState(current) : null);
        if (decision.kind === "send") {
          if (!current) continue;
          try {
            await perform(current, { type: "send", delivery: message.delivery, text: message.text, ...expectedState(current, message.idempotencyKey) });
            setOutbox((items) => items.filter((item) => item.id !== message.id));
          } catch { return; }
        } else {
          setOutbox((items) => items.filter((item) => item.id !== message.id));
          setOfflineReview((items) => [...items, { ...message, reason: decision.reason }]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [mutationsReady, outbox, perform]);

  const createSession = useCallback(async (input: LaunchSessionInput) => {
    if (!api || !mutationsReady) throw new Error("Reconnect before creating a session.");
    const session = await withBusy("create", async () => {
      const workspace = await api.resolveWorkspace(input.hostId, input.workspacePath);
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
      return api.createSession({ provider: input.provider, workspaceId: workspace.id, ...(input.name ? { name: input.name } : {}), initialMessage: input.initialMessage, profile: input.profile, model: input.model, effort: input.effort, idempotencyKey: input.idempotencyKey });
    });
    commitSnapshot({ ...snapshotRef.current, sessions: [...snapshotRef.current.sessions.filter((item) => item.id !== session.id), session] });
    setSelectedId(session.id); setNotice("Session created."); return session;
  }, [api, commitSnapshot, mutationsReady, setSelectedId, withBusy]);

  const releaseSessionWriter = useCallback(async (sessionId: string) => {
    const writer = leasesRef.current[sessionId]; forgetLease(sessionId);
    if (api && writer) await api.releaseLease(sessionId, writer.token).catch(() => undefined);
  }, [api, forgetLease]);
  const closeSelected = useCallback(async () => { const id = reconciledSelectedId; setSelectedId(null); if (id) await releaseSessionWriter(id); }, [reconciledSelectedId, releaseSessionWriter, setSelectedId]);
  const completeWorkspacePath = useCallback((hostId: string, path: string) => api ? api.completeDirectories(hostId, path) : Promise.resolve([]), [api]);
  const loadPreview = useCallback((session: SessionView): Promise<PanePreview> => { if (!api) throw new Error("The cockpit is offline."); return api.preview(session.id); }, [api]);
  const loadAttach = useCallback((session: SessionView): Promise<AttachInstruction> => { if (!api) throw new Error("The cockpit is offline."); return api.attach(session.id); }, [api]);
  const loadAttentionDetails = useCallback((
    sessionId: string,
    requestIds: readonly string[],
  ): Promise<SelectedAttentionDetailsResponse> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.attentionDetails(sessionId, requestIds);
  }, [api]);
  const loadTodoDetail = useCallback((sessionId: string): Promise<SelectedTodoDetailResponse> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.todoDetail(sessionId);
  }, [api]);
  const searchTranscript = useCallback((sessionId: string, query: string, limit = 20): Promise<TranscriptSearchResponse> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.searchTranscript(sessionId, query, limit);
  }, [api]);
  const loadSettingsOptions = useCallback((sessionId: string): Promise<SessionSettingsOptionsResponse> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.settingsOptions(sessionId);
  }, [api]);
  const loadProviderSettingsOptions = useCallback((
    provider: SessionView["provider"],
    hostId: string,
  ): Promise<ProviderSettingsOptionsResponse> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.providerSettingsOptions(provider, hostId);
  }, [api]);
  const loadSessionFacts = useCallback((sessionId: string, generation: number): Promise<SelectedSessionFactsResponse> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.sessionFacts(sessionId, generation);
  }, [api]);
  const loadPlanFile = useCallback((sessionId: string, itemId: string): Promise<PlanFileResponse> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.planFile(sessionId, itemId);
  }, [api]);
  const loadSetup = useCallback((): Promise<SetupReadModel> => {
    if (!api) throw new Error("The cockpit is offline.");
    return api.setup();
  }, [api]);
  return {
    ready: auth !== null, actor: auth?.actor ?? null, authError, availability, snapshot, sessions,
    selectedSession, selectedId: reconciledSelectedId, setSelectedId, closeSelected, scope, setScope,
    hostFilter, setHostFilter, connection, mutationsReady, hosts, workspaces, busy, notice,
    clearNotice: () => setNotice(null), actionError, clearActionError: () => setActionError(null),
    refresh, retryConnection: recoverBrowserSession, controlConflict: selectedSession ? controlConflicts[selectedSession.id] : undefined,
    takeOverControl, hasBusyAction: Object.values(busy).some(Boolean),
    sendMessage, respond, interrupt, setProfile, setModel, setEffort, removeQueued, lifecycleAction, openEditor,
    createSession, completeWorkspacePath, loadPreview, loadAttach, loadAttentionDetails, loadTodoDetail, searchTranscript, loadSettingsOptions, loadProviderSettingsOptions, loadSessionFacts, loadPlanFile, loadSetup, outbox, offlineReview,
    dismissOfflineReview: (id: string) => setOfflineReview((items) => items.filter((item) => item.id !== id)),
  };
}
