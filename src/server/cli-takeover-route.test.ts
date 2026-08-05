import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import {
  observeOnlyControl,
  providerControlCoordination,
} from "../shared/session.ts";
import type {
  ActionDispatchResult,
  CreateSessionInput,
  ProviderControlAdapter,
  RequestContext,
  SessionAction,
} from "./contracts.ts";
import type {
  LocalCliInspection,
  LocalCliProcessIdentity,
  LocalCliProcessInspector,
} from "./cli-takeover.ts";
import { ManagerDatabase } from "./persistence.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "local:codex:takeover-thread",
    provider: "codex",
    providerThreadId: "takeover-thread",
    providerTreeId: "takeover-thread",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Foreign Codex CLI",
    cwd: "/workspace/takeover",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: 42,
    runtimePid: 42,
    startedAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:00:00.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "process",
    source: "fixture",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: "gpt-test", providerValue: "gpt-test", source: "provider-cli", confidence: "exact" },
    effort: { value: "high", providerValue: "high", source: "provider-cli", confidence: "exact" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: observeOnlyControl(),
    workspaceIdentity: null,
    generation: 1,
    ...overrides,
  };
}

const identity: LocalCliProcessIdentity = {
  pid: 42,
  uid: 501,
  executable: "codex",
  startedAt: "Wed Aug 5 10:00:00 2026",
  providerSessionId: "takeover-thread",
  cwd: "/workspace/takeover",
};

class Inspector implements LocalCliProcessInspector {
  inspection: LocalCliInspection = { state: "running", identity };
  inspect(): LocalCliInspection { return structuredClone(this.inspection); }
  terminate(): void { throw new Error("guided takeover must not signal"); }
}

class GracefulInspector extends Inspector {
  signals = 0;
  override terminate(): void { this.signals += 1; }
}

class ResumeInspector extends Inspector {
  associated: LocalCliInspection = { state: "exited" };
  findAssociated(): LocalCliInspection { return structuredClone(this.associated); }
}

async function headers(backend: Awaited<ReturnType<typeof createAgentManagerServer>>) {
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ csrfToken: string }>();
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  assert.ok(cookie);
  return { host, origin, cookie, "content-type": "application/json", "x-csrf-token": body.csrfToken };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (true) {
    try { assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

test("route takeover publishes manager controls only after durable provider adoption", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "takeover-workspace", label: "Takeover", path: "/workspace/takeover" });
  const inspector = new Inspector();
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let commitStarted = false;
  const adapter: ProviderControlAdapter = {
    async createSession(_input: CreateSessionInput, _context: RequestContext): Promise<SessionView> {
      throw new Error("not used");
    },
    async adoptExternalSession(original, profile, context) {
      assert.equal(profile, "plan");
      assert.equal(context.workspace?.path, original.cwd);
      return session({
        ...original,
        pid: null,
        runtimePid: null,
        profile: { value: profile, providerValue: profile, source: "provider-api", confidence: "exact" },
        control: {
          plane: "codex-private",
          authority: "manager",
          coordination: providerControlCoordination("codex"),
          recovery: null,
          capabilities: ["queue"],
          withheld: [],
          takeover: null,
        },
      });
    },
    async commitExternalAdoption(providerSessionId) {
      assert.equal(providerSessionId, "takeover-thread");
      commitStarted = true;
      await commitGate;
      return session({
        profile: { value: "plan", providerValue: "plan", source: "provider-api", confidence: "exact" },
        control: {
          plane: "codex-private",
          authority: "manager",
          coordination: providerControlCoordination("codex"),
          recovery: null,
          capabilities: ["queue"],
          withheld: [],
          takeover: null,
        },
      });
    },
    async performAction(_view: SessionView, _action: SessionAction, _context: RequestContext): Promise<ActionDispatchResult> {
      return { status: "succeeded" };
    },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    database,
    adapters: { codex: adapter },
    initialSessions: [session()],
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { guidedTimeoutMs: 200, adoptionTimeoutMs: 200, pollIntervalMs: 2 },
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const authenticated = await headers(backend);
  const offered = backend.state.get("local:codex:takeover-thread");
  assert.ok(offered);
  assert.ok(offered.control.capabilities.includes("take-control"));
  assert.equal(offered.control.takeover?.fallbackProfile, "plan");

  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "takeover-browser" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const token = leaseResponse.json<{ lease: { token: string } }>().lease.token;
  const action = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": token },
    payload: {
      type: "take-control",
      method: "guided-exit",
      expectedGeneration: offered.generation,
      idempotencyKey: "takeover-route-action",
    },
  });
  assert.equal(action.statusCode, 200, action.body);
  assert.equal(backend.state.get(offered.id)?.control.takeover?.state, "waiting-for-exit");
  assert.equal(backend.state.get(offered.id)?.control.capabilities.includes("queue"), false);

  inspector.inspection = { state: "exited" };
  await waitFor(() => assert.equal(commitStarted, true));
  const committing = backend.state.get(offered.id);
  assert.ok(committing);
  assert.equal(committing.control.takeover?.state, "adopting");
  assert.equal(committing.control.authority, "none");
  assert.equal(committing.control.capabilities.includes("queue"), false);
  assert.equal(database.listManagedSessions().some((record) => record.id === offered.id), true);

  releaseCommit();
  await waitFor(() => assert.equal(backend.state.get(offered.id)?.control.authority, "manager"));
  const adopted = backend.state.get(offered.id);
  assert.ok(adopted?.control.capabilities.includes("queue"));
  assert.equal(adopted?.profile.value, "plan");
});

