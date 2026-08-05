import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActivityHub, type ActivityFrame } from "../activity/index.ts";
import type { SessionView } from "../core/types.ts";
import { REMOTE_BRIDGE_PROTOCOL_VERSION } from "../remote/protocol.ts";
import {
  observeOnlyControl,
  providerControlCoordination,
} from "../shared/session.ts";
import { AGENT_MANAGER_BUILD_ID, WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import { workspaceResolutionResponseSchema } from "../shared/workspace.ts";
import type {
  PanePreviewAdapter,
  ProviderControlAdapter,
  SessionAction,
} from "./contracts.ts";
import type { LocalCliProcessInspector } from "./cli-takeover.ts";
import { createAgentManagerServer } from "./server.ts";
import {
  requestAttachAuthorizeSpawnFromControlSocket,
  requestAttachExitedFromControlSocket,
  requestAttachFailedFromControlSocket,
  requestAttachFromControlSocket,
  requestAttachStartedFromControlSocket,
} from "./control-socket.ts";
import { ManagerDatabase, type OperationalAuditInput } from "./persistence.ts";
import { unknownSandbox } from "../shared/session.ts";
import type { SessionTranscriptReader } from "./transcript.ts";

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
    id: "local:codex:thread-1",
    provider: "codex",
    providerThreadId: "thread-1",
    providerTreeId: "thread-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Test session",
    cwd: "/tmp/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
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
    profile: {
      value: "execute",
      providerValue: "default",
      source: "provider-api",
      confidence: "exact",
    },
    sandbox: unknownSandbox(),
    model: {
      value: "gpt-5.6",
      providerValue: "gpt-5.6",
      source: "provider-api",
      confidence: "exact",
    },
    effort: {
      value: "high",
      providerValue: "high",
      source: "provider-api",
      confidence: "exact",
    },
    todoProgress: null,
    attention: [],
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
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "steer", "interrupt", "respond", "set-profile", "preview", "attach"],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 0,
    ...overrides,
  };
}

function claudeSession(overrides: Partial<SessionView> = {}): SessionView {
  return session({
    id: "local:claude:thread-1",
    provider: "claude",
    providerThreadId: "thread-1",
    providerTreeId: "thread-1",
    control: {
      plane: "claude-sdk",
      authority: "manager",
      coordination: providerControlCoordination("claude"),
      recovery: null,
      capabilities: ["queue", "steer", "interrupt", "respond", "set-profile", "preview", "attach"],
      withheld: [],
      takeover: null,
    },
    ...overrides,
  });
}

function persistManagedClaude(database: ManagerDatabase): void {
  database.upsertManagedSession({
    id: "local:claude:thread-1",
    provider: "claude",
    providerSessionId: "thread-1",
    workspaceId: null,
    metadata: { ownership: "manager-exclusive" },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  });
}

