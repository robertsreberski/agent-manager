import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ActivityItem } from "../activity/index.ts";
import type { SessionRecord } from "../core/types.ts";
import type { DiscoveryWorkerMessage, WorkerPort } from "../discovery/index.ts";
import { digestCodexHookToken } from "../providers/codex/codex-hook-auth.ts";
import { digestHookBearerToken } from "../providers/hooks/auth.ts";
import {
  observeOnlyControl,
  providerControlCoordination,
  sessionRecordId,
} from "../shared/session.ts";
import { requestHooksReloadFromControlSocket } from "./control-socket.ts";
import { ManagerDatabase } from "./persistence.ts";
import { createAgentManagerServer } from "./server.ts";

const HOST = "127.0.0.1:43127";
const ORIGIN = "http://127.0.0.1:43127";
const CLAUDE_TOKEN = "claude-server-hook-token-with-more-than-thirty-two-characters";
const CODEX_TOKEN = "codex-server-hook-token-with-more-than-thirty-two-characters";

function session(provider: "claude" | "codex", providerThreadId: string): SessionRecord {
  return {
    id: sessionRecordId("local", provider, providerThreadId),
    provider,
    providerThreadId,
    providerTreeId: providerThreadId,
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: `${provider} external`,
    cwd: "/tmp",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "running",
    providerStatus: "running",
    pid: null,
    runtimePid: null,
    startedAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
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
    statusSource: "process",
    source: "fixture",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    effort: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: observeOnlyControl(),
    workspaceIdentity: null,
    generation: 0,
  };
}

function claudeTmuxSession(providerThreadId = "claude-external"): SessionRecord {
  return {
    ...session("claude", providerThreadId),
    terminal: {
      attachAvailable: true,
      socketName: "external-claude",
      socketPath: null,
      session: "claude-shell",
      window: "main",
      windowIndex: 0,
      paneIndex: 0,
      paneId: "%7",
      tty: "ttys007",
      attachedClients: 0,
    },
    control: {
      plane: "tmux-attach",
      authority: "foreign",
      coordination: {
        mode: "observe-only",
        nativeAttach: "none",
        responseResolution: "single-controller",
      },
      recovery: null,
      capabilities: ["preview", "attach"],
      withheld: [],
      takeover: null,
    },
  };
}

function claudePermission(providerSessionId = "claude-external") {
  return {
    session_id: providerSessionId,
    transcript_path: "/tmp/claude-external.jsonl",
    cwd: "/tmp",
    prompt_id: "prompt-1",
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "echo safe" },
  };
}

function claudePersistentPermission(providerSessionId = "claude-external") {
  return {
    ...claudePermission(providerSessionId),
    permission_suggestions: [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "echo safe" }],
      behavior: "allow",
      destination: "session",
    }],
  };
}

function claudeStop(providerSessionId = "claude-external") {
  return {
    session_id: providerSessionId,
    transcript_path: "/tmp/claude-external.jsonl",
    cwd: "/tmp",
    prompt_id: "prompt-1",
    hook_event_name: "Stop",
    stop_hook_active: false,
  };
}

function codexSessionStart(providerSessionId = "codex-external") {
  return {
    session_id: providerSessionId,
    transcript_path: "/tmp/codex-external.jsonl",
    cwd: "/tmp",
    hook_event_name: "SessionStart",
    model: "gpt-5.6-codex",
    permission_mode: "default",
    turn_id: null,
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openGlobalStream(
  address: URL,
  cookie: string,
  clientId: string,
): Promise<IncomingMessage> {
  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: `/api/v1/events?clientId=${encodeURIComponent(clientId)}`,
      headers: { host: HOST, cookie, accept: "text/event-stream" },
    }, resolve);
    request.once("error", reject);
  });
  assert.equal(stream.statusCode, 200);
  await once(stream, "data");
  return stream;
}

