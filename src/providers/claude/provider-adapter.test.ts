import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../../core/types.ts";
import type { ActivityMutation } from "../../activity/index.ts";
import type { RequestContext } from "../../server/contracts.ts";
import { AsyncInbox } from "./async-inbox.ts";
import { ClaudeHookSourceArbiter } from "../hooks/claude-source.ts";
import { ClaudeProviderControlAdapter } from "./provider-adapter.ts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeEffortLevel,
  type ClaudeInterruptReceipt,
  type ClaudeModelInfo,
  type ClaudePermissionMode,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkMessage,
  type ClaudeSdkRuntime,
  type ClaudeSdkUserMessage,
} from "./types.ts";

class BridgeQuery implements ClaudeSdkQuery, AsyncIterator<ClaudeSdkMessage> {
  readonly params: ClaudeSdkQueryParams;
  readonly output = new AsyncInbox<ClaudeSdkMessage>();
  readonly input: ClaudeSdkUserMessage[] = [];
  readonly modes: ClaudePermissionMode[] = [];
  readonly models: Array<string | undefined> = [];
  readonly efforts: Array<ClaudeEffortLevel | null> = [];
  supportedModelCatalog: ClaudeModelInfo[] = [{
    value: "sonnet",
    displayName: "Sonnet",
    description: "Balanced",
  }];
  supportedModelsCalls = 0;
  supportedModelsOverride: (() => Promise<ClaudeModelInfo[]>) | null = null;
  closed = false;

  constructor(params: ClaudeSdkQueryParams) {
    this.params = params;
    void this.#consumeInput();
  }

  emit(message: Record<string, unknown>): void {
    this.output.push(message as unknown as ClaudeSdkMessage);
  }

  interrupt(): Promise<ClaudeInterruptReceipt> {
    return Promise.resolve({ still_queued: [] });
  }

  setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.modes.push(mode);
    return Promise.resolve();
  }

  setModel(model?: string): Promise<void> {
    this.models.push(model);
    return Promise.resolve();
  }

  applyFlagSettings(settings: { effortLevel?: ClaudeEffortLevel | null }): Promise<void> {
    if (settings.effortLevel !== undefined) this.efforts.push(settings.effortLevel);
    return Promise.resolve();
  }

  supportedModels(): Promise<ClaudeModelInfo[]> {
    this.supportedModelsCalls += 1;
    if (this.supportedModelsOverride) return this.supportedModelsOverride();
    return Promise.resolve(this.supportedModelCatalog);
  }

  close(): void {
    this.closed = true;
    this.output.close();
  }

  next(): Promise<IteratorResult<ClaudeSdkMessage>> {
    return this.output.next();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this;
  }

  async #consumeInput(): Promise<void> {
    for await (const message of this.params.prompt) this.input.push(message);
  }
}

class BridgeRuntime implements ClaudeSdkRuntime {
  readonly sdkVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly queries: BridgeQuery[] = [];
  #id = 0;

  createQuery(params: ClaudeSdkQueryParams): ClaudeSdkQuery {
    const query = new BridgeQuery(params);
    this.queries.push(query);
    query.emit({
      type: "system",
      subtype: "init",
      session_id: params.options.resume ?? "managed-claude-1",
      claude_code_version: "2.1.221",
      model: params.options.model ?? "default-model",
      permissionMode: params.options.permissionMode,
      capabilities: ["interrupt_receipt_v1"],
    });
    return query;
  }

  randomUUID(): string {
    this.#id += 1;
    return `bridge-${this.#id}`;
  }

  now(): Date {
    return new Date("2026-08-03T12:00:00.000Z");
  }
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not become true");
}

function context(): RequestContext {
  return {
    actor: { id: "local-user", kind: "local", displayName: "Local user" },
    requestId: "request",
    signal: new AbortController().signal,
    workspace: { id: "workspace", label: "Workspace", path: "/workspace" },
  };
}

