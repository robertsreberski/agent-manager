import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../../core/types.ts";
import type { ActivityMutation } from "../../activity/index.ts";
import type { ManagedSessionRecoveryRecord, RequestContext } from "../../server/contracts.ts";
import { AsyncInbox } from "./async-inbox.ts";
import {
  CLAUDE_MANAGER_OWNER_VALUE,
  ClaudeHookSourceArbiter,
} from "../hooks/claude-source.ts";
import { parseClaudeHookInput } from "../hooks/claude-types.ts";
import { ClaudeProviderControlAdapter } from "./provider-adapter.ts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
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
  setModelOverride: (() => Promise<void>) | null = null;
  closed = false;
  closeCalls = 0;
  closeEndsOutput = true;
  readonly closeErrors: Error[] = [];

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
    if (this.setModelOverride) return this.setModelOverride();
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
    this.closeCalls += 1;
    this.closed = true;
    if (this.closeEndsOutput) this.output.close();
    const error = this.closeErrors.shift();
    if (error) throw error;
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
  nextQueryHook: ((query: BridgeQuery) => void) | null = null;
  autoInitialize = true;
  codeVersion = CLAUDE_CODE_VERSION;
  initModelOverride: string | null = null;
  #id = 0;

  createQuery(params: ClaudeSdkQueryParams): ClaudeSdkQuery {
    const query = new BridgeQuery(params);
    this.queries.push(query);
    this.nextQueryHook?.(query);
    if (this.autoInitialize) {
      query.emit({
        type: "system",
        subtype: "init",
        session_id: params.options.resume ?? "managed-claude-1",
        claude_code_version: this.codeVersion,
        model: this.initModelOverride ?? params.options.model ?? "default-model",
        permissionMode: params.options.permissionMode,
        capabilities: ["interrupt_receipt_v1"],
      });
    }
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

function stoppedRecoveryRecord(
  overrides: Partial<ManagedSessionRecoveryRecord> = {},
): ManagedSessionRecoveryRecord {
  return {
    managerSessionId: "local:claude:claude-stopped",
    provider: "claude",
    providerThreadId: "claude-stopped",
    workspaceId: "workspace",
    workspacePath: "/workspace",
    name: "Stopped Claude",
    profile: "plan",
    model: "opus",
    effort: "high",
    createdAt: "2026-08-03T08:00:00.000Z",
    ownership: "manager-exclusive",
    managerControl: "stopped",
    ...overrides,
  };
}

function nativeStopHook(sessionId: string, promptId: string) {
  return parseClaudeHookInput({
    session_id: sessionId,
    transcript_path: `/tmp/${sessionId}.jsonl`,
    cwd: "/workspace",
    prompt_id: promptId,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
}

async function externalClaudeView(runtime: BridgeRuntime): Promise<SessionView> {
  const source = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const view = await source.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Original CLI turn",
    profile: "ask-first",
    sandbox: null,
    model: "sonnet",
    effort: "high",
    idempotencyKey: "external-claude-fixture",
  }, context());
  await source.dispose();
  return {
    ...view,
    source: "claude-hook",
    control: {
      plane: "claude-hook-bridge",
      authority: "foreign",
      coordination: view.control.coordination,
      recovery: null,
      capabilities: [],
      withheld: view.control.withheld,
      takeover: null,
    },
  };
}

test("never publishes manager control for an unexpected Claude Code version", async () => {
  const runtime = new BridgeRuntime();
  runtime.codeVersion = "2.1.219";
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (view) => changes.push(view),
  });

  await assert.rejects(adapter.createSession({
    sandbox: null,
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Must not become writable",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "reject-old-claude-code",
  }, context()), /Unsupported Claude Code 2\.1\.219/);

  assert.deepEqual(changes, []);
  assert.equal(adapter.getManagedSession("managed-claude-1"), null);
  assert.equal(runtime.queries[0]?.closeCalls, 1);
  await adapter.dispose();
});

test("adapter disposal aborts and settles a hanging Claude creation", async () => {
  const runtime = new BridgeRuntime();
  runtime.autoInitialize = false;
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const creation = adapter.createSession({
    sandbox: null,
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Hang before init",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "dispose-hanging-create",
  }, context());
  const rejection = assert.rejects(creation, /disposed/);
  await eventually(() => runtime.queries.length === 1);

  await adapter.dispose();
  await rejection;
  const query = runtime.queries[0];
  assert.ok(query);
  assert.equal(query.params.options.abortController.signal.aborted, true);
  assert.equal(query.closeCalls, 1);
});

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
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "create-model-options",
  }, context());
  const query = runtime.queries[0];
  assert.ok(query);
  query.supportedModelCatalog = [
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Balanced",
      resolvedModel: "claude-sonnet-5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    },
    { value: "opus", displayName: "Opus", description: "Deep reasoning" },
  ];

  assert.deepEqual(await adapter.getSettingsOptions(view, context()), {
    source: "provider-api",
    models: [
      {
        value: "sonnet",
        label: "Sonnet",
        description: "Balanced",
        resolvedModel: "claude-sonnet-5",
        efforts: ["low", "medium", "high"],
      },
      { value: "opus", label: "Opus", description: "Deep reasoning" },
    ],
  });

  query.supportedModelCatalog = [{
    value: "sonnet",
    displayName: "Sonnet",
    description: "Balanced",
    resolvedModel: "claude\nsonnet",
  }];
  await assert.rejects(
    adapter.getSettingsOptions(view, context()),
    /control characters/,
  );

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