function exactClaudeProcessInspector(): LocalCliProcessInspector {
  return {
    inspect(view) {
      return {
        state: "running",
        identity: {
          pid: view.runtimePid ?? view.pid ?? process.pid,
          uid: process.getuid?.() ?? 501,
          executable: "claude",
          startedAt: "Wed Aug 5 10:00:00 2026",
          providerSessionId: view.providerThreadId,
          cwd: view.cwd ?? "/tmp/workspace",
        },
      };
    },
    terminate() {},
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

test("publishes the active provider turn ID in strict session snapshots", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    initialSessions: [session({
      status: "running",
      providerStatus: "running",
      providerTurnId: "turn-active",
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
  const snapshotBody = response.json<{
    schemaVersion: number;
    buildId: string;
    sessions: Array<{ providerTurnId: string | null }>;
  }>();
  assert.equal(snapshotBody.schemaVersion, WIRE_SCHEMA_VERSION);
  assert.equal(snapshotBody.buildId, AGENT_MANAGER_BUILD_ID);
  assert.equal(
    snapshotBody.sessions[0]?.providerTurnId,
    "turn-active",
  );
});

test("hydrates exact current manager attention only through the bounded per-session detail route", async (t) => {
  const activityHub = new ActivityHub({ streamEpoch: "selected-attention-details" });
  const requestBySession = new Map([
    ["local:codex:thread-1", "codex-request"],
    ["local:claude:thread-2", "claude-request"],
  ]);
  const sessions = [...requestBySession.entries()].map(([id, requestId]) => {
    const provider = id.includes(":claude:") ? "claude" as const : "codex" as const;
    const providerThreadId = id.split(":").at(-1)!;
    return session({
      id,
      provider,
      providerThreadId,
      providerTreeId: providerThreadId,
      status: "waiting",
      providerStatus: "waiting",
      attention: [{
        id: requestId,
        kind: "question",
        summary: `GLOBAL-PRIVATE-${provider}`,
        source: "provider-api",
        confidence: "exact",
        details: {
          title: `${provider} private title`,
          questions: [{
            id: "surface",
            header: null,
            text: `Which ${provider} surface?`,
            options: [],
            multiSelect: false,
            allowFreeText: true,
            isSecret: false,
          }],
          toolName: `${provider}-private-tool`,
          inputSummary: `PRIVATE-INPUT-${provider}`,
          respondable: true,
        },
      }],
      control: {
        plane: provider === "codex" ? "codex-private" : "claude-sdk",
        authority: "manager",
        coordination: providerControlCoordination(provider),
        recovery: null,
        capabilities: ["respond"],
        withheld: [],
        takeover: null,
      },
    });
  });
  for (const [sessionId, requestId] of requestBySession) {
    const provider = sessionId.includes(":claude:") ? "claude" as const : "codex" as const;
    if (provider === "claude") {
      activityHub.ingest(sessionId, provider, {
        type: "upsert",
        item: {
          id: "claude-parent-tool",
          kind: "tool",
          toolCallId: "claude-parent-tool-call",
          name: "AskUserQuestion",
          state: "waiting",
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      });
    }
    activityHub.ingest(sessionId, provider, {
      type: "upsert",
      item: {
        id: `${provider}-attention-item`,
        kind: "attention",
        parentId: provider === "claude" ? "claude-parent-tool" : null,
        requestId,
        attentionKind: "question",
        title: `${provider} exact title`,
        summary: `PRIVATE-SUMMARY-${provider}`,
        questions: [{
          id: "surface",
          text: `Which ${provider} surface?`,
          options: [],
          multiSelect: false,
          allowFreeText: true,
          isSecret: false,
        }],
        respondable: true,
        resolved: false,
        isSecret: false,
        state: "waiting",
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    });
    activityHub.ingest(sessionId, provider, {
      type: "upsert",
      item: {
        id: `${provider}-unrequested-attention-item`,
        kind: "attention",
        requestId: `${provider}-unrequested-private`,
        attentionKind: "question",
        title: "PRIVATE UNREQUESTED TITLE",
        questions: [{
          id: "private",
          text: "PRIVATE UNREQUESTED QUESTION",
          options: [],
          multiSelect: false,
          allowFreeText: true,
          isSecret: false,
        }],
        respondable: true,
        resolved: false,
        isSecret: false,
        state: "waiting",
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    });
  }

  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    activityHub,
    initialSessions: sessions,
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const global = await backend.app.inject({ method: "GET", url: "/api/v1/sessions", headers });
  assert.equal(global.statusCode, 200, global.body);
  assert.equal(global.body.includes("Which codex surface?"), false);
  assert.equal(global.body.includes("Which claude surface?"), false);
  assert.equal(global.body.includes("GLOBAL-PRIVATE"), false);

  for (const [sessionId, requestId] of requestBySession) {
    const provider = sessionId.includes(":claude:") ? "claude" : "codex";
    const ordinaryDetail = await backend.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      headers,
    });
    assert.equal(ordinaryDetail.statusCode, 200, ordinaryDetail.body);
    assert.equal(ordinaryDetail.body.includes(`Which ${provider} surface?`), false);
    assert.equal(ordinaryDetail.body.includes("PRIVATE-INPUT"), false);

    const selectedDetail = await backend.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/attention-details?requestId=${encodeURIComponent(requestId)}`,
      headers,
    });
    assert.equal(selectedDetail.statusCode, 200, selectedDetail.body);
    assert.equal(selectedDetail.headers["cache-control"], "no-store");
    assert.deepEqual(selectedDetail.json(), {
      sessionId,
      generation: backend.state.get(sessionId)!.generation,
      details: [{
        requestId,
        kind: "question",
        title: `${provider} exact title`,
        toolName: provider === "claude" ? "AskUserQuestion" : null,
        questions: [{ id: "surface", text: `Which ${provider} surface?` }],
        truncated: false,
      }],
    });
    assert.equal(selectedDetail.body.includes("PRIVATE UNREQUESTED QUESTION"), false);
    assert.equal(selectedDetail.body.includes(`PRIVATE-SUMMARY-${provider}`), false);

    const wrongRequest = await backend.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/attention-details?requestId=${encodeURIComponent(`${provider}-unrequested-private`)}`,
      headers,
    });
    assert.equal(wrongRequest.statusCode, 200, wrongRequest.body);
    assert.deepEqual(wrongRequest.json<{ details: unknown[] }>().details, []);
    assert.equal(wrongRequest.body.includes("PRIVATE UNREQUESTED QUESTION"), false);
  }

  const duplicate = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Acodex%3Athread-1/attention-details?requestId=codex-request&requestId=codex-request",
    headers,
  });
  assert.equal(duplicate.statusCode, 400, duplicate.body);
  const unauthenticated = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Acodex%3Athread-1/attention-details?requestId=codex-request",
    headers: { host },
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

  activityHub.ingest("local:codex:thread-1", "codex", {
    type: "upsert",
    item: {
      id: "codex-attention-item",
      kind: "attention",
      requestId: "codex-request",
      attentionKind: "question",
      respondable: false,
      resolved: true,
      isSecret: false,
      state: "complete",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  const resolved = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Acodex%3Athread-1/attention-details?requestId=codex-request",
    headers,
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.deepEqual(resolved.json<{ details: unknown[] }>().details, []);
  assert.equal(resolved.body.includes("Which codex surface?"), false);
});

test("hydrates only the exact current todo through the bounded per-session detail route", async (t) => {
  const activityHub = new ActivityHub({ streamEpoch: "selected-todo-detail" });
  const sessionId = "local:codex:thread-1";
  activityHub.ingest(sessionId, "codex", {
    type: "upsert",
    item: {
      id: "todo-current",
      kind: "todo",
      steps: [
        { id: "done", text: "PRIVATE DONE TODO", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
        { id: "current", text: "Implement the bounded projection", status: "in_progress", detail: "PRIVATE CURRENT DETAIL", addedAfterStart: false, removedReason: null },
        { id: "pending", text: "PRIVATE PENDING TODO", status: "pending", detail: null, addedAfterStart: false, removedReason: null },
      ],
      added: 3,
      removed: 0,
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });

  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    activityHub,
    initialSessions: [session({ id: sessionId })],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const global = await backend.app.inject({ method: "GET", url: "/api/v1/sessions", headers });
  assert.equal(global.statusCode, 200, global.body);
  assert.equal(global.body.includes("Implement the bounded projection"), false);
  assert.equal(global.body.includes("PRIVATE PENDING TODO"), false);
  assert.deepEqual(global.json<{ sessions: Array<{ todoProgress: unknown }> }>().sessions[0]!.todoProgress, {
    completed: 1,
    total: 3,
    hasMoved: false,
    lastTransitionAt: null,
    active: true,
  });

  const ordinary = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
    headers,
  });
  assert.equal(ordinary.statusCode, 200, ordinary.body);
  assert.equal(ordinary.body.includes("Implement the bounded projection"), false);

  const detail = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/todo-detail`,
    headers,
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.headers["cache-control"], "no-store");
  assert.deepEqual(detail.json(), {
    sessionId,
    generation: backend.state.get(sessionId)!.generation,
    todo: {
      completed: 1,
      total: 3,
      current: "Implement the bounded projection",
    },
  });
  assert.equal(detail.body.includes("PRIVATE DONE TODO"), false);
  assert.equal(detail.body.includes("PRIVATE CURRENT DETAIL"), false);
  assert.equal(detail.body.includes("PRIVATE PENDING TODO"), false);

  const unauthenticated = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/todo-detail`,
    headers: { host },
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

  activityHub.ingest(sessionId, "codex", {
    type: "upsert",
    item: {
      id: "transcript-todo",
      kind: "todo",
      steps: [
        { id: "done", text: "PRIVATE INFERRED DONE", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
        { id: "current", text: "PRIVATE INFERRED CURRENT", status: "in_progress", detail: null, addedAfterStart: false, removedReason: null },
        { id: "pending", text: "PRIVATE INFERRED PENDING", status: "pending", detail: null, addedAfterStart: false, removedReason: null },
      ],
      added: 3,
      removed: 0,
      source: "transcript",
      confidence: "inferred",
      exposure: "transcript-derived",
    },
  });
  const inferred = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/todo-detail`,
    headers,
  });
  assert.equal(inferred.statusCode, 200, inferred.body);
  assert.equal(inferred.body.includes("PRIVATE INFERRED"), false);
  assert.equal(inferred.json<{ todo: unknown }>().todo, null);
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
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers: { host, origin, cookie: headers.cookie, "content-type": "application/json" },
    payload: { clientId: "browser-client" },
  });
  assert.equal(withoutCsrf.statusCode, 403);

  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers,
    payload: { clientId: "browser-client" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
  const generation = backend.state.get("local:codex:thread-1")!.generation;
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
    url: "/api/v1/sessions/local:codex:thread-1/actions",
    headers: actionHeaders,
    payload,
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstAction = first.json<{ action: { status: string; result?: unknown } }>().action;
  assert.equal(firstAction.status, "succeeded");
  assert.equal("result" in firstAction, false);

  const duplicate = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/actions",
    headers: actionHeaders,
    payload,
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(actions.length, 1);

  const conflict = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/actions",
    headers: actionHeaders,
    payload: { ...payload, text: "Different" },
  });
  assert.equal(conflict.statusCode, 409);

  const stale = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/actions",
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
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
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
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers: { ...deleteHeaders, "x-control-lease": "mismatched-token" },
  });
  assert.equal(mismatched.statusCode, 409, mismatched.body);

  const release = () => backend.app.inject({
    method: "DELETE",
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers: { ...deleteHeaders, "x-control-lease": lease.token },
  });
  const first = await release();
  assert.equal(first.statusCode, 204, first.body);
  const lostResponseRetry = await release();
  assert.equal(lostResponseRetry.statusCode, 204, lostResponseRetry.body);
});

test("dispatches every provider response without retaining answer bytes in SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-secret-answer-"));
  const databasePath = join(directory, "state.sqlite");
  const secret = "correct-horse-secret-answer-needle";
  const requestId = "secret-question-request";
  const activityHub = new ActivityHub({ streamEpoch: "secret-answer-test", maxItems: 1 });
  activityHub.ingest("local:codex:thread-1", "codex", {
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
  activityHub.ingest("local:codex:thread-1", "codex", {
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
    activityHub.snapshot("local:codex:thread-1")!.items.some((item) => item.kind === "attention"),
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
        details: {
          title: "Credential",
          questions: [{
            id: "credential",
            header: null,
            text: "Credential",
            options: [],
            multiSelect: false,
            allowFreeText: true,
            isSecret: true,
          }],
          toolName: null,
          inputSummary: null,
          respondable: true,
        },
      }],
    })],
  });
  try {
    await backend.app.ready();
    const headers = await authenticatedHeaders(backend);
    const leaseResponse = await backend.app.inject({
      method: "POST",
      url: "/api/v1/sessions/local:codex:thread-1/control-lease",
      headers,
      payload: { clientId: "secret-answer-client" },
    });
    assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
    const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
    const idempotencyKey = "secret-answer-idempotency";
    const response = await backend.app.inject({
      method: "POST",
      url: "/api/v1/sessions/local:codex:thread-1/actions",
      headers: { ...headers, "x-control-lease": lease.token },
      payload: {
        type: "respond",
        requestId,
        response: { kind: "answer", value: secret, selectedOptions: [] },
        expectedGeneration: backend.state.get("local:codex:thread-1")!.generation,
        idempotencyKey,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ action: { status: string } }>().action.status, "succeeded");
    assert.equal(dispatched[0]?.type, "respond");
    assert.equal(backend.database.getPersistedActionStatus("local:codex:thread-1", idempotencyKey), null);
    assert.equal(backend.database.getActionReceipt("local:codex:thread-1", idempotencyKey), null);
  } finally {
    await backend.close().catch(() => undefined);
  }
  try {
    assert.equal(readFileSync(databasePath).includes(Buffer.from(secret)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves a typed stale failure when a native Codex peer wins the exact response race", async (t) => {
  const requestId = "s:first-response-wins";
  const waiting = session({
    providerTurnId: "turn-race",
    status: "waiting",
    attention: [{
      id: requestId,
      kind: "approval",
      summary: "Run git status",
      source: "provider-api",
      confidence: "exact",
      details: {
        title: null,
        questions: null,
        toolName: "Command execution",
        inputSummary: "git status",
        respondable: true,
      },
    }],
  });
  let backend: Awaited<ReturnType<typeof createAgentManagerServer>> | null = null;
  const adapter: ProviderControlAdapter = {
    async createSession() { return waiting; },
    async performAction(current, action) {
      assert.equal(action.type, "respond");
      assert.equal(action.requestId, requestId);
      // The route precondition observed the request, then the native peer's
      // provider notification removed it before this browser dispatch settled.
      backend?.state.upsert({ ...current, attention: [] });
      return {
        status: "failed",
        error: {
          code: "REQUEST_STALE",
          message: "the Codex request is no longer active; another provider peer may have responded first",
        },
      };
    },
  };
  backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex: adapter },
    initialSessions: [waiting],
  });
  t.after(() => backend?.close());
  await backend.app.ready();

  const headers = await authenticatedHeaders(backend);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers,
    payload: { clientId: "first-response-wins-browser" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/actions",
    headers: { ...headers, "x-control-lease": lease.token },
    payload: {
      type: "respond",
      requestId,
      response: { kind: "decision", decision: "allow" },
      expectedGeneration: waiting.generation,
      expectedProviderTurnId: "turn-race",
      idempotencyKey: "first-response-wins-race",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json<{ action: { status: string; error: { code: string; message: string } | null } }>()
      .action,
    {
      id: response.json<{ action: { id: string } }>().action.id,
      sessionId: waiting.id,
      type: "respond",
      status: "failed",
      createdAt: response.json<{ action: { createdAt: string } }>().action.createdAt,
      completedAt: response.json<{ action: { completedAt: string } }>().action.completedAt,
      error: {
        code: "REQUEST_STALE",
        message: "the Codex request is no longer active; another provider peer may have responded first",
      },
    },
  );
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
    url: "/api/v1/sessions/local:codex:thread-1/preview?lines=999&bytes=999999&paneId=%2599",
    headers: { host, cookie: headers.cookie },
  });
  assert.equal(response.statusCode, 400, response.body);

  const bounded = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local:codex:thread-1/preview?lines=200&bytes=65536&paneId=%2599",
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
    url: "/api/v1/sessions/local:codex:thread-1/attach",
    headers: { host, cookie: headers.cookie },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json<{ requiresHandoff: boolean }>().requiresHandoff, false);
  assert.deepEqual(response.json<{ instruction: { kind: string; argv: string[] } }>().instruction, {
    kind: "manager-cli",
    argv: ["agent-manager", "attach", "local:codex:thread-1"],
    cwd: "/tmp/workspace",
    warning: "Run locally to join this shared Codex App Server; CLI and web controls remain active together.",
  });
  assert.equal(rawInstructionRequests, 0);
});

test("browser resume exposes the guarded manager CLI wrapper without requiring attach", async (t) => {
  const temporary = temporaryControlSocket();
  const database = new ManagerDatabase();
  persistManagedClaude(database);
  const resumeOnly = claudeSession({
    status: "completed",
    terminal: null,
    control: {
      ...observeOnlyControl(),
      plane: "resume-only",
      authority: "manager",
      coordination: providerControlCoordination("claude"),
      capabilities: ["resume"],
      withheld: [{ capability: "attach", reason: "This provider can resume but not attach" }],
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    controlSocketPath: temporary.socketPath,
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
    adapters: {
      claude: {
        async createSession() { return resumeOnly; },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "claude-resume",
            argv: ["claude", "--resume", "thread-1"],
            cwd: resumeOnly.cwd,
            warning: null,
          };
        },
      },
    },
    initialSessions: [resumeOnly],
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(resumeOnly.id)}/attach`,
    headers: { host, cookie: headers.cookie },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json<{ requiresHandoff: boolean }>().requiresHandoff, false);
  assert.deepEqual(response.json<{ instruction: { kind: string; argv: string[] } }>().instruction, {
    kind: "manager-cli",
    argv: ["agent-manager", "attach", resumeOnly.id],
    cwd: resumeOnly.cwd,
    warning: "Run locally to resume this exact Claude conversation; web replies remain unavailable while it runs.",
  });

  const native = await requestAttachFromControlSocket(temporary.socketPath, resumeOnly.id);
  assert.deepEqual(native.instruction.argv, [
    "claude",
    "--resume",
    "thread-1",
  ]);
  assert.ok(native.instruction.handoffId);
  assert.ok(native.instruction.spawnNonce);
});

test("pre-spawn wrapper death reclaims safely after a bounded scan proves no child exists", async (t) => {
  const temporary = temporaryControlSocket();
  const database = new ManagerDatabase();
  const managed = claudeSession();
  persistManagedClaude(database);
  let reclaimCalls = 0;
  const inspector = exactClaudeProcessInspector();
  inspector.findAssociated = () => ({ state: "exited" });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { inspectionTimeoutMs: 20, pollIntervalMs: 2 },
    controlSocketPath: temporary.socketPath,
    adapters: {
      claude: {
        async createSession() { return managed; },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "claude-resume",
            argv: ["claude", "--resume", "thread-1"],
            cwd: "/tmp/workspace",
            warning: null,
          };
        },
        async reclaimFromCli() {
          reclaimCalls += 1;
          return managed;
        },
      },
    },
    initialSessions: [managed],
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, managed.id);
  assert.ok(reply.instruction.handoffId);
  assert.ok(reply.instruction.spawnNonce);
  const wrapper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 250)"], {
    stdio: "ignore",
  });
  await once(wrapper, "spawn");
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    managed.id,
    reply.instruction.handoffId!,
    reply.instruction.spawnNonce!,
    wrapper.pid!,
  );
  await once(wrapper, "exit");
  const deadline = Date.now() + 1_500;
  while (reclaimCalls === 0 && Date.now() < deadline) await delay(10);

  assert.equal(reclaimCalls, 1);
  const retry = await requestAttachFromControlSocket(temporary.socketPath, managed.id);
  assert.ok(retry.instruction.handoffId);
  assert.equal(
    backend.state.snapshot().diagnostics.some((item) =>
      item.message.includes("wrapper died before reporting the provider child")
      || item.message.includes("wrapper exited before reporting its child")
    ),
    true,
  );
});