test("returns only the live bounded Claude model catalog", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const view = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Inspect models",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "create-model-options",
  }, context());
  const query = runtime.queries[0];
  assert.ok(query);
  query.supportedModelCatalog = [
    { value: "sonnet", displayName: "Sonnet", description: "Balanced" },
    { value: "opus", displayName: "Opus", description: "Deep reasoning" },
  ];

  assert.deepEqual(await adapter.getSettingsOptions(view, context()), {
    source: "provider-api",
    models: [
      { value: "sonnet", label: "Sonnet", description: "Balanced" },
      { value: "opus", label: "Opus", description: "Deep reasoning" },
    ],
  });

  query.supportedModelCatalog = [{
    value: "bad\nmodel",
    displayName: "Unsafe",
    description: "Provider regression",
  }];
  await assert.rejects(
    adapter.getSettingsOptions(view, context()),
    /control characters/,
  );
  query.supportedModelCatalog = [{
    value: `${" ".repeat(2_000)}sonnet`,
    displayName: "Sonnet",
    description: "Provider regression",
  }];
  await assert.rejects(adapter.getSettingsOptions(view, context()));
  query.supportedModelCatalog = [{
    value: "sonnet",
    displayName: "x".repeat(129),
    description: "Provider regression",
  }];
  await assert.rejects(adapter.getSettingsOptions(view, context()));
  query.supportedModelCatalog = [{
    value: "sonnet",
    displayName: "Sonnet",
    description: " ".repeat(1_001),
  }];
  await assert.rejects(adapter.getSettingsOptions(view, context()));
  adapter.dispose();
});

test("coalesces live model lookups and rejects a generation race", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const view = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Inspect models",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "create-coalesced-model-options",
  }, context());
  const query = runtime.queries[0];
  assert.ok(query);
  let resolveModels!: (models: ClaudeModelInfo[]) => void;
  const deferredModels = new Promise<ClaudeModelInfo[]>((resolve) => {
    resolveModels = resolve;
  });
  query.supportedModelsOverride = () => deferredModels;

  const first = adapter.getSettingsOptions(view, context());
  const second = adapter.getSettingsOptions(view, context());
  assert.equal(query.supportedModelsCalls, 1);

  const changed = await adapter.performAction(view, {
    type: "set-model",
    model: "opus",
    expectedGeneration: view.generation,
    idempotencyKey: "change-model-during-options",
  }, context());
  assert.equal(changed.status, "succeeded");
  resolveModels([{ value: "sonnet", displayName: "Sonnet", description: "Balanced" }]);
  await assert.rejects(first, /changed during settings lookup/);
  await assert.rejects(second, /changed during settings lookup/);
  assert.equal(query.supportedModelsCalls, 1, "both callers shared one SDK request");
  adapter.dispose();
});

test("expires a hung model lookup and permits a clean provider retry", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const view = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Inspect models",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "create-retried-model-options",
  }, context());
  const query = runtime.queries[0];
  assert.ok(query);
  query.supportedModelsOverride = async () => await new Promise<never>(() => undefined);

  await assert.rejects(
    adapter.getSettingsOptions(view, context()),
    /settings lookup timed out/,
  );
  query.supportedModelsOverride = null;
  query.supportedModelCatalog = [{
    value: "opus",
    displayName: "Opus",
    description: "Deep reasoning",
  }];
  assert.deepEqual(await adapter.getSettingsOptions(view, context()), {
    source: "provider-api",
    models: [{ value: "opus", label: "Opus", description: "Deep reasoning" }],
  });
  assert.equal(query.supportedModelsCalls, 2);
  adapter.dispose();
});

test("rejects a delayed model catalog after native ownership transfer", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Inspect models",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "create-handoff-model-options",
  }, context());
  const query = runtime.queries[0];
  assert.ok(query);
  await eventually(() => query.input.length === 1);
  query.emit({
    type: "result",
    subtype: "success",
    user_message_uuid: query.input[0]?.uuid,
    session_id: "managed-claude-1",
  });
  await eventually(() => changes.at(-1)?.status === "idle");
  const idle = changes.at(-1);
  assert.ok(idle);

  let resolveModels!: (models: ClaudeModelInfo[]) => void;
  const deferredModels = new Promise<ClaudeModelInfo[]>((resolve) => {
    resolveModels = resolve;
  });
  query.supportedModelsOverride = () => deferredModels;
  const lookup = adapter.getSettingsOptions(idle, context());
  const handoff = await adapter.getAttachInstruction(idle, context());
  assert.equal(handoff?.kind, "claude-resume");
  resolveModels([{ value: "sonnet", displayName: "Sonnet", description: "Balanced" }]);
  await assert.rejects(lookup, /live manager-owned SDK query|changed during settings lookup/);
  adapter.dispose();
});

