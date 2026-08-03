import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityMutation } from "../../activity/index.ts";
import {
  CodexManagedAdapter,
  CodexManagedCreationError,
} from "./adapter.ts";
import {
  CodexProviderBridge,
  codexRequestResponse,
  decodeCodexRequestId,
  encodeCodexRequestId,
} from "./provider-bridge.ts";
import type { MessageTransport } from "./rpc.ts";
import type {
  CodexPendingRequest,
  JsonObject,
  JsonRpcId,
  JsonValue,
} from "./types.ts";

type RpcHandler = (params: JsonObject) => JsonValue | Promise<JsonValue>;

class FakeCodexTransport implements MessageTransport {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly handlers = new Map<string, RpcHandler>();
  #messageListeners = new Set<(message: string) => void>();
  #closeListeners = new Set<(error: Error | null) => void>();

  constructor(userAgent = "codex-app-server/0.146.7") {
    this.handlers.set("initialize", () => ({
      codexHome: "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent,
    }));
  }

  async send(raw: string): Promise<void> {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.messages.push(message);
    if (typeof message.method !== "string" ||
        (typeof message.id !== "string" && typeof message.id !== "number")) {
      return;
    }
    const handler = this.handlers.get(message.method);
    queueMicrotask(async () => {
      try {
        if (!handler) {
          this.#emit({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
          return;
        }
        this.#emit({
          jsonrpc: "2.0",
          id: message.id,
          result: await handler((message.params ?? {}) as JsonObject),
        });
      } catch (error) {
        this.#emit({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32_000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
  }

  async close(): Promise<void> {
    for (const listener of this.#closeListeners) listener(null);
  }

  disconnect(error: Error): void {
    for (const listener of this.#closeListeners) listener(error);
  }

  onMessage(listener: (message: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  notify(method: string, params: JsonObject, emittedAtMs?: number): void {
    this.#emit({
      jsonrpc: "2.0",
      method,
      params,
      ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
    });
  }

  request(id: JsonRpcId, method: string, params: JsonObject): void {
    this.#emit({ jsonrpc: "2.0", id, method, params });
  }

  #emit(message: Record<string, unknown>): void {
    const raw = JSON.stringify(message);
    for (const listener of this.#messageListeners) listener(raw);
  }
}

function threadResult(
  id = "thread-1",
  status: "idle" | "active" = "idle",
): JsonObject {
  return {
    cwd: "/workspace",
    model: "gpt-5.6",
    thread: {
      id,
      cwd: "/workspace",
      status: status === "active"
        ? { type: "active", activeFlags: [] }
        : { type: "idle" },
      turns: [],
    },
  };
}

function threadResultWithRawStatus(status?: JsonValue): JsonObject {
  const result = threadResult();
  const thread = result.thread as JsonObject;
  if (status === undefined) delete thread.status;
  else thread.status = status;
  return result;
}

function methodMessages(
  transport: FakeCodexTransport,
  method: string,
): Array<Record<string, unknown>> {
  return transport.messages.filter((message) => message.method === method);
}

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function initializedAdapter(
  transport = new FakeCodexTransport(),
  requestTimeoutMs = 30_000,
): Promise<{ adapter: CodexManagedAdapter; transport: FakeCodexTransport }> {
  const adapter = new CodexManagedAdapter({
    transport,
    socketPath: "/tmp/agent-manager-test/codex.sock",
    requestTimeoutMs,
    createId: (() => {
      let id = 0;
      return () => `message-${++id}`;
    })(),
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });
  await adapter.initialize();
  return { adapter, transport };
}

test("negotiates the 0.146 protocol and sends initialized after initialize", async () => {
  const { adapter, transport } = await initializedAdapter();
  assert.equal(adapter.capabilities.compatible, true);
  assert.equal(adapter.capabilities.serverVersion, "0.146.7");
  assert.ok(adapter.capabilities.controls.includes("turn.steer"));
  assert.deepEqual(
    transport.messages.map((message) => message.method),
    ["initialize", "initialized"],
  );
  const params = transport.messages[0]?.params as JsonObject;
  assert.deepEqual(params.capabilities, {
    experimentalApi: true,
    requestAttestation: false,
  });
  await adapter.dispose();
});

test("fails closed to read-only when the App Server version drifts", async () => {
  const { adapter } = await initializedAdapter(
    new FakeCodexTransport("codex-app-server/0.147.0"),
  );
  assert.equal(adapter.capabilities.compatible, false);
  assert.deepEqual(adapter.capabilities.controls, ["thread.read"]);
  await assert.rejects(
    adapter.startThread({ cwd: "/workspace" }),
    /outside supported range/u,
  );
  await adapter.dispose();
});

test("validates the initial message before creating a provider thread", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());

  await assert.rejects(
    adapter.startThread({ cwd: "/workspace", initialMessage: "   " }),
    /must not be empty/u,
  );
  assert.equal(methodMessages(transport, "thread/start").length, 0);
  assert.deepEqual(adapter.listThreadStates(), []);
  await adapter.dispose();
});

test("starts a managed thread, sets planning mode, and dispatches initial input", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));

  const state = await adapter.startThread({
    cwd: "/workspace",
    mode: "planning",
    initialMessage: "Build the cockpit",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  assert.equal(state.mode, "planning");
  assert.equal(state.status, "running");
  assert.equal(state.activeTurnId, "turn-1");
  const methods = transport.messages.map((message) => message.method);
  assert.deepEqual(methods, [
    "initialize",
    "initialized",
    "thread/start",
    "thread/settings/update",
    "turn/start",
  ]);
  assert.deepEqual(methodMessages(transport, "thread/settings/update")[0]?.params, {
    threadId: "thread-1",
    collaborationMode: {
      mode: "plan",
      settings: { model: "gpt-5.6" },
    },
  });
  assert.deepEqual(methodMessages(transport, "turn/start")[0]?.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "Build the cockpit" }],
    clientUserMessageId: "message-1",
  });
  await adapter.dispose();
});