test("wrapper death adopts an exact unreported child and reclaims only after that child exits", async (t) => {
  const temporary = temporaryControlSocket();
  const database = new ManagerDatabase();
  const managed = claudeSession();
  persistManagedClaude(database);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  const identity = {
    pid: child.pid!,
    uid: process.getuid?.() ?? 501,
    executable: "claude" as const,
    startedAt: "Wed Aug 5 10:00:00 2026",
    providerSessionId: managed.providerThreadId,
    cwd: managed.cwd!,
  };
  const inspector: LocalCliProcessInspector = {
    inspect(_view, expected) {
      if (child.exitCode !== null) return { state: "exited" };
      if (expected && expected.pid !== identity.pid) {
        return { state: "mismatch", reason: "child identity changed" };
      }
      return { state: "running", identity };
    },
    findAssociated() {
      return child.exitCode === null
        ? { state: "running", identity }
        : { state: "exited" };
    },
    terminate() {},
  };
  let attachedCalls = 0;
  let exitedCalls = 0;
  let reclaimCalls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { inspectionTimeoutMs: 20, pollIntervalMs: 2 },
    controlSocketPath: temporary.socketPath,
    adapters: {
      claude: {
        async createSession() { return managed; },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "claude-resume",
            argv: ["claude", "--resume", "thread-1"],
            cwd: managed.cwd,
            warning: null,
          };
        },
        markCliAttached() { attachedCalls += 1; },
        markCliExited() { exitedCalls += 1; },
        async reclaimFromCli() {
          reclaimCalls += 1;
          return managed;
        },
      },
    },
    initialSessions: [managed],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, managed.id);
  const wrapper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
    stdio: "ignore",
  });
  await once(wrapper, "spawn");
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    managed.id,
    reply.instruction.handoffId!,
    reply.instruction.spawnNonce!,
    wrapper.pid!,
  );
  await once(wrapper, "exit");
  const attachDeadline = Date.now() + 1_500;
  while (attachedCalls === 0 && Date.now() < attachDeadline) await delay(10);

  assert.equal(attachedCalls, 1);
  assert.equal(reclaimCalls, 0);
  const persisted = database.listManagedSessions().find((record) => record.id === managed.id);
  assert.equal(persisted?.metadata.ownership, "native-exclusive");
  assert.equal((persisted?.metadata.nativeOwner as { pid?: number } | null)?.pid, child.pid);

  child.kill("SIGTERM");
  await once(child, "exit");
  const reclaimDeadline = Date.now() + 1_500;
  while (reclaimCalls === 0 && Date.now() < reclaimDeadline) await delay(10);
  assert.equal(exitedCalls, 1);
  assert.equal(reclaimCalls, 1);
});