test("coalesces live model lookups and survives concurrent session churn", async () => {
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
    sandbox: null,
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

  /*
    A write landing mid-read must not spoil the catalog: the model list does
    not depend on which model is currently selected, and a fresh session
    churns generations continuously while its first turn streams.
  */
  const changed = await adapter.performAction(view, {
    type: "set-model",
    model: "opus",
    expectedGeneration: view.generation,
    idempotencyKey: "change-model-during-options",
  }, context());
  assert.equal(changed.status, "succeeded");
  resolveModels([{ value: "sonnet", displayName: "Sonnet", description: "Balanced" }]);
  const catalog = {
    source: "provider-api",
    models: [{ value: "sonnet", label: "Sonnet", description: "Balanced" }],
  };
  assert.deepEqual(await first, catalog);
  assert.deepEqual(await second, catalog);
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
    sandbox: null,
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
    sandbox: null,
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
      sandbox: null,
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
      sandbox: null,
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
      sandbox: null,
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

test("ending manager control preserves the closed session and native resume path", async () => {
  const runtime = new BridgeRuntime();
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const changes: SessionView[] = [];
  const stoppedControl: string[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    onManagerControlStopped: (id) => {
      stoppedControl.push(id);
    },
    hookSourceArbiter,
  });
  const created = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Active turn",
    profile: "ask-first",
    sandbox: null,
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
  const [firstEnd, repeatedEnd] = await Promise.all([
    adapter.performAction(current, {
      type: "end",
      expectedGeneration: current.generation,
      idempotencyKey: "end-managed-claude",
    }, context()),
    adapter.performAction(current, {
      type: "end",
      expectedGeneration: current.generation,
      idempotencyKey: "end-managed-claude-repeated",
    }, context()),
  ]);
  assert.equal(firstEnd.status, "succeeded");
  assert.equal(repeatedEnd.status, "succeeded");
  assert.equal(changes.at(-1)?.providerStatus, "closed");
  assert.equal(query.closed, true);
  assert.equal(query.closeCalls, 1);
  assert.deepEqual(stoppedControl, [created.id]);
  const ended = adapter.getManagedSession(created.providerThreadId);
  assert.ok(ended);
  assert.equal(ended.status, "completed");
  assert.equal(ended.control.plane, "resume-only");
  assert.deepEqual(ended.control.capabilities, ["resume", "attach"]);
  assert.equal(hookSourceArbiter.shouldPollTranscript("managed-claude-1"), true);
  const instruction = await adapter.getAttachInstruction(ended, context());
  assert.equal(instruction?.kind, "claude-resume");
  assert.deepEqual(instruction?.argv, ["claude", "--resume", "managed-claude-1"]);
  await adapter.dispose();
});

test("refuses to close Claude control until the durable stopped intent commits", async () => {
  const runtime = new BridgeRuntime();
  let persistenceAvailable = false;
  let persistenceAttempts = 0;
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onManagerControlStopped: () => {
      persistenceAttempts += 1;
      if (!persistenceAvailable) throw new Error("stopped intent write failed");
    },
  });
  const created = await adapter.createSession({
    sandbox: null,
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Keep this query alive until the intent is durable",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "create-durable-end-claude",
  }, context());
  const query = runtime.queries[0];
  assert.ok(query);
  const endAction = {
    type: "end" as const,
    expectedGeneration: created.generation,
    idempotencyKey: "durable-end-claude",
  };

  const rejected = await adapter.performAction(created, endAction, context());
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error?.message ?? "", /stopped intent write failed/);
  assert.equal(query.closed, false, "failed persistence must leave manager control live");
  assert.ok(adapter.getManagedSession(created.providerThreadId)?.control.capabilities.includes("queue"));

  persistenceAvailable = true;
  const retried = await adapter.performAction(created, {
    ...endAction,
    idempotencyKey: "durable-end-claude-retry",
  }, context());
  assert.equal(retried.status, "succeeded");
  assert.equal(query.closed, true);
  assert.equal(persistenceAttempts, 2);
  assert.deepEqual(
    adapter.getManagedSession(created.providerThreadId)?.control.capabilities,
    ["resume", "attach"],
  );
  await adapter.dispose();
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
      sandbox: null,
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
    claudeExecutable: "/opt/agent-manager/bin/claude",
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Prepare",
      profile: "plan",
      sandbox: null,
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
  assert.deepEqual(instruction?.argv, [
    "/opt/agent-manager/bin/claude",
    "--resume",
    "managed-claude-1",
  ]);
  assert.equal(
    query.params.options.pathToClaudeCodeExecutable,
    "/opt/agent-manager/bin/claude",
  );
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
  const handoffId = instruction?.handoffId;
  assert.ok(handoffId);
  adapter.markCliAttached("managed-claude-1", handoffId, 4242);
  adapter.markCliExited("managed-claude-1", handoffId, 0);
  runtime.autoInitialize = false;
  const reclaim = adapter.reclaimFromCli("managed-claude-1", handoffId);
  await eventually(() => runtime.queries.length === 2);
  assert.equal(
    changes.at(-1)?.control.authority,
    "foreign",
    "write authority stays withdrawn until exact provider init",
  );
  runtime.queries[1]?.emit({
    type: "system",
    subtype: "init",
    session_id: "managed-claude-1",
    claude_code_version: CLAUDE_CODE_VERSION,
    model: "default-model",
    permissionMode: "plan",
    capabilities: ["interrupt_receipt_v1"],
  });
  const reclaimed = await reclaim;
  assert.equal(reclaimed.control.authority, "manager");
  assert.ok(reclaimed.control.capabilities.includes("queue"));
  await adapter.dispose();
});