for (const scenario of [
  { label: "omits status", status: undefined },
  { label: "returns an unrecognized status", status: { type: "waiting" } },
] satisfies Array<{ label: string; status: JsonValue | undefined }>) {
  test(`dispatches managed initial input when thread/start ${scenario.label}`, async () => {
    const { adapter, transport } = await initializedAdapter();
    transport.handlers.set(
      "thread/start",
      () => threadResultWithRawStatus(scenario.status),
    );
    transport.handlers.set("turn/start", () => ({
      turn: { id: "turn-uncertain-status", status: "inProgress", items: [] },
    }));

    const state = await adapter.startThread({
      cwd: "/workspace",
      initialMessage: "Dispatch despite uncertain status",
    });

    assert.equal(methodMessages(transport, "turn/start").length, 1);
    assert.equal(state.status, "running");
    assert.equal(state.activeTurnId, "turn-uncertain-status");
    assert.deepEqual(state.queue, []);
    assert.deepEqual(methodMessages(transport, "turn/start")[0]?.params, {
      threadId: "thread-1",
      input: [{ type: "text", text: "Dispatch despite uncertain status" }],
      clientUserMessageId: "message-1",
    });
    await adapter.dispose();
  });
}

test("fails managed creation when initial input dispatch fails", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResultWithRawStatus());
  transport.handlers.set("turn/start", () => {
    throw new Error("simulated initial dispatch failure");
  });

  await assert.rejects(
    adapter.startThread({ cwd: "/workspace", initialMessage: "Must dispatch" }),
    (error: unknown) => {
      assert.ok(error instanceof CodexManagedCreationError);
      assert.equal(error.threadState.threadId, "thread-1");
      assert.equal(error.issue.stage, "initial-message");
      assert.equal(error.issue.outcome, "rejected");
      assert.equal(error.issue.initialMessageDisposition, "rejected");
      return true;
    },
  );
  assert.equal(methodMessages(transport, "turn/start").length, 1);
  assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  await adapter.dispose();
});