test("bridges manager-owned Claude state and normalized backend actions", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: (id) => (id === "workspace" ? "/workspace" : null),
    onSessionChanged: (session) => changes.push(session),
  });
  const created = await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Plan this",
      profile: "plan",
      model: null,
      effort: null,
      idempotencyKey: "create-managed-claude",
    },
    context(),
  );
  assert.equal(created.id, "local:claude:managed-claude-1");
  assert.equal(created.providerThreadId, "managed-claude-1");
  assert.equal(created.profile.value, "plan");
  assert.equal(created.control.plane, "claude-sdk");
  assert.ok(created.control.capabilities.includes("steer"));
  assert.equal(created.control.authority, "manager");

  const query = runtime.queries[0];
  assert.ok(query);
  await eventually(() => query.input.length === 1);
  const queued = await adapter.performAction(
    created,
    {
      type: "send",
      delivery: "queue",
      text: "Follow up",
      expectedGeneration: created.generation,
      idempotencyKey: "queue-key-1",
    },
    context(),
  );
  assert.equal(queued.status, "queued");
  assert.equal(query.input.length, 1, "queued work stays removable until the active turn ends");
  query.emit({
    type: "result",
    subtype: "success",
    user_message_uuid: query.input[0]?.uuid,
    session_id: "managed-claude-1",
  });
  await eventually(() => query.input.length === 2);
  assert.equal(query.input[1]?.priority, "later");

  const permission = query.params.options.canUseTool(
    "Bash",
    { command: "pwd" },
    {
      signal: new AbortController().signal,
      requestId: "permission-1",
      toolUseID: "tool-1",
      title: "Run pwd",
    },
  );
  await eventually(() => changes.at(-1)?.attention.length === 1);
  const waiting = changes.at(-1);
  assert.ok(waiting);
  assert.equal(waiting.attention[0]?.kind, "permission");
  const responded = await adapter.performAction(
    waiting,
    {
      type: "respond",
      requestId: "permission-1",
      response: { kind: "decision", decision: "deny", reason: "Not now" },
      expectedGeneration: waiting.generation,
      idempotencyKey: "respond-key-1",
    },
    context(),
  );
  assert.equal(responded.status, "succeeded");
  assert.deepEqual(await permission, {
    behavior: "deny",
    message: "Not now",
    interrupt: false,
    toolUseID: "tool-1",
    decisionClassification: "user_reject",
  });

  const suggestions = [{
    type: "addRules" as const,
    rules: [{ toolName: "Write", ruleContent: "/workspace/**" }],
    behavior: "allow" as const,
    destination: "session" as const,
  }];
  const persistentPermission = query.params.options.canUseTool(
    "Write",
    { file_path: "/workspace/output.txt", content: "done" },
    {
      signal: new AbortController().signal,
      requestId: "permission-persistent",
      toolUseID: "tool-persistent",
      suggestions,
    },
  );
  await eventually(() => changes.at(-1)?.attention[0]?.id === "permission-persistent");
  const persistentView = changes.at(-1);
  assert.ok(persistentView);
  const persisted = await adapter.performAction(
    persistentView,
    {
      type: "respond",
      requestId: "permission-persistent",
      response: { kind: "decision", decision: "allow", persist: true },
      expectedGeneration: persistentView.generation,
      idempotencyKey: "respond-persist-key-1",
    },
    context(),
  );
  assert.equal(persisted.status, "succeeded");
  assert.deepEqual(await persistentPermission, {
    behavior: "allow",
    updatedInput: { file_path: "/workspace/output.txt", content: "done" },
    updatedPermissions: suggestions,
    toolUseID: "tool-persistent",
    decisionClassification: "user_permanent",
  });

  const question = query.params.options.canUseTool(
    "AskUserQuestion",
    {
      questions: [
        {
          question: "Storage?",
          options: [{ label: "SQLite" }, { label: "Postgres" }],
        },
      ],
    },
    {
      signal: new AbortController().signal,
      requestId: "question-1",
      toolUseID: "tool-2",
    },
  );
  await eventually(() => changes.at(-1)?.attention[0]?.id === "question-1");
  const questionView = changes.at(-1);
  assert.ok(questionView);
  const answered = await adapter.performAction(
    questionView,
    {
      type: "respond",
      requestId: "question-1",
      response: {
        kind: "answer",
        value: "Enable WAL mode",
        selectedOptions: ["SQLite"],
      },
      expectedGeneration: questionView.generation,
      idempotencyKey: "answer-key-1",
    },
    context(),
  );
  assert.equal(answered.status, "succeeded");
  assert.deepEqual(await question, {
    behavior: "allow",
    updatedInput: {
      questions: [
        {
          question: "Storage?",
          options: [{ label: "SQLite" }, { label: "Postgres" }],
        },
      ],
      answers: { "Storage?": "SQLite, Enable WAL mode" },
    },
    toolUseID: "tool-2",
    decisionClassification: "user_temporary",
  });

  const latest = changes.at(-1);
  assert.ok(latest);
  const profile = await adapter.performAction(
    latest,
    {
      type: "set-profile",
      profile: "execute",
      expectedGeneration: latest.generation,
      idempotencyKey: "set-profile-1",
    },
    context(),
  );
  assert.deepEqual(profile, {
    status: "succeeded",
    result: { profile: "execute" },
  });
  assert.deepEqual(query.modes, ["acceptEdits"]);
  adapter.dispose();
});

