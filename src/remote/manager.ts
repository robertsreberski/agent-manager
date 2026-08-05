import { hostname } from "node:os";
import { isAbsolute } from "node:path";

import type { ActivityHub } from "../activity/hub.ts";
import type { Diagnostic, Provider, SessionView } from "../core/types.ts";
import { sessionRecordId } from "../shared/session.ts";
import type { ActionDispatchResult, CreateSessionInput, SessionAction } from "../server/contracts.ts";
import type { WorkspaceRecord } from "../server/persistence.ts";
import {
  setupHarnessProbeResponseSchema,
  type SetupHarnessProbe,
} from "../shared/setup.ts";
import {
  parseStateSnapshot,
  sessionRecordSchema,
} from "../shared/wire.ts";
import { workspaceResolutionResponseSchema } from "../shared/workspace.ts";
import { RemoteActivityMirror } from "./activity-stream.ts";
import { RemoteNodeError, SshNodeClient } from "./ssh-client.ts";
import type { RemoteActivityStream } from "./ssh-client.ts";

export interface RemoteHostDefinition {
  id: string;
  label: string;
  target: string;
}

export interface RemoteHostState extends RemoteHostDefinition {
  status: "online" | "offline" | "connecting" | "unknown";
  statusMessage: string | null;
}

interface RemoteSessionReference {
  hostId: string;
  hostEpoch: number;
  remoteId: string;
  remoteGeneration: number;
  provider: Provider;
}

interface RemoteLease {
  token: string;
  expiresAt: string;
}