test("fails managed creation when turn/start omits its acknowledgement turn ID", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set(
    "thread/start",
    () => threadResultWithRawStatus({ type: "futureStatus" }),
  );
  transport.handlers.set("turn/start", () => ({
    turn: { status: "inProgress", items: [] },
  }));

  await assert.rejects(
    adapter.startThread({ cwd: "/workspace", initialMessage: "Must acknowledge" }),
    (error: unknown) => {
      assert.ok(error instanceof CodexManagedCreationError);
      assert.equal(error.threadState.threadId, "thread-1");
      assert.equal(error.issue.stage, "initial-message");
      assert.equal(error.issue.outcome, "uncertain");
      assert.equal(error.issue.initialMessageDisposition, "uncertain");
      assert.match(error.message, /turn\/start response omitted the turn ID/u);
      return true;
    },
  );
  assert.equal(methodMessages(transport, "turn/start").length, 1);
  assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  await adapter.dispose();
});

test("treats an initial turn/start timeout as uncertain and never leaves the prompt replayable", async () => {
  const { adapter, transport } = await initializedAdapter(
    new FakeCodexTransport(),
    10,
  );
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("turn/start", () => new Promise<JsonValue>(() => undefined));

  await assert.rejects(
    adapter.startThread({ cwd: "/workspace", initialMessage: "Run at most once" }),
    (error: unknown) => {
      assert.ok(error instanceof CodexManagedCreationError);
      assert.equal(error.issue.outcome, "uncertain");
      assert.equal(error.issue.initialMessageDisposition, "uncertain");
      assert.match(error.message, /timed out: turn\/start/u);
      return true;
    },
  );
  assert.equal(methodMessages(transport, "turn/start").length, 1);
  assert.equal(adapter.getThreadState("thread-1")?.status, "unknown");
  assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);

  const later = await adapter.queueMessage("thread-1", "A separate later message");
  assert.equal(later.status, "queued");
  assert.equal(methodMessages(transport, "turn/start").length, 1);
  assert.deepEqual(
    adapter.getThreadState("thread-1")?.queue.map((message) => message.text),
    ["A separate later message"],
  );
  await adapter.dispose();
});

test("keeps the ordinary queue gated for an existing thread with unknown status", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/read", () => threadResultWithRawStatus());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-must-not-start", status: "inProgress", items: [] },
  }));
  await adapter.readThread("thread-1");

  const queued = await adapter.queueMessage("thread-1", "Wait for an idle boundary");

  assert.equal(queued.status, "queued");
  assert.equal(methodMessages(transport, "turn/start").length, 0);
  assert.equal(adapter.getThreadState("thread-1")?.queue[0]?.status, "queued");
  await adapter.dispose();
});

test("keeps a manager-side FIFO and dispatches only at a completed turn boundary", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  let nextTurn = 0;
  transport.handlers.set("turn/start", () => ({
    turn: { id: `turn-${++nextTurn}`, status: "inProgress", items: [] },
  }));
  await adapter.startThread({ cwd: "/workspace" });

  const first = await adapter.queueMessage("thread-1", "first");
  const second = await adapter.queueMessage("thread-1", "second");
  const third = await adapter.queueMessage("thread-1", "third");
  assert.equal(first.status, "dispatched");
  assert.equal(second.status, "queued");
  assert.equal(third.status, "queued");
  assert.equal(methodMessages(transport, "turn/start").length, 1);

  transport.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  await eventually(() => {
    assert.equal(methodMessages(transport, "turn/start").length, 2);
    assert.deepEqual(
      adapter.getThreadState("thread-1")?.queue.map((item) => item.text),
      ["third"],
    );
  });
  assert.equal(
    ((methodMessages(transport, "turn/start")[1]?.params as JsonObject)
      .input as JsonValue[])[0] &&
      (((methodMessages(transport, "turn/start")[1]?.params as JsonObject)
        .input as JsonObject[])[0]?.text),
    "second",
  );
  await adapter.dispose();
});

