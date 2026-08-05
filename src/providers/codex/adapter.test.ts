import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub, type ActivityMutation } from "../../activity/index.ts";
import type { SessionView } from "../../core/types.ts";
import type { WorkspaceIdentity } from "../../core/worktree.ts";
import type { ManagedSessionRecoveryRecord } from "../../server/contracts.ts";
import { parseSessionRecord } from "../../shared/wire.ts";
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
import { sandboxPolicy, unknownSandbox } from "../../shared/session.ts";

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

function externalCodexSession(): SessionView {
  return {
    sandbox: unknownSandbox(),
    id: "local:codex:takeover-thread",
    provider: "codex",
    providerThreadId: "takeover-thread",
    providerTreeId: "takeover-tree",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Terminal-started thread",
    cwd: "/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: 4312,
    runtimePid: 4312,
    startedAt: "2026-08-03T09:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
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
    statusSource: "hook",
    source: "codex-hook",
    profile: {
      value: "plan",
      providerValue: "plan",
      source: "hook",
      confidence: "exact",
    },
    model: {
      value: "gpt-5.6",
      providerValue: "gpt-5.6",
      source: "hook",
      confidence: "exact",
    },
    effort: {
      value: "high",
      providerValue: "high",
      source: "hook",
      confidence: "exact",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "codex-hook-bridge",
      authority: "foreign",
      coordination: {
        mode: "observe-only",
        nativeAttach: "none",
        responseResolution: "first-response-wins",
      },
      recovery: null,
      capabilities: [],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 7,
  };
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

test("runtime loss appends its exact failure without resetting retained activity", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  await adapter.startThread({ cwd: "/workspace" });
  const mutations: ActivityMutation[] = [];
  adapter.subscribe((event) => {
    if (event.type === "activity") mutations.push(event.mutation);
  });

  adapter.markRuntimeUnavailable(new Error("private socket closed unexpectedly"));

  assert.equal(
    mutations.some((mutation) => mutation.type === "reset"),
    false,
    "a transport crash is not a provider conversation reset",
  );
  const diagnostic = mutations.find((mutation) =>
    mutation.type === "upsert" && mutation.item.kind === "lifecycle"
  );
  assert.ok(diagnostic?.type === "upsert" && diagnostic.item.kind === "lifecycle");
  assert.match(diagnostic.item.details ?? "", /private socket closed unexpectedly/u);
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
  transport.handlers.set("thread/name/set", () => ({}));
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));

  const state = await adapter.startThread({
    cwd: "/workspace",
    profile: "plan",
    initialMessage: "Build the cockpit",
    approvalPolicy: "on-request",
    sandbox: sandboxPolicy("workspace-write"),
  });
  assert.equal(state.profile, null);
  assert.equal(state.pendingSettings?.profile, "plan");
  assert.equal(state.status, "running");
  assert.equal(state.activeTurnId, "turn-1");
  assert.equal(state.name, "Build the cockpit");
  const methods = transport.messages.map((message) => message.method);
  assert.deepEqual(methods, [
    "initialize",
    "initialized",
    "thread/start",
    "thread/settings/update",
    "thread/name/set",
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
      // Full access is the approval axis alone: the sandbox stays contained
      // unless the operator asked for a permissive one.
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false },
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
    sandbox: null,
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

test("retains exact typed requests and waits for authoritative first-response resolution", async () => {
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
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests.length, 1);
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests[0]?.respondable, false);
  const response = transport.messages.at(-1);
  assert.deepEqual(response, { jsonrpc: "2.0", id: 17, result: { decision: "acceptForSession" } });
  await assert.rejects(
    adapter.respondToRequest("thread-1", 17, { decision: "decline" }),
    /Invalid or unsupported/u,
  );
  transport.notify("serverRequest/resolved", { threadId: "thread-1", requestId: 17 });
  assert.equal(adapter.getThreadState("thread-1")?.pendingRequests.length, 0);

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
  transport.notify("serverRequest/resolved", { threadId: "thread-1", requestId: 18 });
  await adapter.dispose();
});

test("shared bridge responses are submitted once and every losing peer gets a typed stale failure", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-shared", status: "inProgress", items: [] },
  }));
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "shared-response",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  await bridge.createSession({
    sandbox: null,
    provider: "codex",
    workspaceId: "workspace",
    name: "Shared response",
    initialMessage: "Start",
    profile: "plan",
    model: null,
    effort: null,
    idempotencyKey: "shared-response-session",
  }, context);
  transport.request("shared-approval", "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-shared",
    itemId: "item-shared",
    command: "git status",
  });

  const pending = bridge.getManagedSession("thread-1");
  assert.ok(pending);
  const action = {
    type: "respond" as const,
    requestId: "s:shared-approval",
    response: { kind: "decision" as const, decision: "allow" as const },
    expectedGeneration: pending.generation,
    expectedProviderTurnId: "turn-shared",
    idempotencyKey: "shared-approval-response",
  };
  assert.deepEqual(await bridge.performAction(pending, action, context), {
    status: "succeeded",
    result: {
      coordination: "first-response-wins",
      resolution: "submitted",
    },
  });
  const submitted = bridge.getManagedSession("thread-1");
  assert.ok(submitted);
  assert.deepEqual(await bridge.performAction(submitted, action, context), {
    status: "failed",
    error: {
      code: "REQUEST_STALE",
      message: "the Codex request is no longer active; another provider peer may have responded first",
    },
  });

  transport.notify("serverRequest/resolved", {
    threadId: "thread-1",
    requestId: "shared-approval",
  });
  const resolved = bridge.getManagedSession("thread-1");
  assert.ok(resolved);
  assert.deepEqual(await bridge.performAction(resolved, action, context), {
    status: "failed",
    error: {
      code: "REQUEST_STALE",
      message: "the Codex request is no longer active; another provider peer may have responded first",
    },
  });
  assert.equal(
    transport.messages.filter((message) => message.id === "shared-approval" && message.result)
      .length,
    1,
  );

  transport.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-shared", status: "completed", items: [] },
  });
  transport.notify("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-next", status: "inProgress", items: [] },
  });
  transport.request("shared-approval", "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-next",
    itemId: "item-reused-id",
    command: "git diff",
  });
  const reused = bridge.getManagedSession("thread-1");
  assert.ok(reused);
  assert.deepEqual(await bridge.performAction(reused, action, context), {
    status: "failed",
    error: {
      code: "REQUEST_STALE",
      message: "the Codex request is no longer active; another provider peer may have responded first",
    },
  });
  assert.equal(
    transport.messages.filter((message) => message.id === "shared-approval" && message.result)
      .length,
    1,
    "a reused JSON-RPC ID must not accept an action captured for an older turn",
  );
  assert.deepEqual(await bridge.performAction(reused, {
    ...action,
    expectedGeneration: reused.generation,
    expectedProviderTurnId: "turn-next",
    idempotencyKey: "shared-approval-response-next-turn",
  }, context), {
    status: "succeeded",
    result: {
      coordination: "first-response-wins",
      resolution: "submitted",
    },
  });
  assert.equal(
    transport.messages.filter((message) => message.id === "shared-approval" && message.result)
      .length,
    2,
  );
  bridge.dispose();
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
    sandbox: null,
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
      expectedProviderTurnId: "turn-1",
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