test("provider-attached state survives audit failure and classifies a later failure as an exit", async (t) => {
  const temporary = temporaryControlSocket();
  const database = new ManagerDatabase();
  const managed = claudeSession();
  persistManagedClaude(database);
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
    cliTakeoverInspector: exactClaudeProcessInspector(),
    controlSocketPath: temporary.socketPath,
    adapters: {
      claude: {
        async createSession() { return managed; },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "claude-resume",
            argv: ["claude", "--resume", "thread-1"],
            cwd: "/tmp/workspace",
            warning: null,
          };
        },
        markCliAttached() { attachedCalls += 1; },
        markCliExited() { exitedCalls += 1; },
        markCliAttachFailed() { failedCalls += 1; },
        async reclaimFromCli() { return managed; },
      },
    },
    initialSessions: [managed],
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, managed.id);
  const handoffId = reply.instruction.handoffId!;
  const spawnNonce = reply.instruction.spawnNonce!;
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    managed.id,
    handoffId,
    spawnNonce,
    process.pid,
  );
  await requestAttachStartedFromControlSocket(
    temporary.socketPath,
    managed.id,
    handoffId,
    spawnNonce,
    process.pid,
  );
  await requestAttachFailedFromControlSocket(
    temporary.socketPath,
    managed.id,
    handoffId,
    "lost wrapper acknowledgement",
  );

  assert.equal(attachedCalls, 1);
  assert.equal(exitedCalls, 1);
  assert.equal(failedCalls, 0);
});

test("attach-started waits for Claude's exact registry association before committing ownership", async (t) => {
  const temporary = temporaryControlSocket();
  const database = new ManagerDatabase();
  const managed = claudeSession();
  persistManagedClaude(database);
  const identity = {
    pid: process.pid,
    uid: process.getuid?.() ?? 501,
    executable: "claude" as const,
    startedAt: "Wed Aug 5 10:00:00 2026",
    providerSessionId: managed.providerThreadId,
    cwd: managed.cwd!,
  };
  let inspections = 0;
  const inspector: LocalCliProcessInspector = {
    inspect(_view, expected) {
      inspections += 1;
      return inspections === 1
        ? { state: "pending", identity, reason: "Claude registry is not ready" }
        : { state: "running", identity: expected ?? identity };
    },
    findAssociated() {
      return { state: "running", identity };
    },
    terminate() {},
  };
  let attachedCalls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { inspectionTimeoutMs: 100, pollIntervalMs: 2 },
    controlSocketPath: temporary.socketPath,
    adapters: {
      claude: {
        async createSession() { return managed; },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "claude-resume",
            argv: ["claude", "--resume", managed.providerThreadId],
            cwd: managed.cwd,
            warning: null,
          };
        },
        markCliAttached() { attachedCalls += 1; },
        async reclaimFromCli() { return managed; },
      },
    },
    initialSessions: [managed],
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, managed.id);
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    managed.id,
    reply.instruction.handoffId!,
    reply.instruction.spawnNonce!,
    process.pid,
  );
  await requestAttachStartedFromControlSocket(
    temporary.socketPath,
    managed.id,
    reply.instruction.handoffId!,
    reply.instruction.spawnNonce!,
    process.pid,
  );

  assert.ok(inspections >= 2);
  assert.equal(attachedCalls, 1);
  assert.equal(
    database.listManagedSessions().find((record) => record.id === managed.id)?.metadata.ownership,
    "native-exclusive",
  );
  await requestAttachFailedFromControlSocket(
    temporary.socketPath,
    managed.id,
    reply.instruction.handoffId!,
    "test cleanup",
  );
});