test("publishes buffered SDK messages and callback attention as activity", async () => {
  const runtime = new BridgeRuntime();
  const activity: Array<{ sessionId: string; mutation: ActivityMutation }> = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onActivity: (sessionId, mutation) => activity.push({ sessionId, mutation }),
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Begin",
      profile: "execute",
      model: null,
      effort: null,
      idempotencyKey: "activity-managed-claude",
    },
    context(),
  );

  assert.ok(activity.some(({ sessionId, mutation }) =>
    sessionId === "local:claude:managed-claude-1"
    && mutation.type === "upsert"
    && mutation.item.kind === "lifecycle"
    && mutation.item.title === "Claude session initialized"
  ));

  const query = runtime.queries[0];
  assert.ok(query);
  const abort = new AbortController();
  const pending = query.params.options.canUseTool(
    "Bash",
    { command: "pwd" },
    {
      signal: abort.signal,
      requestId: "activity-permission",
      toolUseID: "activity-tool",
      title: "Run pwd",
    },
  );
  await eventually(() => activity.some(({ mutation }) =>
    mutation.type === "upsert"
    && mutation.item.kind === "attention"
    && mutation.item.requestId === "activity-permission"
    && mutation.item.resolved === false
  ));
  abort.abort();
  await pending;
  await eventually(() => activity.some(({ mutation }) =>
    mutation.type === "upsert"
    && mutation.item.kind === "attention"
    && mutation.item.requestId === "activity-permission"
    && mutation.item.resolved === true
  ));

  const planApproval = query.params.options.canUseTool(
    "ExitPlanMode",
    { plan: "# Exact managed plan" },
    {
      signal: new AbortController().signal,
      requestId: "activity-plan-approval",
      toolUseID: "activity-plan-tool",
      title: "Execute exact plan",
    },
  );
  await eventually(() => activity.some(({ mutation }) =>
    mutation.type === "upsert"
    && mutation.item.kind === "plan"
    && mutation.item.approvalRequestId === "activity-plan-approval"
  ));
  const planView = adapter.getManagedSession("managed-claude-1");
  assert.ok(planView);
  const approved = await adapter.performAction(planView, {
    type: "respond",
    requestId: "activity-plan-approval",
    response: { kind: "decision", decision: "allow" },
    expectedGeneration: planView.generation,
    idempotencyKey: "approve-exact-plan",
  }, context());
  assert.equal(approved.status, "succeeded");
  assert.equal((await planApproval).behavior, "allow");
  assert.ok(activity.some(({ mutation }) =>
    mutation.type === "upsert"
    && mutation.item.kind === "plan"
    && mutation.item.approvalRequestId === "activity-plan-approval"
    && mutation.item.approvedAt === "2026-08-03T12:00:00.000Z"
    && mutation.item.state === "complete"
  ));
  adapter.dispose();
});