test("the sandbox is set on its own axis and confirmed independently of the profile", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => ({}));
  await adapter.startThread({ cwd: "/workspace" });

  await adapter.setSandbox("thread-1", sandboxPolicy("workspace-write", true));
  assert.deepEqual(methodMessages(transport, "thread/settings/update").at(-1)?.params, {
    threadId: "thread-1",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: true },
  });

  await adapter.setSandbox("thread-1", sandboxPolicy("read-only"));
  assert.deepEqual(methodMessages(transport, "thread/settings/update").at(-1)?.params, {
    threadId: "thread-1",
    sandboxPolicy: { type: "readOnly" },
  });
  assert.equal(adapter.getThreadState("thread-1")?.sandbox, null, "nothing is applied until the provider confirms it");

  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: {
      cwd: "/workspace",
      model: "gpt-5.6",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
      collaborationMode: { mode: "default", settings: { model: "gpt-5.6" } },
    },
  });
  assert.deepEqual(adapter.getThreadState("thread-1")?.sandbox, sandboxPolicy("read-only"));
  assert.equal(adapter.getThreadState("thread-1")?.pendingSettings, null);

  // A permissive sandbox no longer implies full access; only never-ask does.
  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: {
      cwd: "/workspace",
      model: "gpt-5.6",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
      collaborationMode: { mode: "default", settings: { model: "gpt-5.6" } },
    },
  });
  assert.deepEqual(adapter.getThreadState("thread-1")?.sandbox, sandboxPolicy("danger-full-access"));
  assert.notEqual(adapter.getThreadState("thread-1")?.profile, "full-access");
  await adapter.dispose();
});

test("an unrecognized sandbox policy leaves the last known one rather than guessing", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/settings/update", () => ({}));
  await adapter.startThread({ cwd: "/workspace", sandbox: sandboxPolicy("read-only") });
  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: { sandboxPolicy: { type: "readOnly" } },
  });
  assert.deepEqual(adapter.getThreadState("thread-1")?.sandbox, sandboxPolicy("read-only"));

  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: { sandboxPolicy: { type: "somethingNewerThanThisBuild" } },
  });
  assert.deepEqual(
    adapter.getThreadState("thread-1")?.sandbox,
    sandboxPolicy("read-only"),
    "an unknown policy must not be read as a permissive one",
  );
  await adapter.dispose();
});

test("a profile and a sandbox changed together both survive the next-turn fallback", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  // No `thread/settings/update` handler: the RPC answers -32601 and both
  // changes demote to next-turn overrides.
  await adapter.startThread({ cwd: "/workspace" });
  await adapter.setProfile("thread-1", "plan");
  await adapter.setSandbox("thread-1", sandboxPolicy("danger-full-access"));

  const pending = adapter.getThreadState("thread-1")?.pendingSettings;
  assert.equal(pending?.profile, "plan", "the first pending change is not dropped by the second");
  assert.deepEqual(pending?.sandbox, sandboxPolicy("danger-full-access"));

  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-overrides", status: "inProgress", items: [] },
  }));
  await adapter.queueMessage("thread-1", "Go");
  const started = methodMessages(transport, "turn/start")[0]?.params as JsonObject;
  assert.equal((started.collaborationMode as JsonObject).mode, "plan");
  assert.equal(started.approvalPolicy, "on-request");
  assert.deepEqual(started.sandboxPolicy, { type: "dangerFullAccess" });
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