test("graceful-stop route requires the server-issued takeover id before signalling", async (t) => {
  const inspector = new GracefulInspector();
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    initialSessions: [session()],
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { gracefulExitTimeoutMs: 500, pollIntervalMs: 5 },
    adapters: {
      codex: {
        async createSession(): Promise<SessionView> { throw new Error("not used"); },
        async adoptExternalSession(): Promise<SessionView> { throw new Error("must not adopt before exit"); },
        async performAction(): Promise<ActionDispatchResult> { return { status: "succeeded" }; },
      },
    },
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const authenticated = await headers(backend);
  const offered = backend.state.get("local:codex:takeover-thread");
  assert.ok(offered);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "graceful-browser" },
  });
  const token = leaseResponse.json<{ lease: { token: string } }>().lease.token;
  const post = (payload: Record<string, unknown>) => backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": token },
    payload,
  });

  const preparedResponse = await post({
    type: "take-control",
    method: "graceful-stop",
    expectedGeneration: offered.generation,
    idempotencyKey: "prepare-graceful-route",
  });
  assert.equal(preparedResponse.statusCode, 200, preparedResponse.body);
  const prepared = backend.state.get(offered.id);
  assert.equal(prepared?.control.takeover?.state, "awaiting-confirmation");
  assert.equal(inspector.signals, 0);

  const staleResponse = await post({
    type: "take-control",
    method: "graceful-stop",
    takeoverId: "stale-takeover-id",
    expectedGeneration: prepared?.generation,
    idempotencyKey: "stale-graceful-route",
  });
  assert.equal(staleResponse.statusCode, 200, staleResponse.body);
  assert.equal(backend.state.get(offered.id)?.control.takeover?.state, "awaiting-confirmation");
  assert.equal(inspector.signals, 0);

  const takeoverId = prepared?.control.takeover?.id;
  assert.ok(takeoverId);
  const confirmedResponse = await post({
    type: "take-control",
    method: "graceful-stop",
    takeoverId,
    expectedGeneration: prepared?.generation,
    idempotencyKey: "confirm-graceful-route",
  });
  assert.equal(confirmedResponse.statusCode, 200, confirmedResponse.body);
  await waitFor(() => assert.equal(inspector.signals, 1));
  assert.equal(backend.state.get(offered.id)?.control.takeover?.state, "stopping");
});

