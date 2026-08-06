import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import {
  emptyChildSummary,
  providerControlCoordination,
} from "../shared/session.ts";
import type {
  ManagedSessionRecoveryRecord,
  ProviderControlAdapter,
} from "./contracts.ts";
import type {
  LocalCliProcessIdentity,
  LocalCliProcessInspector,
} from "./cli-takeover.ts";
import { ManagerDatabase } from "./persistence.ts";
import { createAgentManagerServer } from "./server.ts";
import { SessionStateStore } from "./state.ts";
import { unknownSandbox } from "../shared/session.ts";

const createdAt = "2026-08-05T08:00:00.000Z";

function persistClaude(
  database: ManagerDatabase,
  threadId: string,
  metadata: Record<string, unknown>,
): void {
  database.upsertManagedSession({
    id: `local:claude:${threadId}`,
    provider: "claude",
    providerSessionId: threadId,
    workspaceId: "workspace",
    metadata: {
      managerRequestId: `manager-request:${threadId}`,
      name: threadId,
      profile: "ask-first",
      model: "claude-sonnet-4-5",
      effort: null,
      hostId: "local",
      ...metadata,
    },
    createdAt,
    updatedAt: createdAt,
  });
}

function recoveredView(record: ManagedSessionRecoveryRecord): SessionView {
  return {
    sandbox: unknownSandbox(),
    id: record.managerSessionId,
    provider: "claude",
    providerThreadId: record.providerThreadId,
    providerTreeId: record.providerThreadId,
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: record.name,
    cwd: record.workspacePath,
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: null,
    runtimePid: null,
    startedAt: record.createdAt,
    updatedAt: new Date().toISOString(),
    childSummary: emptyChildSummary(),
    statusSource: "provider-api",
    source: "claude-sdk",
    profile: {
      value: record.profile,
      providerValue: record.profile,
      source: "provider-api",
      confidence: "exact",
    },
    model: {
      value: record.model ?? null,
      providerValue: record.model ?? null,
      source: "provider-api",
      confidence: "exact",
    },
    effort: {
      value: record.effort ?? null,
      providerValue: record.effort ?? null,
      source: "provider-api",
      confidence: "exact",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "claude-sdk",
      authority: "manager",
      coordination: providerControlCoordination("claude"),
      recovery: null,
      capabilities: ["queue", "steer", "interrupt", "end", "attach"],
      withheld: [],
      peers: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 1,
  };
}

async function waitFor(assertion: () => void, label: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${label}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function authenticatedHeaders(
  backend: Awaited<ReturnType<typeof createAgentManagerServer>>,
): Promise<Record<string, string>> {
  const host = "127.0.0.1:43127";
  const origin = "http://127.0.0.1:43127";
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  assert.ok(cookie);
  return {
    host,
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": response.json<{ csrfToken: string }>().csrfToken,
  };
}

function recoveryAdapter(
  state: SessionStateStore,
  onRestore: (record: ManagedSessionRecoveryRecord) => void = () => undefined,
): ProviderControlAdapter {
  return {
    async createSession() { throw new Error("not used"); },
    async performAction() { return { status: "succeeded" }; },
    async restoreManagedSessions(records) {
      for (const record of records) {
        onRestore(record);
        state.upsert(recoveredView(record));
      }
      return {
        restoredSessionIds: records.map((record) => record.managerSessionId),
        failures: [],
        truncated: false,
      };
    },
  };
}

/*
  These three tests are replaced by the two below. They asserted the exclusivity
  contract directly: an interrupted handoff had to be unwound after a bounded scan
  proved the native process was gone; a live native owner had to stay `foreign`
  and publish `waiting-for-native-exit`; and the operator could take that
  ownership back from the browser. Shared join removes all three premises — a live
  native process is a peer, so recovery just opens the manager's query beside it.
*/

test("restart re-joins a session whose native writer is still running", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "live-peer", { ownership: "shared", managerControl: "active" });
  const state = new SessionStateStore();
  let restores = 0;
  const recoveries: Array<string | null> = [];
  // A live, exactly-associated native owner. Under exclusivity this parked
  // recovery indefinitely; now it is simply another writer.
  const inspector: LocalCliProcessInspector = {
    inspect() {
      return {
        state: "running",
        identity: {
          pid: 4242,
          uid: process.getuid?.() ?? 501,
          executable: "claude",
          startedAt: "Wed Aug 5 10:00:00 2026",
          providerSessionId: "live-peer",
          cwd: "/tmp/workspace",
          interactive: true,
        },
      };
    },
    findAssociated() {
      return {
        state: "running",
        identity: {
          pid: 4242,
          uid: process.getuid?.() ?? 501,
          executable: "claude",
          startedAt: "Wed Aug 5 10:00:00 2026",
          providerSessionId: "live-peer",
          cwd: "/tmp/workspace",
          interactive: true,
        },
      };
    },
    terminate() {},
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    database,
    state,
    adapters: {
      claude: recoveryAdapter(state, () => { restores += 1; }),
    },
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { inspectionTimeoutMs: 20, pollIntervalMs: 2 },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    const recovery = state.get("local:claude:live-peer")?.control.recovery;
    recoveries.push(recovery?.state ?? null);
    assert.equal(recovery, null);
    assert.equal(restores, 1);
  }, "join recovery beside a live native writer");
  // No healthy indefinite wait, and no retry churn on the way there.
  assert.equal(
    recoveries.some((entry) => entry !== null && entry !== "reconnecting"),
    false,
    `recovery must not enter any waiting or failing state: ${recoveries.join(",")}`,
  );
  const persisted = database.listManagedSessions().find(
    (record) => record.id === "local:claude:live-peer",
  );
  assert.equal(persisted?.metadata.ownership, "shared");
});