test("external Codex adoption keeps provisional controls inert and publishes only after durable commit", async () => {
  const { adapter, transport } = await initializedAdapter();
  const external = externalCodexSession();
  const exact = (): JsonObject => ({
    ...threadResultWithIdentity(
      external.providerThreadId,
      external.providerTreeId,
      null,
      external.cwd!,
    ),
    reasoningEffort: "high",
  });
  transport.handlers.set("thread/read", exact);
  transport.handlers.set("thread/resume", exact);
  transport.handlers.set("thread/unsubscribe", () => ({}));
  transport.handlers.set("thread/settings/update", (params) => {
    transport.notify("thread/settings/updated", {
      threadId: external.providerThreadId,
      threadSettings: params,
    });
    return {};
  });
  const changes: SessionView[] = [];
  const activity: ActivityMutation[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    onActivity: (_managerSessionId, mutation) => activity.push(mutation),
  });
  const takeoverContext = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "adopt-external-codex",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };

  const provisional = await bridge.adoptExternalSession(external, "plan", takeoverContext);
  assert.equal(methodMessages(transport, "thread/read").length, 1);
  assert.equal(methodMessages(transport, "thread/resume").length, 1);
  assert.deepEqual(methodMessages(transport, "thread/resume")[0]?.params, {
    threadId: external.providerThreadId,
    excludeTurns: true,
  });
  assert.equal(provisional.providerThreadId, external.providerThreadId);
  assert.equal(provisional.providerTreeId, external.providerTreeId);
  assert.equal(provisional.cwd, external.cwd);
  assert.equal(provisional.profile.value, "plan");
  assert.equal(provisional.model.value, "gpt-5.6");
  assert.equal(provisional.effort.value, "high");
  assert.deepEqual(provisional.control.capabilities, []);
  assert.equal(
    provisional.control.withheld.some((item) => item.capability === "queue"),
    true,
  );
  await assert.rejects(
    bridge.performAction(provisional, {
      type: "send",
      delivery: "queue",
      text: "Must wait for the durable ownership commit",
      expectedGeneration: provisional.generation,
      idempotencyKey: "provisional-adoption-write",
    }, takeoverContext),
    /awaiting durable adoption commit/u,
  );

  transport.notify("thread/status/changed", {
    threadId: external.providerThreadId,
    status: { type: "active", activeFlags: [] },
  });
  transport.notify("item/started", {
    threadId: external.providerThreadId,
    turnId: "adoption-turn",
    item: { type: "agentMessage", id: "adoption-message", text: "", phase: "commentary" },
  });
  transport.notify("item/agentMessage/delta", {
    threadId: external.providerThreadId,
    turnId: "adoption-turn",
    itemId: "adoption-message",
    delta: "provider activity before commit",
  });
  assert.deepEqual(changes, [], "the bridge must not publish before durable commit");
  assert.deepEqual(activity, [], "provisional provider activity must not publish before commit");

  const committed = bridge.commitExternalAdoption(external.providerThreadId);
  assert.equal(committed.control.authority, "manager");
  assert.ok(committed.control.capabilities.includes("queue"));
  assert.equal(committed.status, "running", "commit must return the latest held provider state");
  assert.ok(activity.length > 0, "durable commit must release held provider activity");
  transport.notify("thread/status/changed", {
    threadId: external.providerThreadId,
    status: { type: "idle" },
  });
  assert.equal(changes.length, 1);
  const published = changes.at(-1) as SessionView | undefined;
  assert.ok(published);
  assert.ok(published.control.capabilities.includes("queue"));
  await bridge.abortExternalAdoption(external.providerThreadId);
  assert.ok(bridge.getManagedSession(external.providerThreadId));
  bridge.dispose();
  await adapter.dispose();
});

test("provisional Codex activity overflow preserves existing history behind a retention boundary", async () => {
  const { adapter, transport } = await initializedAdapter();
  const external = externalCodexSession();
  const exact = (): JsonObject => ({
    ...threadResultWithIdentity(
      external.providerThreadId,
      external.providerTreeId,
      null,
      external.cwd!,
    ),
    reasoningEffort: "high",
  });
  transport.handlers.set("thread/read", exact);
  transport.handlers.set("thread/resume", exact);
  transport.handlers.set("thread/unsubscribe", () => ({}));
  transport.handlers.set("thread/settings/update", (params) => {
    transport.notify("thread/settings/updated", {
      threadId: external.providerThreadId,
      threadSettings: params,
    });
    return {};
  });

  const activity = new ActivityHub({ streamEpoch: "provisional-overflow" });
  activity.ingest(external.id, "codex", {
    type: "upsert",
    item: {
      id: "pre-existing-hook-history",
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "history materialized before provider adoption",
      state: "complete",
    },
  });
  const released: ActivityMutation[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onActivity: (managerSessionId, mutation) => {
      released.push(mutation);
      activity.ingest(managerSessionId, "codex", mutation);
    },
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "adopt-overflowing-codex",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };

  await bridge.adoptExternalSession(external, "plan", context);
  for (let index = 0; index < 4_100; index += 1) {
    transport.notify("item/started", {
      threadId: external.providerThreadId,
      turnId: "overflow-turn",
      item: {
        type: "agentMessage",
        id: "overflow-message",
        text: `buffered mutation ${index}`,
        phase: "commentary",
      },
    });
  }
  assert.equal(released.length, 0);

  bridge.commitExternalAdoption(external.providerThreadId);
  assert.equal(released[0]?.type, "retention-boundary");
  assert.equal(released.some((mutation) => mutation.type === "reset"), false);
  assert.ok(released.length <= 4_096);
  const snapshot = activity.snapshot(external.id);
  assert.ok(snapshot);
  assert.equal(snapshot.truncated, true);
  assert.equal(
    snapshot.items.some((item) => item.id === "pre-existing-hook-history"),
    true,
  );
  const latest = snapshot.items.find((item) => item.id.endsWith("overflow-message"));
  assert.equal(latest?.kind === "message" ? latest.text : null, "buffered mutation 4099");

  bridge.dispose();
  await adapter.dispose();
});