test("a late provider promotion never restores the prior database identity or aborts active control", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "takeover-workspace", label: "Takeover", path: "/workspace/takeover" });
  const inspector = new ResumeInspector();
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let commitStarted = false;
  let abortCalls = 0;
  const stopped = session({
    pid: null,
    runtimePid: null,
    presence: "recent",
    status: "completed",
    providerStatus: "completed",
    control: {
      plane: "resume-only",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["resume"],
      withheld: [],
      takeover: null,
    },
  });
  const resumed = session({
    ...stopped,
    status: "idle",
    providerStatus: "idle",
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "resume"],
      withheld: [],
      takeover: null,
    },
  });
  const adapter: ProviderControlAdapter = {
    async createSession(): Promise<SessionView> {
      throw new Error("not used");
    },
    async resumeSession() {
      return resumed;
    },
    async commitExternalAdoption() {
      commitStarted = true;
      await commitGate;
      return resumed;
    },
    abortExternalAdoption() {
      abortCalls += 1;
    },
    async performAction() {
      return { status: "succeeded" };
    },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    database,
    adapters: { codex: adapter },
    initialSessions: [stopped],
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: {
      adoptionTimeoutMs: 200,
      persistenceTimeoutMs: 10,
      rollbackTimeoutMs: 20,
      pollIntervalMs: 2,
    },
  });
  t.after(async () => {
    releaseCommit();
    await backend.close();
  });
  await backend.app.ready();
  database.upsertManagedSession({
    id: stopped.id,
    provider: stopped.provider,
    providerSessionId: stopped.providerThreadId,
    workspaceId: "takeover-workspace",
    metadata: {
      durableFixture: "prior-row",
      profile: "ask-first",
      ownership: "prior-owner",
    },
    createdAt: stopped.startedAt!,
    updatedAt: stopped.updatedAt,
  });
  const authenticated = await headers(backend);
  const offered = backend.state.get(stopped.id);
  assert.ok(offered);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "timeout-browser" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const token = leaseResponse.json<{ lease: { token: string } }>().lease.token;
  const action = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": token },
    payload: {
      type: "resume",
      expectedGeneration: offered.generation,
      idempotencyKey: "late-provider-promotion",
    },
  });
  assert.equal(action.statusCode, 200, action.body);
  await waitFor(() => assert.equal(commitStarted, true));
  assert.equal(action.json<{ action: { status: string } }>().action.status, "failed");
  assert.equal(database.listManagedSessions().some((record) => record.id === stopped.id), true);
  assert.equal(abortCalls, 0);

  releaseCommit();
  await waitFor(() => {
    assert.equal(backend.state.get(stopped.id)?.control.capabilities.includes("queue"), true);
  });
  const persisted = database.listManagedSessions().find((record) => record.id === stopped.id);
  assert.equal(persisted?.metadata.profile, "plan");
  assert.equal(persisted?.metadata.ownership, "shared");
  assert.equal(abortCalls, 0);
});