test("restart resumes a session whose writer has exited", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "no-peer", { ownership: "shared", managerControl: "active" });
  const state = new SessionStateStore();
  let restores = 0;
  const inspector: LocalCliProcessInspector = {
    inspect() { return { state: "exited" }; },
    findAssociated() { return { state: "exited" }; },
    terminate() {},
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    database,
    state,
    adapters: {
      claude: recoveryAdapter(state, (record) => {
        restores += 1;
        assert.equal(record.ownership, "shared");
      }),
    },
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { inspectionTimeoutMs: 20, pollIntervalMs: 2 },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    assert.equal(state.get("local:claude:no-peer")?.control.recovery, null);
    assert.equal(restores, 1);
  }, "resume recovery with no live writer");
});


test("legacy Claude managerControl migration uses durable End evidence exactly once", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "legacy-active", { ownership: "manager-exclusive" });
  persistClaude(database, "legacy-stopped", { ownership: "manager-exclusive" });
  database.recordActionReceipt({
    sessionId: "local:claude:legacy-stopped",
    idempotencyKey: "legacy-end",
    requestSha256: "sha256",
    actionId: "action-end",
    actionType: "end",
    status: "unknown",
    createdAt: "2026-08-05T09:00:00.000Z",
    completedAt: "2026-08-05T09:00:01.000Z",
  });
  const backend = await createAgentManagerServer({
    database,
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    cliTakeoverInspector: {
      inspect() { return { state: "exited" }; },
      findAssociated() { return { state: "exited" }; },
      terminate() {},
    },
    cliTakeoverTimings: { inspectionTimeoutMs: 10, pollIntervalMs: 2 },
  });
  t.after(() => backend.close());

  const records = new Map(database.listManagedSessions().map((record) => [record.id, record]));
  assert.equal(records.get("local:claude:legacy-active")?.metadata.managerControl, "active");
  assert.equal(records.get("local:claude:legacy-stopped")?.metadata.managerControl, "stopped");
  assert.equal(records.get("local:claude:legacy-active")?.updatedAt, createdAt);
  assert.equal(records.get("local:claude:legacy-stopped")?.updatedAt, createdAt);
});

/*
  A restart-survival regression, found by testing the real deployed server rather
  than fixtures. Four production sites persisted `ownership: "manager-exclusive"`
  for Claude while the reader's `managedOwnershipSchema` accepts only `"shared"`,
  so every adopted or created Claude session became unreadable on the next
  restart: recovery skipped it as an invalid persisted identity and web control
  was silently lost. It typechecked because `ManagedSessionMetadata.metadata` is
  `Record<string, unknown>`, so nothing connected the writer to the reader.

  This asserts the round trip the types cannot: what the server writes is what the
  server can read back.
*/
test("a persisted managed Claude identity survives its own write on restart", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "round-trip", { ownership: "shared", managerControl: "active" });
  const state = new SessionStateStore();
  let restores = 0;
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    database,
    state,
    adapters: {
      claude: recoveryAdapter(state, (record) => {
        restores += 1;
        assert.equal(record.ownership, "shared");
      }),
    },
    cliTakeoverInspector: {
      inspect() { return { state: "exited" }; },
      findAssociated() { return { state: "exited" }; },
      terminate() {},
    },
    cliTakeoverTimings: { inspectionTimeoutMs: 20, pollIntervalMs: 2 },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    assert.equal(restores, 1, "the persisted identity must be recovered, not skipped");
    assert.equal(state.get("local:claude:round-trip")?.control.recovery, null);
  }, "managed Claude restart round trip");
  assert.deepEqual(
    state.snapshot().diagnostics.filter((d) => /Skipped invalid persisted/u.test(d.message)),
    [],
    "a record the server wrote itself must never be rejected as invalid",
  );
});

