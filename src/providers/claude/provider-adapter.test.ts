import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../../core/types.ts";
import type { RequestContext } from "../../server/contracts.ts";
import { AsyncInbox } from "./async-inbox.ts";
import { ClaudeProviderControlAdapter } from "./provider-adapter.ts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeInterruptReceipt,
  type ClaudePermissionMode,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkUserMessage,
} from "./types.ts";

class BridgeQuery implements ClaudeSdkQuery, AsyncIterator<Record<string, unknown>> {
  readonly params: ClaudeSdkQueryParams;
  readonly output = new AsyncInbox<Record<string, unknown>>();
  readonly input: ClaudeSdkUserMessage[] = [];
  readonly modes: ClaudePermissionMode[] = [];

  constructor(params: ClaudeSdkQueryParams) {
    this.params = params;
    void this.#consumeInput();
  }

  emit(message: Record<string, unknown>): void {
    this.output.push(message);
  }

  interrupt(): Promise<ClaudeInterruptReceipt> {
    return Promise.resolve({ still_queued: [] });
  }

  setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.modes.push(mode);
    return Promise.resolve();
  }

  close(): void {
    this.output.close();
  }

  next(): Promise<IteratorResult<Record<string, unknown>>> {
    return this.output.next();
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
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
      claude_code_version: "2.1.220",
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
      mode: "planning",
      permissionPreset: "standard",
      idempotencyKey: "create-managed-claude",
    },
    context(),
  );
  assert.equal(created.id, "claude:managed-claude-1");
  assert.equal(created.sessionId, "managed-claude-1");
  assert.equal(created.mode.value, "planning");
  assert.equal(created.control.plane, "claude-sdk");
  assert.ok(created.control.capabilities.includes("steer"));
  assert.equal(created.effectiveAccess.fullHostAccess, false);

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
  const mode = await adapter.performAction(
    latest,
    {
      type: "set-mode",
      mode: "execution",
      expectedGeneration: latest.generation,
      idempotencyKey: "set-mode-1",
    },
    context(),
  );
  assert.deepEqual(mode, {
    status: "succeeded",
    result: { mode: "default" },
  });
  assert.deepEqual(query.modes, ["default"]);
  adapter.dispose();
});

test("keeps full-host access visible in plan mode before switching to bypass", async () => {
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
      mode: "planning",
      permissionPreset: "full-host",
      idempotencyKey: "create-full-host-claude",
    },
    context(),
  );
  assert.equal(view.mode.providerValue, "plan");
  assert.equal(view.effectiveAccess.fullHostAccess, true);
  assert.equal(
    runtime.queries[0]?.params.options.allowDangerouslySkipPermissions,
    true,
  );
  const result = await adapter.performAction(view, {
    type: "set-mode",
    mode: "execution",
    expectedGeneration: view.generation,
    idempotencyKey: "set-full-host-mode",
  }, context());
  assert.deepEqual(result, {
    status: "succeeded",
    result: { mode: "bypassPermissions" },
  });
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
      mode: "planning",
      permissionPreset: "standard",
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
    questions: [
      {
        id: "Storage",
        text: "Which database should we use?",
        options: [
          { label: "SQLite", description: "Embedded and local" },
          { label: "Postgres", description: "Separate database service" },
        ],
        multiSelect: false,
        allowFreeText: true,
      },
      {
        id: "Features",
        text: "Which features should be enabled?",
        options: [
          { label: "Audit log", description: "Keep action history" },
          { label: "Metrics", description: "Track runtime health" },
        ],
        multiSelect: true,
        allowFreeText: false,
      },
    ],
  });
  assert.deepEqual(approvalAttention?.details, {
    title: "Inspect repository status",
    toolName: "Bash",
    inputSummary: '{"command":"git status --short","timeout":1000}',
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
      mode: "planning",
      permissionPreset: "standard",
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
  await eventually(() => changes.at(-1)?.activity === "idle");
  const view = changes.at(-1);
  assert.ok(view);
  const instruction = await adapter.getAttachInstruction(view, context());
  assert.equal(instruction?.kind, "claude-resume");
  assert.deepEqual(instruction?.argv, ["claude", "--resume", "managed-claude-1"]);
  assert.equal(typeof instruction?.handoffId, "string");
  assert.ok((instruction?.handoffId?.length ?? 0) > 0);
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
      mode: "execution",
      permissionPreset: "standard",
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
  await eventually(() => changes.at(-1)?.activity === "idle");

  query.close();
  await eventually(() => changes.at(-1)?.providerStatus === "closed");
  const closed = changes.at(-1);
  assert.ok(closed);
  assert.equal(closed.runtimeAlive, false);
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
      mode: "execution",
      permissionPreset: "standard",
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
  assert.equal(failed.runtimeAlive, false);
  assert.equal(failed.control.plane, "resume-only");
  assert.deepEqual(failed.control.capabilities, ["resume", "attach"]);
  adapter.dispose();
});