test("retry-control retries quarantined cleanup before managed recovery and never duplicates it", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "takeover-workspace", label: "Takeover", path: "/workspace/takeover" });
  const inspector = new ResumeInspector();
  const stopped = session({
    pid: null,
    runtimePid: null,
    presence: "recent",
    status: "completed",
    providerStatus: "completed",
    control: {
      plane: "resume-only",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["resume"],
      withheld: [],
      takeover: null,
    },
  });
  const resumed = session({
    ...stopped,
    status: "idle",
    providerStatus: "idle",
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue"],
      withheld: [],
      takeover: null,
    },
  });
  const retryGate = deferred<void>();
  let cleanupCalls = 0;
  let ensureCalls = 0;
  const adapter: ProviderControlAdapter = {
    async createSession(): Promise<SessionView> { throw new Error("not used"); },
    async resumeSession() { return resumed; },
    async commitExternalAdoption() { throw new Error("provider commit failed"); },
    abortExternalAdoption() {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw new Error("provider cleanup rejected");
      return retryGate.promise;
    },
    async performAction(): Promise<ActionDispatchResult> { return { status: "succeeded" }; },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    database,
    adapters: { codex: adapter },
    ensureManagedProvider(provider) {
      assert.equal(provider, "codex");
      ensureCalls += 1;
    },
    initialSessions: [stopped],
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: {
      adoptionTimeoutMs: 200,
      persistenceTimeoutMs: 200,
      rollbackTimeoutMs: 200,
    },
  });
  t.after(async () => {
    retryGate.resolve();
    await backend.close();
  });
  await backend.app.ready();
  const authenticated = await headers(backend);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(stopped.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "cleanup-retry-browser" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const token = leaseResponse.json<{ lease: { token: string } }>().lease.token;
  const post = (payload: Record<string, unknown>) => backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(stopped.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": token },
    payload,
  });

  const resume = await post({
    type: "resume",
    expectedGeneration: backend.state.get(stopped.id)!.generation,
    idempotencyKey: "cleanup-retry-resume",
  });
  assert.equal(resume.statusCode, 200, resume.body);
  assert.equal(resume.json<{ action: { status: string } }>().action.status, "failed");
  const failedCleanup = backend.state.get(stopped.id);
  assert.equal(failedCleanup?.control.recovery?.state, "needs-attention");
  assert.deepEqual(failedCleanup?.control.capabilities, ["retry-control"]);
  assert.equal(cleanupCalls, 1);
  assert.equal(ensureCalls, 1, "only the original resume ensures the provider runtime");

  const retry = await post({
    type: "retry-control",
    expectedGeneration: failedCleanup!.generation,
    idempotencyKey: "cleanup-retry-control",
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json<{ action: { status: string } }>().action.status, "succeeded");
  const pendingCleanup = backend.state.get(stopped.id);
  assert.equal(pendingCleanup?.control.recovery?.state, "reconnecting");
  assert.equal(pendingCleanup?.control.recovery?.attempt, 2);
  assert.deepEqual(pendingCleanup?.control.capabilities, []);
  assert.equal(cleanupCalls, 2);
  assert.equal(ensureCalls, 1, "quarantine retry must run before managed recovery");

  const duplicate = await post({
    type: "retry-control",
    expectedGeneration: pendingCleanup!.generation,
    idempotencyKey: "cleanup-retry-while-pending",
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(cleanupCalls, 2, "an in-flight cleanup must never be duplicated");

  retryGate.resolve();
  await waitFor(() => {
    const recovered = backend.state.get(stopped.id);
    assert.equal(recovered?.control.recovery, null);
    assert.equal(recovered?.control.capabilities.includes("resume"), true);
  });
  assert.equal(cleanupCalls, 2);
  assert.equal(ensureCalls, 1);
});

test("web resume proves no CLI owner and publishes controls only after durable provider commit", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "takeover-workspace", label: "Takeover", path: "/workspace/takeover" });
  const stopped = session({
    pid: null,
    runtimePid: null,
    presence: "recent",
    status: "completed",
    providerStatus: "completed",
    control: {
      plane: "resume-only",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["resume"],
      withheld: [],
      takeover: null,
    },
  });
  const inspector = new ResumeInspector();
  let ensureCalls = 0;
  let resumeCalls = 0;
  let commitStarted = false;
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const resumed = session({
    ...stopped,
    status: "idle",
    providerStatus: "idle",
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "steer", "interrupt", "resume"],
      withheld: [],
      takeover: null,
    },
  });
  const adapter: ProviderControlAdapter = {
    async createSession(): Promise<SessionView> { throw new Error("not used"); },
    async resumeSession(original, profile, context) {
      resumeCalls += 1;
      assert.equal(original.id, stopped.id);
      assert.equal(profile, "plan");
      assert.equal(context.workspace?.path, stopped.cwd);
      return resumed;
    },
    async commitExternalAdoption(providerSessionId) {
      assert.equal(providerSessionId, stopped.providerThreadId);
      commitStarted = true;
      await commitGate;
      return resumed;
    },
    async performAction(): Promise<ActionDispatchResult> { return { status: "succeeded" }; },
  };
  const adapters: { codex?: ProviderControlAdapter } = {};
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    database,
    adapters,
    ensureManagedProvider(provider) {
      assert.equal(provider, "codex");
      ensureCalls += 1;
      adapters.codex = adapter;
    },
    initialSessions: [stopped],
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { adoptionTimeoutMs: 500, persistenceTimeoutMs: 500 },
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
  });
  t.after(async () => {
    releaseCommit();
    await backend.close();
  });
  await backend.app.ready();
  database.upsertManagedSession({
    id: stopped.id,
    provider: stopped.provider,
    providerSessionId: stopped.providerThreadId,
    workspaceId: "takeover-workspace",
    metadata: {
      durableFixture: "preserve-me",
      name: stopped.name,
      profile: "plan",
      model: stopped.model.value,
      effort: stopped.effort.value,
      hostId: "local",
      ownership: "shared",
    },
    createdAt: stopped.startedAt!,
    updatedAt: stopped.updatedAt,
  });
  const authenticated = await headers(backend);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(stopped.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "resume-browser" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const token = leaseResponse.json<{ lease: { token: string } }>().lease.token;
  const payload = {
    type: "resume" as const,
    expectedGeneration: backend.state.get(stopped.id)!.generation,
    idempotencyKey: "web-resume-action",
  };
  const actionPromise = backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(stopped.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": token },
    payload,
  });
  await waitFor(() => assert.equal(commitStarted, true));
  const committing = backend.state.get(stopped.id);
  assert.ok(committing);
  assert.deepEqual(committing.control.capabilities, ["resume"]);
  assert.equal(ensureCalls, 1);
  assert.equal(resumeCalls, 1);

  releaseCommit();
  const action = await actionPromise;
  assert.equal(action.statusCode, 200, action.body);
  assert.equal(action.json<{ action: { status: string } }>().action.status, "succeeded");
  assert.ok(backend.state.get(stopped.id)?.control.capabilities.includes("queue"));

  const duplicate = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(stopped.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": token },
    payload,
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json<{ action: { status: string } }>().action.status, "succeeded");
  assert.equal(resumeCalls, 1);
  assert.equal(ensureCalls, 1);
  const persisted = database.listManagedSessions().find((record) => record.id === stopped.id);
  assert.equal(persisted?.metadata.durableFixture, "preserve-me");
  assert.notEqual(persisted?.metadata.adoptedFromCli, true);
  assert.equal(persisted?.metadata.ownership, "shared");
  assert.equal(persisted?.metadata.providerTreeId, resumed.providerTreeId);
  assert.equal(persisted?.metadata.providerParentThreadId, null);
});