test("requires exact active turn IDs for steer and interrupt", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-active", status: "inProgress", items: [] },
  }));
  transport.handlers.set("turn/steer", (params) => ({
    turnId: params.expectedTurnId as string,
  }));
  transport.handlers.set("turn/interrupt", () => null);
  await adapter.startThread({ cwd: "/workspace", initialMessage: "start" });

  await assert.rejects(
    adapter.steer("thread-1", "stale", "change course"),
    /Stale Codex turn/u,
  );
  assert.equal(
    await adapter.steer("thread-1", "turn-active", "change course"),
    "turn-active",
  );
  assert.deepEqual(methodMessages(transport, "turn/steer")[0]?.params, {
    threadId: "thread-1",
    expectedTurnId: "turn-active",
    input: [{ type: "text", text: "change course" }],
  });
  await assert.rejects(
    adapter.interrupt("thread-1", "stale"),
    /Stale Codex turn/u,
  );
  await adapter.interrupt("thread-1", "turn-active");
  assert.deepEqual(methodMessages(transport, "turn/interrupt")[0]?.params, {
    threadId: "thread-1",
    turnId: "turn-active",
  });
  await adapter.dispose();
});

test("ignores delayed completion events for a superseded turn", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  transport.notify("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-new", status: "inProgress", items: [] },
  });
  transport.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-old", status: "completed", items: [] },
  });
  assert.equal(adapter.getThreadState("thread-1")?.activeTurnId, "turn-new");
  assert.equal(adapter.getThreadState("thread-1")?.status, "running");
  await adapter.dispose();
});

test("retains exact typed requests across unrelated events and answers once", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  transport.request(17, "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1,
    command: "git status",
  });
  transport.notify("thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active", activeFlags: [] },
  });
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests.length, 1);

  await assert.rejects(
    adapter.respondToRequest("thread-1", 17, { decision: "acceptForSession" }),
    /Invalid or unsupported/u,
  );
  await adapter.respondToRequest("thread-1", 17, { decision: "accept" });
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests.length, 0);
  const response = transport.messages.at(-1);
  assert.deepEqual(response, { jsonrpc: "2.0", id: 17, result: { decision: "accept" } });
  await assert.rejects(
    adapter.respondToRequest("thread-1", 17, { decision: "decline" }),
    /stale, resolved/u,
  );
  await adapter.dispose();
});

test("provider-independent response envelopes map to exact Codex results", () => {
  const question: CodexPendingRequest = {
    id: "request-1",
    method: "item/tool/requestUserInput",
    kind: "user-input",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{ id: "surface", header: "Surface", question: "Which?" }],
    },
    respondable: true,
    receivedAt: "2026-08-03T12:00:00.000Z",
  };
  assert.deepEqual(codexRequestResponse(question, {
    kind: "answer",
    value: "Local web app",
    selectedOptions: [],
  }), {
    answers: { surface: { answers: ["Local web app"] } },
  });

  const approval: CodexPendingRequest = {
    ...question,
    id: 9,
    method: "item/commandExecution/requestApproval",
    kind: "command-approval",
  };
  assert.deepEqual(codexRequestResponse(approval, {
    kind: "decision",
    decision: "deny",
    reason: "Not now",
  }), { decision: "decline" });
  assert.equal(encodeCodexRequestId(9), "n:9");
  assert.equal(decodeCodexRequestId("n:9"), 9);
  assert.equal(encodeCodexRequestId("9"), "s:9");
  assert.equal(decodeCodexRequestId("s:9"), "9");
});

