import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActivityHub, type ActivityFrame } from "../activity/index.ts";
import type { SessionView } from "../core/types.ts";
import type {
  PanePreviewAdapter,
  ProviderControlAdapter,
  SessionAction,
} from "./contracts.ts";
import { createAgentManagerServer } from "./server.ts";
import {
  requestAttachAuthorizeSpawnFromControlSocket,
  requestAttachExitedFromControlSocket,
  requestAttachFailedFromControlSocket,
  requestAttachFromControlSocket,
  requestAttachStartedFromControlSocket,
} from "./control-socket.ts";
import { ManagerDatabase, type OperationalAuditInput } from "./persistence.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function nextSseChunk(
  response: import("node:http").IncomingMessage,
  label: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_500);
    timer.unref();
    response.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString("utf8"));
    });
    response.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sseFrame(chunk: string): ActivityFrame {
  const data = chunk.match(/(?:^|\n)data: ([^\n]+)\n/);
  assert.ok(data?.[1], `SSE chunk did not contain JSON data: ${chunk}`);
  return JSON.parse(data[1]) as ActivityFrame;
}

function temporaryControlSocket() {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-handoff-test-"));
  return { root, socketPath: join(root, "runtime", "control.sock") };
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "codex:thread-1",
    provider: "codex",
    sessionId: "thread-1",
    parentSessionId: null,
    rootSessionId: "thread-1",
    depth: 0,
    name: "Test session",
    cwd: "/tmp/workspace",
    kind: "interactive",
    lifecycle: "live",
    status: "idle",
    providerStatus: "idle",
    waitingReason: null,
    pid: 123,
    runtimePid: 123,
    startedAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    childSummary: {
      total: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    },
    statusSource: "provider-cli",
    source: "fixture",
    ownership: "manager",
    runtimeAlive: true,
    mode: {
      value: "execution",
      providerValue: "default",
      source: "provider-api",
      confidence: "exact",
    },
    activity: "idle",
    attention: [],
    effectiveAccess: {
      permissionMode: "default",
      sandboxMode: "workspace-write",
      fullHostAccess: false,
    },
    terminal: {
      attachAvailable: true,
      socketName: "fixture",
      socketPath: null,
      session: "fixture",
      window: "main",
      windowIndex: 0,
      paneIndex: 0,
      paneId: "%1",
      tty: "ttys001",
      attachedClients: 0,
    },
    control: {
      plane: "codex-app-server",
      capabilities: ["queue", "steer", "interrupt", "respond", "set-mode", "preview", "attach"],
      managerOwned: true,
      writableLease: false,
    },
    generation: 0,
    ...overrides,
  };
}

async function authenticatedHeaders(backend: Awaited<ReturnType<typeof createAgentManagerServer>>) {
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
  return {
    host,
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": body.csrfToken,
  };
}

test("publishes the active managed run ID in session snapshots", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    initialSessions: [session({
      status: "running",
      providerStatus: "running",
      activity: "running",
      runId: "turn-active",
    })],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions",
    headers: { host, cookie: headers.cookie },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    response.json<{ sessions: Array<{ runId?: string | null }> }>().sessions[0]?.runId,
    "turn-active",
  );
});

test("returns bounded transcript only from the authenticated session detail route", async (t) => {
  const privateText = "selected-session transcript detail";
  let reads = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    transcriptReader: {
      read(selected) {
        reads += 1;
        assert.equal(selected.sessionId, "thread-1");
        return {
          messages: [{
            id: "message-1",
            role: "assistant",
            text: privateText,
            createdAt: "2026-08-03T00:00:01.000Z",
            status: "complete",
            label: null,
          }],
          transcript: {
            state: "available",
            truncated: false,
            source: "codex-rollout",
            messageCount: 1,
            reason: null,
          },
        };
      },
    },
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const collection = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(collection.statusCode, 200, collection.body);
  assert.equal(collection.body.includes(privateText), false);
  assert.equal(collection.body.includes('"messages"'), false);
  assert.equal(collection.body.includes('"transcript"'), false);
  assert.equal(reads, 0);

  const detail = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const selected = detail.json<{ session: SessionView }>().session;
  assert.equal(selected.messages?.[0]?.text, privateText);
  assert.equal(selected.transcript?.state, "available");
  assert.equal(reads, 1);
});