test("web resume fails closed when a standalone provider owner exists", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "takeover-workspace", label: "Takeover", path: "/workspace/takeover" });
  const inspector = new ResumeInspector();
  inspector.associated = { state: "running", identity };
  let resumeCalls = 0;
  const stopped = session({
    pid: null,
    runtimePid: null,
    status: "completed",
    control: {
      ...observeOnlyControl(),
      plane: "resume-only",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      capabilities: ["resume"],
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    database,
    initialSessions: [stopped],
    cliTakeoverInspector: inspector,
    adapters: {
      codex: {
        async createSession(): Promise<SessionView> { throw new Error("not used"); },
        async resumeSession(): Promise<SessionView> {
          resumeCalls += 1;
          throw new Error("must not run while a CLI owns the conversation");
        },
        async performAction(): Promise<ActionDispatchResult> { return { status: "succeeded" }; },
      },
    },
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const authenticated = await headers(backend);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(stopped.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "conflicted-resume-browser" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const response = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(stopped.id)}/actions`,
    headers: {
      ...authenticated,
      "x-control-lease": leaseResponse.json<{ lease: { token: string } }>().lease.token,
    },
    payload: {
      type: "resume",
      expectedGeneration: backend.state.get(stopped.id)!.generation,
      idempotencyKey: "conflicted-web-resume",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const action = response.json<{ action: { status: string; error: { code: string; message: string } } }>().action;
  assert.equal(action.status, "failed");
  assert.equal(action.error.code, "RESUME_REJECTED");
  assert.match(action.error.message, /still owns this conversation/u);
  assert.equal(resumeCalls, 0);
  assert.deepEqual(backend.state.get(stopped.id)?.control.capabilities, ["resume"]);
});

test("archived sessions cannot acquire a mutation lease even if stale capabilities remain", async (t) => {
  const archived = session({
    archived: true,
    pid: null,
    runtimePid: null,
    status: "completed",
    control: {
      ...observeOnlyControl(),
      plane: "resume-only",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      capabilities: ["resume"],
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    initialSessions: [archived],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const authenticated = await headers(backend);
  const lease = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(archived.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "archived-browser" },
  });
  assert.equal(lease.statusCode, 409, lease.body);
  assert.equal(lease.json<{ error: { code: string } }>().error.code, "ARCHIVED_READ_ONLY");
});
