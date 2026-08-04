import { hostname } from "node:os";

import type { ActivityHub } from "../activity/hub.ts";
import type { ActivityItem, ActivityItemDraft } from "../activity/types.ts";
import type { Diagnostic, Provider, SessionView } from "../core/types.ts";
import type { ActionDispatchResult, CreateSessionInput, SessionAction } from "../server/contracts.ts";
import type { WorkspaceRecord } from "../server/persistence.ts";
import { RemoteNodeError, SshNodeClient } from "./ssh-client.ts";

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

function encodedRemoteId(hostId: string, remoteId: string): string {
  return `remote:${hostId}:${Buffer.from(remoteId, "utf8").toString("base64url")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Remote host request failed";
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class RemoteHostManager {
  #definitions = new Map<string, RemoteHostDefinition>();
  #clients = new Map<string, SshNodeClient>();
  #states = new Map<string, RemoteHostState>();
  #sessionReferences = new Map<string, RemoteSessionReference>();
  #leases = new Map<string, RemoteLease>();
  #pollers = new Map<string, NodeJS.Timeout>();
  #activityPollers = new Map<string, { count: number; timer: NodeJS.Timeout; hashes: Map<string, string> }>();
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
      const activity = this.#activityPollers.get(localId);
      if (activity) clearInterval(activity.timer);
      this.#activityPollers.delete(localId);
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
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "GET",
      path: "/api/v1/sessions",
    });
    const rawSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    return this.#mapSessions(hostId, rawSessions);
  }

  async session(localId: string): Promise<SessionView> {
    const reference = this.#reference(localId);
    const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
      method: "GET",
      path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}`,
    });
    const raw = payload.session ?? payload;
    const mapped = this.#mapSessions(reference.hostId, [raw])[0];
    if (!mapped) throw new Error("Remote node returned an invalid session");
    return mapped;
  }

  async completePath(hostId: string, path: string, limit: number): Promise<string[]> {
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "GET",
      path: `/api/v1/hosts/local/directories?path=${encodeURIComponent(path)}&limit=${String(limit)}`,
    });
    return Array.isArray(payload.paths)
      ? payload.paths.filter((value): value is string => typeof value === "string")
      : [];
  }

  async resolveWorkspace(hostId: string, path: string): Promise<{
    path: string;
    label: string;
    remoteWorkspaceId: string;
  }> {
    const payload = await this.#request<Record<string, unknown>>(hostId, {
      method: "POST",
      path: "/api/v1/workspaces/resolve",
      body: { hostId: "local", path },
    });
    const workspace = payloadRecord(payload.workspace ?? payload);
    if (
      typeof workspace.id !== "string"
      || typeof workspace.path !== "string"
      || typeof workspace.label !== "string"
    ) throw new Error("Remote node returned an invalid workspace");
    return {
      path: workspace.path,
      label: workspace.label,
      remoteWorkspaceId: workspace.id,
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
    const raw = payload.session ?? payload;
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
    const existing = this.#activityPollers.get(localId);
    if (existing) {
      existing.count += 1;
      return () => this.#releaseActivity(localId);
    }
    const hashes = new Map<string, string>();
    const poll = async (): Promise<void> => {
      try {
        const reference = this.#reference(localId);
        const payload = await this.#request<Record<string, unknown>>(reference.hostId, {
          method: "GET",
          path: `/api/v1/sessions/${encodeURIComponent(reference.remoteId)}/activity?limit=400`,
        });
        const items = Array.isArray(payload.items) ? payload.items : [];
        for (const raw of items) {
          const item = payloadRecord(raw) as unknown as ActivityItem;
          if (typeof item.id !== "string" || typeof item.kind !== "string") continue;
          const fingerprint = JSON.stringify(item);
          if (hashes.get(item.id) === fingerprint) continue;
          hashes.set(item.id, fingerprint);
          hub.ingest(localId, provider, {
            type: "upsert",
            item: {
              ...item,
              sessionId: localId,
            } as unknown as ActivityItemDraft,
          });
        }
      } catch {
        // The host status poll reports connectivity; keep the last safe view.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1_000);
    timer.unref();
    this.#activityPollers.set(localId, { count: 1, timer, hashes });
    return () => this.#releaseActivity(localId);
  }

  dispose(): void {
    for (const timer of this.#pollers.values()) clearInterval(timer);
    for (const activity of this.#activityPollers.values()) clearInterval(activity.timer);
    for (const client of this.#clients.values()) client.close();
    this.#pollers.clear();
    this.#activityPollers.clear();
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

  #mapSessions(hostId: string, values: unknown[]): SessionView[] {
    const definition = this.#definition(hostId);
    const valid = values.flatMap((raw): Array<{ raw: SessionView; remoteId: string; localId: string }> => {
      const value = payloadRecord(raw);
      const remoteId = typeof value.id === "string" ? value.id : null;
      if (!remoteId || (value.provider !== "codex" && value.provider !== "claude")) return [];
      return [{ raw: value as unknown as SessionView, remoteId, localId: encodedRemoteId(hostId, remoteId) }];
    });
    const ids = new Map<string, string>();
    for (const item of valid) {
      ids.set(item.remoteId, item.localId);
      if (item.raw.sessionId) ids.set(item.raw.sessionId, item.localId);
      if (item.raw.sessionId) ids.set(`${item.raw.provider}:${item.raw.sessionId}`, item.localId);
    }
    return valid.map(({ raw, remoteId, localId }) => {
      const parent = raw.parentSessionId ? ids.get(raw.parentSessionId) ?? null : null;
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
        parentSessionId: parent,
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

  #releaseActivity(localId: string): void {
    const current = this.#activityPollers.get(localId);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    clearInterval(current.timer);
    this.#activityPollers.delete(localId);
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
