import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Provider } from "../core/types.ts";
import type { Actor, CreateSessionInput, SessionAction } from "./contracts.ts";

export interface WorkspaceRecord {
  id: string;
  label: string;
  path: string;
  hostId: string;
  hostLabel: string;
  hostKind: "local" | "ssh";
  remoteWorkspaceId: string | null;
  createdAt: string;
}

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

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function actionText(action: SessionAction): string {
  if (action.type === "send") return action.text;
  if (action.type === "respond") {
    return typeof action.response === "string" ? action.response : JSON.stringify(action.response);
  }
  return action.type === "set-mode" ? action.mode : "interrupt";
}

/** Audit previews contain operation metadata only, never prompt or response text. */
export function redactedPreview(action: SessionAction): string {
  switch (action.type) {
    case "send": return `send:${action.delivery};content-omitted`;
    case "respond": return `respond:${action.response.kind};content-omitted`;
    case "interrupt": return "interrupt";
    case "set-mode": return `set-mode:${action.mode}`;
  }
}

export class ManagerDatabase {
  readonly path: string;
  #database: DatabaseSync;

  constructor(path = ":memory:") {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(`
      PRAGMA secure_delete = ON;
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
    `);
    const version = Number((this.#database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
    if (version < 2) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE queued_actions RENAME TO queued_actions_v1;
        CREATE TABLE queued_actions (
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
        INSERT INTO queued_actions
          SELECT id, session_id, action_type, payload_json, idempotency_key,
                 status, created_at, updated_at
          FROM queued_actions_v1;
        DROP TABLE queued_actions_v1;
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
    const workspaceColumns = this.#database.prepare("PRAGMA table_info(workspaces)").all() as unknown as Array<{ name: string }>;
    if (!workspaceColumns.some((column) => column.name === "host_id")) {
      this.#database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        ALTER TABLE managed_sessions RENAME TO managed_sessions_v2;
        ALTER TABLE workspaces RENAME TO workspaces_v2;
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          path TEXT NOT NULL,
          host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
          remote_workspace_id TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (host_id, path)
        ) STRICT;
        INSERT INTO workspaces (id, label, path, host_id, remote_workspace_id, created_at)
          SELECT id, label, path, 'local', NULL, created_at FROM workspaces_v2;
        CREATE TABLE managed_sessions (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
          provider_session_id TEXT NOT NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (provider, provider_session_id)
        ) STRICT;
        INSERT INTO managed_sessions
          SELECT id, provider, provider_session_id, workspace_id, metadata_json, created_at, updated_at
          FROM managed_sessions_v2;
        DROP TABLE managed_sessions_v2;
        DROP TABLE workspaces_v2;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } else {
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
    this.#database.exec("PRAGMA user_version = 3;");
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
      metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
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
        const action = safeJsonParse<SessionAction | null>(row.payload_json, null);
        if (action) {
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
      const action = safeJsonParse<SessionAction | null>(row.payload_json, null);
      if (!action) return [];
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
    const action = safeJsonParse<SessionAction | null>(row.payload_json, null);
    if (!action) return null;
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
}
