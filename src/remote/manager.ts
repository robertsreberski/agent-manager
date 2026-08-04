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
  #clients = new Map<string, SshNodeClient>();
  #states = new Map<string, RemoteHostState>();
  #sessionReferences = new Map<string, RemoteSessionReference>();
  #leases = new Map<string, RemoteLease>();
  #pollers = new Map<string, NodeJS.Timeout>();
  #activityStreams = new Map<string, ActiveRemoteActivity>();
  #pollIntervalMs: number;
  #sshExecutable?: string;
  #callbacks: RemoteHostCallbacks | null = null;
  #clientId = `controller-${hostname().replace(/[^A-Za-z0-9._:-]/gu, "-")}-${String(process.pid)}`;

  constructor(
    definitions: readonly RemoteHostDefinition[],
    options: { pollIntervalMs?: number; sshExecutable?: string } = {},
  ) {
    this.#pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 4_000);
    if (options.sshExecutable !== undefined) this.#sshExecutable = options.sshExecutable;
    for (const definition of definitions) {
      this.#definitions.set(definition.id, definition);
      this.#states.set(definition.id, {
        ...definition,
        status: "unknown",
        statusMessage: null,
      });
    }
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

  upsertHost(definition: RemoteHostDefinition): void {
    const previous = this.#definitions.get(definition.id);
    if (previous?.target !== definition.target) {
      this.#clients.get(definition.id)?.close();
      this.#clients.delete(definition.id);
    }
    this.#definitions.set(definition.id, definition);
    const current = this.#states.get(definition.id);
    this.#states.set(definition.id, {
      ...definition,
      status: current?.status ?? "unknown",
      statusMessage: current?.statusMessage ?? null,
    });
    if (this.#callbacks && !this.#pollers.has(definition.id)) {
      this.#startPoller(definition.id);
    }
  }

  removeHost(hostId: string): string[] {
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
      const activity = this.#activityStreams.get(localId);
      if (activity?.retry) clearTimeout(activity.retry);
      activity?.stream?.close();
      this.#activityStreams.delete(localId);
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
    const payload = await this.#request<unknown>(hostId, {
      method: "GET",
      path: "/api/v1/sessions",
    });
    const snapshot = parseStateSnapshot(payload);
    return this.#mapSessions(hostId, snapshot.sessions);
  }

  async session(localId: string): Promise<SessionView> {
    const reference = this.#reference(localId);
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "GET",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}`,
    });
    const envelope = exactRecord(payload, ["session"], "session response");
    const raw = sessionRecordSchema.parse(envelope.session);
    const mapped = this.#mapSessions(reference.hostId, [raw])[0];
    if (!mapped) throw new Error("Remote node returned an invalid session");
    return mapped;
  }

  async completePath(hostId: string, path: string, limit: number): Promise<string[]> {
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "GET",
      path: `/api/v1/hosts/local/directories?path=${encodeURIComponent(path)}&limit=${String(limit)}`,
    });
    const envelope = exactRecord(payload, ["paths"], "directory completion response");
    if (
      !Array.isArray(envelope.paths)
      || envelope.paths.length > Math.max(1, Math.min(50, limit))
      || envelope.paths.some((value) => typeof value !== "string" || !isAbsolute(value))
    ) throw new Error("Remote node returned invalid directory completions");
    return envelope.paths as string[];
  }

  async probeHarnesses(hostId: string): Promise<SetupHarnessProbe> {
    const payload = await this.#request<unknown>(hostId, {
      method: "GET",
      path: "/api/v1/setup/harnesses",
    });
    return setupHarnessProbeResponseSchema.parse(payload).harnesses;
  }

  async resolveWorkspace(hostId: string, path: string): Promise<{
    path: string;
    label: string;
    remoteWorkspaceId: string;
    workspaceIdentity: SessionView["workspaceIdentity"];
  }> {
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "POST",
      path: "/api/v1/workspaces/resolve",
      body: { hostId: "local", path },
    });
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
    const remoteWorkspaceId = workspace.remoteWorkspaceId
      ?? (await this.resolveWorkspace(hostId, workspace.path)).remoteWorkspaceId;
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "POST",
      path: "/api/v1/sessions",
      body: { ...input, workspaceId: remoteWorkspaceId },
    }, 120_000);
    const envelope = exactRecord(payload, ["session"], "created session response");
    const raw = sessionRecordSchema.parse(envelope.session);
    const mapped = this.#mapSessions(hostId, [raw])[0];
    if (!mapped) throw new Error("Remote node returned an invalid created session");
    return mapped;
  }

  async performAction(localId: string, action: SessionAction): Promise<ActionDispatchResult> {
    const reference = this.#reference(localId);
    const lease = await this.#lease(reference);
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
    const result = payloadRecord(payload.action ?? payload);
    const status = result.status;
    if (status !== "queued" && status !== "succeeded" && status !== "failed" && status !== "unknown") {
      throw new Error("Remote node returned an invalid action receipt");
    }
    return { status };
  }

  async acquireControl(localId: string, takeover = false, refresh = false): Promise<void> {
    await this.#lease(this.#reference(localId), takeover, refresh);
  }

  async releaseControl(localId: string): Promise<void> {
    const reference = this.#sessionReferences.get(localId);
    if (!reference) return;
    const key = `${reference.hostId}\0${reference.remoteId}`;
    const lease = this.#leases.get(key);
    if (!lease) return;
    this.#leases.delete(key);
    await this.#request(reference.hostId, {
      method: "DELETE",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/control-lease`,
      controlLease: lease.token,
    });
  }

  async preview(localId: string, query: string): Promise<Record<string, unknown>> {
    const reference = this.#reference(localId);
    return this.#request(reference.hostId, {
      method: "GET",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/preview${query}`,
    });
  }

  async attach(localId: string): Promise<Record<string, unknown>> {
    const reference = this.#reference(localId);
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "GET",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/attach`,
    });
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
    for (const timer of this.#pollers.values()) clearInterval(timer);
    for (const activity of this.#activityStreams.values()) {
      if (activity.retry) clearTimeout(activity.retry);
      activity.stream?.close();
    }
    for (const client of this.#clients.values()) client.close();
    this.#pollers.clear();
    this.#activityStreams.clear();
    this.#clients.clear();
    this.#callbacks = null;
  }

  #startPoller(hostId: string): void {
    if (this.#pollers.has(hostId)) return;
    const poll = async (): Promise<void> => {
      if (!this.has(hostId)) return;
      if (this.#states.get(hostId)?.status === "unknown") {
        this.#setStatus(hostId, "connecting", null);
      }
      try {
        const sessions = await this.listSessions(hostId);
        if (!this.has(hostId)) return;
        this.#setStatus(hostId, "online", null);
        this.#callbacks?.onSessions(hostId, sessions);
      } catch (error) {
        if (!this.has(hostId)) return;
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
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), this.#pollIntervalMs);
    timer.unref();
    this.#pollers.set(hostId, timer);
  }

  #mapSessions(hostId: string, values: readonly unknown[]): SessionView[] {
    const definition = this.#definition(hostId);
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
      onFrame: (frame) => active.mirror.accept(frame),
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
    current.attempt = null;
    if (current.retry) clearTimeout(current.retry);
    current.stream?.close();
    this.#activityStreams.delete(localId);
  }

  #reference(localId: string): RemoteSessionReference {
    const reference = this.#sessionReferences.get(localId);
    if (!reference) throw new Error("Remote session routing information is unavailable");
    return reference;
  }

  #definition(hostId: string): RemoteHostDefinition {
    const definition = this.#definitions.get(hostId);
    if (!definition) throw new Error(`Unknown SSH host: ${hostId}`);
    return definition;
  }

  #client(hostId: string): SshNodeClient {
    const existing = this.#clients.get(hostId);
    if (existing) return existing;
    const definition = this.#definition(hostId);
    const client = new SshNodeClient({
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
    try {
      return await this.#client(hostId).request<T>(request, timeoutMs);
    } catch (error) {
      if (error instanceof RemoteNodeError) throw error;
      this.#clients.get(hostId)?.close();
      this.#clients.delete(hostId);
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