test("restores only exact persisted Claude identities with their profile, model, and effort", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    onSessionChanged: (view) => changes.push(view),
  });
  const record: ManagedSessionRecoveryRecord = {
    managerSessionId: "local:claude:claude-restart",
    provider: "claude",
    providerThreadId: "claude-restart",
    workspaceId: "workspace",
    workspacePath: "/workspace",
    name: "Recovered Claude",
    profile: "plan",
    model: "opus",
    effort: "high",
    createdAt: "2026-08-03T08:00:00.000Z",
  };

  const report = await adapter.restoreManagedSessions([
    record,
    { ...record },
    { ...record, managerSessionId: "local:claude:different", providerThreadId: "wrong" },
  ], new AbortController().signal);

  assert.deepEqual(report.restoredSessionIds, ["local:claude:claude-restart"]);
  assert.equal(report.failures.length, 2);
  assert.match(report.failures[0]?.reason ?? "", /duplicated/u);
  assert.match(report.failures[1]?.reason ?? "", /do not match/u);
  const query = runtime.queries[0];
  assert.ok(query);
  assert.equal(query.params.options.resume, "claude-restart");
  assert.equal(query.params.options.cwd, "/workspace");
  assert.equal(query.params.options.permissionMode, "plan");
  assert.equal(query.params.options.model, "opus");
  assert.equal(query.params.options.effort, "high");
  const recovered = adapter.getManagedSession("claude-restart");
  assert.ok(recovered);
  assert.equal(recovered.name, "Recovered Claude");
  assert.equal(recovered.control.authority, "manager");
  assert.ok(recovered.control.capabilities.includes("queue"));
  assert.ok(changes.some((view) => view.id === recovered.id));
  adapter.dispose();
});

test("restores deliberately stopped Claude control without opening an SDK query", async () => {
  const runtime = new BridgeRuntime();
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const adapter = new ClaudeProviderControlAdapter({ runtime, hookSourceArbiter });
  const record: ManagedSessionRecoveryRecord = {
    managerSessionId: "local:claude:claude-stopped",
    provider: "claude",
    providerThreadId: "claude-stopped",
    workspaceId: "workspace",
    workspacePath: "/workspace",
    name: "Stopped Claude",
    profile: "plan",
    model: "opus",
    effort: "high",
    createdAt: "2026-08-03T08:00:00.000Z",
    ownership: "manager-exclusive",
    managerControl: "stopped",
  };

  const report = await adapter.restoreManagedSessions(
    [record],
    new AbortController().signal,
  );

  assert.deepEqual(report, {
    restoredSessionIds: [record.managerSessionId],
    failures: [],
    truncated: false,
  });
  assert.equal(runtime.queries.length, 0, "restart must not auto-resume ended control");
  assert.equal(
    hookSourceArbiter.shouldPollTranscript(record.providerThreadId),
    true,
    "dormant history must never be announced as a live manager-owned writer",
  );
  const restored = adapter.getManagedSession(record.providerThreadId);
  assert.ok(restored);
  assert.equal(restored.status, "completed");
  assert.equal(restored.profile.value, "plan");
  assert.equal(restored.model.value, "opus");
  assert.equal(restored.effort.value, "high");
  assert.deepEqual(restored.control.capabilities, ["resume", "attach"]);

  const instruction = await adapter.getAttachInstruction(restored, context());
  assert.equal(instruction?.kind, "claude-resume");
  assert.deepEqual(instruction?.argv, ["claude", "--resume", "claude-stopped"]);
  assert.equal(runtime.queries.length, 0, "native attach preparation stays query-free");
  await adapter.dispose();
});

test("in-web resume stays dormant until commit, then atomically publishes one exact writer", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    hookSourceArbiter,
    onSessionChanged: (view) => changes.push(view),
  });
  const record = stoppedRecoveryRecord();
  await adapter.restoreManagedSessions([record], new AbortController().signal);
  const dormant = adapter.getManagedSession(record.providerThreadId);
  assert.ok(dormant);
  const publishedBeforeResume = changes.length;

  const provisional = await adapter.resumeSession(dormant, "plan", context());
  const query = runtime.queries[0];
  assert.ok(query);
  assert.equal(query.params.options.resume, record.providerThreadId);
  assert.equal(query.params.options.cwd, record.workspacePath);
  assert.equal(query.params.options.permissionMode, "plan");
  assert.equal(query.params.options.model, "opus");
  assert.equal(query.params.options.effort, "high");
  assert.ok(provisional.control.capabilities.includes("queue"));
  assert.equal(
    adapter.getManagedSession(record.providerThreadId)?.status,
    "completed",
    "the public entry must remain dormant before durable commit",
  );
  assert.equal(changes.length, publishedBeforeResume);
  assert.equal(hookSourceArbiter.shouldPollTranscript(record.providerThreadId), true);
  assert.equal(
    await adapter.getAttachInstruction(dormant, context()),
    null,
    "native resume must be blocked while an SDK owner awaits commit",
  );
  await assert.rejects(
    adapter.resumeSession(dormant, "plan", context()),
    /awaiting durable commit/u,
  );
  assert.equal(runtime.queries.length, 1, "only one SDK writer may exist");

  const committed = adapter.commitExternalAdoption(record.providerThreadId);
  assert.equal(committed.control.authority, "manager");
  assert.ok(committed.control.capabilities.includes("queue"));
  assert.equal(adapter.getManagedSession(record.providerThreadId)?.status, "idle");
  assert.equal(hookSourceArbiter.shouldPollTranscript(record.providerThreadId), false);
  assert.equal(runtime.queries.length, 1);
  await adapter.dispose();
});