test("web resume adopts one exact dormant thread through the existing shared App Server", async () => {
  const { adapter, transport } = await initializedAdapter();
  const observed = externalCodexSession();
  const dormant: SessionView = {
    ...observed,
    presence: "recent",
    pid: null,
    runtimePid: null,
    source: "codex-transcript",
    control: {
      ...observed.control,
      plane: "codex-private",
      authority: "manager",
      coordination: {
        mode: "shared",
        nativeAttach: "join",
        responseResolution: "first-response-wins",
      },
    },
  };
  const exact = (): JsonObject => ({
    ...threadResultWithIdentity(
      dormant.providerThreadId,
      dormant.providerTreeId,
      null,
      dormant.cwd!,
    ),
    reasoningEffort: "high",
  });
  let releaseRead!: () => void;
  let reportReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    reportReadStarted = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  transport.handlers.set("thread/read", async () => {
    reportReadStarted();
    await readGate;
    return exact();
  });
  transport.handlers.set("thread/resume", () => {
    // A native Codex client may remain joined to the same App Server thread.
    // Presence is observational and must not create an exclusive-owner block.
    transport.notify("thread/environment/connected", {
      threadId: dormant.providerThreadId,
      environmentId: "native-codex-client",
    });
    return exact();
  });
  transport.handlers.set("thread/settings/update", (params) => {
    transport.notify("thread/settings/updated", {
      threadId: dormant.providerThreadId,
      threadSettings: params,
    });
    return {};
  });
  transport.handlers.set("thread/unsubscribe", () => ({}));
  const changes: SessionView[] = [];
  const activity: ActivityMutation[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    onActivity: (_managerSessionId, mutation) => activity.push(mutation),
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "resume-dormant-codex",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };

  const first = bridge.resumeSession(dormant, "plan", context);
  await readStarted;
  await assert.rejects(
    bridge.resumeSession(dormant, "plan", {
      ...context,
      requestId: "duplicate-resume-dormant-codex",
    }),
    /already managed by this bridge/u,
  );
  assert.equal(methodMessages(transport, "thread/read").length, 1);
  assert.equal(methodMessages(transport, "thread/resume").length, 0);
  releaseRead();

  const provisional = await first;
  assert.equal(provisional.providerThreadId, dormant.providerThreadId);
  assert.equal(provisional.providerTreeId, dormant.providerTreeId);
  assert.equal(provisional.cwd, dormant.cwd);
  assert.deepEqual(changes, []);
  assert.deepEqual(activity, []);
  assert.equal(methodMessages(transport, "initialize").length, 1);
  assert.equal(methodMessages(transport, "thread/start").length, 0);
  assert.equal(methodMessages(transport, "thread/read").length, 1);
  assert.equal(methodMessages(transport, "thread/resume").length, 1);

  const committed = bridge.commitExternalAdoption(dormant.providerThreadId);
  assert.equal(committed.control.authority, "manager");
  assert.deepEqual(committed.control.coordination, {
    mode: "shared",
    nativeAttach: "join",
    responseResolution: "first-response-wins",
  });
  assert.deepEqual(
    adapter.getThreadState(dormant.providerThreadId)?.executionEnvironmentIds,
    ["native-codex-client"],
  );
  assert.equal(methodMessages(transport, "thread/resume").length, 1);

  bridge.dispose();
  await adapter.dispose();
});

test("failed web resume rollback unsubscribes the provisional client and drops held activity", async () => {
  const { adapter, transport } = await initializedAdapter();
  const dormant = externalCodexSession();
  const exact = (): JsonObject => ({
    ...threadResultWithIdentity(
      dormant.providerThreadId,
      dormant.providerTreeId,
      null,
      dormant.cwd!,
    ),
    reasoningEffort: "high",
  });
  transport.handlers.set("thread/read", exact);
  transport.handlers.set("thread/resume", () => {
    transport.notify("item/started", {
      threadId: dormant.providerThreadId,
      turnId: "provisional-turn",
      item: {
        type: "agentMessage",
        id: "provisional-message",
        text: "",
        phase: "commentary",
      },
    });
    transport.notify("item/agentMessage/delta", {
      threadId: dormant.providerThreadId,
      turnId: "provisional-turn",
      itemId: "provisional-message",
      delta: "must be discarded when persistence fails",
    });
    return exact();
  });
  transport.handlers.set("thread/settings/update", (params) => {
    transport.notify("thread/settings/updated", {
      threadId: dormant.providerThreadId,
      threadSettings: params,
    });
    return {};
  });
  let releaseUnsubscribe!: () => void;
  let reportUnsubscribeStarted!: () => void;
  const unsubscribeStarted = new Promise<void>((resolve) => {
    reportUnsubscribeStarted = resolve;
  });
  const unsubscribeGate = new Promise<void>((resolve) => {
    releaseUnsubscribe = resolve;
  });
  transport.handlers.set("thread/unsubscribe", async () => {
    reportUnsubscribeStarted();
    await unsubscribeGate;
    return {};
  });
  const changes: SessionView[] = [];
  const activity: ActivityMutation[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    onActivity: (_managerSessionId, mutation) => activity.push(mutation),
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "rollback-dormant-codex",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };

  await bridge.resumeSession(dormant, "plan", context);
  assert.deepEqual(changes, []);
  assert.deepEqual(activity, []);

  const rollback = bridge.abortExternalAdoption(dormant.providerThreadId);
  await unsubscribeStarted;
  const releasing = bridge.getManagedSession(dormant.providerThreadId);
  assert.ok(releasing);
  assert.deepEqual(releasing.control.capabilities, []);
  assert.equal(releasing.control.recovery?.state, "reconnecting");
  assert.equal(releasing.control.recovery?.attempt, 1);
  assert.equal(
    parseSessionRecord(releasing).control.recovery?.state,
    "reconnecting",
    "in-flight quarantine must satisfy the strict wire contract",
  );
  assert.ok(releasing.control.withheld.some(({ capability }) => capability === "attach"));
  assert.ok(releasing.control.withheld.some(({ capability }) => capability === "retry-control"));
  const joinedRollback = bridge.abortExternalAdoption(dormant.providerThreadId);
  assert.equal(
    methodMessages(transport, "thread/unsubscribe").length,
    1,
    "concurrent rollback callers must share the exact in-flight unsubscribe",
  );
  await assert.rejects(
    bridge.resumeSession(dormant, "plan", {
      ...context,
      requestId: "resume-during-rollback",
    }),
    /already managed by this bridge/u,
  );
  releaseUnsubscribe();
  await Promise.all([rollback, joinedRollback]);
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 1);
  assert.equal(adapter.getThreadState(dormant.providerThreadId), null);
  assert.equal(bridge.getManagedSession(dormant.providerThreadId), null);
  assert.deepEqual(changes, []);
  assert.deepEqual(activity, []);
  await bridge.abortExternalAdoption(dormant.providerThreadId);
  assert.equal(
    methodMessages(transport, "thread/unsubscribe").length,
    1,
    "rollback must release the provider client at most once",
  );

  bridge.dispose();
  await adapter.dispose();
});