test("timed-out native reclaim observes one shared provider transition until eventual success", async (t) => {
  const temporary = temporaryControlSocket();
  const database = new ManagerDatabase();
  const managed = claudeSession();
  persistManagedClaude(database);
  let resolveReclaim!: (view: SessionView) => void;
  const pendingReclaim = new Promise<SessionView>((resolve) => {
    resolveReclaim = resolve;
  });
  let reclaimCalls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    shutdownTimeoutMs: 250,
    database,
    cliTakeoverInspector: exactClaudeProcessInspector(),
    controlSocketPath: temporary.socketPath,
    adapters: {
      claude: {
        async createSession() { return managed; },
        async performAction() { return { status: "succeeded" }; },
        async getAttachInstruction() {
          return {
            kind: "claude-resume",
            argv: ["claude", "--resume", "thread-1"],
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
    initialSessions: [managed],
  });
  t.after(async () => {
    resolveReclaim(managed);
    await backend.close().catch(() => undefined);
    rmSync(temporary.root, { recursive: true, force: true });
  });

  const reply = await requestAttachFromControlSocket(temporary.socketPath, managed.id);
  const handoffId = reply.instruction.handoffId!;
  const spawnNonce = reply.instruction.spawnNonce!;
  await requestAttachAuthorizeSpawnFromControlSocket(
    temporary.socketPath,
    managed.id,
    handoffId,
    spawnNonce,
    process.pid,
  );
  await requestAttachStartedFromControlSocket(
    temporary.socketPath,
    managed.id,
    handoffId,
    spawnNonce,
    process.pid,
  );
  await assert.rejects(
    requestAttachExitedFromControlSocket(
      temporary.socketPath,
      managed.id,
      handoffId,
      0,
    ),
    /attach-lifecycle-failed/,
  );
  assert.equal(reclaimCalls, 1);
  await assert.rejects(
    requestAttachFromControlSocket(temporary.socketPath, managed.id),
    /attach-unavailable/,
  );

  resolveReclaim(managed);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reclaimCalls, 1);
  const next = await requestAttachFromControlSocket(temporary.socketPath, managed.id);
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
    profile: "plan" as const,
    model: null,
    effort: null,
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
  const persistedIdentity = backend.database.listManagedSessions().find(
    (record) => record.id === "local:codex:thread-1",
  );
  assert.equal(persistedIdentity?.metadata.providerTreeId, "thread-1");
  assert.equal(persistedIdentity?.metadata.providerParentThreadId, null);

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

test("validates, completes, and remembers arbitrary local workspace paths", async (t) => {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), "agent-manager-custom-workspace-"));
  t.after(() => rmSync(workspaceDirectory, { recursive: true, force: true }));
  let createdWorkspaceId: string | null = null;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: {
      codex: {
        async createSession(input) {
          createdWorkspaceId = input.workspaceId;
          return session({
            id: "local:codex:workspace-resolution-test",
            providerThreadId: "workspace-resolution-test",
            providerTreeId: "workspace-resolution-test",
            cwd: workspaceDirectory,
          });
        },
        async performAction() { return { status: "succeeded" }; },
      },
    },
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const hosts = await backend.app.inject({ method: "GET", url: "/api/v1/hosts", headers });
  assert.equal(hosts.statusCode, 200, hosts.body);
  const localHost = hosts.json<{ hosts: Array<{ id: string; status: string }> }>().hosts[0];
  assert.equal(localHost?.id, "local");
  assert.equal(localHost?.status, "online");

  const partial = workspaceDirectory.slice(0, -1);
  const completions = await backend.app.inject({
    method: "GET",
    url: `/api/v1/hosts/local/directories?path=${encodeURIComponent(partial)}`,
    headers,
  });
  assert.equal(completions.statusCode, 200, completions.body);
  assert.ok(completions.json<{ paths: string[] }>().paths.includes(workspaceDirectory));

  const resolved = await backend.app.inject({
    method: "POST",
    url: "/api/v1/workspaces/resolve",
    headers,
    payload: { hostId: "local", path: workspaceDirectory },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  const resolvedPayload = workspaceResolutionResponseSchema.parse(resolved.json());
  const workspace = resolvedPayload.workspace;
  assert.equal(workspace.hostId, "local");
  assert.equal(workspace.path, realpathSync(workspaceDirectory));
  assert.equal(workspace.workspaceIdentity, null);

  const repeated = await backend.app.inject({
    method: "POST",
    url: "/api/v1/workspaces/resolve",
    headers,
    payload: { hostId: "local", path: workspaceDirectory },
  });
  assert.equal(repeated.json<{ workspace: { id: string } }>().workspace.id, workspace.id);
  assert.equal(backend.database.listWorkspaces().length, 1);

  const created = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers,
    payload: {
      provider: "codex",
      workspaceId: workspace.id,
      initialMessage: "Contract-only managed session test",
      profile: "plan",
      model: null,
      effort: null,
      idempotencyKey: "resolved-workspace-create-session",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(createdWorkspaceId, workspace.id);
});

test("proxies remote sessions through SSH and reserves takeover for a real writer conflict", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "agent-manager-ssh-bridge-"));
  const fakeSsh = join(fixtureRoot, "fake-ssh.cjs");
  const remoteSession = session({
    id: "local:codex:remote-thread",
    providerThreadId: "remote-thread",
    providerTreeId: "remote-tree",
    name: "Remote session",
    cwd: "/srv/project",
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: [
        "queue",
        "resume",
        "take-control",
        "cancel-take-control",
        "retry-control",
      ],
      withheld: [],
      takeover: null,
    },
  });
  const remoteCreatedSession = session({
    id: "local:codex:remote-created",
    providerThreadId: "remote-created",
    providerTreeId: "remote-created",
    name: "Created remotely",
    cwd: "/srv/project",
  });
  const remoteSnapshot = {
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    generatedAt: "2026-08-04T12:00:00.000Z",
    seq: 1,
    stale: false,
    sessions: [remoteSession],
    diagnostics: [],
  };
  const remoteWorkspace = {
    id: "remote-workspace",
    label: "project",
    path: "/srv/project",
    hostId: "local",
    hostLabel: "This Mac",
    hostKind: "local",
    remoteWorkspaceId: null,
    createdAt: "2026-08-04T12:00:00.000Z",
    lastOpenedAt: null,
    repoRoot: null,
    repoName: null,
    workspaceIdentity: null,
  };
  writeFileSync(fakeSsh, `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.at(-1) !== "/bin/zsh -lc 'exec agent-manager node bridge'") process.exit(64);
const remoteSession = ${JSON.stringify(remoteSession)};
const remoteCreatedSession = ${JSON.stringify(remoteCreatedSession)};
const remoteSnapshot = ${JSON.stringify(remoteSnapshot)};
const remoteWorkspace = ${JSON.stringify(remoteWorkspace)};
let owner = "other-controller";
let leaseToken = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const respond = (request, status, body) => send({ type: "response", id: request.id, status, body });
send({
  type: "hello",
  protocolVersion: ${String(REMOTE_BRIDGE_PROTOCOL_VERSION)},
  wireSchemaVersion: ${String(WIRE_SCHEMA_VERSION)},
  buildId: ${JSON.stringify(AGENT_MANAGER_BUILD_ID)},
});
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "GET" && request.path === "/api/v1/sessions") {
    respond(request, 200, remoteSnapshot);
    return;
  }
  if (request.method === "GET" && request.path.startsWith("/api/v1/hosts/local/directories?")) {
    respond(request, 200, { paths: ["/srv/project", "/srv/project-two"] });
    return;
  }
  if (request.method === "POST" && request.path === "/api/v1/workspaces/resolve") {
    respond(request, 200, { workspace: remoteWorkspace });
    return;
  }
  if (request.method === "POST" && request.path === "/api/v1/sessions") {
    const valid = request.body?.workspaceId === "remote-workspace";
    respond(request, valid ? 201 : 400, valid
      ? { session: remoteCreatedSession }
      : { error: { code: "WORKSPACE_UNKNOWN", message: "unknown workspace" } });
    return;
  }
  if (request.method === "GET" && request.path.endsWith("/attach")) {
    respond(request, 200, { instruction: { kind: "manager-cli", argv: ["agent-manager", "attach", remoteSession.id], cwd: remoteSession.cwd, warning: null } });
    return;
  }
  if (request.method === "POST" && request.path.endsWith("/control-lease")) {
    if (owner !== null && owner !== "controller" && request.body?.takeover !== true) {
      respond(request, 409, { error: { code: "LEASE_CONFLICT", message: "another writer is active", details: { expiresAt: "2099-01-01T00:00:00.000Z" } } });
      return;
    }
    owner = "controller";
    leaseToken = "remote-lease-token";
    respond(request, 200, { lease: { token: leaseToken, expiresAt: "2099-01-01T00:00:00.000Z" } });
    return;
  }
  if (request.method === "DELETE" && request.path.endsWith("/control-lease")) {
    if (request.controlLease === leaseToken) {
      owner = null;
      leaseToken = null;
    }
    respond(request, 204, null);
    return;
  }
  if (request.method === "POST" && request.path.endsWith("/actions")) {
    const status = owner === "controller" && request.controlLease === leaseToken ? 200 : 409;
    const body = status === 200
      ? { action: { status: "succeeded" } }
      : { error: { code: "LEASE_INVALID", message: "remote lease missing" } };
    respond(request, status, body);
    return;
  }
  respond(request, 404, { error: { code: "NOT_FOUND", message: "not found" } });
});
`, { mode: 0o700 });
  chmodSync(fakeSsh, 0o700);

  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    sshExecutable: fakeSsh,
    remotePollIntervalMs: 60_000,
  });
  backend.database.addHost({
    id: "build-host",
    label: "Build Host",
    kind: "ssh",
    sshTarget: "dev@build-host",
  });
  t.after(async () => {
    await backend.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const hosts = await backend.app.inject({ method: "GET", url: "/api/v1/hosts", headers });
  assert.equal(hosts.statusCode, 200, hosts.body);
  assert.ok(hosts.json<{ hosts: Array<{ id: string }> }>().hosts.some((candidate) => candidate.id === "build-host"));

  let selected = backend.state.list().find((candidate) => candidate.hostId === "build-host");
  for (let attempt = 0; !selected && attempt < 50; attempt += 1) {
    await delay(20);
    selected = backend.state.list().find((candidate) => candidate.hostId === "build-host");
  }
  assert.ok(selected);
  assert.equal(selected.hostLabel, "Build Host");
  const routeId = encodeURIComponent(selected.id);

  const completions = await backend.app.inject({
    method: "GET",
    url: `/api/v1/hosts/build-host/directories?path=${encodeURIComponent("/srv/pro")}`,
    headers,
  });
  assert.equal(completions.statusCode, 200, completions.body);
  assert.deepEqual(completions.json<{ paths: string[] }>().paths, ["/srv/project", "/srv/project-two"]);

  const resolved = await backend.app.inject({
    method: "POST",
    url: "/api/v1/workspaces/resolve",
    headers,
    payload: { hostId: "build-host", path: "/srv/project" },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  const workspace = resolved.json<{ workspace: { id: string; hostId: string; remoteWorkspaceId: string } }>().workspace;
  assert.equal(workspace.hostId, "build-host");
  assert.equal(workspace.remoteWorkspaceId, "remote-workspace");

  const created = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers,
    payload: {
      provider: "codex",
      workspaceId: workspace.id,
      initialMessage: "Start on the build host",
      profile: "execute",
      model: null,
      effort: null,
      idempotencyKey: "remote-create-0001",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json<{ session: { hostId: string; cwd: string } }>().session.hostId, "build-host");
  assert.equal(created.json<{ session: { cwd: string } }>().session.cwd, "/srv/project");

  const attach = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${routeId}/attach`,
    headers,
  });
  assert.equal(attach.statusCode, 200, attach.body);
  assert.equal(attach.json<{ requiresHandoff: boolean }>().requiresHandoff, false);
  const attachInstruction = attach.json<{ instruction: { kind: string; argv: string[] } }>().instruction;
  assert.equal(attachInstruction.kind, "ssh");
  assert.deepEqual(attachInstruction.argv.slice(0, 3), ["ssh", "-t", "dev@build-host"]);
  assert.match(attachInstruction.argv[3] ?? "", /\/bin\/zsh -lc/);
  assert.match(attachInstruction.argv[3] ?? "", /codex:remote-thread/);

  const conflict = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${routeId}/control-lease`,
    headers,
    payload: { clientId: "browser-client", takeover: false },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json<{ error: { code: string } }>().error.code, "LEASE_CONFLICT");

  const takeover = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${routeId}/control-lease`,
    headers,
    payload: { clientId: "browser-client", takeover: true },
  });
  assert.equal(takeover.statusCode, 200, takeover.body);
  const lease = takeover.json<{ lease: { token: string } }>().lease;
  const action = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${routeId}/actions`,
    headers: { ...headers, "x-control-lease": lease.token },
    payload: {
      type: "send",
      delivery: "queue",
      text: "Continue remotely",
      expectedGeneration: selected.generation,
      idempotencyKey: "remote-action-0001",
    },
  });
  assert.equal(action.statusCode, 200, action.body);
  assert.equal(action.json<{ action: { status: string } }>().action.status, "succeeded");

  for (const [remoteAction, idempotencyKey] of [
    [{ type: "take-control", method: "guided-exit" }, "remote-take-control-0001"],
    [{ type: "cancel-take-control", takeoverId: "remote-takeover-id" }, "remote-cancel-control-0001"],
    [{ type: "retry-control" }, "remote-retry-control-0001"],
    [{ type: "resume" }, "remote-resume-0001"],
  ] as const) {
    const proxied: {
      statusCode: number;
      body: string;
      json(): unknown;
    } = await backend.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${routeId}/actions`,
      headers: { ...headers, "x-control-lease": lease.token },
      payload: {
        ...remoteAction,
        expectedGeneration: selected.generation,
        idempotencyKey,
      },
    });
    assert.equal(proxied.statusCode, 200, proxied.body);
    assert.equal(
      (proxied.json() as { action: { status: string } }).action.status,
      "succeeded",
      `${remoteAction.type} must run on the remote node`,
    );
  }

  const released = await backend.app.inject({
    method: "DELETE",
    url: `/api/v1/sessions/${routeId}/control-lease`,
    headers: {
      host,
      origin,
      cookie: headers.cookie,
      "x-csrf-token": headers["x-csrf-token"],
      "x-control-lease": lease.token,
    },
  });
  assert.equal(released.statusCode, 204, released.body);
  await delay(30);
  const reacquired = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${routeId}/control-lease`,
    headers,
    payload: { clientId: "second-browser", takeover: false },
  });
  assert.equal(reacquired.statusCode, 200, reacquired.body);

  assert.equal(backend.database.removeHost("build-host"), true);
  const afterRemoval = await backend.app.inject({ method: "GET", url: "/api/v1/hosts", headers });
  assert.equal(afterRemoval.statusCode, 200, afterRemoval.body);
  assert.equal(afterRemoval.json<{ hosts: Array<{ id: string }> }>().hosts.some((candidate) => candidate.id === "build-host"), false);
  assert.equal(backend.state.get(selected.id), null);
});