test("failed durable activation aborts only the provisional writer and preserves dormant retry", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    hookSourceArbiter,
    onSessionChanged: (view) => changes.push(view),
  });
  const record = stoppedRecoveryRecord();
  await adapter.restoreManagedSessions([record], new AbortController().signal);
  const dormant = adapter.getManagedSession(record.providerThreadId);
  assert.ok(dormant);
  const publishedBeforeResume = changes.length;

  await adapter.resumeSession(dormant, "plan", context());
  await adapter.abortExternalAdoption(record.providerThreadId);
  assert.equal(runtime.queries[0]?.closeCalls, 1);
  const rolledBack = adapter.getManagedSession(record.providerThreadId);
  assert.ok(rolledBack);
  assert.equal(rolledBack.status, "completed");
  assert.deepEqual(rolledBack.control.capabilities, ["resume", "attach"]);
  assert.equal(changes.length, publishedBeforeResume);
  assert.equal(hookSourceArbiter.shouldPollTranscript(record.providerThreadId), true);

  await adapter.resumeSession(rolledBack, "plan", context());
  assert.equal(runtime.queries.length, 2, "rollback must permit one clean retry");
  await adapter.abortExternalAdoption(record.providerThreadId);
  assert.equal(runtime.queries[1]?.closeCalls, 1);
  await adapter.dispose();
});

test("in-web resume rejects identity drift and leaves the dormant manager record intact", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({ runtime });
  const record = stoppedRecoveryRecord();
  await adapter.restoreManagedSessions([record], new AbortController().signal);
  const dormant = adapter.getManagedSession(record.providerThreadId);
  assert.ok(dormant);
  runtime.nextQueryHook = (query) => query.emit({
    type: "system",
    subtype: "init",
    session_id: "substituted-session",
    claude_code_version: CLAUDE_CODE_VERSION,
    model: "opus",
    permissionMode: "plan",
    capabilities: ["interrupt_receipt_v1"],
  });

  await assert.rejects(
    adapter.resumeSession(dormant, "plan", context()),
    /resumed unexpected session/u,
  );
  assert.equal(runtime.queries[0]?.closeCalls, 1);
  assert.equal(adapter.getManagedSession(record.providerThreadId)?.status, "completed");
  assert.throws(
    () => adapter.commitExternalAdoption(record.providerThreadId),
    /no provisional adoption/u,
  );
  await adapter.dispose();
});

test("duplicate or aborted in-web resume never creates a second Claude writer", async () => {
  const runtime = new BridgeRuntime();
  runtime.autoInitialize = false;
  const adapter = new ClaudeProviderControlAdapter({ runtime });
  const record = stoppedRecoveryRecord();
  await adapter.restoreManagedSessions([record], new AbortController().signal);
  const dormant = adapter.getManagedSession(record.providerThreadId);
  assert.ok(dormant);
  const controller = new AbortController();
  const resumeContext: RequestContext = { ...context(), signal: controller.signal };
  const first = adapter.resumeSession(dormant, "plan", resumeContext);
  await eventually(() => runtime.queries.length === 1);

  await assert.rejects(
    adapter.resumeSession(dormant, "plan", context()),
    /already in progress/u,
  );
  assert.equal(runtime.queries.length, 1);
  controller.abort(new Error("cancel web resume"));
  await assert.rejects(first, /cancel web resume/u);
  assert.equal(runtime.queries[0]?.closeCalls, 1);
  assert.equal(runtime.queries[0]?.params.options.abortController.signal.aborted, true);
  assert.equal(adapter.getManagedSession(record.providerThreadId)?.status, "completed");
  await adapter.dispose();
});

test("cancels a hanging managed Claude recovery without leaking its query", async () => {
  const runtime = new BridgeRuntime();
  runtime.autoInitialize = false;
  const adapter = new ClaudeProviderControlAdapter({ runtime });
  const controller = new AbortController();
  const record: ManagedSessionRecoveryRecord = {
    managerSessionId: "local:claude:claude-recovery-hang",
    provider: "claude",
    providerThreadId: "claude-recovery-hang",
    workspaceId: "workspace",
    workspacePath: "/workspace",
    name: "Hanging recovery",
    profile: "ask-first",
    model: null,
    effort: null,
    createdAt: "2026-08-03T08:00:00.000Z",
  };

  const recovery = adapter.restoreManagedSessions([record], controller.signal);
  await eventually(() => runtime.queries.length === 1);
  controller.abort(new Error("recovery deadline reached"));
  const report = await recovery;

  assert.deepEqual(report.restoredSessionIds, []);
  assert.match(report.failures[0]?.reason ?? "", /recovery deadline reached/);
  const query = runtime.queries[0];
  assert.ok(query);
  assert.equal(query.params.options.abortController.signal.aborted, true);
  assert.equal(query.closeCalls, 1);
  assert.equal(adapter.getManagedSession(record.providerThreadId), null);
  await adapter.dispose();
});

test("unexpected stream close atomically retires the writer and reports managed loss", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const losses: Array<{ id: string; reason: string; registered: boolean }> = [];
  let adapter!: ClaudeProviderControlAdapter;
  adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    onSessionLost: (id, reason) => {
      losses.push({
        id,
        reason,
        registered: adapter.getManagedSession("managed-claude-1") !== null,
      });
    },
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Prepare for terminal close",
      profile: "execute",
      sandbox: null,
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
  await eventually(() => losses.length === 1);
  assert.deepEqual(losses, [{
    id: "local:claude:managed-claude-1",
    reason: "unexpected-close",
    registered: false,
  }]);
  assert.equal(adapter.getManagedSession("managed-claude-1"), null);

  const rejected = await adapter.performAction(
    changes.at(-1)!,
    {
      type: "send",
      delivery: "queue",
      text: "Do not queue this",
      expectedGeneration: changes.at(-1)!.generation,
      idempotencyKey: "terminal-send",
    },
    context(),
  );
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error?.message ?? "", /does not own the Claude SDK query/);

  assert.equal(await adapter.getAttachInstruction(changes.at(-1)!, context()), null);
  await adapter.dispose();
});