test("rejected Codex rollback stays quarantined until an exact idempotent release succeeds", async () => {
  const { adapter, transport } = await initializedAdapter();
  const dormant = externalCodexSession();
  const exact = (): JsonObject => ({
    ...threadResultWithIdentity(
      dormant.providerThreadId,
      dormant.providerTreeId,
      null,
      dormant.cwd!,
    ),
    reasoningEffort: "high",
  });
  transport.handlers.set("thread/read", exact);
  transport.handlers.set("thread/resume", exact);
  transport.handlers.set("thread/settings/update", (params) => {
    transport.notify("thread/settings/updated", {
      threadId: dormant.providerThreadId,
      threadSettings: params,
    });
    return {};
  });
  let unsubscribeAttempts = 0;
  transport.handlers.set("thread/unsubscribe", () => {
    unsubscribeAttempts += 1;
    if (unsubscribeAttempts === 1) throw new Error("unsubscribe acknowledgement was lost");
    return {};
  });
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "quarantine-dormant-codex",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };

  await bridge.resumeSession(dormant, "plan", context);
  await assert.rejects(
    bridge.abortExternalAdoption(dormant.providerThreadId),
    /unsubscribe acknowledgement was lost/u,
  );

  const quarantined = bridge.getManagedSession(dormant.providerThreadId);
  assert.ok(quarantined);
  assert.equal(quarantined.control.recovery?.state, "needs-attention");
  assert.equal(quarantined.control.recovery?.attempt, 1);
  assert.match(quarantined.control.recovery?.error ?? "", /release was not confirmed/u);
  assert.equal(
    parseSessionRecord(quarantined).control.recovery?.state,
    "needs-attention",
    "failed quarantine must satisfy the strict wire contract",
  );
  assert.equal(quarantined.control.capabilities.length, 0);
  for (const capability of ["attach", "resume", "retry-control"] as const) {
    assert.equal(quarantined.control.capabilities.includes(capability), false);
    assert.ok(quarantined.control.withheld.some((entry) =>
      entry.capability === capability && /quarantined/u.test(entry.reason)
    ));
  }
  await assert.rejects(
    bridge.getAttachInstruction(quarantined, context),
    /controls remain quarantined/u,
  );
  await assert.rejects(
    bridge.performAction(quarantined, {
      type: "send",
      delivery: "queue",
      text: "must not dispatch while rollback is uncertain",
      expectedGeneration: quarantined.generation,
      idempotencyKey: "quarantined-send",
    }, context),
    /controls remain quarantined/u,
  );
  await assert.rejects(
    bridge.resumeSession(dormant, "plan", {
      ...context,
      requestId: "quarantined-resume",
    }),
    /already managed by this bridge/u,
  );

  await bridge.abortExternalAdoption(dormant.providerThreadId);
  assert.equal(unsubscribeAttempts, 2);
  assert.equal(bridge.getManagedSession(dormant.providerThreadId), null);
  assert.equal(adapter.getThreadState(dormant.providerThreadId), null);
  await bridge.abortExternalAdoption(dormant.providerThreadId);
  assert.equal(unsubscribeAttempts, 2, "confirmed cleanup is idempotent");

  bridge.dispose();
  await adapter.dispose();
});

test("external Codex adoption rejects resume identity drift without publishing controls", async () => {
  const { adapter, transport } = await initializedAdapter();
  const external = externalCodexSession();
  transport.handlers.set("thread/read", () => ({
    ...threadResultWithIdentity(
      external.providerThreadId,
      external.providerTreeId,
      null,
      external.cwd!,
    ),
    reasoningEffort: "high",
  }));
  transport.handlers.set("thread/resume", () => ({
    ...threadResultWithIdentity(
      external.providerThreadId,
      "different-tree",
      null,
      external.cwd!,
    ),
    reasoningEffort: "high",
  }));
  transport.handlers.set("thread/unsubscribe", () => ({}));
  const changes: SessionView[] = [];
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });

  await assert.rejects(
    bridge.adoptExternalSession(external, "plan", {
      actor: { id: "local", kind: "local", displayName: "Local user" },
      requestId: "reject-external-codex-drift",
      signal: new AbortController().signal,
      workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
    }),
    /changed the validated managed identity/u,
  );
  assert.deepEqual(changes, []);
  assert.equal(bridge.getManagedSession(external.providerThreadId), null);
  assert.equal(adapter.getThreadState(external.providerThreadId), null);
  assert.equal(methodMessages(transport, "thread/resume").length, 1);
  bridge.dispose();
  await adapter.dispose();
});

test("restores persisted ownership into a durable subscription independent of browser refs", async () => {
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
      providerTreeId: "tree-1",
      providerParentThreadId: "parent-thread",
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
      providerTreeId: null,
      providerParentThreadId: null,
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
  assert.ok(changes[0]?.control.capabilities.includes("queue"));
  assert.ok(adapter.getThreadState("persisted-thread"));
  assert.equal(activity.length, 0);
  assert.equal(methodMessages(transport, "thread/read").length, 2);
  assert.equal(methodMessages(transport, "thread/resume").length, 1);
  assert.equal(methodMessages(transport, "thread/list").length, 0);

  const recovered = changes[0]!;
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "post-restart-action",
    signal,
    workspace: null,
  };
  await bridge.performAction(recovered, {
    type: "send",
    delivery: "queue",
    text: "A new action after restart",
    expectedGeneration: recovered.generation,
    idempotencyKey: "post-restart-action",
  }, context);
  assert.equal(methodMessages(transport, "turn/start").length, 1);

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
  await releaseFirst();
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 0);
  await releaseSecond();
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 0);
  assert.ok(adapter.getThreadState("persisted-thread"));
  assert.ok(
    bridge.getManagedSession("persisted-thread")?.control.capabilities.includes("queue"),
  );

  const releaseReselected = await bridge.acquireSelectedSession(recovered, {
    ...context,
    requestId: "reselected-client",
  });
  assert.equal(methodMessages(transport, "thread/resume").length, 1);

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
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 1);
  await releaseReselected();

  bridge.dispose();
  await adapter.dispose();
});

