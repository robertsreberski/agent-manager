import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Provider } from "../core/types.ts";
import type { WireWorkspaceRecord } from "../shared/workspace.ts";
import {
  sessionActionSchema,
  type Actor,
  type CreateSessionInput,
  type SessionAction,
} from "./contracts.ts";

export type WorkspaceRecord = WireWorkspaceRecord;

export interface HostRecord {
  id: string;
  label: string;
  kind: "local" | "ssh";
  sshTarget: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedSessionMetadata {
  id: string;
  provider: Provider;
  providerSessionId: string;
  workspaceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Durable authorization metadata for one surgical Claude hook install.
 * The bearer token itself lives only in Claude's settings; this record keeps
 * the one-way digest needed by the loopback hook route.
 */
export interface ClaudeHookInstallRecord {
  id: string;
  provider: "claude";
  schemaVersion: 1;
  tokenDigest: string;
  createdAt: string;
  settingsPath: string;
  endpoint: string;
  createdHooksProperty: boolean;
  lastSeenAt: string | null;
}

/** Observation-only Codex command-hook authorization and integrity metadata. */
export interface CodexHookInstallRecord {
  id: string;
  provider: "codex";
  schemaVersion: 1;
  tokenDigest: string;
  createdAt: string;
  settingsPath: string;
  shimPath: string;
  endpoint: string;
  command: string;
  shimDigest: string;
  lastSeenAt: string | null;
}

export interface PersistedAction {
  id: string;
  sessionId: string;
  actionType: SessionAction["type"];
  action: SessionAction;
  idempotencyKey: string;
  status: "pending" | "dispatching" | "queued" | "unknown";
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventInput {
  actor: Actor;
  actionId: string;
  sessionId: string;
  generation: number;
  action: SessionAction;
  requestOrRunId: string | null;
  outcome: string;
  providerAcknowledged: boolean;
  precondition: string;
  at?: string;
}

export interface ActionReceipt {
  sessionId: string;
  idempotencyKey: string;
  requestSha256: string;
  actionId: string;
  actionType: SessionAction["type"];
  status: "queued" | "succeeded" | "failed" | "unknown";
  createdAt: string;
  completedAt: string;
}

export interface ManagedControlIntentEvidence {
  actionType: SessionAction["type"];
  status: "queued" | "succeeded" | "unknown";
  at: string;
}

export interface CreateSessionIntent {
  actorId: string;
  idempotencyKey: string;
  requestSha256: string;
  managerRequestId: string;
  provider: Provider;
  workspaceId: string;
  status: "pending" | "dispatching" | "succeeded" | "unknown";
  managedSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalAuditInput {
  actor: Actor;
  operation: string;
  targetId: string;
  phase: "attempt" | "outcome" | "lifecycle";
  outcome: string;
  idempotencyKey?: string;
  details?: Record<string, string | number | boolean | null>;
  at?: string;
}

export function actionFingerprint(action: SessionAction): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

export function createSessionFingerprint(input: CreateSessionInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function assertClaudeHookInstallRecord(
  input: Omit<ClaudeHookInstallRecord, "lastSeenAt">,
): void {
  if (
    input.provider !== "claude"
    || input.schemaVersion !== 1
    || !/^[A-Za-z0-9._:-]{1,256}$/u.test(input.id)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.tokenDigest)
    || !input.settingsPath.startsWith("/")
    || input.settingsPath.length > 32_768
    || input.settingsPath.includes("\0")
    || !Number.isFinite(Date.parse(input.createdAt))
  ) {
    throw new Error("Claude hook install record is invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error("Claude hook install endpoint is invalid");
  }
  if (
    endpoint.protocol !== "http:"
    || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
    || endpoint.pathname !== "/api/v1/hooks/claude"
    || endpoint.search.length > 0
    || endpoint.hash.length > 0
    || endpoint.username.length > 0
    || endpoint.password.length > 0
  ) {
    throw new Error("Claude hook install endpoint must be the loopback hook route");
  }
}

function assertCodexHookInstallRecord(
  input: Omit<CodexHookInstallRecord, "lastSeenAt">,
): void {
  if (
    input.provider !== "codex"
    || input.schemaVersion !== 1
    || !/^[A-Za-z0-9._:-]{1,256}$/u.test(input.id)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.tokenDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.shimDigest)
    || !Number.isFinite(Date.parse(input.createdAt))
    || input.command.length === 0
    || input.command.length > 32_768
    || /[\u0000-\u001f\u007f]/u.test(input.command)
    || ![input.settingsPath, input.shimPath].every((path) =>
      path.startsWith("/") && path.length <= 32_768 && !path.includes("\0")
    )
  ) {
    throw new Error("Codex hook install record is invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error("Codex hook install endpoint is invalid");
  }
  if (
    endpoint.protocol !== "http:"
    || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
    || endpoint.pathname !== "/api/v1/hooks/codex"
    || endpoint.search.length > 0
    || endpoint.hash.length > 0
    || endpoint.username.length > 0
    || endpoint.password.length > 0
  ) {
    throw new Error("Codex hook install endpoint must be the loopback hook route");
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Persisted JSON value is not text");
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Persisted JSON value is malformed", { cause: error });
  }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed session metadata is not an object");
  }
  return parsed as Record<string, unknown>;
}

function parsePersistedAction(value: unknown): SessionAction | null {
  const parsed = parseJson(value);
  if (parsed && typeof parsed === "object" && Object.keys(parsed).length === 0) return null;
  const result = sessionActionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Persisted action does not match the current database epoch", {
      cause: result.error,
    });
  }
  return result.data;
}

function actionText(action: SessionAction): string {
  switch (action.type) {
    case "send": return action.text;
    case "respond": return JSON.stringify(action.response);
    case "set-profile": return action.profile;
    case "set-model": return action.model;
    case "set-effort": return action.effort;
    case "remove-queued": return action.messageId;
    case "open-editor": return action.relativePath;
    case "take-control": return action.method;
    case "cancel-take-control": return action.takeoverId;
    case "retry-control": return action.type;
    case "resume": return action.type;
    case "interrupt":
    case "end":
    case "archive":
    case "delete":
      return action.type;
  }
}

/** Audit previews contain operation metadata only, never prompt or response text. */
export function redactedPreview(action: SessionAction): string {
  switch (action.type) {
    case "send": return `send:${action.delivery};content-omitted`;
    case "respond": return `respond:${action.response.kind};content-omitted`;
    case "interrupt": return "interrupt";
    case "set-profile": return `set-profile:${action.profile}`;
    case "set-model": return "set-model:value-omitted";
    case "set-effort": return `set-effort:${action.effort}`;
    case "remove-queued": return "remove-queued:id-omitted";
    case "end": return "end";
    case "archive": return "archive";
    case "delete": return "delete";
    case "take-control": return `take-control:${action.method}`;
    case "cancel-take-control": return "cancel-take-control:id-omitted";
    case "retry-control": return "retry-control";
    case "resume": return "resume";
    case "open-editor": return "open-editor:path-omitted";
  }
}

export const DATABASE_SCHEMA_VERSION = 4 as const;

export class IncompatibleDatabaseError extends Error {
  readonly code = "INCOMPATIBLE_DATABASE";
  readonly expectedVersion = DATABASE_SCHEMA_VERSION;
  readonly actualVersion: number | null;