test("unexpected provider failure atomically retires the writer and reports managed loss", async () => {
  const runtime = new BridgeRuntime();
  const changes: SessionView[] = [];
  const losses: string[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    onSessionLost: (_id, reason) => { losses.push(reason); },
  });
  await adapter.createSession(
    {
      provider: "claude",
      workspaceId: "workspace",
      initialMessage: "Fail safely",
      profile: "execute",
      sandbox: null,
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
  await eventually(() => losses.length === 1);
  assert.deepEqual(losses, ["unexpected-failure"]);
  assert.equal(adapter.getManagedSession("managed-claude-1"), null);
  assert.equal(query.params.options.abortController.signal.aborted, true);
  assert.equal(query.closeCalls, 1);
  await adapter.dispose();
});

test("markerless hook conflict withdraws manager writes while manager-origin hooks stay ignored", async () => {
  const runtime = new BridgeRuntime();
  const arbiter = new ClaudeHookSourceArbiter();
  const losses: string[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    hookSourceArbiter: arbiter,
    onSessionLost: (_id, reason) => { losses.push(reason); },
  });
  await adapter.createSession({
    sandbox: null,
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Own exactly one writer",
    profile: "execute",
    model: null,
    effort: null,
    idempotencyKey: "create-hook-conflict-claude",
  }, context());
  const hook = parseClaudeHookInput({
    session_id: "managed-claude-1",
    transcript_path: "/tmp/managed-claude-1.jsonl",
    cwd: "/workspace",
    prompt_id: "prompt-1",
    permission_mode: "acceptEdits",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });

  assert.deepEqual(arbiter.accept(hook, { ownerMarker: CLAUDE_MANAGER_OWNER_VALUE }), {
    accepted: false,
    reason: "manager-owned",
  });
  assert.deepEqual(losses, []);
  assert.notEqual(adapter.getManagedSession("managed-claude-1"), null);

  assert.deepEqual(arbiter.accept(hook), {
    accepted: false,
    reason: "ownership-conflict",
  });
  assert.deepEqual(losses, ["ownership-conflict"]);
  assert.equal(adapter.getManagedSession("managed-claude-1"), null);
  assert.equal(runtime.queries[0]?.params.options.abortController.signal.aborted, true);
  assert.equal(runtime.queries[0]?.closeCalls, 1);
  await adapter.dispose();
});

test("explicit end and adapter shutdown never report an unexpected managed loss", async () => {
  const runtime = new BridgeRuntime();
  const losses: string[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionLost: (_id, reason) => { losses.push(reason); },
  });
  const created = await adapter.createSession({
    sandbox: null,
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Stop deliberately",
    profile: "ask-first",
    model: null,
    effort: null,
    idempotencyKey: "create-deliberate-end-claude",
  }, context());

  assert.equal((await adapter.performAction(created, {
    type: "end",
    expectedGeneration: created.generation,
    idempotencyKey: "deliberate-end-claude",
  }, context())).status, "succeeded");
  assert.deepEqual(losses, []);
  assert.equal(adapter.getManagedSession(created.providerThreadId)?.providerStatus, "closed");

  await adapter.dispose();
  assert.deepEqual(losses, []);
});

test("reads the draft model catalog before any manager-owned Claude thread exists", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({ runtime });
  const draftContext: RequestContext = { ...context(), workspace: null };

  const options = await adapter.getCreateSettingsOptions!(draftContext);
  assert.deepEqual(options, {
    source: "provider-api",
    models: [{ value: "sonnet", label: "Sonnet", description: "Balanced" }],
  });
  assert.equal(runtime.queries.length, 1, "the catalog read owns exactly one query");
  const probe = runtime.queries[0];
  assert.ok(probe);
  assert.equal(
    probe.params.options.persistSession,
    false,
    "a draft catalog probe must not persist a resumable Claude session",
  );
  assert.equal(probe.closed, true, "the catalog probe is closed as soon as it answers");
  assert.equal(
    adapter.getManagedSession("managed-claude-1"),
    null,
    "the catalog probe never becomes a cockpit session",
  );
  adapter.dispose();
});

test("draft catalog exposes per-model efforts and never borrows another session", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const created = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Unrelated work",
    profile: "ask-first",
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "create-before-draft-catalog",
  }, context());
  const sessionQuery = runtime.queries[0];
  assert.ok(sessionQuery);
  sessionQuery.supportedModelCatalog = [
    { value: "borrowed", displayName: "Borrowed", description: "Wrong source" },
  ];

  const draftQueryIndex = runtime.queries.length;
  const options = await adapter.getCreateSettingsOptions!(context());
  const draftQuery = runtime.queries[draftQueryIndex];
  assert.ok(draftQuery, "the draft read starts its own bounded query");
  assert.equal(sessionQuery.supportedModelsCalls, 0, "an unrelated session is never a catalog proxy");
  assert.deepEqual(options.models.map((model) => model.value), ["sonnet"]);
  assert.equal(created.provider, "claude");

  assert.equal(draftQuery.closed, true);
  // Every draft read re-probes: a cached catalog could outlive the provider
  // capability it describes.
  runtime.nextQueryHook = (query) => {
    query.supportedModelCatalog = [{
      value: "opus",
      displayName: "Opus",
      description: "Deep reasoning",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high", "max"],
    }];
  };
  assert.deepEqual(await adapter.getCreateSettingsOptions!(context()), {
    source: "provider-api",
    models: [{
      value: "opus",
      label: "Opus",
      description: "Deep reasoning",
      efforts: ["low", "high", "max"],
    }],
  });
  adapter.dispose();
});