test("rejects recovery identity drift before exposing controls or activity", async () => {
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
    providerTreeId: "original-tree",
    providerParentThreadId: "original-parent",
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

  const report = await bridge.restoreManagedSessions([record], signal);
  assert.deepEqual(report.restoredSessionIds, []);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]?.reason ?? "", /changed the validated managed identity/u);
  assert.equal(bridge.getManagedSession(threadId), null);
  assert.equal(adapter.getThreadState(threadId), null);
  assert.deepEqual(changes, []);
  assert.deepEqual(activity, [], "rejected recovery activity must never leak");
  assert.equal(resumeCount, 1);
  assert.equal(methodMessages(transport, "thread/resume").length, 1);
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 0);
  bridge.dispose();
  await adapter.dispose();
});

test("replays execution-environment presence without withdrawing shared controls", async () => {
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
    providerTreeId: "stable-tree",
    providerParentThreadId: "stable-parent",
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
  const selected = bridge.getManagedSession(threadId);
  assert.ok(selected);
  const release = await bridge.acquireSelectedSession(selected, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "select-foreign-controlled-thread",
    signal,
    workspace: null,
  });

  assert.equal(selected.control.authority, "manager");
  assert.ok(selected.control.capabilities.includes("queue"));
  assert.deepEqual(
    adapter.getThreadState(threadId)?.executionEnvironmentIds,
    ["foreign-environment"],
  );
  assert.equal(changes.at(-1)?.control.authority, "manager");
  assert.ok(changes.at(-1)?.control.capabilities.includes("queue"));
  assert.equal(methodMessages(transport, "thread/resume").length, 1);

  await release();
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 0);
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
  transport.handlers.set("thread/resume", (params) =>
    threadResultWithIdentity(String(params.threadId), null, null)
  );
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
        providerTreeId: null,
        providerParentThreadId: null,
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
  assert.equal(methodMessages(transport, "thread/resume").length, 100);
  assert.equal(maxConcurrentReads, 4);
  assert.equal(activeReads, 0);
  assert.equal(adapter.listThreadStates().length, 100);

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
    sandbox: null,
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

test("execution-environment presence is observational and preserves writes", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "shared-turn", status: "inProgress", items: [] },
  }));
  await adapter.startThread({ cwd: "/workspace" });
  transport.notify("thread/environment/connected", {
    threadId: "thread-1",
    environmentId: "other-client",
  });
  const state = adapter.getThreadState("thread-1");
  assert.deepEqual(state?.executionEnvironmentIds, ["other-client"]);
  transport.request("shared-question", "item/tool/requestUserInput", {
    threadId: "thread-1",
    turnId: "shared-turn",
    itemId: "shared-question-item",
    questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
  });
  assert.equal(
    adapter.getThreadState("thread-1")?.pendingRequests[0]?.respondable,
    true,
  );
  const queued = await adapter.queueMessage("thread-1", "shared client input");
  assert.equal(queued.status, "dispatched");
  transport.notify("thread/environment/disconnected", {
    threadId: "thread-1",
    environmentId: "other-client",
  });
  assert.deepEqual(adapter.getThreadState("thread-1")?.executionEnvironmentIds, []);
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
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "create-cockpit-builder",
  }, {
    actor: { id: "local", kind: "local", displayName: "Local user" },
    requestId: "request-create",
    signal,
    workspace: { id: "workspace-1", label: "Workspace", path: "/workspace" },
  });
  assert.ok(created.control.capabilities.includes("steer"));
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
  assert.deepEqual(view.control.coordination, {
    mode: "shared",
    nativeAttach: "join",
    responseResolution: "first-response-wins",
  });
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
  assert.match(attach?.warning ?? "", /CLI and web stay active together/u);
  await releaseSelection();
  assert.ok(bridge.getManagedSession("thread-1")?.control.capabilities.includes("queue"));
  assert.equal(methodMessages(transport, "thread/unsubscribe").length, 0);
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
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "mode-recovery",
  }, context);

  assert.equal(view.id, "local:codex:thread-1");
  assert.equal(view.status, "waiting");
  assert.equal(view.status, "waiting");
  assert.equal(view.attention[0]?.id, "creation-recovery");
  assert.match(view.attention[0]?.summary ?? "", /initial message was not sent/u);
  assert.deepEqual(view.control.capabilities, ["attach", "resume"]);
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
    /needs native recovery/u,
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
    sandbox: null,
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
  assert.deepEqual(view.control.capabilities, ["interrupt", "attach", "resume"]);
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
    sandbox: null,
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
    sandbox: null,
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
    sandbox: null,
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

function threadResultWithProvenance(
  source: string | null,
  threadSource: string | null,
  name: string | null = null,
): JsonObject {
  const result = threadResult();
  const thread = result.thread as JsonObject;
  if (source !== null) thread.source = source;
  if (threadSource !== null) thread.threadSource = threadSource;
  thread.name = name;
  return result;
}

function queueActivityMessages(
  mutations: readonly ActivityMutation[],
): Array<Array<{ id: string; status: string; text: string }>> {
  const projections: Array<Array<{ id: string; status: string; text: string }>> = [];
  for (const mutation of mutations) {
    if (mutation.type !== "upsert") continue;
    const item = mutation.item as unknown as {
      kind: string;
      messages?: Array<{ id: string; status: string; text: string }>;
    };
    if (item.kind !== "queue") continue;
    projections.push((item.messages ?? []).map((message) => ({
      id: message.id,
      status: message.status,
      text: message.text,
    })));
  }
  return projections;
}