  constructor(actualVersion: number | null) {
    super(
      `Unsupported Agent Manager database version: ${actualVersion === null ? "unreadable" : String(actualVersion)}`,
    );
    this.name = "IncompatibleDatabaseError";
    this.actualVersion = actualVersion;
  }
}

export class ManagerDatabase {
  readonly path: string;
  #database: DatabaseSync;

  constructor(path = ":memory:") {
    this.path = path;
    const hadDatabase = path !== ":memory:" && existsSync(path) && statSync(path).size > 0;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(path);
    if (hadDatabase) {
      let actualVersion: number | null = null;
      try {
        actualVersion = this.#schemaVersion();
      } catch {
        actualVersion = null;
      }
      if (actualVersion !== DATABASE_SCHEMA_VERSION) {
        this.#database.close();
        throw new IncompatibleDatabaseError(actualVersion);
      }
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#initialize();
  }

  close(): void {
    this.#database.close();
  }

  #schemaVersion(): number {
    return Number(
      (this.#database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0,
    );
  }

  #initialize(): void {
    this.#database.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        ssh_target TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((kind = 'local' AND ssh_target IS NULL) OR (kind = 'ssh' AND ssh_target IS NOT NULL)),
        UNIQUE (ssh_target)
      ) STRICT;
      INSERT OR IGNORE INTO hosts (id, label, kind, ssh_target, created_at, updated_at)
        VALUES ('local', 'This Mac', 'local', NULL, datetime('now'), datetime('now'));
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        path TEXT NOT NULL,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        remote_workspace_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (host_id, path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS managed_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        provider_session_id TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider, provider_session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS claude_hook_installs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'claude'),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        token_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settings_path TEXT NOT NULL UNIQUE,
        endpoint TEXT NOT NULL,
        created_hooks_property INTEGER NOT NULL CHECK (created_hooks_property IN (0, 1)),
        last_seen_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS codex_hook_installs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'codex'),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        token_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settings_path TEXT NOT NULL UNIQUE,
        shim_path TEXT NOT NULL UNIQUE,
        endpoint TEXT NOT NULL,
        command TEXT NOT NULL,
        shim_digest TEXT NOT NULL,
        last_seen_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS queued_actions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'queued', 'unknown')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        action_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        request_or_run_id TEXT,
        idempotency_key TEXT NOT NULL,
        precondition TEXT NOT NULL,
        provider_acknowledged INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        payload_char_count INTEGER NOT NULL,
        redacted_preview TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_receipts (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        action_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'succeeded', 'failed', 'unknown')),
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS create_session_intents (
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        manager_request_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'succeeded', 'unknown')),
        managed_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_events_session_at
        ON audit_events(session_id, at DESC);
      PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
    `);
  }

  addHost(input: {
    id: string;
    label: string;
    kind: "local" | "ssh";
    sshTarget?: string | null;
    createdAt?: string;
  }): HostRecord {
    const at = input.createdAt ?? new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO hosts (id, label, kind, ssh_target, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        kind = excluded.kind,
        ssh_target = excluded.ssh_target,
        updated_at = excluded.updated_at
    `).run(input.id, input.label, input.kind, input.sshTarget ?? null, at, at);
    return this.getHost(input.id)!;
  }

  listHosts(): HostRecord[] {
    const rows = this.#database.prepare(`
      SELECT id, label, kind, ssh_target, created_at, updated_at
      FROM hosts ORDER BY kind, label, id
    `).all() as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row.id),
      label: asString(row.label),
      kind: asString(row.kind) as HostRecord["kind"],
      sshTarget: row.ssh_target === null ? null : asString(row.ssh_target),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
  }

  getHost(id: string): HostRecord | null {
    return this.listHosts().find((host) => host.id === id) ?? null;
  }

  removeHost(id: string): boolean {
    if (id === "local") return false;
    const result = this.#database.prepare("DELETE FROM hosts WHERE id = ? AND kind = 'ssh'").run(id);
    return Number(result.changes) > 0;
  }

  addWorkspace(input: {
    id?: string;
    label: string;
    path: string;
    hostId?: string;
    remoteWorkspaceId?: string | null;
    createdAt?: string;
  }): WorkspaceRecord {
    const hostId = input.hostId ?? "local";
    const host = this.getHost(hostId);
    if (!host) throw new Error(`Unknown workspace host: ${hostId}`);
    const record: WorkspaceRecord = {
      id: input.id ?? randomUUID(),
      label: input.label,
      path: input.path,
      hostId,
      hostLabel: host.label,
      hostKind: host.kind,
      remoteWorkspaceId: input.remoteWorkspaceId ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.#database.prepare(`
      INSERT INTO workspaces (id, label, path, host_id, remote_workspace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, path) DO UPDATE SET
        label = excluded.label,
        remote_workspace_id = COALESCE(excluded.remote_workspace_id, workspaces.remote_workspace_id)
    `).run(record.id, record.label, record.path, record.hostId, record.remoteWorkspaceId, record.createdAt);
    return this.#workspaceByHostPath(record.hostId, record.path) ?? record;
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.#database.prepare(`${this.#workspaceSelect()} ORDER BY h.kind, h.label, w.label, w.path`)
      .all() as unknown as Record<string, unknown>[];
    return rows.map((row) => this.#workspaceRecord(row));
  }

  getWorkspace(id: string): WorkspaceRecord | null {
    const row = this.#database.prepare(`${this.#workspaceSelect()} WHERE w.id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.#workspaceRecord(row) : null;
  }

  #workspaceByHostPath(hostId: string, path: string): WorkspaceRecord | null {
    const row = this.#database.prepare(`${this.#workspaceSelect()} WHERE w.host_id = ? AND w.path = ?`)
      .get(hostId, path) as Record<string, unknown> | undefined;
    return row ? this.#workspaceRecord(row) : null;
  }

  #workspaceSelect(): string {
    return `SELECT w.id, w.label, w.path, w.host_id, w.remote_workspace_id, w.created_at,
                   h.label AS host_label, h.kind AS host_kind
            FROM workspaces w JOIN hosts h ON h.id = w.host_id`;
  }

  #workspaceRecord(row: Record<string, unknown>): WorkspaceRecord {
    return {
      id: asString(row.id),
      label: asString(row.label),
      path: asString(row.path),
      hostId: asString(row.host_id),
      hostLabel: asString(row.host_label),
      hostKind: asString(row.host_kind) as WorkspaceRecord["hostKind"],
      remoteWorkspaceId: row.remote_workspace_id === null ? null : asString(row.remote_workspace_id),
      createdAt: asString(row.created_at),
    };
  }

  removeWorkspace(id: string): boolean {
    const result = this.#database.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  upsertManagedSession(record: ManagedSessionMetadata): void {
    this.#database.prepare(`
      INSERT INTO managed_sessions (
        id, provider, provider_session_id, workspace_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        workspace_id = excluded.workspace_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.provider,
      record.providerSessionId,
      record.workspaceId,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    );
  }

  listManagedSessions(): ManagedSessionMetadata[] {
    const rows = this.#database.prepare(`
      SELECT id, provider, provider_session_id, workspace_id, metadata_json, created_at, updated_at
      FROM managed_sessions ORDER BY created_at
    `).all() as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row.id),
      provider: asString(row.provider) as Provider,
      providerSessionId: asString(row.provider_session_id),
      workspaceId: row.workspace_id === null ? null : asString(row.workspace_id),
      metadata: parseMetadata(row.metadata_json),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
  }

  removeManagedSession(id: string): boolean {
    const result = this.#database.prepare("DELETE FROM managed_sessions WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  listClaudeHookInstallRecords(): ClaudeHookInstallRecord[] {
    const rows = this.#database.prepare(`
      SELECT id, provider, schema_version, token_digest, created_at,
             settings_path, endpoint, created_hooks_property, last_seen_at
      FROM claude_hook_installs ORDER BY created_at, id
    `).all() as unknown as Record<string, unknown>[];
    return rows.map((row) => {
      const record: ClaudeHookInstallRecord = {
        id: asString(row.id),
        provider: "claude",
        schemaVersion: 1,
        tokenDigest: asString(row.token_digest),
        createdAt: asString(row.created_at),
        settingsPath: asString(row.settings_path),
        endpoint: asString(row.endpoint),
        createdHooksProperty: Number(row.created_hooks_property) === 1,
        lastSeenAt: row.last_seen_at === null ? null : asString(row.last_seen_at),
      };
      assertClaudeHookInstallRecord(record);
      if (record.lastSeenAt !== null && !Number.isFinite(Date.parse(record.lastSeenAt))) {
        throw new Error("Persisted Claude hook last-seen timestamp is invalid");
      }
      return record;
    });
  }

  getClaudeHookInstallRecord(settingsPath: string): ClaudeHookInstallRecord | null {
    return this.listClaudeHookInstallRecords().find(
      (record) => record.settingsPath === settingsPath,
    ) ?? null;
  }

  upsertClaudeHookInstallRecord(
    input: Omit<ClaudeHookInstallRecord, "lastSeenAt">,
  ): ClaudeHookInstallRecord {
    assertClaudeHookInstallRecord(input);
    this.#database.prepare(`
      INSERT INTO claude_hook_installs (
        id, provider, schema_version, token_digest, created_at,
        settings_path, endpoint, created_hooks_property, last_seen_at
      ) VALUES (?, 'claude', 1, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(settings_path) DO UPDATE SET
        id = excluded.id,
        token_digest = excluded.token_digest,
        created_at = excluded.created_at,
        endpoint = excluded.endpoint,
        created_hooks_property = excluded.created_hooks_property,
        last_seen_at = CASE
          WHEN claude_hook_installs.id = excluded.id
            AND claude_hook_installs.token_digest = excluded.token_digest
          THEN claude_hook_installs.last_seen_at
          ELSE NULL
        END
    `).run(
      input.id,
      input.tokenDigest,
      input.createdAt,
      input.settingsPath,
      input.endpoint,
      input.createdHooksProperty ? 1 : 0,
    );
    const stored = this.getClaudeHookInstallRecord(input.settingsPath);
    if (!stored) throw new Error("Claude hook install record disappeared during upsert");
    return stored;
  }

  removeClaudeHookInstallRecord(id: string): boolean {
    const result = this.#database.prepare(
      "DELETE FROM claude_hook_installs WHERE id = ?",
    ).run(id);
    return Number(result.changes) > 0;
  }

  markClaudeHookSeen(id: string, at = new Date().toISOString()): boolean {
    if (!Number.isFinite(Date.parse(at))) throw new Error("Claude hook last-seen timestamp is invalid");
    const result = this.#database.prepare(`
      UPDATE claude_hook_installs
      SET last_seen_at = ?
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
    `).run(at, id, at);
    return Number(result.changes) > 0;
  }

  listCodexHookInstallRecords(): CodexHookInstallRecord[] {
    const rows = this.#database.prepare(`
      SELECT id, provider, schema_version, token_digest, created_at,
             settings_path, shim_path, endpoint, command, shim_digest, last_seen_at
      FROM codex_hook_installs ORDER BY created_at, id
    `).all() as unknown as Record<string, unknown>[];
    return rows.map((row) => {
      const record: CodexHookInstallRecord = {
        id: asString(row.id),
        provider: "codex",
        schemaVersion: 1,
        tokenDigest: asString(row.token_digest),
        createdAt: asString(row.created_at),
        settingsPath: asString(row.settings_path),
        shimPath: asString(row.shim_path),
        endpoint: asString(row.endpoint),
        command: asString(row.command),
        shimDigest: asString(row.shim_digest),
        lastSeenAt: row.last_seen_at === null ? null : asString(row.last_seen_at),
      };
      assertCodexHookInstallRecord(record);
      if (record.lastSeenAt !== null && !Number.isFinite(Date.parse(record.lastSeenAt))) {
        throw new Error("Persisted Codex hook last-seen timestamp is invalid");
      }
      return record;
    });
  }

  getCodexHookInstallRecord(settingsPath: string): CodexHookInstallRecord | null {
    return this.listCodexHookInstallRecords().find(
      (record) => record.settingsPath === settingsPath,
    ) ?? null;
  }

  upsertCodexHookInstallRecord(
    input: Omit<CodexHookInstallRecord, "lastSeenAt">,
  ): CodexHookInstallRecord {
    assertCodexHookInstallRecord(input);
    this.#database.prepare(`
      INSERT INTO codex_hook_installs (
        id, provider, schema_version, token_digest, created_at, settings_path,
        shim_path, endpoint, command, shim_digest, last_seen_at
      ) VALUES (?, 'codex', 1, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(settings_path) DO UPDATE SET
        id = excluded.id,
        token_digest = excluded.token_digest,
        created_at = excluded.created_at,
        shim_path = excluded.shim_path,
        endpoint = excluded.endpoint,
        command = excluded.command,
        shim_digest = excluded.shim_digest,
        last_seen_at = CASE
          WHEN codex_hook_installs.id = excluded.id
            AND codex_hook_installs.token_digest = excluded.token_digest
            AND codex_hook_installs.shim_digest = excluded.shim_digest
          THEN codex_hook_installs.last_seen_at
          ELSE NULL
        END
    `).run(
      input.id,
      input.tokenDigest,
      input.createdAt,
      input.settingsPath,
      input.shimPath,
      input.endpoint,
      input.command,
      input.shimDigest,
    );
    const stored = this.getCodexHookInstallRecord(input.settingsPath);
    if (!stored) throw new Error("Codex hook install record disappeared during upsert");
    return stored;
  }

  removeCodexHookInstallRecord(id: string): boolean {
    const result = this.#database.prepare(
      "DELETE FROM codex_hook_installs WHERE id = ?",
    ).run(id);
    return Number(result.changes) > 0;
  }

  markCodexHookSeen(id: string, at = new Date().toISOString()): boolean {
    if (!Number.isFinite(Date.parse(at))) throw new Error("Codex hook last-seen timestamp is invalid");
    const result = this.#database.prepare(`
      UPDATE codex_hook_installs
      SET last_seen_at = ?
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
    `).run(at, id, at);
    return Number(result.changes) > 0;
  }

  beginCreateSessionIntent(input: {
    actorId: string;
    request: CreateSessionInput;
    at?: string;
  }): { intent: CreateSessionIntent; created: boolean } {
    const existing = this.getCreateSessionIntent(input.actorId, input.request.idempotencyKey);
    if (existing) return { intent: existing, created: false };
    const at = input.at ?? new Date().toISOString();
    const intent: CreateSessionIntent = {
      actorId: input.actorId,
      idempotencyKey: input.request.idempotencyKey,
      requestSha256: createSessionFingerprint(input.request),
      managerRequestId: `manager-request:${randomUUID()}`,
      provider: input.request.provider,
      workspaceId: input.request.workspaceId,
      status: "pending",
      managedSessionId: null,
      createdAt: at,
      updatedAt: at,
    };
    try {
      this.#database.prepare(`
        INSERT INTO create_session_intents (
          actor_id, idempotency_key, request_sha256, manager_request_id,
          provider, workspace_id, status, managed_session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        intent.actorId,
        intent.idempotencyKey,
        intent.requestSha256,
        intent.managerRequestId,
        intent.provider,
        intent.workspaceId,
        intent.status,
        intent.createdAt,
        intent.updatedAt,
      );
      return { intent, created: true };
    } catch (error) {
      const raced = this.getCreateSessionIntent(input.actorId, input.request.idempotencyKey);
      if (raced) return { intent: raced, created: false };
      throw error;
    }
  }

  getCreateSessionIntent(actorId: string, idempotencyKey: string): CreateSessionIntent | null {
    const row = this.#database.prepare(`
      SELECT actor_id, idempotency_key, request_sha256, manager_request_id,
             provider, workspace_id, status, managed_session_id, created_at, updated_at
      FROM create_session_intents WHERE actor_id = ? AND idempotency_key = ?
    `).get(actorId, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? {
      actorId: asString(row.actor_id),
      idempotencyKey: asString(row.idempotency_key),
      requestSha256: asString(row.request_sha256),
      managerRequestId: asString(row.manager_request_id),
      provider: asString(row.provider) as Provider,
      workspaceId: asString(row.workspace_id),
      status: asString(row.status) as CreateSessionIntent["status"],
      managedSessionId: row.managed_session_id === null ? null : asString(row.managed_session_id),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    } : null;
  }

  markCreateSessionDispatching(
    actorId: string,
    idempotencyKey: string,
    at = new Date().toISOString(),
  ): void {
    const result = this.#database.prepare(`
      UPDATE create_session_intents SET status = 'dispatching', updated_at = ?
      WHERE actor_id = ? AND idempotency_key = ? AND status = 'pending'
    `).run(at, actorId, idempotencyKey);
    if (Number(result.changes) !== 1) throw new Error("create-session intent is not pending");
  }

  completeCreateSessionIntent(input: {
    actorId: string;
    idempotencyKey: string;
    session: ManagedSessionMetadata;
    at?: string;
  }): void {
    const at = input.at ?? new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.upsertManagedSession(input.session);
      const result = this.#database.prepare(`
        UPDATE create_session_intents
        SET status = 'succeeded', managed_session_id = ?, updated_at = ?
        WHERE actor_id = ? AND idempotency_key = ? AND status = 'dispatching'
      `).run(input.session.id, at, input.actorId, input.idempotencyKey);
      if (Number(result.changes) !== 1) throw new Error("create-session intent is not dispatching");
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  markCreateSessionUnknown(
    actorId: string,
    idempotencyKey: string,
    at = new Date().toISOString(),
  ): void {
    this.#database.prepare(`
      UPDATE create_session_intents SET status = 'unknown', updated_at = ?
      WHERE actor_id = ? AND idempotency_key = ? AND status IN ('pending', 'dispatching')
    `).run(at, actorId, idempotencyKey);
  }

  recoverCreateSessionIntents(at = new Date().toISOString()): number {
    const result = this.#database.prepare(`
      UPDATE create_session_intents SET status = 'unknown', updated_at = ?
      WHERE status IN ('pending', 'dispatching')
    `).run(at);
    return Number(result.changes);
  }

  persistAction(record: PersistedAction): void {
    this.#database.prepare(`
      INSERT INTO queued_actions (
        id, session_id, action_type, payload_json, idempotency_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionId,
      record.actionType,
      JSON.stringify(record.action),
      record.idempotencyKey,
      record.status,
      record.createdAt,
      record.updatedAt,
    );
  }

  persistActionWithAudit(record: PersistedAction, audit: AuditEventInput): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.persistAction(record);
      this.audit(audit);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  markActionDispatching(id: string, at = new Date().toISOString()): void {
    const result = this.#database.prepare(
      "UPDATE queued_actions SET status = 'dispatching', updated_at = ? WHERE id = ? AND status = 'pending'",
    ).run(at, id);
    if (Number(result.changes) !== 1) throw new Error("action is not pending");
  }

  markActionQueued(id: string, at = new Date().toISOString()): void {
    const result = this.#database.prepare(
      "UPDATE queued_actions SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'dispatching'",
    ).run(at, id);
    if (Number(result.changes) !== 1) throw new Error("action is not dispatching");
  }

  acknowledgeAction(id: string): void {
    this.#database.prepare("DELETE FROM queued_actions WHERE id = ?").run(id);
  }

  markActionUnknown(id: string, at = new Date().toISOString()): void {
    this.#database.prepare(
      "UPDATE queued_actions SET status = 'unknown', payload_json = '{}', updated_at = ? WHERE id = ?",
    ).run(at, id);
  }

  markInterruptedDispatchesUnknown(at = new Date().toISOString()): number {
    const rows = this.#database.prepare(`
      SELECT id, session_id, action_type, payload_json, idempotency_key, created_at
      FROM queued_actions WHERE status IN ('pending', 'dispatching', 'queued')
    `).all() as unknown as Record<string, unknown>[];
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const action = parsePersistedAction(row.payload_json);
        if (action) {
          if (action.type !== asString(row.action_type)) {
            throw new Error("Persisted action type does not match its payload");
          }
          this.#database.prepare(`
            INSERT INTO action_receipts (
              session_id, idempotency_key, request_sha256, action_id,
              action_type, status, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)
            ON CONFLICT(session_id, idempotency_key) DO NOTHING
          `).run(
            asString(row.session_id),
            asString(row.idempotency_key),
            actionFingerprint(action),
            asString(row.id),
            asString(row.action_type),
            asString(row.created_at),
            at,
          );
        }
      }
      const result = this.#database.prepare(
        `UPDATE queued_actions
         SET status = 'unknown', payload_json = '{}', updated_at = ?
         WHERE status IN ('pending', 'dispatching', 'queued')`,
      ).run(at);
      this.#database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getActionReceipt(sessionId: string, idempotencyKey: string): ActionReceipt | null {
    const row = this.#database.prepare(`
      SELECT session_id, idempotency_key, request_sha256, action_id,
             action_type, status, created_at, completed_at
      FROM action_receipts WHERE session_id = ? AND idempotency_key = ?
    `).get(sessionId, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? {
      sessionId: asString(row.session_id),
      idempotencyKey: asString(row.idempotency_key),
      requestSha256: asString(row.request_sha256),
      actionId: asString(row.action_id),
      actionType: asString(row.action_type) as SessionAction["type"],
      status: asString(row.status) as ActionReceipt["status"],
      createdAt: asString(row.created_at),
      completedAt: asString(row.completed_at),
    } : null;
  }

  /**
   * Latest durable provider-control intent that can establish whether a
   * pre-managerControl Claude record was explicitly ended. Failed actions and
   * local-only coordination actions carry no provider ownership evidence.
   */
  getLatestManagedControlIntent(sessionId: string): ManagedControlIntentEvidence | null {
    const actionTypes = [
      "send",
      "respond",
      "interrupt",
      "set-profile",
      "set-model",
      "set-effort",
      "remove-queued",
      "end",
    ] as const satisfies readonly SessionAction["type"][];
    const placeholders = actionTypes.map(() => "?").join(", ");
    const receipt = this.#database.prepare(`
      SELECT action_type, status, created_at AS at
      FROM action_receipts
      WHERE session_id = ?
        AND action_type IN (${placeholders})
        AND status IN ('succeeded', 'unknown')
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(sessionId, ...actionTypes) as Record<string, unknown> | undefined;
    const audit = this.#database.prepare(`
      SELECT outcome.action_type, outcome.outcome AS status,
             COALESCE(intent.at, outcome.at) AS at
      FROM audit_events AS outcome
      LEFT JOIN audit_events AS intent
        ON intent.action_id = outcome.action_id
       AND intent.session_id = outcome.session_id
       AND intent.outcome = 'dispatch-attempt'
      WHERE outcome.session_id = ?
        AND outcome.action_type IN (${placeholders})
        AND outcome.outcome IN ('succeeded', 'unknown')
      ORDER BY COALESCE(intent.at, outcome.at) DESC, outcome.rowid DESC
      LIMIT 1
    `).get(sessionId, ...actionTypes) as Record<string, unknown> | undefined;
    const candidates = [receipt, audit]
      .filter((row): row is Record<string, unknown> => row !== undefined)
      .map((row) => ({
        actionType: asString(row.action_type) as SessionAction["type"],
        status: asString(row.status) as ManagedControlIntentEvidence["status"],
        at: asString(row.at),
      }));
    candidates.sort((left, right) => right.at.localeCompare(left.at));
    return candidates[0] ?? null;
  }

  recordActionReceipt(receipt: ActionReceipt): void {
    this.#database.prepare(`
      INSERT INTO action_receipts (
        session_id, idempotency_key, request_sha256, action_id,
        action_type, status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, idempotency_key) DO UPDATE SET
        request_sha256 = excluded.request_sha256,
        action_id = excluded.action_id,
        action_type = excluded.action_type,
        status = excluded.status,
        created_at = excluded.created_at,
        completed_at = excluded.completed_at
    `).run(
      receipt.sessionId,
      receipt.idempotencyKey,
      receipt.requestSha256,
      receipt.actionId,
      receipt.actionType,
      receipt.status,
      receipt.createdAt,
      receipt.completedAt,
    );
  }

  listUndispatchedActions(): PersistedAction[] {
    const rows = this.#database.prepare(`
      SELECT id, session_id, action_type, payload_json, idempotency_key, status, created_at, updated_at
      FROM queued_actions WHERE status = 'pending' ORDER BY created_at
    `).all() as unknown as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const action = parsePersistedAction(row.payload_json);
      if (!action) return [];
      if (action.type !== asString(row.action_type)) {
        throw new Error("Persisted action type does not match its payload");
      }
      return [{
        id: asString(row.id),
        sessionId: asString(row.session_id),
        actionType: asString(row.action_type) as SessionAction["type"],
        action,
        idempotencyKey: asString(row.idempotency_key),
        status: asString(row.status) as PersistedAction["status"],
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }];
    });
  }

  getPersistedAction(sessionId: string, idempotencyKey: string): PersistedAction | null {
    const row = this.#database.prepare(`
      SELECT id, session_id, action_type, payload_json, idempotency_key, status, created_at, updated_at
      FROM queued_actions WHERE session_id = ? AND idempotency_key = ?
    `).get(sessionId, idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    const action = parsePersistedAction(row.payload_json);
    if (!action) return null;
    if (action.type !== asString(row.action_type)) {
      throw new Error("Persisted action type does not match its payload");
    }
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      actionType: asString(row.action_type) as SessionAction["type"],
      action,
      idempotencyKey: asString(row.idempotency_key),
      status: asString(row.status) as PersistedAction["status"],
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  getPersistedActionStatus(
    sessionId: string,
    idempotencyKey: string,
  ): Pick<PersistedAction, "id" | "sessionId" | "actionType" | "idempotencyKey" | "status" | "createdAt" | "updatedAt"> | null {
    const row = this.#database.prepare(`
      SELECT id, session_id, action_type, idempotency_key, status, created_at, updated_at
      FROM queued_actions WHERE session_id = ? AND idempotency_key = ?
    `).get(sessionId, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      actionType: asString(row.action_type) as SessionAction["type"],
      idempotencyKey: asString(row.idempotency_key),
      status: asString(row.status) as PersistedAction["status"],
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    } : null;
  }

  audit(input: AuditEventInput): void {
    const serialized = JSON.stringify(input.action);
    const charCount = Array.from(actionText(input.action)).length;
    this.#database.prepare(`
      INSERT INTO audit_events (
        id, at, actor_id, actor_kind, action_id, session_id, generation,
        action_type, request_or_run_id, idempotency_key, precondition,
        provider_acknowledged, outcome, payload_sha256, payload_char_count,
        redacted_preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.at ?? new Date().toISOString(),
      input.actor.id,
      input.actor.kind,
      input.actionId,
      input.sessionId,
      input.generation,
      input.action.type,
      input.requestOrRunId,
      input.action.idempotencyKey,
      input.precondition,
      input.providerAcknowledged ? 1 : 0,
      input.outcome,
      createHash("sha256").update(serialized).digest("hex"),
      charCount,
      redactedPreview(input.action),
    );
  }

  auditOperation(input: OperationalAuditInput): void {
    const details = JSON.stringify(input.details ?? {});
    this.#database.prepare(`
      INSERT INTO audit_events (
        id, at, actor_id, actor_kind, action_id, session_id, generation,
        action_type, request_or_run_id, idempotency_key, precondition,
        provider_acknowledged, outcome, payload_sha256, payload_char_count,
        redacted_preview
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      randomUUID(),
      input.at ?? new Date().toISOString(),
      input.actor.id,
      input.actor.kind,
      randomUUID(),
      input.targetId,
      input.operation,
      input.phase,
      input.idempotencyKey ?? "",
      details,
      input.phase === "attempt" ? 0 : 1,
      input.outcome,
      createHash("sha256").update(details).digest("hex"),
      `${input.operation}:${input.phase}`,
    );
  }

  /**
   * Atomically records a one-shot operational intent. This reuses the durable
   * append-only audit table so safety journals do not need an independently
   * migrated schema. A claimed target remains claimed across service restarts.
   */
  claimOperationalIntent(
    operation: string,
    targetId: string,
    details: Record<string, string | number | boolean | null> = {},
  ): boolean {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#database.prepare(`
        SELECT 1 AS claimed FROM audit_events
        WHERE action_type = ? AND session_id = ? AND outcome = 'claimed'
        LIMIT 1
      `).get(operation, targetId);
      if (prior) {
        this.#database.exec("COMMIT");
        return false;
      }
      this.auditOperation({
        actor: { id: "agent-manager", kind: "local", displayName: "Agent Manager" },
        operation,
        targetId,
        phase: "attempt",
        outcome: "claimed",
        details,
      });
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the deciding persistence error.
      }
      throw error;
    }
  }
}