test("a failing draft catalog read is surfaced rather than fabricated", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({ runtime });
  runtime.nextQueryHook = (query) => {
    query.supportedModelsOverride = () => Promise.reject(new Error("CLI transport closed"));
  };
  await assert.rejects(
    adapter.getCreateSettingsOptions!(context()),
    /CLI transport closed/,
  );
  assert.equal(runtime.queries[0]?.closed, true, "a failed probe still releases its query");

  runtime.nextQueryHook = null;
  const recovered = await adapter.getCreateSettingsOptions!(context());
  assert.deepEqual(recovered.models.map((model) => model.value), ["sonnet"]);
  adapter.dispose();
});

test("adapter disposal aborts a hanging draft catalog query", async () => {
  const runtime = new BridgeRuntime();
  runtime.nextQueryHook = (query) => {
    query.supportedModelsOverride = async () => await new Promise<never>(() => undefined);
  };
  const adapter = new ClaudeProviderControlAdapter({ runtime });
  const lookup = adapter.getCreateSettingsOptions!(context());
  const rejection = assert.rejects(lookup, /disposed/);
  await eventually(() => runtime.queries.length === 1);

  await adapter.dispose();
  await rejection;
  const query = runtime.queries[0];
  assert.ok(query);
  assert.equal(query.params.options.abortController.signal.aborted, true);
  assert.equal(query.closeCalls, 1);
});

test("manager-owned Claude sessions publish resolved workspace identity", async () => {
  const runtime = new BridgeRuntime();
  const identity = {
    repoRoot: "/workspace",
    repoName: "workspace",
    worktreePath: "/workspace",
    linked: false,
    branch: "main",
    detached: false,
    dirtyCount: 3,
    ahead: null,
    behind: null, insertions: null, deletions: null,
  };
  const requests: Array<readonly (string | null | undefined)[]> = [];
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
    workspaceIdentityResolver: {
      resolveMany: async (cwds) => {
        requests.push(cwds);
        return new Map(cwds.flatMap((cwd) => typeof cwd === "string" ? [[cwd, identity]] : []));
      },
    },
  });
  const created = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Start",
    profile: "ask-first",
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "claude-workspace-identity",
  }, context());
  assert.deepEqual(requests, [["/workspace"]]);
  assert.deepEqual(created.workspaceIdentity, identity);
  assert.deepEqual(changes.at(-1)?.workspaceIdentity, identity);
  adapter.dispose();
});

test("a Claude session stays publishable when git facts cannot be resolved", async () => {
  const runtime = new BridgeRuntime();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    workspaceIdentityResolver: {
      resolveMany: () => Promise.reject(new Error("git budget exhausted")),
    },
  });
  const created = await adapter.createSession({
    provider: "claude",
    workspaceId: "workspace",
    initialMessage: "Start",
    profile: "ask-first",
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "claude-workspace-identity-budget",
  }, context());
  assert.equal(created.workspaceIdentity, null);
  assert.equal(created.control.authority, "manager");
  adapter.dispose();
});

test("external Claude adoption resumes the exact identity and stays unpublished until commit", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  const changes: SessionView[] = [];
  const activity: Array<{ sessionId: string; mutation: ActivityMutation }> = [];
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const nativeHook = parseClaudeHookInput({
    session_id: external.providerThreadId,
    transcript_path: `/tmp/${external.providerThreadId}.jsonl`,
    cwd: "/workspace",
    prompt_id: "native-before-adoption",
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  assert.equal(hookSourceArbiter.accept(nativeHook, { now: 10 }).accepted, true);
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    hookSourceArbiter,
    onSessionChanged: (session) => changes.push(session),
    onActivity: (sessionId, mutation) => activity.push({ sessionId, mutation }),
  });

  const provisional = await adapter.adoptExternalSession(external, "ask-first", context());
  const resumed = runtime.queries.at(-1);
  assert.ok(resumed);
  assert.equal(resumed.params.options.resume, external.providerThreadId);
  assert.equal(resumed.params.options.cwd, "/workspace");
  assert.equal(resumed.params.options.permissionMode, "default");
  assert.equal(resumed.params.options.model, "sonnet");
  assert.equal(resumed.params.options.effort, "high");
  assert.equal(provisional.providerThreadId, external.providerThreadId);
  assert.equal(provisional.profile.value, "ask-first");
  assert.equal(provisional.model.value, "sonnet");
  assert.equal(provisional.effort.value, "high");
  resumed.emit({
    type: "system",
    subtype: "informational",
    content: "Buffered before durable commit",
    level: "info",
    uuid: "provisional-buffered-event",
    session_id: external.providerThreadId,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [], "a provisional adoption must not publish manager controls");
  assert.equal(activity.length, 0, "provisional provider events must remain buffered");
  assert.equal(adapter.getManagedSession(external.providerThreadId), null);
  assert.equal(hookSourceArbiter.lastHookAt(external.providerThreadId), 10);
  assert.equal(
    hookSourceArbiter.shouldPollTranscript(external.providerThreadId),
    false,
    "hook/transcript authority stays external until durable commit",
  );

  const committed = adapter.commitExternalAdoption(external.providerThreadId);
  assert.equal(committed.control.authority, "manager");
  assert.ok(committed.control.capabilities.includes("queue"));
  assert.ok(activity.some(({ mutation }) =>
    mutation.type === "upsert"
    && mutation.item.kind === "lifecycle"
    && mutation.item.title === "Claude session initialized"
  ));
  assert.ok(activity.some(({ mutation }) =>
    mutation.type === "upsert"
    && mutation.item.kind === "message"
    && mutation.item.text === "Buffered before durable commit"
  ));
  assert.equal(hookSourceArbiter.lastHookAt(external.providerThreadId), null);
  assert.equal(hookSourceArbiter.shouldPollTranscript(external.providerThreadId), false);
  adapter.abortExternalAdoption(external.providerThreadId);
  assert.ok(adapter.getManagedSession(external.providerThreadId));
  await adapter.dispose();
});