test("releasing the detail plane retains the manager queue and dispatches it after re-adoption", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/resume", () => threadResult());
  transport.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  let nextTurn = 0;
  transport.handlers.set("turn/start", () => ({
    turn: { id: `turn-${++nextTurn}`, status: "inProgress", items: [] },
  }));
  await adapter.startThread({ cwd: "/workspace", initialMessage: "first" });
  const queued = await adapter.queueMessage("thread-1", "My message. Disappeared?");
  assert.equal(queued.status, "queued");

  await adapter.releaseThread("thread-1");
  assert.equal(adapter.getThreadState("thread-1"), null);

  const readopted = await adapter.adoptThread("thread-1", {
    threadId: "thread-1",
    treeId: null,
    parentThreadId: null,
    cwd: "/workspace",
  });
  assert.deepEqual(
    readopted.queue.map((item) => item.text),
    ["My message. Disappeared?"],
    "detaching the detail plane must not destroy an operator's queued message",
  );
  await eventually(() => {
    assert.equal(methodMessages(transport, "turn/start").length, 2);
    assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  });
  assert.equal(
    ((methodMessages(transport, "turn/start")[1]?.params as JsonObject)
      .input as JsonObject[])[0]?.text,
    "My message. Disappeared?",
  );
  await adapter.dispose();
});

test("remove-queued is advertised exactly while a queued activity item is rendered", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const mutations: ActivityMutation[] = [];
  adapter.subscribe((event) => {
    if (event.type === "activity") mutations.push(event.mutation);
  });
  const bridge = new CodexProviderBridge({ adapter, resolveWorkspace: () => "/workspace" });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "queue-projection",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  const created = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "first",
    profile: "plan",
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "queue-projection-session",
  }, context);
  await bridge.acquireSelectedSession(created, context);

  const queued = await adapter.queueMessage("thread-1", "second");
  const rendered = queueActivityMessages(mutations).at(-1) ?? [];
  assert.deepEqual(rendered.map((message) => message.text), ["second"]);
  assert.equal(
    bridge.getManagedSession("thread-1")?.control.capabilities.includes("remove-queued"),
    true,
    "a rendered queued item must be removable",
  );

  await adapter.removeQueuedMessage("thread-1", queued.id);
  assert.deepEqual(queueActivityMessages(mutations).at(-1), []);
  assert.equal(
    bridge.getManagedSession("thread-1")?.control.capabilities.includes("remove-queued"),
    false,
  );

  await adapter.queueMessage("thread-1", "third");
  assert.deepEqual(
    (queueActivityMessages(mutations).at(-1) ?? []).map((message) => message.text),
    ["third"],
  );
  transport.handlers.set("thread/resume", () => threadResult());
  await adapter.releaseThread("thread-1");
  await adapter.adoptThread("thread-1", {
    threadId: "thread-1",
    treeId: null,
    parentThreadId: null,
    cwd: "/workspace",
  });
  assert.deepEqual(
    (queueActivityMessages(mutations).at(-1) ?? []).map((message) => message.text),
    adapter.getThreadState("thread-1")?.queue.map((item) => item.text),
    "the rendered queue and the adapter queue must never diverge across a detach",
  );
  bridge.dispose();
  await adapter.dispose();
});

test("drains the manager queue when the provider reports idle before turn/completed", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  let nextTurn = 0;
  transport.handlers.set("turn/start", () => ({
    turn: { id: `turn-${++nextTurn}`, status: "inProgress", items: [] },
  }));
  const diagnostics: string[] = [];
  adapter.subscribe((event) => {
    if (event.type === "diagnostic") diagnostics.push(event.code);
  });
  await adapter.startThread({ cwd: "/workspace", initialMessage: "first" });
  await adapter.queueMessage("thread-1", "second");
  assert.equal(methodMessages(transport, "turn/start").length, 1);

  // Codex 0.146 emits `thread/status/changed -> idle` immediately before
  // `turn/completed`; the idle transition alone must release the queue.
  transport.notify("thread/status/changed", {
    threadId: "thread-1",
    status: { type: "idle" },
  });
  await eventually(() => {
    assert.equal(methodMessages(transport, "turn/start").length, 2);
    assert.equal(adapter.getThreadState("thread-1")?.activeTurnId, "turn-2");
    assert.deepEqual(adapter.getThreadState("thread-1")?.queue, []);
  });

  // The late completion of the turn the idle status already retired must not be
  // mistaken for a superseded turn now that a newer turn is running.
  transport.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  assert.equal(adapter.getThreadState("thread-1")?.activeTurnId, "turn-2");
  assert.equal(adapter.getThreadState("thread-1")?.status, "running");
  assert.deepEqual(diagnostics.filter((code) => code.includes("stale_completion")), []);
  await adapter.dispose();
});

test("a manager-created thread reports manager provenance and keeps its confirmed profile", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set(
    "thread/start",
    () => threadResultWithProvenance("vscode", "agent-manager"),
  );
  transport.handlers.set(
    "thread/resume",
    () => threadResultWithProvenance("vscode", "agent-manager"),
  );
  transport.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("thread/name/set", () => ({}));

  const state = await adapter.startThread({ cwd: "/workspace", profile: "plan" });
  assert.equal(
    state.source,
    "agent-manager",
    "the environment-derived source kind must not misreport a manager-created thread",
  );
  const update = methodMessages(transport, "thread/settings/update")[0]
    ?.params as JsonObject;
  assert.equal((update.collaborationMode as JsonObject).mode, "plan");
  assert.equal(update.approvalPolicy, "on-request");
  // The profile carries the approval axis only; a start that requested no
  // sandbox must not silently assert one.
  assert.equal(Object.hasOwn(update, "sandboxPolicy"), false);
  assert.equal(
    adapter.getThreadState("thread-1")?.profile,
    null,
    "the profile stays unknown until the provider confirms it",
  );

  transport.notify("thread/settings/updated", {
    threadId: "thread-1",
    threadSettings: {
      cwd: "/workspace",
      model: "gpt-5.6",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
      collaborationMode: { mode: "plan", settings: { model: "gpt-5.6" } },
    },
  });
  assert.equal(adapter.getThreadState("thread-1")?.profile, "plan");

  await adapter.releaseThread("thread-1");
  const readopted = await adapter.adoptThread("thread-1", {
    threadId: "thread-1",
    treeId: null,
    parentThreadId: null,
    cwd: "/workspace",
  });
  assert.equal(
    readopted.profile,
    "plan",
    "thread/resume carries no collaboration mode, so the confirmed profile must survive detach",
  );
  await adapter.dispose();
});