interface RemoteHostCallbacks {
  onSessions: (hostId: string, sessions: SessionView[]) => void;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

interface ActiveRemoteActivity {
  count: number;
  provider: Provider;
  mirror: RemoteActivityMirror;
  stream: RemoteActivityStream | null;
  retry: NodeJS.Timeout | null;
  attempt: object | null;
}

export interface RemoteHostClient {
  request<T = unknown>(
    input: Parameters<SshNodeClient["request"]>[0],
    timeoutMs?: number,
  ): Promise<T>;
  openActivityStream(
    options: Parameters<SshNodeClient["openActivityStream"]>[0],
  ): Promise<RemoteActivityStream>;
  close(): void;
}

export interface RemoteHostManagerOptions {
  pollIntervalMs?: number;
  sshExecutable?: string;
  /** Test/embedder seam for a transport with the same owner-only node protocol. */
  clientFactory?: (definition: RemoteHostDefinition) => RemoteHostClient;
}

class StaleRemoteHostRequestError extends Error {
  constructor() {
    super("Remote host changed while the request was in flight");
    this.name = "StaleRemoteHostRequestError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Remote host request failed";
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = payloadRecord(value);
  const keys = Object.keys(record);
  if (
    keys.length !== required.length
    || !required.every((key) => Object.hasOwn(record, key))
  ) throw new Error(`Remote node returned an invalid ${label}`);
  return record;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function remapParentId(
  hostId: string,
  session: SessionView,
  knownIds: ReadonlyMap<string, string>,
): string | null {
  if (session.parentId === null) return null;
  const known = knownIds.get(session.parentId);
  if (known) return known;
  const prefix = `${session.hostId}:${session.provider}:`;
  if (!session.parentId.startsWith(prefix) || session.parentId.length === prefix.length) {
    throw new Error("Remote node returned an invalid parent session identity");
  }
  return sessionRecordId(hostId, session.provider, session.parentId.slice(prefix.length));
}

export class RemoteHostManager {
  #definitions = new Map<string, RemoteHostDefinition>();
  #clients = new Map<string, RemoteHostClient>();
  #states = new Map<string, RemoteHostState>();
  #sessionReferences = new Map<string, RemoteSessionReference>();
  #leases = new Map<string, RemoteLease>();
  #pollers = new Map<string, NodeJS.Timeout>();
  #activityStreams = new Map<string, ActiveRemoteActivity>();
  #hostEpochs = new Map<string, number>();
  #nextHostEpoch = 0;
  #pollIntervalMs: number;
  #sshExecutable?: string;
  #clientFactory?: (definition: RemoteHostDefinition) => RemoteHostClient;
  #callbacks: RemoteHostCallbacks | null = null;
  #clientId = `controller-${hostname().replace(/[^A-Za-z0-9._:-]/gu, "-")}-${String(process.pid)}`;

  constructor(
    definitions: readonly RemoteHostDefinition[],
    options: RemoteHostManagerOptions = {},
  ) {
    this.#pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 4_000);
    if (options.sshExecutable !== undefined) this.#sshExecutable = options.sshExecutable;
    if (options.clientFactory !== undefined) this.#clientFactory = options.clientFactory;
    for (const definition of definitions) this.#addHost(definition);
  }

  get configured(): boolean {
    return this.#definitions.size > 0;
  }

  states(): RemoteHostState[] {
    return [...this.#states.values()].map((state) => ({ ...state }));
  }

  has(hostId: string): boolean {
    return this.#definitions.has(hostId);
  }

  upsertHost(definition: RemoteHostDefinition): string[] {
    const previous = this.#definitions.get(definition.id);
    if (previous?.target !== definition.target) {
      const removed = previous ? this.removeHost(definition.id) : [];
      this.#addHost(definition);
      return removed;
    }
    this.#definitions.set(definition.id, { ...definition });
    const current = this.#states.get(definition.id);
    this.#states.set(definition.id, {
      ...definition,
      status: current?.status ?? "unknown",
      statusMessage: current?.statusMessage ?? null,
    });
    if (this.#callbacks && !this.#pollers.has(definition.id)) {
      this.#startPoller(definition.id);
    }
    return [];
  }

  reconcile(definitions: readonly RemoteHostDefinition[]): string[] {
    const next = new Map<string, RemoteHostDefinition>();
    for (const definition of definitions) next.set(definition.id, { ...definition });
    const removed = new Set<string>();
    for (const current of [...this.#definitions.values()]) {
      const replacement = next.get(current.id);
      if (replacement && replacement.target === current.target) continue;
      for (const sessionId of this.removeHost(current.id)) removed.add(sessionId);
    }
    for (const definition of next.values()) {
      for (const sessionId of this.upsertHost(definition)) removed.add(sessionId);
    }
    return [...removed];
  }

  removeHost(hostId: string): string[] {
    this.#hostEpochs.set(hostId, ++this.#nextHostEpoch);
    const timer = this.#pollers.get(hostId);
    if (timer) clearInterval(timer);
    this.#pollers.delete(hostId);
    this.#clients.get(hostId)?.close();
    this.#clients.delete(hostId);
    this.#definitions.delete(hostId);
    this.#states.delete(hostId);
    const removed: string[] = [];
    for (const [localId, reference] of this.#sessionReferences) {
      if (reference.hostId !== hostId) continue;
      removed.push(localId);
      this.#closeActivity(localId);
      this.#sessionReferences.delete(localId);
    }
    for (const key of this.#leases.keys()) {
      if (key.startsWith(`${hostId}\0`)) this.#leases.delete(key);
    }
    return removed;
  }

  start(options: RemoteHostCallbacks): void {
    this.#callbacks = options;
    for (const hostId of this.#definitions.keys()) this.#startPoller(hostId);
  }

  async listSessions(hostId: string): Promise<SessionView[]> {
    const epoch = this.#hostEpoch(hostId);
    const payload = await this.#request<unknown>(hostId, {
      method: "GET",
      path: "/api/v1/sessions",
    });
    this.#assertCurrentHost(hostId, epoch);
    const snapshot = parseStateSnapshot(payload);
    return this.#mapSessions(hostId, snapshot.sessions);
  }

  async session(localId: string): Promise<SessionView> {
    const reference = this.#reference(localId);
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "GET",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}`,
    });
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    const envelope = exactRecord(payload, ["session"], "session response");
    const raw = sessionRecordSchema.parse(envelope.session);
    const mapped = this.#mapSessions(reference.hostId, [raw])[0];
    if (!mapped) throw new Error("Remote node returned an invalid session");
    return mapped;
  }

  async completePath(hostId: string, path: string, limit: number): Promise<string[]> {
    const epoch = this.#hostEpoch(hostId);
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "GET",
      path: `/api/v1/hosts/local/directories?path=${encodeURIComponent(path)}&limit=${String(limit)}`,
    });
    this.#assertCurrentHost(hostId, epoch);
    const envelope = exactRecord(payload, ["paths"], "directory completion response");
    if (
      !Array.isArray(envelope.paths)
      || envelope.paths.length > Math.max(1, Math.min(50, limit))
      || envelope.paths.some((value) => typeof value !== "string" || !isAbsolute(value))
    ) throw new Error("Remote node returned invalid directory completions");
    return envelope.paths as string[];
  }

  async probeHarnesses(hostId: string): Promise<SetupHarnessProbe> {
    const epoch = this.#hostEpoch(hostId);
    const payload = await this.#request<unknown>(hostId, {
      method: "GET",
      path: "/api/v1/setup/harnesses",
    });
    this.#assertCurrentHost(hostId, epoch);
    return setupHarnessProbeResponseSchema.parse(payload).harnesses;
  }

  async resolveWorkspace(hostId: string, path: string): Promise<{
    path: string;
    label: string;
    remoteWorkspaceId: string;
    workspaceIdentity: SessionView["workspaceIdentity"];
  }> {
    const epoch = this.#hostEpoch(hostId);
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "POST",
      path: "/api/v1/workspaces/resolve",
      body: { hostId: "local", path },
    });
    this.#assertCurrentHost(hostId, epoch);
    const { workspace } = workspaceResolutionResponseSchema.parse(payload);
    if (
      workspace.hostId !== "local"
      || workspace.hostKind !== "local"
      || !isAbsolute(workspace.path)
      || workspace.remoteWorkspaceId !== null
    ) throw new Error("Remote node returned an invalid workspace");
    return {
      path: workspace.path,
      label: workspace.label,
      remoteWorkspaceId: workspace.id,
      workspaceIdentity: structuredClone(workspace.workspaceIdentity),
    };
  }

  async createSession(
    hostId: string,
    input: CreateSessionInput,
    workspace: WorkspaceRecord,
  ): Promise<SessionView> {
    const epoch = this.#hostEpoch(hostId);
    const remoteWorkspaceId = workspace.remoteWorkspaceId
      ?? (await this.resolveWorkspace(hostId, workspace.path)).remoteWorkspaceId;
    this.#assertCurrentHost(hostId, epoch);
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "POST",
      path: "/api/v1/sessions",
      body: { ...input, workspaceId: remoteWorkspaceId },
    }, 120_000);
    this.#assertCurrentHost(hostId, epoch);
    const envelope = exactRecord(payload, ["session"], "created session response");
    const raw = sessionRecordSchema.parse(envelope.session);
    const mapped = this.#mapSessions(hostId, [raw])[0];
    if (!mapped) throw new Error("Remote node returned an invalid created session");
    return mapped;
  }

  async performAction(localId: string, action: SessionAction): Promise<ActionDispatchResult> {
    const reference = this.#reference(localId);
    const lease = await this.#lease(reference);
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    const remoteAction = {
      ...action,
      expectedGeneration: reference.remoteGeneration,
    };
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "POST",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/actions`,
      body: remoteAction,
      controlLease: lease.token,
    }, 120_000);
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    const result = payloadRecord(payload.action ?? payload);
    const status = result.status;
    if (status !== "queued" && status !== "succeeded" && status !== "failed" && status !== "unknown") {
      throw new Error("Remote node returned an invalid action receipt");
    }
    return { status };
  }

  async acquireControl(localId: string, takeover = false, refresh = false): Promise<void> {
    const reference = this.#reference(localId);
    await this.#lease(reference, takeover, refresh);
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
  }

  async releaseControl(localId: string): Promise<void> {
    const reference = this.#sessionReferences.get(localId);
    if (!reference) return;
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    const key = `${reference.hostId}\0${reference.remoteId}`;
    const lease = this.#leases.get(key);
    if (!lease) return;
    this.#leases.delete(key);
    await this.#request(reference.hostId, {
      method: "DELETE",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/control-lease`,
      controlLease: lease.token,
    });
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
  }

  async preview(localId: string, query: string): Promise<Record<string, unknown>> {
    const reference = this.#reference(localId);
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "GET",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/preview${query}`,
    });
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    return payload;
  }

  async attach(localId: string): Promise<Record<string, unknown>> {
    const reference = this.#reference(localId);
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "GET",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/attach`,
    });
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    const definition = this.#definition(reference.hostId);
    if (!payload.instruction || typeof payload.instruction !== "object") {
      return { instruction: null };
    }
    const script = 'exec agent-manager attach "$1"';
    const remoteCommand = `/bin/zsh -lc ${shellLiteral(script)} agent-manager ${shellLiteral(reference.remoteId)}`;
    return {
      instruction: {
        kind: "ssh",
        argv: ["ssh", "-t", definition.target, remoteCommand],
        cwd: null,
        warning: `Run from a terminal with SSH access to ${definition.label}.`,
      },
    };
  }

  acquireActivity(localId: string, hub: ActivityHub, provider: Provider): () => void {
    const existing = this.#activityStreams.get(localId);
    if (existing) {
      if (existing.provider !== provider) throw new Error("Remote activity provider cannot change");
      existing.count += 1;
      return () => this.#releaseActivity(localId);
    }
    const reference = this.#reference(localId);
    const active: ActiveRemoteActivity = {
      count: 1,
      provider,
      mirror: new RemoteActivityMirror({
        hub,
        localSessionId: localId,
        remoteSessionId: reference.remoteId,
        provider,
      }),
      stream: null,
      retry: null,
      attempt: null,
    };
    this.#activityStreams.set(localId, active);
    this.#openActivity(localId, active);
    return () => this.#releaseActivity(localId);
  }

  dispose(): void {
    for (const hostId of this.#definitions.keys()) {
      this.#hostEpochs.set(hostId, ++this.#nextHostEpoch);
    }
    this.#callbacks = null;
    for (const timer of this.#pollers.values()) clearInterval(timer);
    for (const localId of [...this.#activityStreams.keys()]) this.#closeActivity(localId);
    for (const client of this.#clients.values()) client.close();
    this.#pollers.clear();
    this.#clients.clear();
    this.#definitions.clear();
    this.#states.clear();
    this.#sessionReferences.clear();
    this.#leases.clear();
  }

  #startPoller(hostId: string): void {
    if (this.#pollers.has(hostId)) return;
    const epoch = this.#hostEpoch(hostId);
    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling || !this.#isCurrentHost(hostId, epoch)) return;
      polling = true;
      if (this.#states.get(hostId)?.status === "unknown") {
        this.#setStatus(hostId, "connecting", null);
      }
      try {
        const sessions = await this.listSessions(hostId);
        if (!this.#isCurrentHost(hostId, epoch)) return;
        this.#setStatus(hostId, "online", null);
        this.#callbacks?.onSessions(hostId, sessions);
      } catch (error) {
        if (!this.#isCurrentHost(hostId, epoch)) return;
        const message = errorMessage(error);
        const prior = this.#states.get(hostId)?.statusMessage;
        this.#setStatus(hostId, "offline", message);
        if (prior !== message) {
          const definition = this.#definition(hostId);
          this.#callbacks?.onDiagnostic?.({
            provider: "system",
            level: "warning",
            message: `${definition.label} is unavailable over SSH: ${message}`,
          });
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), this.#pollIntervalMs);
    timer.unref();
    this.#pollers.set(hostId, timer);
    void poll();
  }

  #mapSessions(hostId: string, values: readonly unknown[]): SessionView[] {
    const definition = this.#definition(hostId);
    const hostEpoch = this.#hostEpoch(hostId);
    const valid = values.map((value) => {
      const raw = sessionRecordSchema.parse(value);
      return {
        raw,
        remoteId: raw.id,
        localId: sessionRecordId(hostId, raw.provider, raw.providerThreadId),
      };
    });
    const ids = new Map<string, string>();
    for (const item of valid) {
      ids.set(item.remoteId, item.localId);
    }
    return valid.map(({ raw, remoteId, localId }) => {
      const parent = remapParentId(hostId, raw, ids);
      this.#sessionReferences.set(localId, {
        hostId,
        hostEpoch,
        remoteId,
        remoteGeneration: raw.generation,
        provider: raw.provider,
      });
      return {
        ...raw,
        id: localId,
        hostId,
        hostLabel: definition.label,
        parentId: parent,
      };
    });
  }

  async #lease(
    reference: RemoteSessionReference,
    takeover = false,
    refresh = false,
  ): Promise<RemoteLease> {
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    const key = `${reference.hostId}\0${reference.remoteId}`;
    const current = this.#leases.get(key);
    if (!takeover && !refresh && current && Date.parse(current.expiresAt) > Date.now() + 5_000) {
      return current;
    }
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "POST",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/control-lease`,
      body: { clientId: this.#clientId, ttlSeconds: 60, takeover },
      ...(current ? { controlLease: current.token } : {}),
    });
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    const lease = payloadRecord(payload.lease ?? payload);
    if (typeof lease.token !== "string" || typeof lease.expiresAt !== "string") {
      throw new Error("Remote node returned an invalid writer lease");
    }
    const next = { token: lease.token, expiresAt: lease.expiresAt };
    this.#leases.set(key, next);
    return next;
  }

  #openActivity(localId: string, active: ActiveRemoteActivity): void {
    if (
      this.#activityStreams.get(localId) !== active
      || active.count < 1
      || active.stream
      || active.attempt
    ) return;
    let reference: RemoteSessionReference;
    try {
      reference = this.#reference(localId);
    } catch {
      return;
    }
    const attempt = {};
    active.attempt = attempt;
    const path = `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/activity/events?clientId=${encodeURIComponent(this.#clientId)}`;
    const lastEventId = active.mirror.resumeCursor;
    void this.#client(reference.hostId).openActivityStream({
      path,
      ...(lastEventId ? { lastEventId } : {}),
      onFrame: (frame) => {
        if (
          this.#activityStreams.get(localId) !== active
          || active.attempt !== attempt
          || !this.#isCurrentHost(reference.hostId, reference.hostEpoch)
        ) return;
        active.mirror.accept(frame);
      },
      onClose: (error) => {
        if (this.#activityStreams.get(localId) !== active || active.attempt !== attempt) return;
        active.attempt = null;
        active.stream = null;
        if (error) active.mirror.requireSnapshot();
        this.#retryActivity(localId, active);
      },
    }).then((stream) => {
      if (this.#activityStreams.get(localId) !== active || active.attempt !== attempt) {
        stream.close();
        return;
      }
      active.stream = stream;
    }).catch(() => {
      if (this.#activityStreams.get(localId) !== active || active.attempt !== attempt) return;
      active.attempt = null;
      active.stream = null;
      active.mirror.requireSnapshot();
      this.#retryActivity(localId, active);
    });
  }

  #retryActivity(localId: string, active: ActiveRemoteActivity): void {
    if (this.#activityStreams.get(localId) !== active || active.retry || active.count < 1) return;
    active.retry = setTimeout(() => {
      active.retry = null;
      this.#openActivity(localId, active);
    }, 1_000);
    active.retry.unref();
  }

  #releaseActivity(localId: string): void {
    const current = this.#activityStreams.get(localId);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    this.#closeActivity(localId);
  }

  #closeActivity(localId: string): void {
    const current = this.#activityStreams.get(localId);
    if (!current) return;
    this.#activityStreams.delete(localId);
    current.attempt = null;
    if (current.retry) clearTimeout(current.retry);
    current.retry = null;
    const stream = current.stream;
    current.stream = null;
    stream?.close();
  }

  #reference(localId: string): RemoteSessionReference {
    const reference = this.#sessionReferences.get(localId);
    if (!reference) throw new Error("Remote session routing information is unavailable");
    this.#assertCurrentHost(reference.hostId, reference.hostEpoch);
    return reference;
  }

  #definition(hostId: string): RemoteHostDefinition {
    const definition = this.#definitions.get(hostId);
    if (!definition) throw new Error(`Unknown SSH host: ${hostId}`);
    return definition;
  }

  #addHost(definition: RemoteHostDefinition): void {
    const stored = { ...definition };
    this.#definitions.set(stored.id, stored);
    this.#states.set(stored.id, {
      ...stored,
      status: "unknown",
      statusMessage: null,
    });
    this.#hostEpochs.set(stored.id, ++this.#nextHostEpoch);
    if (this.#callbacks && !this.#pollers.has(stored.id)) this.#startPoller(stored.id);
  }

  #hostEpoch(hostId: string): number {
    const epoch = this.#hostEpochs.get(hostId);
    if (epoch === undefined || !this.#definitions.has(hostId)) {
      throw new Error(`Unknown SSH host: ${hostId}`);
    }
    return epoch;
  }

  #isCurrentHost(hostId: string, epoch: number): boolean {
    return this.#definitions.has(hostId) && this.#hostEpochs.get(hostId) === epoch;
  }

  #assertCurrentHost(hostId: string, epoch: number): void {
    if (!this.#isCurrentHost(hostId, epoch)) throw new StaleRemoteHostRequestError();
  }

  #client(hostId: string): RemoteHostClient {
    const existing = this.#clients.get(hostId);
    if (existing) return existing;
    const definition = this.#definition(hostId);
    const client = this.#clientFactory
      ? this.#clientFactory({ ...definition })
      : new SshNodeClient({
          target: definition.target,
          ...(this.#sshExecutable ? { sshExecutable: this.#sshExecutable } : {}),
        });
    this.#clients.set(hostId, client);
    return client;
  }

  async #request<T>(
    hostId: string,
    request: Parameters<SshNodeClient["request"]>[0],
    timeoutMs?: number,
  ): Promise<T> {
    const epoch = this.#hostEpoch(hostId);
    const client = this.#client(hostId);
    try {
      const response = await client.request<T>(request, timeoutMs);
      this.#assertCurrentHost(hostId, epoch);
      return response;
    } catch (error) {
      if (!this.#isCurrentHost(hostId, epoch)) throw new StaleRemoteHostRequestError();
      if (error instanceof RemoteNodeError) throw error;
      if (this.#clients.get(hostId) === client) {
        client.close();
        this.#clients.delete(hostId);
      }
      throw error;
    }
  }

  #setStatus(
    hostId: string,
    status: RemoteHostState["status"],
    statusMessage: string | null,
  ): void {
    const definition = this.#definition(hostId);
    this.#states.set(hostId, { ...definition, status, statusMessage });
  }
}