test("a native hook during first adoption aborts the reserved SDK writer without suppressing the hook", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  const changes: SessionView[] = [];
  const activity: Array<{ sessionId: string; mutation: ActivityMutation }> = [];
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const decisions: unknown[] = [];
  runtime.nextQueryHook = () => {
    decisions.push(hookSourceArbiter.accept(parseClaudeHookInput({
      session_id: external.providerThreadId,
      transcript_path: `/tmp/${external.providerThreadId}.jsonl`,
      cwd: "/workspace",
      prompt_id: "native-raced-adoption",
      permission_mode: "default",
      hook_event_name: "Stop",
      stop_hook_active: false,
    }), { now: 42 }));
  };
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    hookSourceArbiter,
    onSessionChanged: (session) => changes.push(session),
    onActivity: (sessionId, mutation) => activity.push({ sessionId, mutation }),
  });

  await assert.rejects(
    adapter.adoptExternalSession(external, "ask-first", context()),
    /native Claude owner appeared during web adoption/u,
  );
  assert.deepEqual(decisions, [{ accepted: true, suppressTranscriptPolling: true }]);
  assert.equal(runtime.queries.at(-1)?.closeCalls, 1);
  assert.equal(runtime.queries.at(-1)?.params.options.abortController.signal.aborted, true);
  assert.equal(adapter.getManagedSession(external.providerThreadId), null);
  assert.deepEqual(changes, []);
  assert.deepEqual(activity, []);
  assert.equal(hookSourceArbiter.lastHookAt(external.providerThreadId), 42);
  assert.equal(hookSourceArbiter.shouldPollTranscript(external.providerThreadId), false);
  assert.throws(
    () => adapter.commitExternalAdoption(external.providerThreadId),
    /Unknown managed Claude session/u,
  );
  await adapter.dispose();
});

test("rolling back first adoption preserves hook and transcript authority with no activity leak", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  const activity: Array<{ sessionId: string; mutation: ActivityMutation }> = [];
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const hook = parseClaudeHookInput({
    session_id: external.providerThreadId,
    transcript_path: `/tmp/${external.providerThreadId}.jsonl`,
    cwd: "/workspace",
    prompt_id: "native-history",
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  hookSourceArbiter.accept(hook, { now: 77 });
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    hookSourceArbiter,
    onActivity: (sessionId, mutation) => activity.push({ sessionId, mutation }),
  });

  await adapter.adoptExternalSession(external, "ask-first", context());
  await adapter.abortExternalAdoption(external.providerThreadId);
  assert.equal(runtime.queries.at(-1)?.closeCalls, 1);
  assert.deepEqual(activity, []);
  assert.equal(adapter.getManagedSession(external.providerThreadId), null);
  assert.equal(hookSourceArbiter.lastHookAt(external.providerThreadId), 77);
  assert.equal(hookSourceArbiter.shouldPollTranscript(external.providerThreadId), false);
  assert.equal(hookSourceArbiter.accept(hook, { now: 78 }).accepted, true);
  await adapter.dispose();
});

test("external adoption retains one quarantined cleanup while provider close hangs", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    hookSourceArbiter,
  });
  await adapter.adoptExternalSession(external, "ask-first", context());
  const query = runtime.queries.at(-1);
  assert.ok(query);
  query.closeEndsOutput = false;

  assert.equal(hookSourceArbiter.accept(
    nativeStopHook(external.providerThreadId, "hang-external-close"),
  ).accepted, true);
  const first = adapter.abortExternalAdoption(external.providerThreadId);
  const second = adapter.abortExternalAdoption(external.providerThreadId);
  let settled = false;
  void first.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(query.closeCalls, 1, "concurrent aborts must share one close attempt");
  assert.equal(settled, false);
  await assert.rejects(
    adapter.adoptExternalSession(external, "ask-first", context()),
    /already in progress/u,
  );
  assert.throws(
    () => adapter.commitExternalAdoption(external.providerThreadId),
    /quarantined during cleanup/u,
  );

  query.output.close();
  await Promise.all([first, second]);
  const retry = await adapter.adoptExternalSession(external, "ask-first", context());
  assert.equal(retry.providerThreadId, external.providerThreadId);
  assert.equal(runtime.queries.length, 3);
  await adapter.abortExternalAdoption(external.providerThreadId);
  await adapter.dispose();
});

test("external adoption retains identity after rejected close and retries cleanup safely", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    hookSourceArbiter,
  });
  await adapter.adoptExternalSession(external, "ask-first", context());
  const query = runtime.queries.at(-1);
  assert.ok(query);
  query.closeErrors.push(new Error("external close rejected"));

  assert.equal(hookSourceArbiter.accept(
    nativeStopHook(external.providerThreadId, "reject-external-close"),
  ).accepted, true);
  await eventually(() => query.closeCalls === 1);
  assert.equal(query.closeCalls, 1);
  await assert.rejects(
    adapter.adoptExternalSession(external, "ask-first", context()),
    /already in progress/u,
  );
  assert.throws(
    () => adapter.commitExternalAdoption(external.providerThreadId),
    /quarantined during cleanup/u,
  );

  await adapter.abortExternalAdoption(external.providerThreadId);
  assert.equal(query.closeCalls, 2);
  const retry = await adapter.adoptExternalSession(external, "ask-first", context());
  assert.equal(retry.providerThreadId, external.providerThreadId);
  await adapter.abortExternalAdoption(external.providerThreadId);
  await adapter.dispose();
});