test("Codex MCP elicitation fails closed across SessionView and action dispatch", async () => {
  const request: CodexPendingRequest = {
    id: "elicit-1",
    method: "mcpServer/elicitation/request",
    kind: "elicitation",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "calendar",
      mode: "form",
      message: "Choose a calendar",
      requestedSchema: { type: "object", properties: {} },
      _meta: null,
    },
    respondable: true,
    receivedAt: "2026-08-03T12:00:00.000Z",
  };
  assert.deepEqual(codexRequestResponse(request, {
    kind: "decision",
    decision: "deny",
    reason: "Not now",
  }), {
    action: "decline",
    content: null,
    _meta: null,
  });
  assert.deepEqual(codexRequestResponse(request, {
    kind: "decision",
    decision: "allow",
    value: { calendar: "personal" },
  }), {
    action: "accept",
    content: { calendar: "personal" },
    _meta: null,
  });

  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "request-elicit",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Start",
    mode: "planning",
    permissionPreset: "standard",
    idempotencyKey: "create-elicit-session",
  }, context);
  transport.request(request.id, request.method, request.params);
  const view = bridge.getManagedSession("thread-1");
  assert.ok(view);
  const attention = view.attention.find((item) => item.id === "s:elicit-1");
  assert.equal(attention?.kind, "elicitation");
  assert.equal(attention?.details?.respondable, false);

  await assert.rejects(
    bridge.performAction(view, {
      type: "respond",
      requestId: "s:elicit-1",
      response: { kind: "decision", decision: "deny", reason: "Not now" },
      expectedGeneration: view.generation,
      idempotencyKey: "deny-elicit",
    }, context),
    /not respondable in the cockpit/u,
  );
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests.length, 1);
  assert.equal(
    transport.messages.some((message) =>
      message.id === request.id && Object.hasOwn(message, "result")
    ),
    false,
  );
  bridge.dispose();
  await adapter.dispose();
});

test("multi-question envelopes map atomically by stable provider question ID", () => {
  const request: CodexPendingRequest = {
    id: "request-multi",
    method: "item/tool/requestUserInput",
    kind: "user-input",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-multi",
      questions: [
        { id: "surface", header: "Surface", question: "Which surface?" },
        { id: "access", header: "Access", question: "Which access?" },
      ],
    },
    respondable: true,
    receivedAt: "2026-08-03T12:00:00.000Z",
  };
  assert.deepEqual(codexRequestResponse(request, {
    kind: "answers",
    answers: [
      {
        questionId: "access",
        value: "",
        selectedOptions: ["Loopback + Tailscale"],
      },
      {
        questionId: "surface",
        value: "Local web app",
        selectedOptions: [],
      },
    ],
  }), {
    answers: {
      access: { answers: ["Loopback + Tailscale"] },
      surface: { answers: ["Local web app"] },
    },
  });
  assert.throws(
    () => codexRequestResponse(request, {
      kind: "answers",
      answers: [{
        questionId: "surface",
        value: "Local web app",
        selectedOptions: [],
      }],
    }),
    /missing answers for: access/u,
  );
  assert.throws(
    () => codexRequestResponse(request, {
      kind: "answers",
      answers: [
        { questionId: "surface", value: "one", selectedOptions: [] },
        { questionId: "surface", value: "two", selectedOptions: [] },
      ],
    }),
    /Duplicate Codex answer/u,
  );
});

test("updates mode from provider notifications and generates argv-only native attach", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: {
      cwd: "/workspace",
      model: "gpt-5.6",
      collaborationMode: { mode: "plan", settings: { model: "gpt-5.6" } },
    },
  });
  assert.equal(adapter.getThreadState("thread-1")?.mode, "planning");
  assert.deepEqual(adapter.buildAttachCommand("thread-1"), {
    executable: "codex",
    args: [
      "resume",
      "thread-1",
      "--remote",
      "unix:///tmp/agent-manager-test/codex.sock",
    ],
    display:
      "codex resume thread-1 --remote unix:///tmp/agent-manager-test/codex.sock",
  });
  await adapter.dispose();
});

test("method-not-found disables only the failed capability", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  await assert.rejects(adapter.setMode("thread-1", "planning"), /Method not found/u);
  assert.equal(adapter.capabilities.controls.includes("mode.set"), false);
  assert.equal(adapter.capabilities.controls.includes("turn.queue"), true);
  await adapter.dispose();
});