test("maps the atomic full-access profile to Claude bypass permissions", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const view = await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Plan",
      profile: "plan",
      model: null,
      effort: null,
      idempotencyKey: "create-bypass-claude",
    },
    context(),
  );
  assert.equal(view.profile.providerValue, "plan");
  assert.equal(
    runtime.queries[0]?.params.options.allowDangerouslySkipPermissions,
    true,
  );
  const result = await adapter.performAction(view, {
    type: "set-profile",
    profile: "full-access",
    expectedGeneration: view.generation,
    idempotencyKey: "set-bypass-mode",
  }, context());
  assert.deepEqual(result, {
    status: "succeeded",
    result: { profile: "full-access" },
  });
  assert.deepEqual(runtime.queries[0]?.modes, ["bypassPermissions"]);
  adapter.dispose();
});

test("exposes live model, effort, removable staging, and manager-only end", async () => {
  const runtime = new BridgeRuntime();
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    hookSourceArbiter,
  });
  const created = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Active turn",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "create-controls-claude",
  }, context());
  const query = runtime.queries[0];
  assert.ok(query);
  assert.equal(hookSourceArbiter.shouldPollTranscript("managed-claude-1"), false);

  const queued = await adapter.performAction(created, {
    type: "send",
    delivery: "queue",
    text: "Removable follow-up",
    expectedGeneration: created.generation,
    idempotencyKey: "queue-remove-claude",
  }, context());
  const messageId = (queued.result as { messageId?: string } | undefined)?.messageId;
  assert.equal(typeof messageId, "string");
  await eventually(() => changes.at(-1)?.control.capabilities.includes("remove-queued") === true);

  let current = changes.at(-1)!;
  assert.equal((await adapter.performAction(current, {
    type: "remove-queued",
    messageId: messageId!,
    expectedGeneration: current.generation,
    idempotencyKey: "remove-queue-claude",
  }, context())).status, "succeeded");

  current = changes.at(-1)!;
  assert.equal((await adapter.performAction(current, {
    type: "set-model",
    model: "sonnet",
    expectedGeneration: current.generation,
    idempotencyKey: "set-model-claude",
  }, context())).status, "succeeded");
  current = changes.at(-1)!;
  for (const effort of ["minimal", "ultra"] as const) {
    const rejected = await adapter.performAction(current, {
      type: "set-effort",
      effort,
      expectedGeneration: current.generation,
      idempotencyKey: `set-${effort}-effort-claude`,
    }, context());
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error?.message ?? "", new RegExp(`does not expose the ${effort} effort level`, "u"));
  }
  assert.deepEqual(query.efforts, []);
  assert.equal((await adapter.performAction(current, {
    type: "set-effort",
    effort: "xhigh",
    expectedGeneration: current.generation,
    idempotencyKey: "set-effort-claude",
  }, context())).status, "succeeded");
  assert.deepEqual(query.models, ["sonnet"]);
  assert.deepEqual(query.efforts, ["xhigh"]);

  current = changes.at(-1)!;
  assert.equal((await adapter.performAction(current, {
    type: "end",
    expectedGeneration: current.generation,
    idempotencyKey: "end-managed-claude",
  }, context())).status, "succeeded");
  assert.equal(changes.at(-1)?.providerStatus, "closed");
  assert.equal(query.closed, true);
  assert.equal(hookSourceArbiter.shouldPollTranscript("managed-claude-1"), true);
  adapter.dispose();
});

