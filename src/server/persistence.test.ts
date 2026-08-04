import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { SessionAction } from "./contracts.ts";
import {
  actionFingerprint,
  createSessionFingerprint,
  ManagerDatabase,
  redactedPreview,
} from "./persistence.ts";

test("crash recovery marks pending work unknown and securely scrubs full payloads", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-db-"));
  const path = join(directory, "state.sqlite");
  const action: SessionAction = {
    type: "send",
    delivery: "queue",
    text: "top-secret-unrecoverable-needle",
    expectedGeneration: 1,
    idempotencyKey: "idempotency-secret-test",
  };
  try {
    let database = new ManagerDatabase(path);
    database.persistAction({
      id: "action-1",
      sessionId: "codex:thread",
      actionType: "send",
      action,
      idempotencyKey: action.idempotencyKey,
      status: "pending",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    database.close();

    database = new ManagerDatabase(path);
    assert.equal(database.markInterruptedDispatchesUnknown(), 1);
    assert.deepEqual(database.listUndispatchedActions(), []);
    assert.equal(
      database.getActionReceipt("codex:thread", action.idempotencyKey)?.requestSha256,
      actionFingerprint(action),
    );
    assert.equal(database.getActionReceipt("codex:thread", action.idempotencyKey)?.status, "unknown");
    database.close();

    assert.equal(readFileSync(path).includes(Buffer.from(action.text)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace persistence removes configured launch targets and previews omit content", () => {
  const database = new ManagerDatabase();
  const workspace = database.addWorkspace({
    id: "ws_test",
    label: "Test",
    path: "/tmp/test",
  });
  assert.equal(database.getWorkspace(workspace.id)?.path, "/tmp/test");
  assert.equal(database.removeWorkspace(workspace.id), true);
  assert.equal(database.removeWorkspace(workspace.id), false);
  assert.equal(database.getWorkspace(workspace.id), null);
  database.close();

  const preview = redactedPreview({
    type: "send",
    delivery: "queue",
    text: "password=hunter2 and Bearer abcdefghijklmnop",
    expectedGeneration: 1,
    idempotencyKey: "idempotency-redaction",
  });
  assert.equal(preview, "send:queue;content-omitted");
  assert.doesNotMatch(preview, /hunter2|abcdefghijklmnop/);
});

test("queued work stays durable until recovery marks it unknown and scrubs content", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-queued-db-"));
  const path = join(directory, "state.sqlite");
  const action: SessionAction = {
    type: "send",
    delivery: "queue",
    text: "queued-private-needle",
    expectedGeneration: 3,
    idempotencyKey: "idempotency-queued-test",
  };
  try {
    let database = new ManagerDatabase(path);
    database.persistAction({
      id: "queued-action",
      sessionId: "claude:managed",
      actionType: "send",
      action,
      idempotencyKey: action.idempotencyKey,
      status: "pending",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    database.markActionDispatching("queued-action");
    database.markActionQueued("queued-action");
    assert.equal(database.getPersistedAction("claude:managed", action.idempotencyKey)?.status, "queued");
    database.close();

    database = new ManagerDatabase(path);
    assert.equal(database.markInterruptedDispatchesUnknown(), 1);
    assert.equal(database.getActionReceipt("claude:managed", action.idempotencyKey)?.status, "unknown");
    database.close();
    assert.equal(readFileSync(path).includes(Buffer.from(action.text)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session creation intent is durable without storing the initial message", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-create-db-"));
  const path = join(directory, "state.sqlite");
  const request = {
    provider: "codex" as const,
    workspaceId: "workspace-one",
    initialMessage: "create-private-needle",
    mode: "planning" as const,
    accessMode: "sandboxed" as const,
    idempotencyKey: "idempotency-create-test",
  };
  try {
    let database = new ManagerDatabase(path);
    const begun = database.beginCreateSessionIntent({ actorId: "local", request });
    assert.equal(begun.created, true);
    assert.equal(begun.intent.requestSha256, createSessionFingerprint(request));
    database.markCreateSessionDispatching("local", request.idempotencyKey);
    database.close();

    database = new ManagerDatabase(path);
    assert.equal(database.recoverCreateSessionIntents(), 1);
    assert.equal(
      database.getCreateSessionIntent("local", request.idempotencyKey)?.status,
      "unknown",
    );
    database.close();
    assert.equal(readFileSync(path).includes(Buffer.from(request.initialMessage)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace identity is scoped to its host and removing a host cascades only its paths", () => {
  const database = new ManagerDatabase();
  database.addHost({
    id: "host-studio",
    label: "Studio Mac",
    kind: "ssh",
    sshTarget: "robert@studio.local",
  });
  const local = database.addWorkspace({
    id: "workspace-local",
    hostId: "local",
    label: "Project",
    path: "/Users/robert/project",
  });
  const remote = database.addWorkspace({
    id: "workspace-remote",
    hostId: "host-studio",
    label: "Project",
    path: "/Users/robert/project",
    remoteWorkspaceId: "remote-workspace",
  });

  assert.notEqual(local.id, remote.id);
  assert.equal(remote.hostLabel, "Studio Mac");
  assert.equal(remote.remoteWorkspaceId, "remote-workspace");
  assert.equal(database.listWorkspaces().length, 2);
  assert.equal(database.removeHost("host-studio"), true);
  assert.deepEqual(database.listWorkspaces().map((workspace) => workspace.id), ["workspace-local"]);
  database.close();
});

test("migrates legacy path-only workspaces onto the implicit local host", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-workspace-migration-"));
  const path = join(directory, "state.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      ) STRICT;
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
      INSERT INTO workspaces VALUES ('legacy-workspace', 'Legacy', '/tmp/legacy', '2026-08-01T00:00:00.000Z');
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new ManagerDatabase(path);
    assert.deepEqual(migrated.getWorkspace("legacy-workspace"), {
      id: "legacy-workspace",
      label: "Legacy",
      path: "/tmp/legacy",
      hostId: "local",
      hostLabel: "This Mac",
      hostKind: "local",
      remoteWorkspaceId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