test("ProviderControlAdapter bridge creates normalized sessions and streams changes", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-bridge", status: "inProgress", items: [] },
  }));
  const changes: Array<{
    status: string;
    name: string | null;
    runId: string | null | undefined;
  }> = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: (workspaceId) => {
      assert.equal(workspaceId, "workspace-1");
      return "/workspace";
    },
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    onSessionChanged: (view) => changes.push({
      status: view.status,
      name: view.name,
      runId: view.runId,
    }),
  });
  const signal = new AbortController().signal;
  const view = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace-1",
    name: "Cockpit builder",
    initialMessage: "Build it",
    mode: "planning",
    permissionPreset: "standard",
    idempotencyKey: "create-cockpit-builder",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "request-create",
    signal,
    workspace: { id: "workspace-1", label: "Workspace", path: "/workspace" },
  });
  assert.equal(view.id, "codex:thread-1");
  assert.equal(view.ownership, "manager");
  assert.equal(view.control.plane, "codex-app-server");
  assert.ok(view.control.capabilities.includes("steer"));
  assert.equal(view.mode.value, "planning");
  assert.equal(view.effectiveAccess.fullHostAccess, false);
  assert.equal(view.runId, "turn-bridge");

  transport.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-bridge", status: "completed", items: [] },
  });
  assert.deepEqual(changes.at(-1), {
    status: "idle",
    name: "Cockpit builder",
    runId: null,
  });
  const attach = await bridge.getAttachInstruction(view, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "request-attach",
    signal,
    workspace: null,
  });
  assert.equal(attach?.kind, "codex-remote");
  assert.deepEqual(attach?.argv.slice(0, 3), ["codex", "resume", "thread-1"]);
  bridge.dispose();
  await adapter.dispose();
});

test("ProviderControlAdapter surfaces an addressable recovery handle after mode setup fails", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => {
    throw new Error("mode setup rejected");
  });
  const activity: Array<{ managerSessionId: string; mutation: ActivityMutation }> = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onActivity: (managerSessionId, mutation) => {
      activity.push({ managerSessionId, mutation });
    },
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "mode-recovery",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };

  const view = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "This must not be sent before mode is confirmed",
    mode: "planning",
    permissionPreset: "standard",
    idempotencyKey: "mode-recovery",
  }, context);

  assert.equal(view.id, "codex:thread-1");
  assert.equal(view.status, "waiting");
  assert.equal(view.waitingReason, "blocked");
  assert.equal(view.attention[0]?.id, "creation-recovery");
  assert.match(view.attention[0]?.summary ?? "", /initial message was not sent/u);
  assert.deepEqual(view.control.capabilities, ["attach", "resume"]);
  assert.equal(methodMessages(transport, "turn/start").length, 0);
  assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  assert.ok(activity.some((entry) =>
    entry.managerSessionId === "codex:thread-1" &&
    entry.mutation.type === "upsert" &&
    entry.mutation.item.kind === "lifecycle" &&
    entry.mutation.item.state === "failed"
  ));
  const attach = await bridge.getAttachInstruction(view, context);
  assert.deepEqual(attach?.argv.slice(0, 3), ["codex", "resume", "thread-1"]);
  await assert.rejects(
    bridge.performAction(view, {
      type: "send",
      delivery: "queue",
      text: "Do not auto-recover",
      expectedGeneration: view.generation,
      idempotencyKey: "unsafe-retry",
    }, context),
    /needs native recovery/u,
  );
  assert.equal(methodMessages(transport, "turn/start").length, 0);

  bridge.dispose();
  await adapter.dispose();
});

