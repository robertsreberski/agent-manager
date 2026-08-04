import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityMutation } from "../../activity/index.ts";
import type { ManagedSessionRecoveryRecord } from "../../server/contracts.ts";
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

function threadResultWithIdentity(
  id: string,
  treeId: string | null,
  parentThreadId: string | null,
  cwd = "/workspace",
): JsonObject {
  const result = threadResult(id);
  const thread = result.thread as JsonObject;
  result.cwd = cwd;
  thread.cwd = cwd;
  if (treeId !== null) thread.sessionId = treeId;
  if (parentThreadId !== null) thread.parentThreadId = parentThreadId;
  return result;
}

function threadResultWithRawStatus(status?: JsonValue): JsonObject {
  const result = threadResult();
  const thread = result.thread as JsonObject;
  if (status === undefined) delete thread.status;
  else thread.status = status;
  return result;
}

function accountUsageResult(): JsonObject {
  return {
    summary: {
      lifetimeTokens: 1_250_000,
      peakDailyTokens: 240_000,
      longestRunningTurnSec: 840,
      currentStreakDays: 4,
      longestStreakDays: 9,
    },
    dailyUsageBuckets: [
      { startDate: "2026-08-03", tokens: 12_000 },
      { startDate: "2026-08-04", tokens: 18_500 },
    ],
  };
}

function accountRateLimitsResult(): JsonObject {
  return {
    rateLimits: {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_775_299_200 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: "provider-private-balance" },
      individualLimit: null,
      spendControlReached: false,
      planType: "plus",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [{
        id: "provider-private-credit-id",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1_775_000_000,
        expiresAt: null,
        title: "Reset",
        description: "Private provider detail",
      }],
    },
  };
}