test("keeps full-access profile independent from automatic writer coordination", async (t) => {
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
      profile: {
        value: "full-access",
        providerValue: "danger-full-access",
        source: "provider-api",
        confidence: "exact",
      },
    })],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers,
    payload: { clientId: "browser-client" },
  });
  const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/actions",
    headers: { ...headers, "x-control-lease": lease.token },
    payload: {
      type: "interrupt",
      expectedGeneration: backend.state.get("local:codex:thread-1")!.generation,
      idempotencyKey: "idem-key-bypass",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(calls, 1);

  const conflict = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers,
    payload: { clientId: "other-browser" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);

  const takeoverResponse = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/control-lease",
    headers,
    payload: { clientId: "other-browser", takeover: true },
  });
  assert.equal(takeoverResponse.statusCode, 200, takeoverResponse.body);
  const takeover = takeoverResponse.json<{ lease: { token: string } }>().lease;
  assert.notEqual(takeover.token, lease.token);

  const oldToken = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/actions",
    headers: { ...headers, "x-control-lease": lease.token },
    payload: {
      type: "interrupt",
      expectedGeneration: backend.state.get("local:codex:thread-1")!.generation,
      idempotencyKey: "idem-key-old-token",
    },
  });
  assert.equal(oldToken.statusCode, 409, oldToken.body);

  const takeoverAction = await backend.app.inject({
    method: "POST",
    url: "/api/v1/sessions/local:codex:thread-1/actions",
    headers: { ...headers, "x-control-lease": takeover.token },
    payload: {
      type: "interrupt",
      expectedGeneration: backend.state.get("local:codex:thread-1")!.generation,
      idempotencyKey: "idem-key-takeover-success",
    },
  });
  assert.equal(takeoverAction.statusCode, 200, takeoverAction.body);
  assert.equal(calls, 2);
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
  const data = firstChunk.match(/\ndata: ([^\n]+)\n/);
  assert.ok(data?.[1]);
  const envelope = JSON.parse(data[1]) as {
    schemaVersion: number;
    buildId: string;
    payload: { schemaVersion: number; buildId: string };
  };
  assert.equal(envelope.schemaVersion, WIRE_SCHEMA_VERSION);
  assert.equal(envelope.buildId, AGENT_MANAGER_BUILD_ID);
  assert.equal(envelope.payload.schemaVersion, WIRE_SCHEMA_VERSION);
  assert.equal(envelope.payload.buildId, AGENT_MANAGER_BUILD_ID);
});