async function openActivityStream(
  address: URL,
  cookie: string,
  clientId: string,
  sessionId: string,
): Promise<IncomingMessage> {
  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/activity/events?clientId=${encodeURIComponent(clientId)}`,
      headers: { host: HOST, cookie, accept: "text/event-stream" },
    }, resolve);
    request.once("error", reject);
  });
  assert.equal(stream.statusCode, 200);
  await once(stream, "data");
  return stream;
}

async function authenticatedHeaders(
  backend: Awaited<ReturnType<typeof createAgentManagerServer>>,
) {
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  assert.ok(cookie);
  return {
    host: HOST,
    origin: ORIGIN,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": response.json<{ csrfToken: string }>().csrfToken,
  };
}

function persistClaude(database: ManagerDatabase, token = CLAUDE_TOKEN): void {
  database.upsertClaudeHookInstallRecord({
    id: "claude-install",
    provider: "claude",
    schemaVersion: 1,
    tokenDigest: digestHookBearerToken(token),
    createdAt: "2026-08-04T12:00:00.000Z",
    settingsPath: "/Users/test/.claude/settings.json",
    endpoint: "http://127.0.0.1:43127/api/v1/hooks/claude",
    createdHooksProperty: true,
  });
}

function persistCodex(database: ManagerDatabase, token = CODEX_TOKEN): void {
  const shimPath = "/Users/test/Library/Application Support/agent-manager/hooks/codex-hook.mjs";
  database.upsertCodexHookInstallRecord({
    id: "codex-install",
    provider: "codex",
    schemaVersion: 1,
    tokenDigest: digestCodexHookToken(token),
    createdAt: "2026-08-04T12:00:00.000Z",
    settingsPath: "/Users/test/.codex/hooks.json",
    shimPath,
    endpoint: "http://127.0.0.1:43127/api/v1/hooks/codex",
    command: `'${shimPath}'`,
    shimDigest: `sha256:${"c".repeat(64)}`,
  });
}

test("server holds exact Claude permission attention and dispatches persistent browser approval", async (t) => {
  const database = new ManagerDatabase();
  persistClaude(database);
  const id = sessionRecordId("local", "claude", "claude-external");
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
    discovery: false,
    staticDir: false,
    database,
    initialSessions: [session("claude", "claude-external")],
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const cockpit = await openGlobalStream(address, headers.cookie, "hook-test-client");
  t.after(async () => {
    cockpit.destroy();
    await backend.close();
  });

  // No browser Origin, cookie, or CSRF header: the route retains Host/JSON and
  // digest auth while bypassing only the browser-specific checks.
  const hookReply = backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host: HOST,
      authorization: `Bearer ${CLAUDE_TOKEN}`,
      "content-type": "application/json",
    },
    payload: claudePersistentPermission(),
  });
  await waitFor(() => backend.state.get(id)?.attention.length === 1, "Claude permission attention");

  const waiting = backend.state.get(id)!;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.control.plane, "claude-hook-bridge");
  assert.equal(waiting.control.authority, "foreign");
  assert.deepEqual(waiting.control.capabilities, ["respond"]);
  assert.equal(waiting.attention[0]?.source, "hook");
  assert.equal(waiting.attention[0]?.confidence, "exact");
  assert.equal(waiting.attention[0]?.details?.respondable, true);
  const requestId = waiting.attention[0]?.id;
  assert.ok(requestId);
  const pendingActivity = backend.activityHub.snapshot(id)?.items.find(
    (item: ActivityItem) => item.kind === "attention" && !item.resolved,
  );
  assert.equal(
    pendingActivity?.kind === "attention"
      ? pendingActivity.approvalFacts?.canPersist
      : null,
    true,
  );
  const selectedDetail = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(id)}/attention-details?requestId=${encodeURIComponent(requestId)}`,
    headers,
  });
  assert.equal(selectedDetail.statusCode, 200, selectedDetail.body);
  assert.equal(selectedDetail.headers["cache-control"], "no-store");
  assert.deepEqual(selectedDetail.json(), {
    sessionId: id,
    generation: waiting.generation,
    details: [{
      requestId,
      kind: "permission",
      title: "Claude requests Bash",
      toolName: "Bash",
      questions: [],
      truncated: false,
    }],
  });
  assert.equal(selectedDetail.body.includes("echo safe"), false);

  const leaseReply = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(id)}/control-lease`,
    headers,
    payload: { clientId: "hook-test-client" },
  });
  assert.equal(leaseReply.statusCode, 200, leaseReply.body);
  const lease = leaseReply.json<{ lease: { token: string } }>().lease;
  const actionReply = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(id)}/actions`,
    headers: { ...headers, "x-control-lease": lease.token },
    payload: {
      type: "respond",
      requestId,
      response: { kind: "decision", decision: "allow", persist: true },
      expectedGeneration: waiting.generation,
      idempotencyKey: "claude-hook-persistent-response-1",
    },
  });
  assert.equal(actionReply.statusCode, 200, actionReply.body);
  assert.equal(actionReply.json<{ action: { status: string } }>().action.status, "succeeded");

  const providerReply = await hookReply;
  assert.equal(providerReply.statusCode, 200, providerReply.body);
  assert.deepEqual(providerReply.json(), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedPermissions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "echo safe" }],
          behavior: "allow",
          destination: "session",
        }],
      },
    },
  });
  assert.equal(backend.state.get(id)?.attention.length, 0);
  assert.equal(backend.state.get(id)?.control.plane, "observe-only");
  assert.ok(database.getClaudeHookInstallRecord("/Users/test/.claude/settings.json")?.lastSeenAt);
  const attention = backend.activityHub.snapshot(id)?.items.find(
    (item: ActivityItem) => item.kind === "attention",
  );
  assert.equal(attention?.kind === "attention" ? attention.resolved : null, true);
});