function modelCatalogEntry(input: {
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultEffort?: string;
  efforts?: readonly string[];
}): JsonObject {
  const efforts = input.efforts ?? ["low", "medium", "high"];
  return {
    id: `catalog:${input.model}`,
    model: input.model,
    displayName: input.displayName,
    description: input.description ?? "Provider model",
    hidden: input.hidden ?? false,
    isDefault: input.isDefault ?? false,
    defaultReasoningEffort: input.defaultEffort ?? "medium",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} reasoning`,
    })),
  };
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

test("withdraws every capability when the App Server version drifts", async () => {
  const { adapter } = await initializedAdapter(
    new FakeCodexTransport("codex-app-server/0.147.0"),
  );
  assert.equal(adapter.capabilities.compatible, false);
  assert.deepEqual(adapter.capabilities.controls, []);
  await assert.rejects(
    adapter.startThread({ cwd: "/workspace" }),
    /outside supported range/u,
  );
  await adapter.dispose();
});

test("reads pinned Codex account facts and projects only bounded display-safe fields", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("account/usage/read", accountUsageResult);
  transport.handlers.set("account/rateLimits/read", accountRateLimitsResult);

  const facts = await adapter.readAccountFacts();
  assert.deepEqual(facts, {
    available: true,
    source: "provider-api",
    usage: {
      summary: {
        lifetimeTokens: 1_250_000,
        peakDailyTokens: 240_000,
        longestRunningTurnSec: 840,
        currentStreakDays: 4,
        longestStreakDays: 9,
      },
      recentDays: [
        { date: "2026-08-03", tokens: 12_000 },
        { date: "2026-08-04", tokens: 18_500 },
      ],
    },
    rateLimits: [{
      label: "Codex",
      planType: "plus",
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_775_299_200 },
      secondary: null,
      spendControlReached: false,
    }],
  });
  const serialized = JSON.stringify(facts);
  assert.doesNotMatch(serialized, /private|balance|credit-id/u);
  for (const method of ["account/usage/read", "account/rateLimits/read"]) {
    const message = methodMessages(transport, method)[0];
    assert.ok(message);
    assert.equal(Object.hasOwn(message, "params"), false, `${method} has no params in the 0.146 schema`);
  }
  await adapter.dispose();
});

test("omits individually unsupported Codex account methods without inventing zeroes", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("account/usage/read", accountUsageResult);

  const facts = await adapter.readAccountFacts();
  assert.equal(facts.usage?.summary.lifetimeTokens, 1_250_000);
  assert.equal(facts.rateLimits, null);
  await adapter.dispose();
});

test("reads the bounded Codex model catalog with per-model effort truth", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("model/list", (params) => {
    if (params.cursor === "page-2") {
      assert.deepEqual(params, { limit: 63, includeHidden: false, cursor: "page-2" });
      return {
        data: [modelCatalogEntry({
          model: "gpt-codex-deep",
          displayName: "Codex Deep",
          efforts: ["high", "xhigh", "ultra"],
          defaultEffort: "xhigh",
        })],
        // The live 0.146 response may omit its optional terminal cursor.
      };
    }
    assert.deepEqual(params, { limit: 64, includeHidden: false });
    return {
      data: [
        modelCatalogEntry({
          model: "gpt-codex",
          displayName: "Codex",
          description: "Balanced",
          isDefault: true,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        }),
        modelCatalogEntry({
          model: "hidden-model",
          displayName: "Hidden",
          hidden: true,
        }),
      ],
      nextCursor: "page-2",
    };
  });

  assert.deepEqual(await adapter.listModels(), [
    {
      value: "gpt-codex",
      label: "Codex",
      description: "Balanced",
      isDefault: true,
      defaultEffort: "medium",
      efforts: ["low", "medium", "high"],
    },
    {
      value: "gpt-codex-deep",
      label: "Codex Deep",
      description: "Provider model",
      isDefault: false,
      defaultEffort: "xhigh",
      efforts: ["high", "xhigh", "ultra"],
    },
  ]);
  assert.equal(methodMessages(transport, "model/list").length, 2);
  await adapter.dispose();
});

test("reads draft settings through the provider bridge without creating a session", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("model/list", () => ({
    data: [modelCatalogEntry({
      model: "gpt-codex",
      displayName: "Codex",
      description: "Live provider catalog",
      isDefault: true,
      efforts: ["medium", "high", "xhigh"],
      defaultEffort: "high",
    })],
    nextCursor: null,
  }));
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });

  assert.deepEqual(await bridge.getCreateSettingsOptions({
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "draft-settings",
    signal: new AbortController().signal,
    workspace: null,
  }), {
    source: "provider-api",
    models: [{
      value: "gpt-codex",
      label: "Codex",
      description: "Live provider catalog",
      isDefault: true,
      defaultEffort: "high",
      efforts: ["medium", "high", "xhigh"],
    }],
  });
  assert.deepEqual(adapter.listThreadStates(), []);
  assert.equal(methodMessages(transport, "model/list").length, 1);
  assert.equal(methodMessages(transport, "thread/start").length, 0);
  assert.equal(methodMessages(transport, "thread/resume").length, 0);

  bridge.dispose();
  await adapter.dispose();
});

test("cancels and releases an in-flight draft model/list RPC", async () => {
  const { adapter, transport } = await initializedAdapter();
  let finishCatalog!: (value: JsonValue) => void;
  transport.handlers.set("model/list", () => new Promise<JsonValue>((resolve) => {
    finishCatalog = resolve;
  }));
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  const controller = new AbortController();
  const lookup = bridge.getCreateSettingsOptions({
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "cancel-draft-settings",
    signal: controller.signal,
    workspace: null,
  });
  await eventually(() => assert.equal(methodMessages(transport, "model/list").length, 1));
  controller.abort(new Error("draft settings cancelled"));
  // The fake App Server is still holding its response. Rejection here can only
  // come from the signal removing the client's pending model/list call.
  await assert.rejects(lookup, /draft settings cancelled/u);

  finishCatalog({ data: [], nextCursor: null });
  await new Promise((resolve) => setImmediate(resolve));
  bridge.dispose();
  await adapter.dispose();
});

test("fails closed on malformed Codex model effort metadata", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("model/list", () => ({
    data: [modelCatalogEntry({
      model: "broken",
      displayName: "Broken",
      efforts: ["high", "high"],
      defaultEffort: "high",
    })],
    nextCursor: null,
  }));
  await assert.rejects(adapter.listModels(), /effort option/u);

  const missingIdentity = modelCatalogEntry({
    model: "missing-identity",
    displayName: "Missing identity",
  });
  delete missingIdentity.id;
  transport.handlers.set("model/list", () => ({
    data: [missingIdentity],
    nextCursor: null,
  }));
  await assert.rejects(adapter.listModels(), /catalog identity/u);
  await adapter.dispose();
});

test("rejects malformed or timed-out Codex account payloads", async () => {
  const malformed = await initializedAdapter();
  malformed.transport.handlers.set("account/usage/read", () => ({
    ...accountUsageResult(),
    accessToken: "must-never-cross",
  }));
  malformed.transport.handlers.set("account/rateLimits/read", accountRateLimitsResult);
  await assert.rejects(malformed.adapter.readAccountFacts());
  await malformed.adapter.dispose();

  const timedOut = await initializedAdapter(new FakeCodexTransport(), 10);
  timedOut.transport.handlers.set("account/usage/read", () => new Promise(() => undefined));
  timedOut.transport.handlers.set("account/rateLimits/read", () => new Promise(() => undefined));
  await assert.rejects(timedOut.adapter.readAccountFacts(), /timed out/u);
  await timedOut.adapter.dispose();
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

test("starts a managed thread, stages a plan profile, and dispatches initial input", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));

  const state = await adapter.startThread({
    cwd: "/workspace",
    profile: "plan",
    initialMessage: "Build the cockpit",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  assert.equal(state.profile, null);
  assert.equal(state.pendingSettings?.profile, "plan");
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
      settings: {
        model: "gpt-5.6",
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: false,
    },
  });
  assert.deepEqual(methodMessages(transport, "turn/start")[0]?.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "Build the cockpit" }],
    clientUserMessageId: "message-1",
  });
  await adapter.dispose();
});

test("uses the thread/start default model to stage a null-model managed create", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", (params) => {
    assert.equal(Object.hasOwn(params, "model"), false);
    return {
      ...threadResult(),
      reasoningEffort: "high",
    };
  });
  transport.handlers.set("thread/settings/update", (params) => {
    assert.deepEqual(params, {
      threadId: "thread-1",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.6",
          reasoning_effort: "medium",
          developer_instructions: null,
        },
      },
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "medium",
    });
    return {};
  });
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-default-model", status: "inProgress", items: [] },
  }));

  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  const view = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Dispatch with the provider default model",
    profile: "full-access",
    model: null,
    effort: "medium",
    idempotencyKey: "provider-default-model",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "provider-default-model",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  });

  assert.equal(view.status, "running");
  assert.equal(adapter.getThreadState("thread-1")?.model, "gpt-5.6");
  assert.equal(methodMessages(transport, "thread/settings/update").length, 1);
  assert.equal(methodMessages(transport, "turn/start").length, 1);
  assert.deepEqual(methodMessages(transport, "turn/start")[0]?.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "Dispatch with the provider default model" }],
    clientUserMessageId: "message-1",
  });
  bridge.dispose();
  await adapter.dispose();
});

test("does not stage settings or dispatch when thread/start omits its required default model", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => {
    const result = threadResult();
    delete result.model;
    return result;
  });

  await assert.rejects(
    adapter.startThread({
      cwd: "/workspace",
      profile: "full-access",
      effort: "medium",
      initialMessage: "Must remain unsent",
    }),
    (error: unknown) => {
      assert.ok(error instanceof CodexManagedCreationError);
      assert.equal(error.threadState.threadId, "thread-1");
      assert.equal(error.issue.stage, "profile");
      assert.equal(error.issue.outcome, "rejected");
      assert.equal(error.issue.initialMessageDisposition, "not-sent");
      assert.match(error.issue.message, /did not return the model/u);
      return true;
    },
  );

  assert.equal(methodMessages(transport, "thread/settings/update").length, 0);
  assert.equal(methodMessages(transport, "turn/start").length, 0);
  assert.ok(adapter.getThreadState("thread-1"));
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
  transport.handlers.set("thread/resume", () => threadResultWithRawStatus());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-must-not-start", status: "inProgress", items: [] },
  }));
  await adapter.adoptThread("thread-1", {
    threadId: "thread-1",
    treeId: null,
    parentThreadId: null,
    cwd: "/workspace",
  });

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

  await adapter.respondToRequest("thread-1", 17, { decision: "acceptForSession" });
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests.length, 0);
  const response = transport.messages.at(-1);
  assert.deepEqual(response, { jsonrpc: "2.0", id: 17, result: { decision: "acceptForSession" } });
  await assert.rejects(
    adapter.respondToRequest("thread-1", 17, { decision: "decline" }),
    /stale, resolved/u,
  );

  transport.request(18, "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-2",
    startedAtMs: 2,
    command: "git diff",
  });
  await adapter.respondToRequest("thread-1", 18, { decision: "accept" });
  assert.deepEqual(transport.messages.at(-1), {
    jsonrpc: "2.0",
    id: 18,
    result: { decision: "accept" },
  });
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
  assert.deepEqual(codexRequestResponse(approval, {
    kind: "decision",
    decision: "allow",
    persist: true,
  }), { decision: "acceptForSession" });
  assert.deepEqual(codexRequestResponse({
    ...approval,
    method: "item/fileChange/requestApproval",
    kind: "file-change-approval",
  }, {
    kind: "decision",
    decision: "allow",
    persist: true,
  }), { decision: "acceptForSession" });
  assert.throws(() => codexRequestResponse(approval, {
    kind: "decision",
    decision: "deny",
    persist: true,
  }), /cannot persist a denied approval/);
  assert.throws(() => codexRequestResponse({
    ...approval,
    method: "item/permissions/requestApproval",
    kind: "permission-approval",
    params: {
      ...approval.params,
      cwd: "/workspace",
      permissions: { network: { enabled: true } },
    },
  }, {
    kind: "decision",
    decision: "allow",
    persist: true,
  }), /scoped to this turn/);
  assert.equal(encodeCodexRequestId(9), "n:9");
  assert.equal(decodeCodexRequestId("n:9"), 9);
  assert.equal(encodeCodexRequestId("9"), "s:9");
  assert.equal(decodeCodexRequestId("s:9"), "9");
});

test("Random pick choices preserve exact Codex labels and reject ambiguous answers", () => {
  const question: CodexPendingRequest = {
    id: "random-pick",
    method: "item/tool/requestUserInput",
    kind: "user-input",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-random-pick",
      questions: [{
        id: "random_destination",
        header: "Random pick",
        question: "Which imaginary weekend destination would you choose?",
        isOther: true,
        options: [
          {
            label: "Moon cabin (Recommended)",
            description: "Quiet views, low gravity, and maximum novelty.",
          },
          { label: "Undersea hotel", description: "Ocean life outside every window." },
          { label: "Cloud city", description: "Endless sunsets and dramatic scenery." },
        ],
      }],
    },
    respondable: true,
    receivedAt: "2026-08-04T07:04:18.242Z",
  };

  assert.deepEqual(codexRequestResponse(question, {
    kind: "answer",
    value: "",
    selectedOptions: ["Moon cabin (Recommended)"],
  }), {
    answers: {
      random_destination: { answers: ["Moon cabin (Recommended)"] },
    },
  });
  assert.deepEqual(codexRequestResponse(question, {
    kind: "answer",
    value: "A library at the edge of time",
    selectedOptions: [],
  }), {
    answers: {
      random_destination: { answers: ["A library at the edge of time"] },
    },
  });

  assert.throws(
    () => codexRequestResponse(question, {
      kind: "answer",
      value: "",
      selectedOptions: ["Moon cabin (Recommended)", "Cloud city"],
    }),
    /accepts only one option/u,
  );
  assert.throws(
    () => codexRequestResponse(question, {
      kind: "answer",
      value: "A library at the edge of time",
      selectedOptions: ["Moon cabin (Recommended)"],
    }),
    /cannot combine an option with a custom answer/u,
  );
  assert.throws(
    () => codexRequestResponse(question, {
      kind: "answer",
      value: "",
      selectedOptions: ["Mars resort"],
    }),
    /Unknown option/u,
  );
  assert.throws(
    () => codexRequestResponse({
      ...question,
      params: {
        ...question.params,
        questions: [{
          ...(question.params.questions as JsonObject[])[0],
          isOther: false,
        }],
      },
    }, {
      kind: "answer",
      value: "A library at the edge of time",
      selectedOptions: [],
    }),
    /does not allow a custom answer/u,
  );
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
  transport.handlers.set("thread/unsubscribe", () => ({}));
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
  const created = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Start",
    profile: "plan",
    model: null,
    effort: null,
    idempotencyKey: "create-elicit-session",
  }, context);
  const releaseSelection = await bridge.acquireSelectedSession(created, context);
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
  await releaseSelection();
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
        {
          id: "access",
          header: "Access",
          question: "Which access?",
          options: [{ label: "Loopback + Tailscale" }],
        },
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

test("updates profile from provider notifications and generates argv-only native attach", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: {
      cwd: "/workspace",
      model: "gpt-5.6",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
      collaborationMode: { mode: "plan", settings: { developer_instructions: null } },
    },
  });
  assert.equal(adapter.getThreadState("thread-1")?.profile, "plan");
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

test("method-not-found falls back to next-turn settings without optimistic state", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  await adapter.setProfile("thread-1", "plan");
  assert.equal(adapter.capabilities.settingsDelivery, "next-turn");
  assert.equal(adapter.getThreadState("thread-1")?.profile, null);
  assert.equal(adapter.getThreadState("thread-1")?.pendingSettings?.profile, "plan");
  assert.equal(adapter.capabilities.controls.includes("profile.set"), true);
  assert.equal(adapter.capabilities.controls.includes("turn.queue"), true);
  await adapter.dispose();
});

test("adopts by Thread.id and unsubscribe releases only this client", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/resume", () => threadResult("foreign-thread"));
  transport.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  const state = await adapter.adoptThread("foreign-thread", {
    threadId: "foreign-thread",
    treeId: null,
    parentThreadId: null,
    cwd: "/workspace",
  });
  assert.equal(state.threadId, "foreign-thread");
  await adapter.releaseThread("foreign-thread");
  assert.equal(adapter.getThreadState("foreign-thread"), null);
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 1);
  await adapter.dispose();
});

test("rejects read and resume responses that substitute a different Thread.id", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/read", () => threadResult("wrong-thread"));
  transport.handlers.set("thread/resume", () => threadResult("wrong-thread"));

  await assert.rejects(
    adapter.readThread("persisted-thread"),
    /returned wrong-thread for requested thread persisted-thread/u,
  );
  assert.deepEqual(methodMessages(transport, "thread/read")[0]?.params, {
    threadId: "persisted-thread",
    includeTurns: false,
  });
  await assert.rejects(
    adapter.resumeThread("persisted-thread"),
    /returned wrong-thread for requested thread persisted-thread/u,
  );
  assert.equal(adapter.getThreadState("wrong-thread"), null);
  assert.equal(adapter.getThreadState("persisted-thread"), null);
  await adapter.dispose();
});

test("emits one truthful removal event for acknowledged end, archive, and delete", async () => {
  const { adapter, transport } = await initializedAdapter();
  let nextThread = 0;
  transport.handlers.set("thread/start", () => threadResult(`lifecycle-${++nextThread}`));
  transport.handlers.set("thread/archive", () => ({}));
  transport.handlers.set("thread/delete", () => ({}));
  transport.handlers.set("thread/unsubscribe", () => ({}));
  const removals: Array<{ threadId: string; reason: string }> = [];
  const unsubscribe = adapter.subscribe((event) => {
    if (event.type === "thread.removed") removals.push(event);
  });

  await adapter.startThread({ cwd: "/workspace" });
  await adapter.archiveThread("lifecycle-1");
  transport.notify("thread/archived", { threadId: "lifecycle-1" });
  await adapter.startThread({ cwd: "/workspace" });
  await adapter.deleteThread("lifecycle-2");
  transport.notify("thread/deleted", { threadId: "lifecycle-2" });
  await adapter.startThread({ cwd: "/workspace" });
  await adapter.endThread("lifecycle-3");

  assert.deepEqual(removals, [
    { type: "thread.removed", threadId: "lifecycle-1", reason: "archived" },
    { type: "thread.removed", threadId: "lifecycle-2", reason: "deleted" },
    { type: "thread.removed", threadId: "lifecycle-3", reason: "ended" },
  ]);
  assert.deepEqual(adapter.listThreadStates(), []);
  unsubscribe();
  await adapter.dispose();
});

test("restores persisted ownership by capped exact reads and ref-counts selection", async () => {
  const { adapter, transport } = await initializedAdapter();
  const recoveredResult = (): JsonObject => ({
    cwd: "/workspace",
    model: "gpt-5.6",
    reasoningEffort: "high",
    thread: {
      id: "persisted-thread",
      sessionId: "tree-1",
      parentThreadId: "parent-thread",
      cwd: "/workspace",
      name: "Provider name",
      source: "agent-manager",
      status: { type: "idle" },
      turns: [],
    },
  });
  transport.handlers.set("thread/list", () => {
    throw new Error("thread/list must not run during managed recovery");
  });
  transport.handlers.set("thread/read", (params) => {
    if (params.threadId === "missing-thread") {
      throw new Error("thread not loaded: missing-thread");
    }
    return recoveredResult();
  });
  transport.handlers.set("thread/resume", recoveredResult);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "new-turn", status: "inProgress", items: [] },
  }));
  transport.handlers.set("turn/interrupt", () => ({}));
  transport.handlers.set("thread/unsubscribe", () => ({}));
  transport.handlers.set("model/list", () => ({
    data: [modelCatalogEntry({
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      isDefault: true,
      efforts: ["medium", "high", "xhigh"],
      defaultEffort: "high",
    })],
    nextCursor: null,
  }));
  const changes: ReturnType<CodexProviderBridge["toSessionView"]>[] = [];
  const removals: Array<{ managerSessionId: string; reason: string }> = [];
  const activity: ActivityMutation[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    now: () => new Date("2026-08-04T10:00:00.000Z"),
    onSessionChanged: (session) => changes.push(session),
    onSessionRemoved: (managerSessionId, reason) => {
      removals.push({ managerSessionId, reason });
    },
    onActivity: (_managerSessionId, mutation) => activity.push(mutation),
  });
  const signal = new AbortController().signal;
  const report = await bridge.restoreManagedSessions([
    {
      managerSessionId: "local:codex:persisted-thread",
      provider: "codex",
      providerThreadId: "persisted-thread",
      workspaceId: "workspace-1",
      workspacePath: "/workspace",
      name: "Persisted cockpit name",
      profile: "plan",
      createdAt: "2026-08-03T09:00:00.000Z",
    },
    {
      managerSessionId: "local:codex:missing-thread",
      provider: "codex",
      providerThreadId: "missing-thread",
      workspaceId: "workspace-1",
      workspacePath: "/workspace",
      name: null,
      profile: "execute",
      createdAt: "2026-08-03T09:05:00.000Z",
    },
  ], signal);

  assert.deepEqual(report, {
    restoredSessionIds: ["local:codex:persisted-thread"],
    failures: [{
      managerSessionId: "local:codex:missing-thread",
      providerThreadId: "missing-thread",
      reason: "thread not loaded: missing-thread",
    }],
    truncated: false,
  });
  assert.equal(changes.length, 1, "validated read state must publish once after reconciliation");
  assert.equal(changes[0]?.name, "Persisted cockpit name");
  assert.equal(changes[0]?.cwd, "/workspace");
  assert.equal(changes[0]?.providerTreeId, "tree-1");
  assert.equal(changes[0]?.parentId, "local:codex:parent-thread");
  assert.equal(changes[0]?.startedAt, "2026-08-03T09:00:00.000Z");
  assert.equal(changes[0]?.control.authority, "manager");
  assert.deepEqual(changes[0]?.control.capabilities, []);
  assert.equal(adapter.getThreadState("persisted-thread"), null);
  assert.equal(activity.length, 0);
  assert.deepEqual(
    transport.messages.map((message) => message.method),
    ["initialize", "initialized", "thread/read", "thread/read"],
  );
  assert.equal(methodMessages(transport, "thread/list").length, 0);

  const recovered = changes[0]!;
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "post-restart-action",
    signal,
    workspace: null,
  };
  await assert.rejects(
    bridge.performAction(recovered, {
      type: "send",
      delivery: "queue",
      text: "Must remain unloaded",
      expectedGeneration: recovered.generation,
      idempotencyKey: "unselected-post-restart-action",
    }, context),
    /not selected or loaded/u,
  );
  assert.equal(methodMessages(transport, "turn/start").length, 0, "recovery never replays work");

  const releaseFirst = await bridge.acquireSelectedSession(recovered, context);
  const releaseSecond = await bridge.acquireSelectedSession(recovered, {
    ...context,
    requestId: "second-selected-client",
  });
  assert.equal(methodMessages(transport, "thread/resume").length, 1);
  assert.equal(
    (methodMessages(transport, "thread/resume")[0]?.params as JsonObject).excludeTurns,
    true,
  );
  const selected = bridge.getManagedSession("persisted-thread");
  assert.ok(selected);
  assert.ok(selected.control.capabilities.includes("queue"));
  assert.deepEqual(await bridge.getSettingsOptions(selected, context), {
    source: "provider-api",
    models: [{
      value: "gpt-5.6",
      label: "GPT-5.6",
      description: "Provider model",
      isDefault: true,
      defaultEffort: "high",
      efforts: ["medium", "high", "xhigh"],
    }],
  });
  await bridge.performAction(selected, {
    type: "send",
    delivery: "queue",
    text: "A new action after restart",
    expectedGeneration: selected.generation,
    idempotencyKey: "post-restart-action",
  }, context);
  assert.equal(methodMessages(transport, "turn/start").length, 1);

  await releaseFirst();
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 0);
  await releaseSecond();
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 1);
  assert.equal(adapter.getThreadState("persisted-thread"), null);
  assert.deepEqual(bridge.getManagedSession("persisted-thread")?.control.capabilities, []);

  const releaseReselected = await bridge.acquireSelectedSession(recovered, {
    ...context,
    requestId: "reselected-client",
  });
  assert.equal(methodMessages(transport, "thread/resume").length, 2);

  const active = bridge.getManagedSession("persisted-thread");
  assert.ok(active);
  await bridge.performAction(active, {
    type: "end",
    expectedGeneration: active.generation,
    expectedProviderTurnId: active.providerTurnId ?? undefined,
    idempotencyKey: "end-restored-session",
  }, { ...context, requestId: "end-restored-session" });
  assert.deepEqual(removals, [
    {
      managerSessionId: "local:codex:persisted-thread",
      reason: "ended",
    },
  ]);
  assert.equal(bridge.getManagedSession("persisted-thread"), null);
  await releaseReselected();

  bridge.dispose();
  await adapter.dispose();
});

test("rejects repeated cold adoption identity drift without exposing controls or activity", async () => {
  const { adapter, transport } = await initializedAdapter();
  const threadId = "cold-managed-thread";
  const record: ManagedSessionRecoveryRecord = {
    managerSessionId: `local:codex:${threadId}`,
    provider: "codex",
    providerThreadId: threadId,
    workspaceId: "workspace-1",
    workspacePath: "/workspace",
    name: "Cold managed thread",
    profile: "execute",
    createdAt: "2026-08-03T09:00:00.000Z",
  };
  transport.handlers.set("thread/read", () =>
    threadResultWithIdentity(threadId, "original-tree", "original-parent")
  );
  transport.handlers.set("thread/unsubscribe", () => ({}));
  let resumeCount = 0;
  transport.handlers.set("thread/resume", () => {
    resumeCount += 1;
    const itemId = `stale-adoption-${resumeCount}`;
    transport.notify("item/started", {
      threadId,
      turnId: `stale-turn-${resumeCount}`,
      item: { type: "agentMessage", id: itemId, text: "", phase: "commentary" },
    });
    transport.notify("item/agentMessage/delta", {
      threadId,
      turnId: `stale-turn-${resumeCount}`,
      itemId,
      delta: `must-not-leak-${resumeCount}`,
    });
    return threadResultWithIdentity(
      threadId,
      `wrong-tree-${resumeCount}`,
      `wrong-parent-${resumeCount}`,
    );
  });
  const changes: ReturnType<CodexProviderBridge["toSessionView"]>[] = [];
  const activity: ActivityMutation[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    onActivity: (_managerSessionId, mutation) => activity.push(mutation),
  });
  const signal = new AbortController().signal;

  assert.deepEqual(await bridge.restoreManagedSessions([record], signal), {
    restoredSessionIds: [record.managerSessionId],
    failures: [],
    truncated: false,
  });
  const original = bridge.getManagedSession(threadId);
  assert.ok(original);
  assert.equal(original.providerTreeId, "original-tree");
  assert.equal(original.parentId, "local:codex:original-parent");
  assert.deepEqual(original.control.capabilities, []);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const cold = bridge.getManagedSession(threadId);
    assert.ok(cold);
    await assert.rejects(
      bridge.acquireSelectedSession(cold, {
        actor: { id: "local", kind: "local", displayName: "Local user" },
        requestId: `reject-drift-${attempt}`,
        signal,
        workspace: null,
      }),
      /changed the validated managed identity/u,
    );
    const after = bridge.getManagedSession(threadId);
    assert.ok(after);
    assert.equal(after.providerTreeId, "original-tree");
    assert.equal(after.parentId, "local:codex:original-parent");
    assert.equal(after.cwd, "/workspace");
    assert.equal(after.generation, original.generation);
    assert.equal(after.control.authority, "manager");
    assert.deepEqual(after.control.capabilities, []);
    assert.equal(adapter.getThreadState(threadId), null);
  }

  transport.handlers.set("thread/resume", () => {
    resumeCount += 1;
    transport.notify("thread/environment/connected", {
      threadId,
      environmentId: "foreign-after-rejections",
    });
    return threadResultWithIdentity(threadId, "original-tree", "original-parent");
  });
  const stillCold = bridge.getManagedSession(threadId);
  assert.ok(stillCold);
  const release = await bridge.acquireSelectedSession(stillCold, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "validate-no-stale-activity",
    signal,
    workspace: null,
  });
  const selected = bridge.getManagedSession(threadId);
  assert.ok(selected);
  assert.equal(selected.control.authority, "foreign");
  assert.deepEqual(selected.control.capabilities, []);
  assert.deepEqual(activity, [], "rejected adoption activity must never flush later");
  assert.ok(changes.length >= 3);
  assert.ok(changes.every((change) =>
    change.providerTreeId === "original-tree" &&
    change.parentId === "local:codex:original-parent" &&
    change.control.capabilities.length === 0
  ));
  assert.equal(resumeCount, 3);
  assert.equal(methodMessages(transport, "thread/resume").length, 3);

  await release();
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 1);
  bridge.dispose();
  await adapter.dispose();
});

test("replays a foreign environment event buffered before adoption acknowledgement", async () => {
  const { adapter, transport } = await initializedAdapter();
  const threadId = "foreign-controlled-cold-thread";
  const record: ManagedSessionRecoveryRecord = {
    managerSessionId: `local:codex:${threadId}`,
    provider: "codex",
    providerThreadId: threadId,
    workspaceId: "workspace-1",
    workspacePath: "/workspace",
    name: null,
    profile: "execute",
    createdAt: "2026-08-03T09:00:00.000Z",
  };
  const recovered = () =>
    threadResultWithIdentity(threadId, "stable-tree", "stable-parent");
  transport.handlers.set("thread/read", recovered);
  transport.handlers.set("thread/resume", () => {
    transport.notify("thread/environment/connected", {
      threadId,
      environmentId: "foreign-environment",
    });
    return recovered();
  });
  transport.handlers.set("thread/unsubscribe", () => ({}));
  const changes: ReturnType<CodexProviderBridge["toSessionView"]>[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  const signal = new AbortController().signal;

  const report = await bridge.restoreManagedSessions([record], signal);
  assert.deepEqual(report.failures, []);
  const cold = bridge.getManagedSession(threadId);
  assert.ok(cold);
  const release = await bridge.acquireSelectedSession(cold, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "select-foreign-controlled-thread",
    signal,
    workspace: null,
  });

  const selected = bridge.getManagedSession(threadId);
  assert.ok(selected);
  assert.equal(selected.control.authority, "foreign");
  assert.deepEqual(selected.control.capabilities, []);
  assert.match(selected.control.withheld[0]?.reason ?? "", /foreign-environment/u);
  assert.deepEqual(adapter.getThreadState(threadId)?.environmentIds, ["foreign-environment"]);
  assert.equal(adapter.getThreadState(threadId)?.controller, "foreign-environment");
  assert.equal(changes.at(-1)?.control.authority, "foreign");
  assert.deepEqual(changes.at(-1)?.control.capabilities, []);
  assert.equal(methodMessages(transport, "thread/resume").length, 1);

  await release();
  bridge.dispose();
  await adapter.dispose();
});

test("bounds managed recovery to one hundred records and four concurrent reads", async () => {
  const { adapter, transport } = await initializedAdapter();
  let activeReads = 0;
  let maxConcurrentReads = 0;
  transport.handlers.set("thread/read", async (params) => {
    activeReads += 1;
    maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeReads -= 1;
    return threadResultWithIdentity(String(params.threadId), null, null);
  });
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  const records: ManagedSessionRecoveryRecord[] = Array.from(
    { length: 105 },
    (_, index) => {
      const threadId = `bounded-recovery-${index}`;
      return {
        managerSessionId: `local:codex:${threadId}`,
        provider: "codex",
        providerThreadId: threadId,
        workspaceId: "workspace-1",
        workspacePath: "/workspace",
        name: null,
        profile: "execute",
        createdAt: "2026-08-03T09:00:00.000Z",
      };
    },
  );

  const report = await bridge.restoreManagedSessions(
    records,
    new AbortController().signal,
  );

  assert.equal(report.truncated, true);
  assert.equal(report.restoredSessionIds.length, 100);
  assert.deepEqual(report.failures, []);
  assert.equal(methodMessages(transport, "thread/read").length, 100);
  assert.equal(maxConcurrentReads, 4);
  assert.equal(activeReads, 0);
  assert.equal(adapter.listThreadStates().length, 0);

  bridge.dispose();
  await adapter.dispose();
});

test("settings are idle-only and become effective only after provider notification", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => ({}));
  await adapter.startThread({ cwd: "/workspace" });
  await adapter.setEffort("thread-1", "high");
  assert.equal(adapter.getThreadState("thread-1")?.effort, null);
  assert.equal(adapter.getThreadState("thread-1")?.pendingSettings?.effort, "high");
  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: {
      cwd: "/workspace",
      model: "gpt-5.6",
      effort: "high",
      collaborationMode: { mode: "default", settings: {} },
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    },
  });
  assert.equal(adapter.getThreadState("thread-1")?.effort, "high");
  assert.equal(adapter.getThreadState("thread-1")?.pendingSettings, null);
  transport.notify("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-running", status: "inProgress", items: [] },
  });
  await assert.rejects(
    adapter.setProfile("thread-1", "full-access"),
    /only be changed while the thread is idle/u,
  );
  await adapter.dispose();
});

test("bridge normalizes Codex effort facts without discarding unknown provider values", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Start",
    profile: "plan",
    model: null,
    effort: null,
    idempotencyKey: "create-effort-session",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "request-effort",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  });

  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: { effort: "ultra" },
  });
  assert.deepEqual(bridge.getManagedSession("thread-1")?.effort, {
    value: "ultra",
    providerValue: "ultra",
    source: "provider-api",
    confidence: "exact",
  });

  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: { effort: "bogusvalue" },
  });
  assert.deepEqual(bridge.getManagedSession("thread-1")?.effort, {
    value: null,
    providerValue: "bogusvalue",
    source: "provider-api",
    confidence: "exact",
  });
  bridge.dispose();
  await adapter.dispose();
});

test("foreign environment control withdraws writes without losing observation", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  transport.notify("thread/environment/connected", {
    threadId: "thread-1",
    environmentId: "other-client",
  });
  const state = adapter.getThreadState("thread-1");
  assert.equal(state?.controller, "foreign-environment");
  assert.match(state?.writeBlockedReason ?? "", /other-client/u);
  await assert.rejects(
    adapter.queueMessage("thread-1", "must stay local"),
    /controlled by foreign environment/u,
  );
  assert.ok(adapter.getThreadState("thread-1"));
  await adapter.dispose();
});

test("ProviderControlAdapter bridge creates normalized sessions and streams changes", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("thread/unsubscribe", () => ({}));
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-bridge", status: "inProgress", items: [] },
  }));
  const changes: Array<{
    status: string;
    name: string | null;
    providerTurnId: string | null;
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
      providerTurnId: view.providerTurnId,
    }),
  });
  const signal = new AbortController().signal;
  const created = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace-1",
    name: "Cockpit builder",
    initialMessage: "Build it",
    profile: "plan",
    model: null,
    effort: null,
    idempotencyKey: "create-cockpit-builder",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "request-create",
    signal,
    workspace: { id: "workspace-1", label: "Workspace", path: "/workspace" },
  });
  assert.deepEqual(created.control.capabilities, []);
  const releaseSelection = await bridge.acquireSelectedSession(created, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "request-select",
    signal,
    workspace: { id: "workspace-1", label: "Workspace", path: "/workspace" },
  });
  const view = bridge.getManagedSession("thread-1");
  assert.ok(view);
  assert.equal(view.id, "local:codex:thread-1");
  assert.equal(view.control.authority, "manager");
  assert.equal(view.control.plane, "codex-private");
  assert.ok(view.control.capabilities.includes("steer"));
  assert.equal(view.profile.value, null);
  assert.equal(view.providerTurnId, "turn-bridge");

  transport.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-bridge", status: "completed", items: [] },
  });
  assert.deepEqual(changes.at(-1), {
    status: "idle",
    name: "Cockpit builder",
    providerTurnId: null,
  });
  const attach = await bridge.getAttachInstruction(view, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "request-attach",
    signal,
    workspace: null,
  });
  assert.equal(attach?.kind, "codex-remote");
  assert.deepEqual(attach?.argv.slice(0, 3), ["codex", "resume", "thread-1"]);
  await releaseSelection();
  bridge.dispose();
  await adapter.dispose();
});

test("ProviderControlAdapter surfaces an addressable recovery handle after mode setup fails", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/unsubscribe", () => ({}));
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
    profile: "plan",
    model: null,
    effort: null,
    idempotencyKey: "mode-recovery",
  }, context);

  assert.equal(view.id, "local:codex:thread-1");
  assert.equal(view.status, "waiting");
  assert.equal(view.status, "waiting");
  assert.equal(view.attention[0]?.id, "creation-recovery");
  assert.match(view.attention[0]?.summary ?? "", /initial message was not sent/u);
  assert.deepEqual(view.control.capabilities, []);
  assert.equal(methodMessages(transport, "turn/start").length, 0);
  assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  assert.ok(activity.some((entry) =>
    entry.managerSessionId === "local:codex:thread-1" &&
    entry.mutation.type === "upsert" &&
    entry.mutation.item.kind === "lifecycle" &&
    entry.mutation.item.state === "failed"
  ));
  await assert.rejects(
    bridge.performAction(view, {
      type: "send",
      delivery: "queue",
      text: "Do not auto-recover",
      expectedGeneration: view.generation,
      idempotencyKey: "unsafe-unselected-retry",
    }, context),
    /not selected or loaded/u,
  );
  const releaseSelection = await bridge.acquireSelectedSession(view, context);
  const selectedView = bridge.getManagedSession("thread-1");
  assert.ok(selectedView);
  assert.deepEqual(selectedView.control.capabilities, ["attach", "resume"]);
  const attach = await bridge.getAttachInstruction(selectedView, context);
  assert.deepEqual(attach?.argv.slice(0, 3), ["codex", "resume", "thread-1"]);
  await assert.rejects(
    bridge.performAction(selectedView, {
      type: "send",
      delivery: "queue",
      text: "Do not auto-recover",
      expectedGeneration: selectedView.generation,
      idempotencyKey: "unsafe-retry",
    }, context),
    /needs native recovery/u,
  );
  assert.equal(methodMessages(transport, "turn/start").length, 0);

  await releaseSelection();
  bridge.dispose();
  await adapter.dispose();
});

test("ProviderControlAdapter retains buffered live activity when turn acknowledgement is uncertain", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("thread/unsubscribe", () => ({}));
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
    profile: "execute",
    model: null,
    effort: null,
    idempotencyKey: "uncertain-ack",
  }, context);

  assert.equal(callbackCountInsideTurnStart, 0);
  assert.equal(view.id, "local:codex:thread-1");
  assert.equal(view.status, "running");
  assert.equal(view.providerTurnId, "turn-provider-confirmed");
  assert.equal(view.status, "running");
  assert.match(view.attention[0]?.summary ?? "", /will not be sent again automatically/u);
  assert.deepEqual(view.control.capabilities, []);
  assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  assert.equal(methodMessages(transport, "turn/start").length, 1);
  assert.ok(activity.every((entry) => entry.managerSessionId === "local:codex:thread-1"));
  assert.ok(activity.some((entry) =>
    entry.mutation.type === "append" &&
    entry.mutation.id.endsWith("/answer-uncertain") &&
    entry.mutation.text === "The provider is already producing output"
  ));

  const releaseSelection = await bridge.acquireSelectedSession(view, context);
  const selectedView = bridge.getManagedSession("thread-1");
  assert.ok(selectedView);
  assert.deepEqual(selectedView.control.capabilities, ["interrupt", "attach", "resume"]);
  await assert.rejects(
    bridge.performAction(selectedView, {
      type: "send",
      delivery: "queue",
      text: "Do not duplicate",
      expectedGeneration: selectedView.generation,
      idempotencyKey: "do-not-duplicate",
    }, context),
    /needs native recovery/u,
  );
  assert.equal(methodMessages(transport, "turn/start").length, 1);

  await releaseSelection();
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
    profile: "execute",
    model: null,
    effort: null,
    idempotencyKey: "first-activity-race",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "first-activity-race",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  });

  assert.equal(callbackCountInsideTurnStart, 0);
  assert.ok(activity.length >= 4, "queue and assistant mutations should flush after mapping");
  assert.ok(activity.every((entry) => entry.managerSessionId === "local:codex:thread-1"));
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
    profile: "plan",
    model: null,
    effort: null,
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
        header: "Surface",
        text: "Where should the cockpit run?",
        options: [
          { label: "Local web", description: "Runs on loopback" },
          { label: "Terminal", description: "Uses a TUI" },
        ],
        multiSelect: false,
        allowFreeText: false,
        isSecret: false,
      },
      {
        id: "access",
        header: "Access",
        text: "Who can connect?",
        options: [],
        multiSelect: false,
        allowFreeText: true,
        isSecret: false,
      },
    ],
    toolName: null,
    inputSummary: null,
    respondable: true,
  });

  transport.request("secret-question", "item/tool/requestUserInput", {
    threadId: "thread-1",
    turnId: "turn-details",
    itemId: "item-secret-question",
    questions: [{
      id: "token",
      header: "Credential",
      question: "Enter the token",
      isOther: true,
      isSecret: true,
      options: null,
    }],
  });
  const secretQuestion = bridge.getManagedSession("thread-1")?.attention.find(
    (attention) => attention.id === "s:secret-question",
  );
  assert.equal(secretQuestion?.details?.questions?.[0]?.header, "Credential");
  assert.equal(secretQuestion?.details?.questions?.[0]?.text, "Enter the token");
  assert.equal(secretQuestion?.details?.questions?.[0]?.isSecret, true);

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

  const published: Array<{ status: string; capabilities: readonly string[] }> = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => published.push({
      status: session.status,
      capabilities: session.control.capabilities,
    }),
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "runtime-death-create",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  const created = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "bootstrap",
    profile: "execute",
    model: null,
    effort: null,
    idempotencyKey: "runtime-death-session",
  }, context);
  await bridge.acquireSelectedSession(created, context);
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
  assert.equal(view?.status, "failed");
  assert.deepEqual(view?.attention, []);
  assert.deepEqual(view?.control.capabilities, ["remove-queued"]);
  assert.deepEqual(published.at(-1), {
    status: "failed",
    capabilities: ["remove-queued"],
  });
  await assert.rejects(
    adapter.queueMessage("thread-1", "must fail closed"),
    /App Server is unavailable/u,
  );

  bridge.dispose();
  await adapter.dispose();
});