test("closes live SSE clients before the bounded service shutdown", async (t) => {
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    shutdownTimeoutMs: 250,
    discovery: false,
    staticDir: false,
    initialSessions: [session()],
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: "/api/v1/events?clientId=shutdown-test",
      headers: {
        host,
        cookie: headers.cookie,
        accept: "text/event-stream",
      },
    }, resolve);
    request.once("error", reject);
  });
  t.after(() => response.destroy());
  await nextSseChunk(response, "shutdown snapshot");
  const closed = new Promise<void>((resolve) => {
    response.once("close", resolve);
    response.once("aborted", resolve);
    response.once("error", resolve);
  });

  await Promise.race([
    backend.close(),
    delay(1_000).then(() => { throw new Error("server shutdown remained blocked by SSE"); }),
  ]);
  await Promise.race([
    closed,
    delay(1_000).then(() => { throw new Error("SSE client remained open after shutdown"); }),
  ]);
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
  const streams = new Set<import("node:http").IncomingMessage>();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await backend.close();
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const openStream = async () => {
    const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
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
    streams.add(stream);
    return stream;
  };

  const first = await openStream();
  assert.equal(first.statusCode, 200);
  await once(first, "data");
  const firstClosed = new Promise<void>((resolve) => {
    first.once("close", resolve);
    first.once("aborted", resolve);
    first.once("error", resolve);
  });

  const second = await openStream();
  assert.equal(second.statusCode, 200);
  await Promise.race([
    firstClosed,
    delay(1_000).then(() => { throw new Error("replaced SSE stream did not close"); }),
  ]);
});