test("ProviderControlAdapter retains buffered live activity when turn acknowledgement is uncertain", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  const activity: Array<{ managerSessionId: string; mutation: ActivityMutation }> = [];
  let callbackCountInsideTurnStart = -1;
  transport.handlers.set("turn/start", () => {
    transport.notify("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-provider-confirmed", status: "inProgress", items: [] },
    });
    transport.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-provider-confirmed",
      item: { type: "agentMessage", id: "answer-uncertain", text: "", phase: "commentary" },
    });
    transport.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-provider-confirmed",
      itemId: "answer-uncertain",
      delta: "The provider is already producing output",
    });
    callbackCountInsideTurnStart = activity.length;
    // The request succeeded but its direct acknowledgement is malformed. A
    // retry could duplicate the running prompt, so creation must recover the
    // provider thread without replaying it.
    return { turn: { status: "inProgress", items: [] } };
  });
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onActivity: (managerSessionId, mutation) => {
      activity.push({ managerSessionId, mutation });
    },
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "uncertain-ack",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };

  const view = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Run exactly once",
    mode: "execution",
    permissionPreset: "standard",
    idempotencyKey: "uncertain-ack",
  }, context);

  assert.equal(callbackCountInsideTurnStart, 0);
  assert.equal(view.id, "codex:thread-1");
  assert.equal(view.status, "running");
  assert.equal(view.runId, "turn-provider-confirmed");
  assert.equal(view.waitingReason, "blocked");
  assert.match(view.attention[0]?.summary ?? "", /will not be sent again automatically/u);
  assert.deepEqual(view.control.capabilities, ["interrupt", "attach", "resume"]);
  assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  assert.equal(methodMessages(transport, "turn/start").length, 1);
  assert.ok(activity.every((entry) => entry.managerSessionId === "codex:thread-1"));
  assert.ok(activity.some((entry) =>
    entry.mutation.type === "append" &&
    entry.mutation.id.endsWith("/answer-uncertain") &&
    entry.mutation.text === "The provider is already producing output"
  ));

  await assert.rejects(
    bridge.performAction(view, {
      type: "send",
      delivery: "queue",
      text: "Do not duplicate",
      expectedGeneration: view.generation,
      idempotencyKey: "do-not-duplicate",
    }, context),
    /needs native recovery/u,
  );
  assert.equal(methodMessages(transport, "turn/start").length, 1);

  bridge.dispose();
  await adapter.dispose();
});

test("ProviderControlAdapter buffers first-turn activity until the manager session mapping exists", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  const activity: Array<{ managerSessionId: string; mutation: ActivityMutation }> = [];
  let callbackCountInsideTurnStart = -1;
  transport.handlers.set("turn/start", () => {
    transport.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-first",
      startedAtMs: 1_775_212_800_000,
      item: { type: "agentMessage", id: "answer-first", text: "", phase: "commentary" },
    }, 1_775_212_800_010);
    transport.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-first",
      itemId: "answer-first",
      delta: "First live output",
    }, 1_775_212_800_020);
    callbackCountInsideTurnStart = activity.length;
    return { turn: { id: "turn-first", status: "inProgress", items: [] } };
  });

  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onActivity: (managerSessionId, mutation) => {
      activity.push({ managerSessionId, mutation });
    },
  });
  await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Start immediately",
    mode: "execution",
    permissionPreset: "standard",
    idempotencyKey: "first-activity-race",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "first-activity-race",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  });

  assert.equal(callbackCountInsideTurnStart, 0);
  assert.ok(activity.length >= 4, "queue and assistant mutations should flush after mapping");
  assert.ok(activity.every((entry) => entry.managerSessionId === "codex:thread-1"));
  const assistantUpsert = activity.find((entry) =>
    entry.mutation.type === "upsert" &&
    entry.mutation.item.kind === "message" &&
    entry.mutation.item.id.endsWith("/answer-first")
  );
  assert.ok(assistantUpsert);
  if (assistantUpsert.mutation.type === "upsert") {
    assert.equal(assistantUpsert.mutation.item.updatedAt, "2026-04-03T10:40:00.010Z");
  }
  const assistantDelta = activity.find((entry) =>
    entry.mutation.type === "append" &&
    entry.mutation.id.endsWith("/answer-first")
  );
  assert.deepEqual(assistantDelta?.mutation, {
    type: "append",
    id: "codex/item/thread-1/turn-first/answer-first",
    channel: "text",
    offset: 0,
    text: "First live output",
  });

  bridge.dispose();
  await adapter.dispose();
});