test("sanitizes transcript reader failures", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    transcriptReader: {
      read() {
        throw new Error("/private/path/that-must-not-leak");
      },
    },
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const detail = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.body.includes("/private/path"), false);
  assert.deepEqual(detail.json<{ session: SessionView }>().session.transcript, {
    state: "unavailable",
    truncated: false,
    source: null,
    messageCount: 0,
    reason: "unreadable",
  });
});

test("enforces bootstrap, CSRF, leases, stale generations and idempotency", async (t) => {
  const actions: SessionAction[] = [];
  const adapter: ProviderControlAdapter = {
    async createSession() {
      return session();
    },
    async performAction(_view, action) {
      actions.push(action);
      return { status: "succeeded", result: { accepted: true } };
    },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex: adapter },
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  const badHost = await backend.app.inject({ method: "GET", url: "/api/v1/healthz", headers: { host: "evil.invalid" } });
  assert.equal(badHost.statusCode, 400);

  const headers = await authenticatedHeaders(backend);
  const repeatedBootstrap = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(repeatedBootstrap.statusCode, 401);

  const withoutCsrf = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers: { host, origin, cookie: headers.cookie, "content-type": "application/json" },
    payload: { clientId: "browser-client" },
  });
  assert.equal(withoutCsrf.statusCode, 403);

  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers,
    payload: { clientId: "browser-client" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
  const generation = backend.state.get("codex:thread-1")!.generation;
  const actionHeaders = { ...headers, "x-control-lease": lease.token };
  const payload = {
    type: "send" as const,
    delivery: "queue" as const,
    text: "Do the work",
    expectedGeneration: generation,
    idempotencyKey: "idem-key-0001",
  };
  const first = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/actions",
    headers: actionHeaders,
    payload,
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstAction = first.json<{ action: { status: string; result?: unknown } }>().action;
  assert.equal(firstAction.status, "succeeded");
  assert.equal("result" in firstAction, false);

  const duplicate = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/actions",
    headers: actionHeaders,
    payload,
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(actions.length, 1);

  const conflict = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/actions",
    headers: actionHeaders,
    payload: { ...payload, text: "Different" },
  });
  assert.equal(conflict.statusCode, 409);

  const stale = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/actions",
    headers: actionHeaders,
    payload: { ...payload, expectedGeneration: generation + 1, idempotencyKey: "idem-key-0002" },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json<{ error: { code: string } }>().error.code, "STALE_GENERATION");
});

test("retries a lost control-lease release response without accepting an active mismatched token", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const acquired = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers,
    payload: { clientId: "browser-client" },
  });
  assert.equal(acquired.statusCode, 200, acquired.body);
  const lease = acquired.json<{ lease: { token: string } }>().lease;
  const deleteHeaders = {
    host,
    origin,
    cookie: headers.cookie,
    "x-csrf-token": headers["x-csrf-token"],
  };

  const mismatched = await backend.app.inject({
    method: "DELETE",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers: { ...deleteHeaders, "x-control-lease": "mismatched-token" },
  });
  assert.equal(mismatched.statusCode, 409, mismatched.body);
  assert.equal(backend.state.get("codex:thread-1")?.control.writableLease, true);

  const release = () => backend.app.inject({
    method: "DELETE",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers: { ...deleteHeaders, "x-control-lease": lease.token },
  });
  const first = await release();
  assert.equal(first.statusCode, 204, first.body);
  const lostResponseRetry = await release();
  assert.equal(lostResponseRetry.statusCode, 204, lostResponseRetry.body);
  assert.equal(backend.state.get("codex:thread-1")?.control.writableLease, false);
});