test("admits two same-auth browser clients with global and activity streams up to the exact cap", async (t) => {
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    maxSseClientsPerAuthSession: 4,
    discovery: false,
    staticDir: false,
    initialSessions: [session()],
  });
  const streams = new Set<import("node:http").IncomingMessage>();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await backend.close();
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const openStream = async (path: string) => {
    const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = httpGet({
        hostname: address.hostname,
        port: Number(address.port),
        path,
        headers: {
          host,
          cookie: headers.cookie,
          accept: "text/event-stream",
        },
      }, resolve);
      request.once("error", reject);
    });
    streams.add(stream);
    return stream;
  };

  for (const clientId of ["browser-one", "browser-two"]) {
    const global = await openStream(`/api/v1/events?clientId=${clientId}`);
    assert.equal(global.statusCode, 200);
    assert.match(await nextSseChunk(global, `${clientId} global snapshot`), /event: snapshot/);

    const activity = await openStream(
      `/api/v1/sessions/local:codex:thread-1/activity/events?clientId=${clientId}`,
    );
    assert.equal(activity.statusCode, 200);
    assert.equal(
      sseFrame(await nextSseChunk(activity, `${clientId} activity snapshot`)).type,
      "activity.snapshot",
    );
  }

  const overCap = await openStream("/api/v1/events?clientId=browser-three");
  assert.equal(overCap.statusCode, 429);
  let body = "";
  for await (const chunk of overCap) body += chunk.toString("utf8");
  assert.equal(JSON.parse(body).error.code, "SSE_LIMIT_REACHED");
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
  const streams = new Set<import("node:http").IncomingMessage>();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await backend.close();
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const openStream = async (path: string, extraHeaders: Record<string, string> = {}) => {
    const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
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
    streams.add(stream);
    return stream;
  };

  const global = await openStream("/api/v1/events?clientId=dual-stream-client");
  await nextSseChunk(global, "global snapshot");

  const activity = await openStream(
    "/api/v1/sessions/local:codex:thread-1/activity/events?clientId=dual-stream-client",
  );
  assert.equal(activity.statusCode, 200);
  assert.equal(activity.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(activity.headers["cache-control"], "no-store");
  const initial = sseFrame(await nextSseChunk(activity, "activity snapshot"));
  assert.equal(initial.type, "activity.snapshot");
  assert.equal(initial.sessionId, "local:codex:thread-1");

  const liveFrame = nextSseChunk(activity, "live activity upsert");
  activityHub.ingest("local:codex:thread-1", "codex", {
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
  assert.equal(streamed.sessionId, "local:codex:thread-1");
  assert.equal(streamed.type === "activity.upsert" ? streamed.item.id : null, "live-message");

  activity.destroy();
  activityHub.ingest("local:codex:thread-1", "codex", {
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
    "/api/v1/sessions/local:codex:thread-1/activity/events?clientId=dual-stream-client",
    { "last-event-id": streamed.cursor },
  );
  const replayed = sseFrame(await nextSseChunk(resumed, "activity replay"));
  assert.equal(replayed.type, "activity.upsert");
  assert.equal(
    replayed.type === "activity.upsert" ? replayed.item.id : null,
    "replayed-message",
  );

  // The activity stream must not displace the metadata stream using the same
  // browser client id. A state update still arrives on the global channel.
  const globalUpdate = nextSseChunk(global, "global metadata update");
  backend.state.upsert(session({ name: "Updated while both streams are open" }));
  assert.match(await globalUpdate, /event: session\.upsert/);
});

test("streams retained transcript history when managed Codex detail acquisition fails", async (t) => {
  const activityHub = new ActivityHub({ streamEpoch: "provider-detail-degraded" });
  let acquisitionAttempts = 0;
  const lateAcquire = {
    resolve: null as ((release: () => void) => void) | null,
  };
  let lateReleases = 0;
  const adapter: ProviderControlAdapter = {
    async createSession() {
      return session();
    },
    acquireSelectedSession() {
      acquisitionAttempts += 1;
      if (acquisitionAttempts <= 2) {
        return Promise.reject(new Error("simulated private bridge failure"));
      }
      return new Promise<() => void>((resolve) => {
        lateAcquire.resolve = resolve;
      });
    },
    async performAction() {
      return { status: "succeeded" };
    },
  };
  const transcriptReader: SessionTranscriptReader = {
    read(selected) {
      assert.equal(selected.providerThreadId, "thread-1");
      return {
        transcript: {
          state: "available",
          source: "codex-rollout",
          truncated: false,
          itemCount: 1,
          reason: null,
        },
        items: [{
          kind: "message",
          id: "retained-history",
          role: "assistant",
          text: "retained transcript survives provider detail failure",
          label: null,
          createdAt: "2026-08-03T00:00:01.000Z",
          status: "complete",
          correlationId: null,
          turnId: null,
          memoryCitation: null,
        }],
      };
    },
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    activityHub,
    adapters: { codex: adapter },
    transcriptReader,
    initialSessions: [session()],
  });
  const streams = new Set<import("node:http").IncomingMessage>();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await backend.close();
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const open = async (clientId: string) => {
    const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = httpGet({
        hostname: address.hostname,
        port: Number(address.port),
        path: `/api/v1/sessions/local:codex:thread-1/activity/events?clientId=${clientId}`,
        headers: { host, cookie: headers.cookie, accept: "text/event-stream" },
      }, resolve);
      request.once("error", reject);
    });
    streams.add(stream);
    assert.equal(stream.statusCode, 200);
    return stream;
  };
  const framesUntilWarning = async (stream: import("node:http").IncomingMessage) =>
    await new Promise<ActivityFrame[]>((resolve, reject) => {
      const frames: ActivityFrame[] = [];
      let buffered = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for degraded provider detail warning"));
      }, 1_500);
      const cleanup = (): void => {
        clearTimeout(timer);
        stream.off("data", onData);
        stream.off("error", onError);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString("utf8");
        while (buffered.includes("\n\n")) {
          const boundary = buffered.indexOf("\n\n");
          const event = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = event.match(/(?:^|\n)data: ([^\n]+)(?:\n|$)/u)?.[1];
          if (!data) continue;
          frames.push(JSON.parse(data) as ActivityFrame);
        }
        const warned = frames.some((frame) =>
          frame.type === "activity.upsert"
            ? frame.item.id === "manager:provider-enrichment-unavailable"
            : "items" in frame
              && frame.items.some((item) => item.id === "manager:provider-enrichment-unavailable")
        );
        if (!warned) return;
        cleanup();
        resolve(frames);
      };
      stream.on("data", onData);
      stream.on("error", onError);
    });
  const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 1_500;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await delay(10);
    }
  };

  const first = await open("provider-detail-1");
  const firstFrames = await framesUntilWarning(first);
  const visibleItems = firstFrames.flatMap((frame) =>
    frame.type === "activity.upsert" ? [frame.item]
      : "items" in frame ? frame.items : []
  );
  assert.ok(visibleItems.some((item) =>
    item.kind === "message"
      && item.text === "retained transcript survives provider detail failure"
  ));
  assert.ok(visibleItems.some((item) =>
    item.kind === "lifecycle"
      && item.id === "manager:provider-enrichment-unavailable"
      && item.level === "warning"
  ));
  first.destroy();

  const second = await open("provider-detail-2");
  await framesUntilWarning(second);
  await waitFor(() =>
    acquisitionAttempts >= 2
    && (activityHub.snapshot("local:codex:thread-1")?.items.find(
      (item) => item.id === "manager:provider-enrichment-unavailable",
    )?.revision ?? 0) >= 2, "second provider acquisition warning update");
  assert.equal(
    activityHub.snapshot("local:codex:thread-1")?.items.filter(
      (item) => item.id === "manager:provider-enrichment-unavailable",
    ).length,
    1,
    "repeated acquisitions update one bounded warning instead of duplicating it",
  );
  second.destroy();

  const third = await open("provider-detail-3");
  await nextSseChunk(third, "third retained transcript snapshot");
  await waitFor(() => acquisitionAttempts >= 3 && lateAcquire.resolve !== null, "pending provider acquisition");
  third.destroy();
  await delay(20);
  const resolveLateAcquire = lateAcquire.resolve;
  assert.ok(resolveLateAcquire);
  resolveLateAcquire(() => {
    lateReleases += 1;
  });
  await waitFor(() => lateReleases === 1, "late provider selection release");
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
      session({
        id: "local:codex:thread-2",
        providerThreadId: "thread-2",
        providerTreeId: "thread-2",
      }),
    ],
  });
  const streams = new Set<import("node:http").IncomingMessage>();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await backend.close();
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const open = async (sessionId: string, lastEventId?: string) => {
    const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
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
    streams.add(stream);
    return stream;
  };

  const first = await open("local:codex:thread-1");
  const firstFrame = sseFrame(await nextSseChunk(first, "first activity snapshot"));
  first.destroy();

  const second = await open("local:codex:thread-2", firstFrame.cursor);
  const reset = sseFrame(await nextSseChunk(second, "cross-session reset"));
  assert.equal(reset.type, "activity.reset");
  assert.equal(reset.sessionId, "local:codex:thread-2");
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
        url: "/api/v1/sessions/local:codex:thread-1/control-lease",
        headers,
        payload: { clientId: `browser-${run}` },
      });
      const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
      const response = await backend.app.inject({
        method: "POST",
        url: "/api/v1/sessions/local:codex:thread-1/actions",
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