test("names a manager-created thread only through the advertised rename RPC", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  transport.handlers.set("thread/name/set", () => ({}));
  const named = await adapter.startThread({
    cwd: "/workspace",
    initialMessage: "  Ship the cockpit queue fix\nand nothing else  ",
  });
  assert.deepEqual(methodMessages(transport, "thread/name/set")[0]?.params, {
    threadId: "thread-1",
    name: "Ship the cockpit queue fix",
  });
  assert.equal(named.name, "Ship the cockpit queue fix");
  await adapter.dispose();

  const withdrawn = await initializedAdapter();
  withdrawn.transport.handlers.set("thread/start", () => threadResult());
  withdrawn.transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const unnamed = await withdrawn.adapter.startThread({
    cwd: "/workspace",
    initialMessage: "Ship the cockpit queue fix",
  });
  assert.equal(
    unnamed.name,
    null,
    "a rejected thread-name RPC must not fabricate a provider name",
  );
  assert.equal(
    withdrawn.adapter.capabilities.controls.includes("thread.rename"),
    false,
    "method-not-found withdraws the rename control",
  );
  assert.equal(
    methodMessages(withdrawn.transport, "turn/start").length,
    1,
    "a missing thread-name RPC never blocks the initial message",
  );
  await withdrawn.adapter.dispose();
});

test("create-time profile falls back to next-turn overrides when the live method is withdrawn", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const state = await adapter.startThread({
    cwd: "/workspace",
    profile: "plan",
    initialMessage: "first",
  });
  assert.equal(state.profile, null, "an unconfirmed profile is never asserted");
  assert.equal(adapter.capabilities.settingsDelivery, "next-turn");
  const start = methodMessages(transport, "turn/start")[0]?.params as JsonObject;
  assert.equal((start.collaborationMode as JsonObject).mode, "plan");
  assert.equal(start.approvalPolicy, "on-request");
  await adapter.dispose();
});

const PAOLA_IDENTITY: WorkspaceIdentity = {
  repoRoot: "/workspace",
  repoName: "workspace",
  worktreePath: "/workspace",
  linked: false,
  branch: "master",
  detached: false,
  dirtyCount: 25,
  ahead: null,
  behind: null, insertions: null, deletions: null,
};

class FakeWorkspaceIdentityResolver {
  readonly requests: Array<readonly (string | null | undefined)[]> = [];
  identity: WorkspaceIdentity | null = PAOLA_IDENTITY;
  failure: Error | null = null;

  async resolveMany(
    cwds: readonly (string | null | undefined)[],
  ): Promise<Map<string, WorkspaceIdentity | null>> {
    this.requests.push(cwds);
    if (this.failure) throw this.failure;
    const result = new Map<string, WorkspaceIdentity | null>();
    for (const cwd of cwds) {
      if (typeof cwd === "string") result.set(cwd, this.identity);
    }
    return result;
  }
}

test("bridge-published Codex sessions carry resolved workspace identity", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/name/set", () => ({}));
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const resolver = new FakeWorkspaceIdentityResolver();
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    workspaceIdentityResolver: resolver,
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "workspace-identity-create",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  const created = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "first",
    profile: "plan",
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "workspace-identity-session",
  }, context);
  assert.deepEqual(resolver.requests, [["/workspace"]]);
  assert.deepEqual(
    created.workspaceIdentity,
    PAOLA_IDENTITY,
    "a manager-created session must land in the same board column as its repository",
  );
  assert.deepEqual(
    bridge.getManagedSession("thread-1")?.workspaceIdentity,
    PAOLA_IDENTITY,
  );
  bridge.dispose();
  await adapter.dispose();
});

test("workspace identity stays null when the bounded git resolution cannot answer", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set("thread/start", () => threadResult());
  transport.handlers.set("thread/name/set", () => ({}));
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const resolver = new FakeWorkspaceIdentityResolver();
  resolver.failure = new Error("git budget exhausted");
  const bridge = new CodexProviderBridge({
    adapter,
    resolveWorkspace: () => "/workspace",
    workspaceIdentityResolver: resolver,
  });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "workspace-identity-budget",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  const created = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "first",
    profile: "plan",
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "workspace-identity-budget-session",
  }, context);
  assert.equal(created.workspaceIdentity, null);
  assert.equal(created.id, "local:codex:thread-1", "creation still succeeds");
  bridge.dispose();
  await adapter.dispose();
});

test("bridge reports manager provenance and the created thread name", async () => {
  const { adapter, transport } = await initializedAdapter();
  transport.handlers.set(
    "thread/start",
    () => threadResultWithProvenance("vscode", "agent-manager"),
  );
  transport.handlers.set("thread/name/set", () => ({}));
  transport.handlers.set("thread/settings/update", () => null);
  transport.handlers.set("turn/start", () => ({
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }));
  const bridge = new CodexProviderBridge({ adapter, resolveWorkspace: () => "/workspace" });
  const context = {
    actor: { id: "local", kind: "local" as const, displayName: "Local user" },
    requestId: "provenance-create",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
  const created = await bridge.createSession({
    provider: "codex",
    workspaceId: "workspace",
    initialMessage: "Fix the stranded queue",
    profile: "plan",
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "provenance-session",
  }, context);
  assert.equal(created.source, "agent-manager");
  assert.equal(created.name, "Fix the stranded queue");
  bridge.dispose();
  await adapter.dispose();
});
