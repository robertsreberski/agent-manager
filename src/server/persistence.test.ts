import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { digestCodexHookToken } from "../providers/codex/codex-hook-auth.ts";
import { digestHookBearerToken } from "../providers/hooks/auth.ts";
import type { SessionAction } from "./contracts.ts";
import {
  actionFingerprint,
  createSessionFingerprint,
  IncompatibleDatabaseError,
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
  assert.equal(redactedPreview({
    type: "resume",
    expectedGeneration: 2,
    idempotencyKey: "idempotency-resume-preview",
  }), "resume");
});

test("persists Claude hook authorization as a digest and tracks monotonic liveness", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-hook-db-"));
  const path = join(directory, "state.sqlite");
  const bearer = "plaintext-hook-token-that-must-not-enter-agent-manager-state";
  const digest = digestHookBearerToken(bearer);
  try {
    let database = new ManagerDatabase(path);
    assert.deepEqual(database.upsertClaudeHookInstallRecord({
      id: "hook-install-1",
      provider: "claude",
      schemaVersion: 1,
      tokenDigest: digest,
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/Users/test/.claude/settings.json",
      endpoint: "http://127.0.0.1:43127/api/v1/hooks/claude",
      createdHooksProperty: true,
    }), {
      id: "hook-install-1",
      provider: "claude",
      schemaVersion: 1,
      tokenDigest: digest,
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/Users/test/.claude/settings.json",
      endpoint: "http://127.0.0.1:43127/api/v1/hooks/claude",
      createdHooksProperty: true,
      lastSeenAt: null,
    });
    assert.equal(database.markClaudeHookSeen("hook-install-1", "2026-08-04T12:01:00.000Z"), true);
    assert.equal(database.markClaudeHookSeen("hook-install-1", "2026-08-04T12:00:30.000Z"), false);
    database.close();

    database = new ManagerDatabase(path);
    assert.equal(
      database.getClaudeHookInstallRecord("/Users/test/.claude/settings.json")?.lastSeenAt,
      "2026-08-04T12:01:00.000Z",
    );
    assert.equal(database.removeClaudeHookInstallRecord("hook-install-1"), true);
    assert.equal(database.listClaudeHookInstallRecords().length, 0);
    database.close();

    assert.equal(readFileSync(path).includes(Buffer.from(bearer)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists Codex hook digests and integrity metadata without its bearer", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-codex-hook-db-"));
  const path = join(directory, "state.sqlite");
  const bearer = "codex-plaintext-token-that-must-not-enter-agent-manager-state";
  const digest = digestCodexHookToken(bearer);
  const shimDigest = `sha256:${"b".repeat(64)}`;
  try {
    let database = new ManagerDatabase(path);
    const stored = database.upsertCodexHookInstallRecord({
      id: "codex-hook-install-1",
      provider: "codex",
      schemaVersion: 1,
      tokenDigest: digest,
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/Users/test/.codex/hooks.json",
      shimPath: "/Users/test/Library/Application Support/agent-manager/hooks/codex-hook.mjs",
      endpoint: "http://127.0.0.1:43127/api/v1/hooks/codex",
      command: "'/Users/test/Library/Application Support/agent-manager/hooks/codex-hook.mjs'",
      shimDigest,
    });
    assert.equal(stored.lastSeenAt, null);
    assert.equal(database.markCodexHookSeen("codex-hook-install-1", "2026-08-04T12:01:00.000Z"), true);
    database.close();

    database = new ManagerDatabase(path);
    assert.equal(
      database.getCodexHookInstallRecord("/Users/test/.codex/hooks.json")?.lastSeenAt,
      "2026-08-04T12:01:00.000Z",
    );
    assert.equal(database.removeCodexHookInstallRecord("codex-hook-install-1"), true);
    database.close();
    assert.equal(readFileSync(path).includes(Buffer.from(bearer)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("managed control intent evidence survives reopen and follows the latest provider intent", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-control-intent-db-"));
  const path = join(directory, "state.sqlite");
  const recordReceipt = (
    database: ManagerDatabase,
    input: {
      sessionId: string;
      idempotencyKey: string;
      actionType: SessionAction["type"];
      status: "succeeded" | "unknown";
      at: string;
    },
  ): void => {
    database.recordActionReceipt({
      ...input,
      requestSha256: `sha256:${input.idempotencyKey}`,
      actionId: `action:${input.idempotencyKey}`,
      createdAt: input.at,
      completedAt: input.at,
    });
  };

  try {
    let database = new ManagerDatabase(path);
    assert.equal(database.getLatestManagedControlIntent("claude:no-evidence"), null);
    recordReceipt(database, {
      sessionId: "claude:ended-successfully",
      idempotencyKey: "end-success",
      actionType: "end",
      status: "succeeded",
      at: "2026-08-05T10:00:00.000Z",
    });
    recordReceipt(database, {
      sessionId: "claude:end-outcome-unknown",
      idempotencyKey: "end-unknown",
      actionType: "end",
      status: "unknown",
      at: "2026-08-05T10:01:00.000Z",
    });
    recordReceipt(database, {
      sessionId: "claude:resumed-after-end",
      idempotencyKey: "end-before-send",
      actionType: "end",
      status: "succeeded",
      at: "2026-08-05T10:02:00.000Z",
    });
    recordReceipt(database, {
      sessionId: "claude:resumed-after-end",
      idempotencyKey: "send-after-end",
      actionType: "send",
      status: "succeeded",
      at: "2026-08-05T10:03:00.000Z",
    });
    database.close();

    database = new ManagerDatabase(path);
    assert.equal(database.getLatestManagedControlIntent("claude:no-evidence"), null);
    assert.deepEqual(database.getLatestManagedControlIntent("claude:ended-successfully"), {
      actionType: "end",
      status: "succeeded",
      at: "2026-08-05T10:00:00.000Z",
    });
    assert.deepEqual(database.getLatestManagedControlIntent("claude:end-outcome-unknown"), {
      actionType: "end",
      status: "unknown",
      at: "2026-08-05T10:01:00.000Z",
    });
    assert.deepEqual(database.getLatestManagedControlIntent("claude:resumed-after-end"), {
      actionType: "send",
      status: "succeeded",
      at: "2026-08-05T10:03:00.000Z",
    });
    database.close();
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
    profile: "plan" as const,
    model: null,
    effort: null,
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

test("one-shot operational intents remain claimed across database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-intent-"));
  const path = join(directory, "state.sqlite");
  try {
    let database = new ManagerDatabase(path);
    assert.equal(database.claimOperationalIntent(
      "takeover.signal-intent",
      "sha256:identity-one",
      { pid: 1234 },
    ), true);
    assert.equal(database.claimOperationalIntent(
      "takeover.signal-intent",
      "sha256:identity-one",
      { pid: 1234 },
    ), false);
    database.close();

    database = new ManagerDatabase(path);
    assert.equal(database.claimOperationalIntent(
      "takeover.signal-intent",
      "sha256:identity-one",
    ), false);
    assert.equal(database.claimOperationalIntent(
      "takeover.signal-intent",
      "sha256:identity-two",
    ), true);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an incompatible database without migrating or deleting its records", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-workspace-reject-"));
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

    const inspected = new DatabaseSync(path, { readOnly: true });
    assert.throws(() => new ManagerDatabase(path), IncompatibleDatabaseError);
    assert.equal(
      (inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      2,
    );
    assert.equal(
      (inspected.prepare("SELECT label FROM workspaces WHERE id = 'legacy-workspace'").get() as { label: string }).label,
      "Legacy",
    );
    inspected.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
