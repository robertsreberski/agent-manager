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

test("restart recovers an interrupted handoff when a bounded owner scan proves absence", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "interrupted", {
    ownership: "handoff-prepared",
    handoffId: "handoff-before-restart",
    nativeOwner: null,
    managerControl: "active",
  });
  const state = new SessionStateStore();
  let ownerScans = 0;
  let restores = 0;
  const inspector: LocalCliProcessInspector = {
    inspect() { return { state: "exited" }; },
    findAssociated() {
      ownerScans += 1;
      return { state: "exited" };
    },
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
        assert.equal(record.ownership, "manager-exclusive");
        assert.equal(record.nativeOwner, null);
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
    assert.equal(state.get("local:claude:interrupted")?.control.recovery, null);
    assert.equal(restores, 1);
  }, "interrupted handoff recovery");
  assert.ok(ownerScans > 1, "absence must be stable across the bounded window");
  const persisted = database.listManagedSessions().find(
    (record) => record.id === "local:claude:interrupted",
  );
  assert.equal(persisted?.metadata.ownership, "manager-exclusive");
  assert.equal(persisted?.metadata.nativeOwner, null);
  assert.equal(persisted?.metadata.handoffId, null);
});

test("restart keeps an exact native Claude owner foreign and publishes a truthful waiting state", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  persistClaude(database, "native-owner", {
    ownership: "handoff-prepared",
    handoffId: "handoff-native",
    nativeOwner: null,
    managerControl: "active",
  });
  const state = new SessionStateStore();
  const identity: LocalCliProcessIdentity = {
    pid: 42_424,
    uid: process.getuid?.() ?? 501,
    executable: "claude",
    startedAt: "Wed Aug 5 10:00:00 2026",
    providerSessionId: "native-owner",
    cwd: "/tmp/workspace",
  };
  let restores = 0;
  let ownerScans = 0;
  let ownerRunning = true;
  const inspector: LocalCliProcessInspector = {
    inspect(_session, expected) {
      return ownerRunning
        ? { state: "running", identity: expected ?? identity }
        : { state: "exited" };
    },
    findAssociated() {
      ownerScans += 1;
      return ownerScans === 1
        ? {
            state: "pending",
            identity,
            reason: "Claude registry publication is still settling",
          }
        : { state: "running", identity };
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
    cliTakeoverTimings: { inspectionTimeoutMs: 50, pollIntervalMs: 2 },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.listen();

  await waitFor(() => {
    const observed = state.get("local:claude:native-owner");
    assert.equal(observed?.control.recovery?.state, "waiting-for-native-exit");
    assert.equal(observed?.control.authority, "foreign");
    assert.equal(observed?.control.plane, "resume-only");
    assert.equal(observed?.presence, "live");
    assert.deepEqual(observed?.control.capabilities, []);
  }, "native owner waiting state");
  assert.equal(restores, 0);
  const persisted = database.listManagedSessions().find(
    (record) => record.id === "local:claude:native-owner",
  );
  assert.equal(persisted?.metadata.ownership, "native-exclusive");
  assert.equal((persisted?.metadata.nativeOwner as { pid?: number } | null)?.pid, identity.pid);

  ownerRunning = false;
  backend.recoverManagedProvider("claude");
  await waitFor(() => {
    assert.equal(state.get("local:claude:native-owner")?.control.recovery, null);
    assert.equal(state.get("local:claude:native-owner")?.control.authority, "manager");
    assert.equal(restores, 1);
  }, "manager reclaim after exact native exit");
  const reclaimed = database.listManagedSessions().find(
    (record) => record.id === "local:claude:native-owner",
  );
  assert.equal(reclaimed?.metadata.ownership, "manager-exclusive");
  assert.equal(reclaimed?.metadata.nativeOwner, null);
});

test("restart recovery can transfer an exact native Claude owner entirely in the web app", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
  const identity: LocalCliProcessIdentity = {
    pid: 52_525,
    uid: process.getuid?.() ?? 501,
    executable: "claude",
    startedAt: "Wed Aug 5 11:00:00 2026",
    providerSessionId: "native-web-transfer",
    cwd: "/tmp/workspace",
    interactive: true,
  };
  persistClaude(database, identity.providerSessionId, {
    ownership: "native-exclusive",
    nativeOwner: identity,
    managerControl: "active",
  });
  const state = new SessionStateStore();
  let ownerRunning = true;
  let pinnedIdentity = identity;
  let signals = 0;
  let resumes = 0;
  let recoveryRestores = 0;
  const inspector: LocalCliProcessInspector = {
    inspect(_session, expected) {
      if (!ownerRunning) return { state: "exited" };
      if (expected) pinnedIdentity = expected;
      return { state: "running", identity: pinnedIdentity };
    },
    findAssociated() {
      return ownerRunning
        ? { state: "running", identity: pinnedIdentity }
        : { state: "exited" };
    },
    terminate(expected) {
      assert.equal(expected.pid, identity.pid);
      assert.equal(expected.providerSessionId, identity.providerSessionId);
      signals += 1;
      ownerRunning = false;
    },
  };
  let adopted: SessionView | null = null;
  const adapter: ProviderControlAdapter = {
    async createSession() { throw new Error("not used"); },
    async resumeSession(original, profile) {
      resumes += 1;
      assert.equal(original.providerThreadId, identity.providerSessionId);
      assert.equal(profile, "ask-first");
      adopted = {
        ...original,
        pid: null,
        runtimePid: null,
        presence: "live",
        status: "idle",
        providerStatus: "idle",
        source: "claude-sdk",
        profile: {
          value: profile,
          providerValue: profile,
          source: "provider-api",
          confidence: "exact",
        },
        control: {
          plane: "claude-sdk",
          authority: "manager",
          coordination: providerControlCoordination("claude"),
          recovery: null,
          capabilities: ["queue", "steer", "interrupt", "end", "attach"],
          withheld: [],
          takeover: null,
        },
      };
      return adopted;
    },
    async commitExternalAdoption(providerSessionId) {
      assert.equal(providerSessionId, identity.providerSessionId);
      assert.ok(adopted);
      return adopted;
    },
    async restoreManagedSessions(records) {
      recoveryRestores += 1;
      for (const record of records) state.upsert(recoveredView(record));
      return {
        restoredSessionIds: records.map((record) => record.managerSessionId),
        failures: [],
        truncated: false,
      };
    },
    async performAction() { return { status: "succeeded" }; },
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 43_127,
    database,
    state,
    adapters: { claude: adapter },
    cliTakeoverInspector: inspector,
    transcriptReader: {
      read() {
        return {
          items: [],
          transcript: {
            state: "available",
            source: "claude-transcript",
            truncated: false,
            itemCount: 0,
            reason: null,
          },
        };
      },
    },
    cliTakeoverTimings: {
      inspectionTimeoutMs: 50,
      gracefulExitTimeoutMs: 100,
      adoptionTimeoutMs: 100,
      persistenceTimeoutMs: 100,
      pollIntervalMs: 2,
    },
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.app.ready();
  backend.recoverManagedProvider("claude");

  await waitFor(() => {
    const waiting = state.get("local:claude:native-web-transfer");
    assert.equal(waiting?.control.recovery?.state, "waiting-for-native-exit");
    assert.equal(waiting?.control.takeover?.state, "available");
    assert.equal(waiting?.control.capabilities.includes("take-control"), true);
  }, "browser takeover offer");
  const authenticated = await authenticatedHeaders(backend);
  const offered = state.get("local:claude:native-web-transfer");
  assert.ok(offered);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "recovery-web-transfer" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const lease = leaseResponse.json<{ lease: { token: string } }>().lease.token;
  const post = (payload: Record<string, unknown>) => backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": lease },
    payload,
  });

  const preparedResponse = await post({
    type: "take-control",
    method: "graceful-stop",
    expectedGeneration: offered.generation,
    idempotencyKey: "prepare-recovery-web-transfer",
  });
  assert.equal(preparedResponse.statusCode, 200, preparedResponse.body);
  const prepared = state.get(offered.id);
  assert.equal(prepared?.control.recovery, null);
  assert.equal(prepared?.control.takeover?.state, "awaiting-confirmation");
  assert.equal(signals, 0, "preparation must never signal");
  assert.equal(recoveryRestores, 0, "takeover owns recovery after preparation");

  const firstTakeoverId = prepared?.control.takeover?.id;
  assert.ok(firstTakeoverId);
  const cancelledResponse = await post({
    type: "cancel-take-control",
    takeoverId: firstTakeoverId,
    expectedGeneration: prepared?.generation,
    idempotencyKey: "cancel-recovery-web-transfer",
  });
  assert.equal(cancelledResponse.statusCode, 200, cancelledResponse.body);
  await waitFor(() => {
    const waiting = state.get(offered.id);
    assert.equal(waiting?.control.recovery?.state, "waiting-for-native-exit");
    assert.equal(waiting?.control.takeover?.state, "available");
  }, "automatic recovery after takeover cancellation");
  assert.equal(signals, 0);
  assert.equal(recoveryRestores, 0);

  const retriedOffer = state.get(offered.id);
  assert.ok(retriedOffer);
  const retriedPrepareResponse = await post({
    type: "take-control",
    method: "graceful-stop",
    expectedGeneration: retriedOffer.generation,
    idempotencyKey: "retry-prepare-recovery-web-transfer",
  });
  assert.equal(retriedPrepareResponse.statusCode, 200, retriedPrepareResponse.body);
  const retriedPrepared = state.get(offered.id);
  assert.equal(retriedPrepared?.control.takeover?.state, "awaiting-confirmation");
  const takeoverId = retriedPrepared?.control.takeover?.id;
  assert.ok(takeoverId);
  assert.notEqual(takeoverId, firstTakeoverId);
  const confirmedResponse = await post({
    type: "take-control",
    method: "graceful-stop",
    takeoverId,
    expectedGeneration: retriedPrepared?.generation,
    idempotencyKey: "confirm-recovery-web-transfer",
  });
  assert.equal(confirmedResponse.statusCode, 200, confirmedResponse.body);
  await waitFor(() => {
    assert.equal(state.get(offered.id)?.control.authority, "manager");
    assert.equal(state.get(offered.id)?.control.recovery, null);
  }, "manager adoption");
  assert.equal(signals, 1);
  assert.equal(resumes, 1);
  assert.equal(recoveryRestores, 0);
  const persisted = database.listManagedSessions().find((record) => record.id === offered.id);
  assert.equal(persisted?.metadata.ownership, "manager-exclusive");
  assert.equal(persisted?.metadata.nativeOwner, null);
  assert.equal(persisted?.metadata.recovery, null);
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