test("serves exact Claude hook todo progress through the selected per-session detail edge", async (t) => {
  const database = new ManagerDatabase();
  persistClaude(database);
  const id = sessionRecordId("local", "claude", "claude-external");
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
    discovery: false,
    staticDir: false,
    database,
    initialSessions: [session("claude", "claude-external")],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const hook = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host: HOST,
      authorization: `Bearer ${CLAUDE_TOKEN}`,
      "content-type": "application/json",
    },
    payload: {
      session_id: "claude-external",
      transcript_path: "/tmp/claude-external.jsonl",
      cwd: "/tmp",
      prompt_id: "prompt-todo",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "TodoWrite",
      tool_use_id: "todo-write-1",
      tool_input: {
        todos: [
          { content: "Inspect the harness", status: "completed", activeForm: "Inspecting the harness" },
          { content: "Render exact hook progress", status: "in_progress", activeForm: "Rendering exact hook progress" },
          { content: "PRIVATE HOOK PENDING", status: "pending", activeForm: "Waiting" },
        ],
      },
    },
  });
  assert.equal(hook.statusCode, 200, hook.body);
  await waitFor(() => backend.state.get(id)?.todoProgress?.total === 3, "Claude hook todo progress");

  const projected = backend.activityHub.snapshot(id)?.items.find((item) => item.kind === "todo");
  assert.equal(projected?.confidence, "exact");
  assert.equal(projected?.exposure, "provider-exposed");
  const global = await backend.app.inject({ method: "GET", url: "/api/v1/sessions", headers });
  assert.equal(global.body.includes("Render exact hook progress"), false);
  assert.equal(global.body.includes("PRIVATE HOOK PENDING"), false);

  const detail = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(id)}/todo-detail`,
    headers,
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json(), {
    sessionId: id,
    generation: backend.state.get(id)!.generation,
    todo: {
      completed: 1,
      total: 3,
      current: "Render exact hook progress",
    },
  });
  assert.equal(detail.body.includes("PRIVATE HOOK PENDING"), false);
});

test("external Claude holds keep foreign tmux authority and fail open only after the last authenticated cockpit disconnects", async (t) => {
  const database = new ManagerDatabase();
  persistClaude(database);
  const id = sessionRecordId("local", "claude", "claude-external");
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
    discovery: false,
    staticDir: false,
    database,
    initialSessions: [session("claude", "claude-external")],
  });
  const streams = new Set<IncomingMessage>();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await backend.close();
  });
  const address = new URL(await backend.listen());
  const firstAuth = await authenticatedHeaders(backend);
  backend.auth.issueBootstrapToken();
  const secondAuth = await authenticatedHeaders(backend);
  const first = await openGlobalStream(address, firstAuth.cookie, "same-tab-id");
  const second = await openGlobalStream(address, secondAuth.cookie, "same-tab-id");
  const selected = await openActivityStream(address, secondAuth.cookie, "same-tab-id", id);
  streams.add(first);
  streams.add(second);
  streams.add(selected);

  const hookReply = backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host: HOST,
      authorization: `Bearer ${CLAUDE_TOKEN}`,
      "content-type": "application/json",
    },
    payload: claudePermission(),
  });
  await waitFor(() => backend.state.get(id)?.attention.length === 1, "held external permission");

  const held = backend.state.get(id)!;
  assert.equal(held.control.plane, "claude-hook-bridge");
  assert.equal(held.control.authority, "foreign");
  assert.deepEqual(held.control.capabilities, ["respond"]);

  // A discovery refresh can learn a tmux pane while the request is pending.
  // The hook overlay must preserve that external attach route and never turn it
  // into the manager-owned SDK handoff wrapper.
  backend.replaceSessions([claudeTmuxSession()]);
  const refreshed = backend.state.get(id)!;
  assert.equal(refreshed.control.authority, "foreign");
  assert.deepEqual(refreshed.control.capabilities, ["preview", "attach", "respond"]);
  const attach = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(id)}/attach`,
    headers: { host: HOST, cookie: firstAuth.cookie },
  });
  assert.equal(attach.statusCode, 200, attach.body);
  assert.deepEqual(
    attach.json<{ instruction: { kind: string; argv: string[] } }>().instruction,
    {
      kind: "tmux",
      argv: ["tmux", "-L", "external-claude", "attach-session", "-t", "claude-shell"],
      cwd: "/tmp",
      warning: "Attach opens tmux session claude-shell; select pane %7 if it is not already active.",
    },
  );

  first.destroy();
  assert.equal(await Promise.race([
    hookReply.then(() => "released" as const),
    delay(100).then(() => "held" as const),
  ]), "held", "another authenticated cockpit still owns the response opportunity");
  assert.equal(backend.state.get(id)?.attention.length, 1);

  second.destroy();
  assert.equal(await Promise.race([
    hookReply.then(() => "released" as const),
    delay(100).then(() => "held" as const),
  ]), "held", "the authenticated selected-session stream remains a response path");
  assert.equal(backend.state.get(id)?.attention.length, 1);

  selected.destroy();
  const released = await Promise.race([
    hookReply,
    delay(1_000).then(() => { throw new Error("Claude permission did not fail open after browser loss"); }),
  ]);
  assert.equal(released.statusCode, 200);
  assert.equal(released.body, "");
  await waitFor(() => backend.state.get(id)?.attention.length === 0, "released hook attention");
  assert.deepEqual(backend.state.get(id)?.control, claudeTmuxSession().control);
});