test("dormant resume retains one quarantined cleanup while provider close hangs", async () => {
  const runtime = new BridgeRuntime();
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const adapter = new ClaudeProviderControlAdapter({ runtime, hookSourceArbiter });
  const record = stoppedRecoveryRecord();
  await adapter.restoreManagedSessions([record], new AbortController().signal);
  const dormant = adapter.getManagedSession(record.providerThreadId);
  assert.ok(dormant);
  await adapter.resumeSession(dormant, "plan", context());
  const query = runtime.queries[0];
  assert.ok(query);
  query.closeEndsOutput = false;

  assert.equal(hookSourceArbiter.accept(
    nativeStopHook(record.providerThreadId, "hang-dormant-close"),
  ).accepted, true);
  const first = adapter.abortExternalAdoption(record.providerThreadId);
  const second = adapter.abortExternalAdoption(record.providerThreadId);
  let settled = false;
  void first.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(query.closeCalls, 1);
  assert.equal(settled, false);
  await assert.rejects(
    adapter.resumeSession(dormant, "plan", context()),
    /awaiting durable commit/u,
  );
  assert.throws(
    () => adapter.commitExternalAdoption(record.providerThreadId),
    /quarantined during cleanup/u,
  );
  assert.equal(adapter.getManagedSession(record.providerThreadId)?.status, "completed");

  query.output.close();
  await Promise.all([first, second]);
  const retry = await adapter.resumeSession(dormant, "plan", context());
  assert.equal(retry.providerThreadId, record.providerThreadId);
  assert.equal(runtime.queries.length, 2);
  await adapter.abortExternalAdoption(record.providerThreadId);
  await adapter.dispose();
});

test("dormant resume retains identity after rejected close and retries cleanup safely", async () => {
  const runtime = new BridgeRuntime();
  const hookSourceArbiter = new ClaudeHookSourceArbiter();
  const adapter = new ClaudeProviderControlAdapter({ runtime, hookSourceArbiter });
  const record = stoppedRecoveryRecord();
  await adapter.restoreManagedSessions([record], new AbortController().signal);
  const dormant = adapter.getManagedSession(record.providerThreadId);
  assert.ok(dormant);
  await adapter.resumeSession(dormant, "plan", context());
  const query = runtime.queries[0];
  assert.ok(query);
  query.closeErrors.push(new Error("dormant close rejected"));

  assert.equal(hookSourceArbiter.accept(
    nativeStopHook(record.providerThreadId, "reject-dormant-close"),
  ).accepted, true);
  await eventually(() => query.closeCalls === 1);
  assert.equal(query.closeCalls, 1);
  await assert.rejects(
    adapter.resumeSession(dormant, "plan", context()),
    /awaiting durable commit/u,
  );
  assert.throws(
    () => adapter.commitExternalAdoption(record.providerThreadId),
    /quarantined during cleanup/u,
  );
  assert.equal(adapter.getManagedSession(record.providerThreadId)?.status, "completed");

  await adapter.abortExternalAdoption(record.providerThreadId);
  assert.equal(query.closeCalls, 2);
  const retry = await adapter.resumeSession(dormant, "plan", context());
  assert.equal(retry.providerThreadId, record.providerThreadId);
  await adapter.abortExternalAdoption(record.providerThreadId);
  await adapter.dispose();
});

test("external Claude adoption rejects provider identity drift without publishing controls", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  const changes: SessionView[] = [];
  runtime.nextQueryHook = (query) => {
    query.emit({
      type: "system",
      subtype: "init",
      session_id: "different-claude-session",
      claude_code_version: "2.1.222",
      model: "sonnet",
      permissionMode: "default",
      capabilities: ["interrupt_receipt_v1"],
    });
  };
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });

  await assert.rejects(
    adapter.adoptExternalSession(external, "ask-first", context()),
    /resumed unexpected session/u,
  );
  assert.deepEqual(changes, []);
  assert.equal(adapter.getManagedSession(external.providerThreadId), null);
  assert.equal(runtime.queries.at(-1)?.closed, true);
  adapter.dispose();
});

test("external Claude adoption cancellation closes the provisional query", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  runtime.autoInitialize = false;
  const changes: SessionView[] = [];
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
    onSessionChanged: (session) => changes.push(session),
  });
  const controller = new AbortController();
  const adoptionContext: RequestContext = {
    ...context(),
    signal: controller.signal,
  };

  const adoption = adapter.adoptExternalSession(external, "ask-first", adoptionContext);
  const rejection = assert.rejects(adoption, /cancel provisional adoption/);
  await eventually(() => runtime.queries.length === 2);
  controller.abort(new Error("cancel provisional adoption"));
  await rejection;

  const query = runtime.queries[1];
  assert.ok(query);
  assert.equal(query.params.options.abortController.signal.aborted, true);
  assert.equal(query.closeCalls, 1);
  assert.deepEqual(changes, []);
  assert.equal(adapter.getManagedSession(external.providerThreadId), null);
  await adapter.dispose();
});

test("adapter disposal owns adoption until provider settings finish", async () => {
  const runtime = new BridgeRuntime();
  const external = await externalClaudeView(runtime);
  runtime.initModelOverride = "provider-default";
  runtime.nextQueryHook = (query) => {
    query.setModelOverride = () => new Promise<void>((_resolve, reject) => {
      const signal = query.params.options.abortController.signal;
      const abort = (): void => reject(
        signal.reason ?? new Error("adoption query aborted"),
      );
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const adapter = new ClaudeProviderControlAdapter({
    runtime,
    resolveWorkspace: () => "/workspace",
  });
  const adoption = adapter.adoptExternalSession(external, "ask-first", context());
  const rejection = assert.rejects(adoption, /disposed/);
  await eventually(() => runtime.queries[1]?.models.includes("sonnet") === true);

  await adapter.dispose();
  await rejection;
  const query = runtime.queries[1];
  assert.ok(query);
  assert.equal(query.params.options.abortController.signal.aborted, true);
  assert.equal(query.closeCalls, 1);
  assert.equal(adapter.getManagedSession(external.providerThreadId), null);
});