test("Codex SessionView publishes exact questions and bounded approval details", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-details", status: "inProgress", items: [] },
  }));
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "request-details",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Start",
    mode: "planning",
    permissionPreset: "standard",
    idempotencyKey: "create-details-session",
  }, context);

  transport.request("questions", "item/tool/requestUserInput", {
    threadId: "thread-1",
    turnId: "turn-details",
    itemId: "item-questions",
    questions: [
      {
        id: "surface",
        header: "Surface",
        question: "Where should the cockpit run?",
        options: [
          { label: "Local web", description: "Runs on loopback" },
          { label: "Terminal", description: "Uses a TUI" },
        ],
      },
      {
        id: "access",
        header: "Access",
        question: "Who can connect?",
        options: null,
      },
    ],
  });
  const questionAttention = bridge.getManagedSession("thread-1")?.attention.find(
    (attention) => attention.id === "s:questions",
  );
  assert.deepEqual(questionAttention?.details, {
    title: "Codex needs your answers",
    questions: [
      {
        id: "surface",
        text: "Surface: Where should the cockpit run?",
        options: [
          { label: "Local web", description: "Runs on loopback" },
          { label: "Terminal", description: "Uses a TUI" },
        ],
        multiSelect: false,
        allowFreeText: true,
      },
      {
        id: "access",
        text: "Access: Who can connect?",
        options: [],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  });

  transport.request("approval", "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-details",
    itemId: "item-command",
    startedAtMs: 1,
    command: "x".repeat(1_200),
  });
  const approvalAttention = bridge.getManagedSession("thread-1")?.attention.find(
    (attention) => attention.id === "s:approval",
  );
  assert.equal(approvalAttention?.details?.toolName, "Command execution");
  assert.equal(Array.from(approvalAttention?.details?.inputSummary ?? "").length, 1_001);
  assert.match(approvalAttention?.details?.inputSummary ?? "", /…$/u);
  bridge.dispose();
  await adapter.dispose();
});

test("transport death atomically fails managed sessions and in-flight controls", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-bootstrap", status: "inProgress", items: [] },
  }));

  const published: Array<{ runtimeAlive: boolean; capabilities: readonly string[] }> = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => published.push({
      runtimeAlive: session.runtimeAlive,
      capabilities: session.control.capabilities,
    }),
  });
  await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "bootstrap",
    mode: "execution",
    permissionPreset: "standard",
    idempotencyKey: "runtime-death-session",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "runtime-death-create",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  });
  transport.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-bootstrap", status: "completed", items: [] },
  });
  transport.handlers.set("turn/start", () => new Promise<JsonValue>(() => undefined));
  published.length = 0;
  transport.request("pending-approval", "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: "git status",
  });
  const dispatch = adapter.queueMessage("thread-1", "queued control");
  await eventually(() => {
    assert.equal(methodMessages(transport, "turn/start").length, 2);
  });

  transport.disconnect(new Error("simulated socket reset"));

  await assert.rejects(dispatch, /simulated socket reset/u);
  assert.equal(adapter.runtimeAlive, false);
  assert.equal(adapter.runtimeFailure, "simulated socket reset");
  assert.equal(adapter.capabilities.compatible, false);
  assert.deepEqual(adapter.capabilities.controls, []);
  assert.equal(adapter.getThreadState("thread-1")?.status, "system-error");
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests.length, 0);
  assert.equal(adapter.getThreadState("thread-1")?.queue[0]?.status, "queued");

  const view = bridge.getManagedSession("thread-1");
  assert.equal(view?.runtimeAlive, false);
  assert.equal(view?.status, "failed");
  assert.deepEqual(view?.attention, []);
  assert.deepEqual(view?.control.capabilities, []);
  assert.deepEqual(published.at(-1), { runtimeAlive: false, capabilities: [] });
  await assert.rejects(
    adapter.queueMessage("thread-1", "must fail closed"),
    /App Server is unavailable/u,
  );

  bridge.dispose();
  await adapter.dispose();
});