test("browser-wide lease release is CSRF-protected, auth-session scoped and idempotent", async (t) => {
  const database = new ManagerDatabase();
  const audits: OperationalAuditInput[] = [];
  const originalAudit = database.auditOperation.bind(database);
  database.auditOperation = ((input: OperationalAuditInput) => {
    audits.push(input);
    originalAudit(input);
  }) as ManagerDatabase["auditOperation"];
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    initialSessions: [
      session(),
      session({ id: "codex:thread-2", sessionId: "thread-2", rootSessionId: "thread-2" }),
      session({ id: "codex:thread-3", sessionId: "thread-3", rootSessionId: "thread-3" }),
    ],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const firstHeaders = await authenticatedHeaders(backend);
  backend.auth.issueBootstrapToken();
  const secondHeaders = await authenticatedHeaders(backend);
  const acquire = async (id: string, headers: Awaited<ReturnType<typeof authenticatedHeaders>>) => {
    const response = await backend.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/control-lease`,
      headers,
      payload: { clientId: `browser-${id}` },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  await acquire("codex:thread-1", firstHeaders);
  await acquire("codex:thread-2", firstHeaders);
  await acquire("codex:thread-3", secondHeaders);
  const deleteHeaders = {
    host,
    origin,
    cookie: firstHeaders.cookie,
    "x-csrf-token": firstHeaders["x-csrf-token"],
  };

  const withoutCsrf = await backend.app.inject({
    method: "DELETE",
    url: "/api/v1/control-leases",
    headers: { host, origin, cookie: firstHeaders.cookie },
  });
  assert.equal(withoutCsrf.statusCode, 403, withoutCsrf.body);
  assert.equal(backend.state.get("codex:thread-1")?.control.writableLease, true);

  const release = () => backend.app.inject({
    method: "DELETE",
    url: "/api/v1/control-leases",
    headers: deleteHeaders,
  });
  const first = await release();
  assert.equal(first.statusCode, 204, first.body);
  assert.equal(backend.state.get("codex:thread-1")?.control.writableLease, false);
  assert.equal(backend.state.get("codex:thread-2")?.control.writableLease, false);
  assert.equal(backend.state.get("codex:thread-3")?.control.writableLease, true);

  const retry = await release();
  assert.equal(retry.statusCode, 204, retry.body);
  const releaseAudits = audits.filter((audit) => audit.operation === "lease.release-all");
  assert.deepEqual(releaseAudits.map((audit) => [audit.phase, audit.outcome]), [
    ["attempt", "requested"],
    ["outcome", "succeeded"],
    ["attempt", "requested"],
    ["outcome", "succeeded"],
  ]);
  assert.deepEqual(
    releaseAudits.filter((audit) => audit.phase === "outcome").map((audit) => audit.details),
    [{ releasedCount: 2 }, { releasedCount: 0 }],
  );
});

test("browser-wide lease release does not mutate leases when its attempt audit fails", async (t) => {
  const database = new ManagerDatabase();
  const originalAudit = database.auditOperation.bind(database);
  database.auditOperation = ((input: OperationalAuditInput) => {
    if (input.operation === "lease.release-all" && input.phase === "attempt") {
      throw new Error("injected lease release audit failure");
    }
    originalAudit(input);
  }) as ManagerDatabase["auditOperation"];
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const acquired = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers,
    payload: { clientId: "browser-client" },
  });
  assert.equal(acquired.statusCode, 200, acquired.body);

  const response = await backend.app.inject({
    method: "DELETE",
    url: "/api/v1/control-leases",
    headers: {
      host,
      origin,
      cookie: headers.cookie,
      "x-csrf-token": headers["x-csrf-token"],
    },
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json<{ error: { code: string } }>().error.code, "LEASE_AUDIT_FAILED");
  assert.equal(backend.state.get("codex:thread-1")?.control.writableLease, true);
});

test("dispatches every provider response without retaining answer bytes in SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-secret-answer-"));
  const databasePath = join(directory, "state.sqlite");
  const secret = "correct-horse-secret-answer-needle";
  const requestId = "secret-question-request";
  const activityHub = new ActivityHub({ streamEpoch: "secret-answer-test", maxItems: 1 });
  activityHub.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: {
      id: "secret-attention",
      kind: "attention",
      requestId,
      attentionKind: "question",
      title: "Credential",
      summary: "Enter the credential",
      questions: [{
        id: "credential",
        text: "Credential",
        options: [],
        multiSelect: false,
        allowFreeText: true,
        isSecret: true,
      }],
      respondable: true,
      resolved: false,
      isSecret: true,
      state: "waiting",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  activityHub.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: {
      id: "newer-running-item",
      kind: "message",
      role: "assistant",
      text: "newer activity evicts the bounded attention card",
      state: "running",
    },
  });
  assert.equal(
    activityHub.snapshot("codex:thread-1")!.items.some((item) => item.kind === "attention"),
    false,
  );
  const dispatched: SessionAction[] = [];
  const adapter: ProviderControlAdapter = {
    async createSession() { return session(); },
    async performAction(_session, action) {
      dispatched.push(action);
      return { status: "succeeded" };
    },
  };
  const backend = await createAgentManagerServer({
    databasePath,
    discovery: false,
    staticDir: false,
    activityHub,
    adapters: { codex: adapter },
    initialSessions: [session({
      attention: [{
        id: requestId,
        kind: "question",
        summary: "Enter the credential",
        source: "provider-api",
        confidence: "exact",
        details: { respondable: true },
      }],
    })],
  });
  try {
    await backend.app.ready();
    const headers = await authenticatedHeaders(backend);
    const leaseResponse = await backend.app.inject({
      method: "POST",
      url: "/api/v1/sessions/codex:thread-1/control-lease",
      headers,
      payload: { clientId: "secret-answer-client" },
    });
    assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
    const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
    const idempotencyKey = "secret-answer-idempotency";
    const response = await backend.app.inject({
      method: "POST",
      url: "/api/v1/sessions/codex:thread-1/actions",
      headers: { ...headers, "x-control-lease": lease.token },
      payload: {
        type: "respond",
        requestId,
        response: { kind: "answer", value: secret, selectedOptions: [] },
        expectedGeneration: backend.state.get("codex:thread-1")!.generation,
        idempotencyKey,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ action: { status: string } }>().action.status, "succeeded");
    assert.equal(dispatched[0]?.type, "respond");
    assert.equal(backend.database.getPersistedActionStatus("codex:thread-1", idempotencyKey), null);
    assert.equal(backend.database.getActionReceipt("codex:thread-1", idempotencyKey), null);
  } finally {
    await backend.close().catch(() => undefined);
  }
  try {
    assert.equal(readFileSync(databasePath).includes(Buffer.from(secret)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounds pane previews and never accepts browser-supplied tmux targets", async (t) => {
  const captured: Array<{ maxLines: number; maxBytes: number; paneId: string }> = [];
  const previewAdapter: PanePreviewAdapter = {
    async capture(terminal, limits) {
      captured.push({ ...limits, paneId: terminal.paneId });
      return { content: "safe output", truncated: false, lineCount: 1, byteCount: 11 };
    },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    previewAdapter,
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1/preview?lines=999&bytes=999999&paneId=%2599",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(response.statusCode, 400, response.body);

  const bounded = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1/preview?lines=200&bytes=65536&paneId=%2599",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(bounded.statusCode, 200, bounded.body);
  assert.deepEqual(captured, [{ maxLines: 200, maxBytes: 65_536, paneId: "%1" }]);
});

test("browser attach exposes only the guarded manager CLI wrapper", async (t) => {
  let rawInstructionRequests = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: {
      codex: {
        async createSession() { return session(); },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          rawInstructionRequests += 1;
          return {
            kind: "codex-remote",
            argv: ["codex", "resume", "thread-1", "--remote", "unix:///private/tmp/private.sock"],
            cwd: "/tmp/workspace",
            warning: null,
          };
        },
      },
    },
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1/attach",
    headers: { host, cookie: headers.cookie },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json<{ instruction: { kind: string; argv: string[] } }>().instruction, {
    kind: "manager-cli",
    argv: ["agent-manager", "attach", "codex:thread-1"],
    cwd: "/tmp/workspace",
    warning: "Run this command locally to perform a guarded ownership handoff through Agent Manager.",
  });
  assert.equal(rawInstructionRequests, 0);
});

test("pre-spawn authorization leaves ownership fail-closed when its wrapper dies before reporting a child", async (t) => {
  const temporary = temporaryControlSocket();
  let reclaimCalls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    controlSocketPath: temporary.socketPath,
    adapters: {
      codex: {
        async createSession() { return session(); },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "codex-remote",
            argv: ["codex", "resume", "thread-1", "--remote", "unix:///tmp/codex.sock"],
            cwd: "/tmp/workspace",
            warning: null,
          };
        },
        async reclaimFromCli() {
          reclaimCalls += 1;
          return session();
        },
      },
    },
    initialSessions: [session()],
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, "codex:thread-1");
  assert.ok(reply.instruction.handoffId);
  assert.ok(reply.instruction.spawnNonce);
  const wrapper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 250)"], {
    stdio: "ignore",
  });
  await once(wrapper, "spawn");
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    "codex:thread-1",
    reply.instruction.handoffId!,
    reply.instruction.spawnNonce!,
    wrapper.pid!,
  );
  await once(wrapper, "exit");
  await delay(1_100);

  assert.equal(reclaimCalls, 0);
  await assert.rejects(
    requestAttachFromControlSocket(temporary.socketPath, "codex:thread-1"),
    /attach-unavailable/,
  );
  assert.equal(
    backend.state.snapshot().diagnostics.some((item) =>
      item.message.includes("wrapper died before reporting the provider child")
    ),
    true,
  );
});

test("provider-attached state survives audit failure and classifies a later failure as an exit", async (t) => {
  const temporary = temporaryControlSocket();
  const database = new ManagerDatabase();
  const originalAudit = database.auditOperation.bind(database);
  database.auditOperation = ((input: OperationalAuditInput) => {
    if (input.operation === "native.handoff" && input.outcome === "attached") {
      throw new Error("injected attached audit failure");
    }
    originalAudit(input);
  }) as ManagerDatabase["auditOperation"];
  let attachedCalls = 0;
  let exitedCalls = 0;
  let failedCalls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    controlSocketPath: temporary.socketPath,
    adapters: {
      codex: {
        async createSession() { return session(); },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "codex-remote",
            argv: ["codex", "resume", "thread-1", "--remote", "unix:///tmp/codex.sock"],
            cwd: "/tmp/workspace",
            warning: null,
          };
        },
        markCliAttached() { attachedCalls += 1; },
        markCliExited() { exitedCalls += 1; },
        markCliAttachFailed() { failedCalls += 1; },
        async reclaimFromCli() { return session(); },
      },
    },
    initialSessions: [session()],
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, "codex:thread-1");
  const handoffId = reply.instruction.handoffId!;
  const spawnNonce = reply.instruction.spawnNonce!;
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    "codex:thread-1",
    handoffId,
    spawnNonce,
    process.pid,
  );
  await requestAttachStartedFromControlSocket(
    temporary.socketPath,
    "codex:thread-1",
    handoffId,
    spawnNonce,
    process.pid,
  );
  await requestAttachFailedFromControlSocket(
    temporary.socketPath,
    "codex:thread-1",
    handoffId,
    "lost wrapper acknowledgement",
  );

  assert.equal(attachedCalls, 1);
  assert.equal(exitedCalls, 1);
  assert.equal(failedCalls, 0);
});

test("timed-out native reclaim observes one shared provider transition until eventual success", async (t) => {
  const temporary = temporaryControlSocket();
  let resolveReclaim!: (view: SessionView) => void;
  const pendingReclaim = new Promise<SessionView>((resolve) => {
    resolveReclaim = resolve;
  });
  let reclaimCalls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    shutdownTimeoutMs: 250,
    controlSocketPath: temporary.socketPath,
    adapters: {
      codex: {
        async createSession() { return session(); },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "codex-remote",
            argv: ["codex", "resume", "thread-1", "--remote", "unix:///tmp/codex.sock"],
            cwd: "/tmp/workspace",
            warning: null,
          };
        },
        async reclaimFromCli() {
          reclaimCalls += 1;
          return await pendingReclaim;
        },
      },
    },
    initialSessions: [session()],
  });
  t.after(async () => {
    resolveReclaim(session());
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, "codex:thread-1");
  const handoffId = reply.instruction.handoffId!;
  const spawnNonce = reply.instruction.spawnNonce!;
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    "codex:thread-1",
    handoffId,
    spawnNonce,
    process.pid,
  );
  await requestAttachStartedFromControlSocket(
    temporary.socketPath,
    "codex:thread-1",
    handoffId,
    spawnNonce,
    process.pid,
  );
  await assert.rejects(
    requestAttachExitedFromControlSocket(
      temporary.socketPath,
      "codex:thread-1",
      handoffId,
      0,
    ),
    /attach-lifecycle-failed/,
  );
  assert.equal(reclaimCalls, 1);
  await assert.rejects(
    requestAttachFromControlSocket(temporary.socketPath, "codex:thread-1"),
    /attach-unavailable/,
  );

  resolveReclaim(session());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reclaimCalls, 1);
  const next = await requestAttachFromControlSocket(temporary.socketPath, "codex:thread-1");
  assert.ok(next.instruction.spawnNonce);
});

test("session creation reserves a durable idempotency intent before provider dispatch", async (t) => {
  let calls = 0;
  let managerRequestId: string | undefined;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: {
      codex: {
        async createSession(_input, context) {
          calls += 1;
          managerRequestId = context.managerSessionId;
          return session();
        },
        async performAction() { return { status: "succeeded" }; },
      },
    },
  });
  t.after(() => backend.close());
  backend.database.addWorkspace({ id: "workspace-one", label: "One", path: "/tmp/workspace" });
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const payload = {
    provider: "codex" as const,
    workspaceId: "workspace-one",
    initialMessage: "Private initial task",
    mode: "planning" as const,
    permissionPreset: "standard" as const,
    idempotencyKey: "create-idempotency-one",
  };
  const first = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers,
    payload,
  });
  assert.equal(first.statusCode, 201, first.body);
  assert.match(managerRequestId ?? "", /^manager-request:/);

  const duplicate = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers,
    payload,
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(calls, 1);

  const conflict = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers,
    payload: { ...payload, initialMessage: "Different task" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json<{ error: { code: string } }>().error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(calls, 1);
});

test("requires explicit full-host arming on the exclusive control lease", async (t) => {
  let calls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: {
      codex: {
        async createSession() { return session(); },
        async performAction() { calls += 1; return { status: "succeeded" }; },
      },
    },
    initialSessions: [session({
      effectiveAccess: {
        permissionMode: "never",
        sandboxMode: "danger-full-access",
        fullHostAccess: true,
      },
    })],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers,
    payload: { clientId: "browser-client", armFullHost: false },
  });
  const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/actions",
    headers: { ...headers, "x-control-lease": lease.token },
    payload: {
      type: "interrupt",
      expectedGeneration: backend.state.get("codex:thread-1")!.generation,
      idempotencyKey: "idem-key-armed",
    },
  });
  assert.equal(response.statusCode, 428, response.body);
  assert.equal(calls, 0);

  const missingCurrentToken = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers,
    payload: { clientId: "browser-client", armFullHost: true },
  });
  assert.equal(missingCurrentToken.statusCode, 409, missingCurrentToken.body);

  const armedResponse = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/control-lease",
    headers: { ...headers, "x-control-lease": lease.token },
    payload: { clientId: "browser-client", armFullHost: true },
  });
  assert.equal(armedResponse.statusCode, 200, armedResponse.body);
  const armed = armedResponse.json<{ lease: { token: string } }>().lease;
  assert.notEqual(armed.token, lease.token);

  const oldToken = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/actions",
    headers: { ...headers, "x-control-lease": lease.token },
    payload: {
      type: "interrupt",
      expectedGeneration: backend.state.get("codex:thread-1")!.generation,
      idempotencyKey: "idem-key-old-token",
    },
  });
  assert.equal(oldToken.statusCode, 409, oldToken.body);

  const armedAction = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/codex:thread-1/actions",
    headers: { ...headers, "x-control-lease": armed.token },
    payload: {
      type: "interrupt",
      expectedGeneration: backend.state.get("codex:thread-1")!.generation,
      idempotencyKey: "idem-key-armed-success",
    },
  });
  assert.equal(armedAction.statusCode, 200, armedAction.body);
  assert.equal(calls, 1);
});

test("serves newly published static assets and the production SPA fallback without weakening Host checks", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-static-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Agent Manager Fixture</title>");
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: directory,
  });
  t.after(async () => {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await backend.app.ready();
  writeFileSync(join(directory, "published-after-start.js"), "globalThis.__publishedAfterStart = true;");
  const publishedAsset = await backend.app.inject({
    method: "GET",
    url: "/published-after-start.js",
    headers: { host },
  });
  assert.equal(publishedAsset.statusCode, 200, publishedAsset.body);
  assert.match(publishedAsset.body, /__publishedAfterStart/);
  const response = await backend.app.inject({
    method: "GET",
    url: "/sessions/thread",
    headers: { host, accept: "text/html" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /Agent Manager Fixture/);
  const rejected = await backend.app.inject({
    method: "GET",
    url: "/sessions/thread",
    headers: { host: "evil.invalid", accept: "text/html" },
  });
  assert.equal(rejected.statusCode, 400);
});

test("serves SSE with EventSource-compatible headers over a real HTTP response", async (t) => {
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);

  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: "/api/v1/events",
      headers: {
        host,
        cookie: headers.cookie,
        accept: "text/event-stream",
      },
    }, resolve);
    request.once("error", reject);
  });
  t.after(() => response.destroy());

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-accel-buffering"], "no");

  const firstChunk = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the SSE snapshot")), 1_000);
    timer.unref();
    response.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString("utf8"));
    });
    response.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  response.destroy();

  assert.match(firstChunk, /^id: \d+\nevent: snapshot\ndata: /);
});

test("replaces a stale SSE stream from the same authenticated browser client", async (t) => {
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    maxSseClientsPerAuthSession: 1,
    discovery: false,
    staticDir: false,
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const openStream = () => new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: "/api/v1/events?clientId=web-reconnect-test",
      headers: {
        host,
        cookie: headers.cookie,
        accept: "text/event-stream",
      },
    }, resolve);
    request.once("error", reject);
  });

  const first = await openStream();
  t.after(() => first.destroy());
  assert.equal(first.statusCode, 200);
  await once(first, "data");
  const firstClosed = new Promise<void>((resolve) => {
    first.once("close", resolve);
    first.once("aborted", resolve);
    first.once("error", resolve);
  });

  const second = await openStream();
  t.after(() => second.destroy());
  assert.equal(second.statusCode, 200);
  await Promise.race([
    firstClosed,
    delay(1_000).then(() => { throw new Error("replaced SSE stream did not close"); }),
  ]);
});

test("serves bounded authenticated activity history without crossing session boundaries", async (t) => {
  const activityHub = new ActivityHub({ streamEpoch: "activity-history-test" });
  activityHub.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: {
      id: "message-a",
      kind: "message",
      role: "assistant",
      phase: "final",
      text: "selected-session-a-private",
      state: "complete",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  activityHub.ingest("claude:thread-2", "claude", {
    type: "upsert",
    item: {
      id: "message-b",
      kind: "message",
      role: "assistant",
      phase: "final",
      text: "other-session-b-private",
      state: "complete",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    activityHub,
    initialSessions: [
      session(),
      session({
        id: "claude:thread-2",
        provider: "claude",
        sessionId: "thread-2",
        rootSessionId: "thread-2",
        control: {
          plane: "claude-sdk",
          capabilities: [],
          managerOwned: true,
          writableLease: false,
        },
      }),
    ],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  const rejected = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1/activity",
    headers: { host },
  });
  assert.equal(rejected.statusCode, 401);

  const headers = await authenticatedHeaders(backend);
  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1/activity?limit=1",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /selected-session-a-private/);
  assert.doesNotMatch(response.body, /other-session-b-private/);

  const staleCursor = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1/activity?before=old-epoch:1",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(staleCursor.statusCode, 409);
  assert.equal(
    staleCursor.json<{ error: { code: string } }>().error.code,
    "ACTIVITY_CURSOR_STALE",
  );

  const collection = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions",
    headers: { host, cookie: headers.cookie },
  });
  assert.doesNotMatch(collection.body, /selected-session-a-private|other-session-b-private/);

  const missing = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:missing/activity",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(missing.statusCode, 404);
});

test("seeds selected external-session activity from its bounded transcript", async (t) => {
  const privateText = "external-selected-transcript-live";
  let reads = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    transcriptReader: {
      read() {
        reads += 1;
        return {
          messages: [{
            id: "external-message",
            role: "assistant",
            text: privateText,
            createdAt: "2026-08-03T00:00:01.000Z",
            status: "complete",
            label: null,
          }],
          transcript: {
            state: "available",
            truncated: false,
            source: "codex-rollout",
            messageCount: 1,
            reason: null,
          },
        };
      },
    },
    initialSessions: [session({
      ownership: "external",
      control: {
        plane: "observe-only",
        capabilities: [],
        managerOwned: false,
        writableLease: false,
      },
    })],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const collection = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(reads, 0);
  assert.doesNotMatch(collection.body, new RegExp(privateText));

  const activity = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/codex:thread-1/activity",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(activity.statusCode, 200, activity.body);
  assert.equal(reads, 1);
  assert.match(activity.body, new RegExp(privateText));
  assert.match(activity.body, /"source":"transcript"/);
});

test("streams selected activity live while retaining a separate global stream", async (t) => {
  const activityHub = new ActivityHub({ streamEpoch: "activity-stream-test" });
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    maxSseClientsPerAuthSession: 2,
    discovery: false,
    staticDir: false,
    activityHub,
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const openStream = (path: string, extraHeaders: Record<string, string> = {}) =>
    new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = httpGet({
        hostname: address.hostname,
        port: Number(address.port),
        path,
        headers: {
          host,
          cookie: headers.cookie,
          accept: "text/event-stream",
          ...extraHeaders,
        },
      }, resolve);
      request.once("error", reject);
    });

  const global = await openStream("/api/v1/events?clientId=dual-stream-client");
  t.after(() => global.destroy());
  await nextSseChunk(global, "global snapshot");

  const activity = await openStream(
    "/api/v1/sessions/codex:thread-1/activity/events?clientId=dual-stream-client",
  );
  t.after(() => activity.destroy());
  assert.equal(activity.statusCode, 200);
  assert.equal(activity.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(activity.headers["cache-control"], "no-store");
  const initial = sseFrame(await nextSseChunk(activity, "activity snapshot"));
  assert.equal(initial.type, "activity.snapshot");
  assert.equal(initial.sessionId, "codex:thread-1");

  const liveFrame = nextSseChunk(activity, "live activity upsert");
  activityHub.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: {
      id: "live-message",
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "arrived-before-turn-complete",
      state: "running",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  const streamed = sseFrame(await liveFrame);
  assert.equal(streamed.type, "activity.upsert");
  assert.equal(streamed.sessionId, "codex:thread-1");
  assert.equal(streamed.type === "activity.upsert" ? streamed.item.id : null, "live-message");

  activity.destroy();
  activityHub.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: {
      id: "replayed-message",
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "replayed-after-reconnect",
      state: "running",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  const resumed = await openStream(
    "/api/v1/sessions/codex:thread-1/activity/events?clientId=dual-stream-client",
    { "last-event-id": streamed.cursor },
  );
  t.after(() => resumed.destroy());
  const replayed = sseFrame(await nextSseChunk(resumed, "activity replay"));
  assert.equal(replayed.type, "activity.upsert");
  assert.equal(
    replayed.type === "activity.upsert" ? replayed.item.id : null,
    "replayed-message",
  );

  // The activity stream must not displace the metadata stream using the same
  // browser client id. A state update still arrives on the global channel.
  const globalUpdate = nextSseChunk(global, "global metadata update");
  backend.state.setWritableLease("codex:thread-1", true);
  assert.match(await globalUpdate, /event: session\.upsert/);
});

test("rejects cross-session activity cursors with an atomic reset", async (t) => {
  const activityHub = new ActivityHub({ streamEpoch: "activity-cursor-test" });
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    activityHub,
    initialSessions: [
      session(),
      session({ id: "codex:thread-2", sessionId: "thread-2", rootSessionId: "thread-2" }),
    ],
  });
  t.after(() => backend.close());
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const open = (sessionId: string, lastEventId?: string) =>
    new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = httpGet({
        hostname: address.hostname,
        port: Number(address.port),
        path: `/api/v1/sessions/${sessionId}/activity/events?clientId=cursor-client`,
        headers: {
          host,
          cookie: headers.cookie,
          accept: "text/event-stream",
          ...(lastEventId ? { "last-event-id": lastEventId } : {}),
        },
      }, resolve);
      request.once("error", reject);
    });

  const first = await open("codex:thread-1");
  const firstFrame = sseFrame(await nextSseChunk(first, "first activity snapshot"));
  first.destroy();

  const second = await open("codex:thread-2", firstFrame.cursor);
  t.after(() => second.destroy());
  const reset = sseFrame(await nextSseChunk(second, "cross-session reset"));
  assert.equal(reset.type, "activity.reset");
  assert.equal(reset.sessionId, "codex:thread-2");
});

test("durable idempotency receipts prevent replay after a server restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-receipt-"));
  const databasePath = join(directory, "state.sqlite");
  let calls = 0;
  const adapter: ProviderControlAdapter = {
    async createSession() { return session(); },
    async performAction() { calls += 1; return { status: "succeeded" }; },
  };
  const payload = {
    type: "send" as const,
    delivery: "queue" as const,
    text: "Only once",
    expectedGeneration: 1,
    idempotencyKey: "idempotency-restart",
  };
  try {
    for (let run = 0; run < 2; run += 1) {
      const backend = await createAgentManagerServer({
        databasePath,
        discovery: false,
        staticDir: false,
        adapters: { codex: adapter },
        initialSessions: [session()],
      });
      await backend.app.ready();
      const headers = await authenticatedHeaders(backend);
      const leaseResponse = await backend.app.inject({
        method: "POST",
        url: "/api/v1/sessions/codex:thread-1/control-lease",
        headers,
        payload: { clientId: `browser-${run}` },
      });
      const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
      const response = await backend.app.inject({
        method: "POST",
        url: "/api/v1/sessions/codex:thread-1/actions",
        headers: { ...headers, "x-control-lease": lease.token },
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<{ action: { status: string } }>().action.status, "succeeded");
      await backend.close();
    }
    assert.equal(calls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