test("an exact pre-cutover Claude identity canonicalizes only after shared recovery succeeds", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "pre-cutover", {
    ownership: "manager-exclusive",
    managerControl: "active",
    nativeOwner: null,
    handoffId: null,
  });
  const state = new SessionStateStore();
  let restores = 0;
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    database,
    state,
    adapters: {
      claude: recoveryAdapter(state, (record) => {
        restores += 1;
        assert.equal(record.ownership, "shared");
      }),
    },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    assert.equal(restores, 1);
    assert.equal(state.get("local:claude:pre-cutover")?.control.recovery, null);
    assert.equal(
      database.listManagedSessions().find(
        (record) => record.id === "local:claude:pre-cutover",
      )?.metadata.ownership,
      "shared",
    );
  }, "legacy Claude shared recovery");
  const persisted = database.listManagedSessions().find(
    (record) => record.id === "local:claude:pre-cutover",
  );
  assert.equal(persisted?.metadata.ownership, "shared");
  assert.equal("nativeOwner" in (persisted?.metadata ?? {}), false);
  assert.equal("handoffId" in (persisted?.metadata ?? {}), false);
  assert.equal(persisted?.createdAt, createdAt);
  assert.equal(
    state.snapshot().diagnostics.some((d) => /Skipped invalid persisted/u.test(d.message)),
    false,
  );
});

test("a deliberately stopped pre-cutover Claude identity canonicalizes without becoming active", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "legacy-stopped-control", {
    ownership: "manager-exclusive",
    managerControl: "stopped",
    nativeOwner: null,
    handoffId: null,
  });
  const state = new SessionStateStore();
  let restores = 0;
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    database,
    state,
    adapters: {
      claude: recoveryAdapter(state, (record) => {
        restores += 1;
        assert.equal(record.managerControl, "stopped");
        assert.equal(record.ownership, "shared");
      }),
    },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    assert.equal(restores, 1);
    assert.equal(
      database.listManagedSessions().find(
        (record) => record.id === "local:claude:legacy-stopped-control",
      )?.metadata.ownership,
      "shared",
    );
  }, "stopped legacy Claude canonicalization");
});

test("a failed exact Claude recovery leaves legacy ownership unchanged", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "legacy-failure", {
    ownership: "manager-exclusive",
    managerControl: "active",
    nativeOwner: null,
    handoffId: null,
  });
  const state = new SessionStateStore();
  let attempts = 0;
  const adapter: ProviderControlAdapter = {
    async createSession() { throw new Error("not used"); },
    async performAction() { return { status: "succeeded" }; },
    async restoreManagedSessions(records) {
      attempts += 1;
      return {
        restoredSessionIds: [],
        failures: records.map((record) => ({
          managerSessionId: record.managerSessionId,
          providerThreadId: record.providerThreadId,
          reason: "provider rejected the exact identity",
        })),
        truncated: false,
      };
    },
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    database,
    state,
    adapters: { claude: adapter },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    assert.equal(attempts, 1);
    assert.match(
      state.get("local:claude:legacy-failure")?.control.recovery?.error ?? "",
      /provider rejected the exact identity/u,
    );
  }, "failed legacy Claude recovery");
  const persisted = database.listManagedSessions().find(
    (record) => record.id === "local:claude:legacy-failure",
  );
  assert.equal(persisted?.metadata.ownership, "manager-exclusive");
  assert.equal(persisted?.metadata.nativeOwner, null);
  assert.equal(persisted?.metadata.handoffId, null);
});

test("ambiguous pre-cutover Claude ownership still fails closed", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "handoff", {
    ownership: "handoff-prepared",
    managerControl: "active",
    handoffId: "handoff-before-restart",
    nativeOwner: null,
  });
  persistClaude(database, "native", {
    ownership: "manager-exclusive",
    managerControl: "active",
    handoffId: null,
    nativeOwner: { pid: 42_424 },
  });
  const state = new SessionStateStore();
  let restores = 0;
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    database,
    state,
    adapters: { claude: recoveryAdapter(state, () => { restores += 1; }) },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    assert.equal(
      state.snapshot().diagnostics.filter((d) => /Skipped invalid persisted/u.test(d.message)).length,
      2,
    );
  }, "ambiguous legacy ownership rejection");
  assert.equal(restores, 0);
});