test("publishes exact multi-question and approval attention details", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Ask me",
      profile: "plan",
      model: null,
      effort: null,
      idempotencyKey: "create-attention-claude",
    },
    context(),
  );
  const query = runtime.queries[0];
  assert.ok(query);
  const questionAbort = new AbortController();
  const approvalAbort = new AbortController();
  const question = query.params.options.canUseTool(
    "AskUserQuestion",
    {
      questions: [
        {
          header: "Storage",
          question: "Which database should we use?",
          options: [
            { label: "SQLite", description: "Embedded and local" },
            { label: "Postgres", description: "Separate database service" },
          ],
          multiSelect: false,
        },
        {
          header: "Features",
          question: "Which features should be enabled?",
          options: [
            { label: "Audit log", description: "Keep action history" },
            { label: "Metrics", description: "Track runtime health" },
          ],
          multiSelect: true,
          allowFreeText: false,
        },
      ],
    },
    {
      signal: questionAbort.signal,
      requestId: "multi-question",
      toolUseID: "question-tool",
    },
  );
  const approval = query.params.options.canUseTool(
    "Bash",
    { command: "git status --short", timeout: 1_000 },
    {
      signal: approvalAbort.signal,
      requestId: "bash-approval",
      toolUseID: "bash-tool",
      title: "Inspect repository status",
    },
  );
  await eventually(() => changes.at(-1)?.attention.length === 2);
  const latest = changes.at(-1);
  assert.ok(latest);
  const questionAttention = latest.attention.find(
    (item) => item.id === "multi-question",
  );
  const approvalAttention = latest.attention.find(
    (item) => item.id === "bash-approval",
  );
  assert.deepEqual(questionAttention?.details, {
    title: "Claude needs your answer",
    toolName: "AskUserQuestion",
    inputSummary: null,
    respondable: true,
    questions: [
      {
        id: "Storage",
        header: "Storage",
        text: "Which database should we use?",
        options: [
          { label: "SQLite", description: "Embedded and local" },
          { label: "Postgres", description: "Separate database service" },
        ],
        multiSelect: false,
        allowFreeText: true,
        isSecret: false,
      },
      {
        id: "Features",
        header: "Features",
        text: "Which features should be enabled?",
        options: [
          { label: "Audit log", description: "Keep action history" },
          { label: "Metrics", description: "Track runtime health" },
        ],
        multiSelect: true,
        allowFreeText: false,
        isSecret: false,
      },
    ],
  });
  assert.deepEqual(approvalAttention?.details, {
    title: "Inspect repository status",
    toolName: "Bash",
    questions: null,
    inputSummary: '{"command":"git status --short","timeout":1000}',
    respondable: true,
  });

  const missingAnswer = await adapter.performAction(
    latest,
    {
      type: "respond",
      requestId: "multi-question",
      response: {
        kind: "answers",
        answers: [
          { questionId: "Storage", value: "", selectedOptions: ["SQLite"] },
        ],
      },
      expectedGeneration: latest.generation,
      idempotencyKey: "missing-answer-1",
    },
    context(),
  );
  assert.equal(missingAnswer.status, "failed");
  assert.match(missingAnswer.error?.message ?? "", /exactly once/);

  const answered = await adapter.performAction(
    latest,
    {
      type: "respond",
      requestId: "multi-question",
      response: {
        kind: "answers",
        answers: [
          {
            questionId: "Features",
            value: "",
            selectedOptions: ["Audit log", "Metrics"],
          },
          { questionId: "Storage", value: "", selectedOptions: ["SQLite"] },
        ],
      },
      expectedGeneration: latest.generation,
      idempotencyKey: "all-answers-1",
    },
    context(),
  );
  assert.equal(answered.status, "succeeded");
  assert.deepEqual(await question, {
    behavior: "allow",
    updatedInput: {
      questions: [
        {
          header: "Storage",
          question: "Which database should we use?",
          options: [
            { label: "SQLite", description: "Embedded and local" },
            { label: "Postgres", description: "Separate database service" },
          ],
          multiSelect: false,
        },
        {
          header: "Features",
          question: "Which features should be enabled?",
          options: [
            { label: "Audit log", description: "Keep action history" },
            { label: "Metrics", description: "Track runtime health" },
          ],
          multiSelect: true,
          allowFreeText: false,
        },
      ],
      answers: {
        "Which database should we use?": "SQLite",
        "Which features should be enabled?": "Audit log, Metrics",
      },
    },
    toolUseID: "question-tool",
    decisionClassification: "user_temporary",
  });

  approvalAbort.abort();
  await approval;
  adapter.dispose();
});