test("external Claude permissions fail open immediately when no authenticated cockpit is present", async (t) => {
  const database = new ManagerDatabase();
  persistClaude(database);
  const id = sessionRecordId("local", "claude", "claude-external");
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    initialSessions: [session("claude", "claude-external")],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  const reply = await Promise.race([
    backend.app.inject({
      method: "POST",
      url: "/api/v1/hooks/claude",
      headers: {
        host: HOST,
        authorization: `Bearer ${CLAUDE_TOKEN}`,
        "content-type": "application/json",
      },
      payload: claudePermission(),
    }),
    delay(1_000).then(() => { throw new Error("unattended Claude permission remained held"); }),
  ]);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.body, "");
  assert.equal(backend.state.get(id)?.attention.length, 0);
  assert.equal(backend.state.get(id)?.control.plane, "observe-only");
});

test("recent Codex hook evidence selects the foreign hook plane and expires to observe-only", async (t) => {
  const database = new ManagerDatabase();
  persistCodex(database);
  const id = sessionRecordId("local", "codex", "codex-external");
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    codexHookFreshnessMs: 25,
    initialSessions: [session("codex", "codex-external")],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  const reply = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/codex",
    headers: {
      host: HOST,
      authorization: `Bearer ${CODEX_TOKEN}`,
      "content-type": "application/json",
    },
    payload: codexSessionStart(),
  });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.deepEqual(reply.json(), {});
  assert.deepEqual(backend.state.get(id)?.control, {
    ...observeOnlyControl(),
    plane: "codex-hook-bridge",
    authority: "foreign",
  });
  assert.ok(backend.activityHub.snapshot(id)?.items.some(
    (item) => item.kind === "lifecycle" && item.title === "External Codex session started",
  ));
  assert.ok(database.getCodexHookInstallRecord("/Users/test/.codex/hooks.json")?.lastSeenAt);
  await waitFor(
    () => backend.state.get(id)?.control.plane === "observe-only",
    "stale Codex hook evidence to expire",
  );
  assert.deepEqual(backend.state.get(id)?.control, observeOnlyControl());
});

test("Codex hook evidence never promotes a manager-owned private session", async (t) => {
  const database = new ManagerDatabase();
  persistCodex(database);
  const id = sessionRecordId("local", "codex", "codex-private");
  const managed: SessionRecord = {
    ...session("codex", "codex-private"),
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "interrupt"],
      withheld: [],
      takeover: null,
    },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    database,
    initialSessions: [managed],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  const reply = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/codex",
    headers: {
      host: HOST,
      authorization: `Bearer ${CODEX_TOKEN}`,
      "content-type": "application/json",
    },
    payload: codexSessionStart("codex-private"),
  });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.deepEqual(backend.state.get(id)?.control, managed.control);
  assert.equal(backend.activityHub.snapshot(id), null);
});