test("returns the provider handoff id with native Claude attach instructions", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Prepare",
      profile: "plan",
      model: null,
      effort: null,
      idempotencyKey: "create-handoff-claude",
    },
    context(),
  );
  const query = runtime.queries[0];
  assert.ok(query);
  await eventually(() => query.input.length === 1);
  query.emit({
    type: "result",
    subtype: "success",
    user_message_uuid: query.input[0]?.uuid,
    session_id: "managed-claude-1",
  });
  query.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    session_id: "managed-claude-1",
  });
  await eventually(() => changes.at(-1)?.status === "idle");
  const view = changes.at(-1);
  assert.ok(view);
  const instruction = await adapter.getAttachInstruction(view, context());
  assert.equal(instruction?.kind, "claude-resume");
  assert.deepEqual(instruction?.argv, ["claude", "--resume", "managed-claude-1"]);
  assert.equal(typeof instruction?.handoffId, "string");
  assert.ok((instruction?.handoffId?.length ?? 0) > 0);
  const nativeOwned = changes.at(-1);
  assert.ok(nativeOwned);
  assert.equal(nativeOwned.control.authority, "foreign");
  assert.deepEqual(nativeOwned.control.capabilities, []);
  assert.match(
    nativeOwned.control.withheld.find(({ capability }) => capability === "resume")?.reason ?? "",
    /already owns this session/,
  );
  adapter.dispose();
});

test("withdraws writable controls after stream close while preserving native resume", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Prepare for terminal close",
      profile: "execute",
      model: null,
      effort: null,
      idempotencyKey: "create-terminal-claude",
    },
    context(),
  );
  const query = runtime.queries[0];
  assert.ok(query);
  await eventually(() => query.input.length === 1);
  query.emit({
    type: "result",
    subtype: "success",
    user_message_uuid: query.input[0]?.uuid,
    session_id: "managed-claude-1",
  });
  query.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    session_id: "managed-claude-1",
  });
  await eventually(() => changes.at(-1)?.status === "idle");

  query.close();
  await eventually(() => changes.at(-1)?.providerStatus === "closed");
  const closed = changes.at(-1);
  assert.ok(closed);
  assert.equal(closed.control.plane, "resume-only");
  assert.deepEqual(closed.control.capabilities, ["resume", "attach"]);

  const rejected = await adapter.performAction(
    closed,
    {
      type: "send",
      delivery: "queue",
      text: "Do not queue this",
      expectedGeneration: closed.generation,
      idempotencyKey: "terminal-send",
    },
    context(),
  );
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error?.message ?? "", /no live Agent SDK consumer/);

  const instruction = await adapter.getAttachInstruction(closed, context());
  assert.equal(instruction?.kind, "claude-resume");
  assert.deepEqual(instruction?.argv, ["claude", "--resume", "managed-claude-1"]);
  assert.equal(typeof instruction?.handoffId, "string");
  adapter.dispose();
});

test("withdraws writable controls after terminal provider failure", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Fail safely",
      profile: "execute",
      model: null,
      effort: null,
      idempotencyKey: "create-failed-claude",
    },
    context(),
  );
  const query = runtime.queries[0];
  assert.ok(query);
  query.emit({
    type: "result",
    subtype: "error_during_execution",
    errors: ["terminal provider failure"],
    session_id: "managed-claude-1",
  });
  await eventually(() => changes.at(-1)?.providerStatus === "failed");

  const failed = changes.at(-1);
  assert.ok(failed);
  assert.equal(failed.control.plane, "resume-only");
  assert.deepEqual(failed.control.capabilities, []);
  assert.match(
    failed.control.withheld.find(({ capability }) => capability === "resume")?.reason ?? "",
    /provider-confirmed empty Claude input queue/,
  );
  assert.equal(await adapter.getAttachInstruction(failed, context()), null);
  adapter.dispose();
});