test("owner reload rotates provider digests and releases holds from the removed token", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-hook-reload-"));
  const socketPath = join(root, "runtime", "control.sock");
  const database = new ManagerDatabase();
  persistClaude(database);
  const id = sessionRecordId("local", "claude", "claude-external");
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
    discovery: false,
    staticDir: false,
    database,
    controlSocketPath: socketPath,
    initialSessions: [session("claude", "claude-external")],
  });
  let cockpit: IncomingMessage | null = null;
  t.after(async () => {
    cockpit?.destroy();
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  cockpit = await openGlobalStream(address, headers.cookie, "hook-rotation-client");

  const pendingReply = backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host: HOST,
      authorization: `Bearer ${CLAUDE_TOKEN}`,
      "content-type": "application/json",
    },
    payload: claudePermission(),
  });
  await waitFor(() => backend.state.get(id)?.attention.length === 1, "held permission before rotation");

  const replacement = "replacement-claude-hook-token-with-more-than-thirty-two-characters";
  persistClaude(database, replacement);
  assert.deepEqual(await requestHooksReloadFromControlSocket(socketPath), { ok: true });
  const released = await pendingReply;
  assert.equal(released.statusCode, 200);
  assert.equal(released.body, "");
  assert.equal(backend.state.get(id)?.attention.length, 0);

  const oldReply = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host: HOST,
      authorization: `Bearer ${CLAUDE_TOKEN}`,
      "content-type": "application/json",
    },
    payload: claudeStop(),
  });
  assert.equal(oldReply.statusCode, 401);
  const newReply = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host: HOST,
      authorization: `Bearer ${replacement}`,
      "content-type": "application/json",
    },
    payload: claudeStop(),
  });
  assert.equal(newReply.statusCode, 200);
});

class FakeWorker implements WorkerPort {
  readonly requests: Array<{ type: "scan"; id: number; recentWindowSeconds: number }> = [];
  readonly #messageListeners = new Set<(message: DiscoveryWorkerMessage) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #exitListeners = new Set<(code: number) => void>();

  postMessage(message: { type: "scan"; id: number; recentWindowSeconds: number }): void {
    this.requests.push(message);
  }

  on(event: "message", listener: (message: DiscoveryWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(
    event: "message" | "error" | "exit",
    listener: ((message: DiscoveryWorkerMessage) => void)
      | ((error: Error) => void)
      | ((code: number) => void),
  ): this {
    if (event === "message") this.#messageListeners.add(listener as (message: DiscoveryWorkerMessage) => void);
    else if (event === "error") this.#errorListeners.add(listener as (error: Error) => void);
    else this.#exitListeners.add(listener as (code: number) => void);
    return this;
  }

  emitMessage(message: DiscoveryWorkerMessage): void {
    for (const listener of this.#messageListeners) listener(message);
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

test("authenticated provider hooks trigger one coalesced discovery scan", async (t) => {
  const worker = new FakeWorker();
  const backend = await createAgentManagerServer({
    staticDir: false,
    codexHookAuthorizationRecords: [{
      id: "codex-install",
      provider: "codex",
      tokenDigest: digestCodexHookToken(CODEX_TOKEN),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/Users/test/.codex/hooks.json",
      shimPath: "/Users/test/codex-hook.mjs",
    }],
    discovery: {
      intervalMs: 60_000,
      workerFactory: () => worker,
      workspaceResolver: { resolveMany: async () => new Map() },
    },
  });
  t.after(() => backend.close());
  await backend.app.ready();
  assert.equal(worker.requests.length, 1);

  const hook = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/codex",
    headers: {
      host: HOST,
      authorization: `Bearer ${CODEX_TOKEN}`,
      "content-type": "application/json",
    },
    payload: codexSessionStart(),
  });
  assert.equal(hook.statusCode, 200, hook.body);
  assert.equal(worker.requests.length, 1, "active scan is coalesced instead of overlapped");

  worker.emitMessage({
    type: "result",
    id: worker.requests[0]!.id,
    generatedAt: "2026-08-04T12:00:01.000Z",
    sessions: [session("codex", "codex-external")],
    diagnostics: [],
  });
  await waitFor(() => worker.requests.length === 2, "hook-triggered discovery follow-up");
});
