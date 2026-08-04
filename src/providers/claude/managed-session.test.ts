import assert from "node:assert/strict";
import test from "node:test";

import { AsyncInbox } from "./async-inbox.ts";
import { ClaudeManagedSession } from "./managed-session.ts";
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

class FakeQuery implements ClaudeSdkQuery, AsyncIterator<ClaudeSdkMessage> {
  readonly params: ClaudeSdkQueryParams;
  readonly output = new AsyncInbox<ClaudeSdkMessage>();
  readonly input: ClaudeSdkUserMessage[] = [];
  readonly modeChanges: ClaudePermissionMode[] = [];
  readonly modelChanges: Array<string | undefined> = [];
  readonly effortChanges: Array<ClaudeEffortLevel | null> = [];
  interruptResult: ClaudeInterruptReceipt | undefined = {
    still_queued: [],
  };
  interruptCalls = 0;
  closed = false;

  constructor(params: ClaudeSdkQueryParams) {
    this.params = params;
    void this.#readInput();
  }

  emit(message: Record<string, unknown>): void {
    this.output.push(message as unknown as ClaudeSdkMessage);
  }

  interrupt(): Promise<ClaudeInterruptReceipt | undefined> {
    this.interruptCalls += 1;
    return Promise.resolve(this.interruptResult);
  }

  setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.modeChanges.push(mode);
    return Promise.resolve();
  }

  setModel(model?: string): Promise<void> {
    this.modelChanges.push(model);
    return Promise.resolve();
  }

  applyFlagSettings(settings: { effortLevel?: ClaudeEffortLevel | null }): Promise<void> {
    if (settings.effortLevel !== undefined) this.effortChanges.push(settings.effortLevel);
    return Promise.resolve();
  }

  supportedModels(): Promise<ClaudeModelInfo[]> {
    return Promise.resolve([{
      value: "sonnet",
      displayName: "Sonnet",
      description: "Balanced",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    }]);
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

  async #readInput(): Promise<void> {
    for await (const message of this.params.prompt) this.input.push(message);
  }
}

class FakeRuntime implements ClaudeSdkRuntime {
  readonly queries: FakeQuery[] = [];
  sdkVersion = CLAUDE_AGENT_SDK_VERSION;
  codeVersion = "2.1.221";
  initMode: ClaudePermissionMode | null = null;
  #uuid = 0;
  #time = Date.parse("2026-08-03T12:00:00.000Z");

  createQuery(params: ClaudeSdkQueryParams): ClaudeSdkQuery {
    const query = new FakeQuery(params);
    this.queries.push(query);
    const sessionId = params.options.resume ?? `session-${this.queries.length}`;
    query.emit({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      claude_code_version: this.codeVersion,
      model: params.options.model ?? "default-model",
      permissionMode: this.initMode ?? params.options.permissionMode,
      capabilities: ["interrupt_receipt_v1"],
    });
    return query;
  }

  randomUUID(): string {
    this.#uuid += 1;
    return `uuid-${this.#uuid}`;
  }

  now(): Date {
    this.#time += 1;
    return new Date(this.#time);
  }
}

async function eventually(
  condition: () => boolean,
  message = "condition did not become true",
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

test("keeps a streaming query, stages removable queue work, and maps steer and mode", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "plan",
    initialMessage: "Plan the change",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  await eventually(() => query.input.length === 1);

  assert.equal(session.snapshot.sessionId, "session-1");
  assert.equal(session.snapshot.mode, "plan");
  assert.equal(session.snapshot.canSteer, true);
  assert.equal(query.params.options.includePartialMessages, true);
  assert.equal(query.params.options.includeHookEvents, true);
  assert.equal(query.params.options.forwardSubagentText, true);
  assert.equal("agentProgressSummaries" in query.params.options, false);
  assert.equal(query.input[0]?.priority, "later");
  assert.deepEqual(query.input[0]?.origin, { kind: "human" });

  const queuedId = session.send("Do this after the plan", "queue");
  const steeredId = session.send("Correct course now", "steer");
  await eventually(() => query.input.length === 2);
  assert.deepEqual(
    query.input.slice(1).map(({ priority, uuid }) => ({ priority, uuid })),
    [{ priority: "now", uuid: steeredId }],
  );
  assert.deepEqual(session.snapshot.stagedMessages.map(({ id }) => id), [queuedId]);
  assert.equal(session.removeStagedMessage(queuedId), true);
  assert.equal(session.removeStagedMessage(queuedId), false);
  assert.deepEqual(session.snapshot.stagedMessages, []);

  await session.setMode("default");
  assert.deepEqual(query.modeChanges, ["default"]);
  assert.equal(session.snapshot.mode, "default");
  await session.setModel("sonnet");
  await session.setEffort("high");
  assert.deepEqual(query.modelChanges, ["sonnet"]);
  assert.deepEqual(query.effortChanges, ["high"]);
  assert.equal(session.snapshot.model, "sonnet");
  assert.equal(session.snapshot.effort, "high");
  assert.equal((await session.supportedModels())[0]?.value, "sonnet");
  session.dispose();
});

test("end closes only the owned SDK query and discards manager-side staging", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
    initialMessage: "active turn",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  session.send("later", "queue");
  assert.equal(session.snapshot.stagedMessages.length, 1);

  session.end();
  assert.equal(query.closed, true);
  assert.equal(session.snapshot.activity, "closed");
  assert.deepEqual(session.snapshot.stagedMessages, []);
  assert.deepEqual(session.snapshot.outstandingMessageIds, []);
  assert.throws(() => session.send("must not run"), /disposed/);
});

test("replays messages emitted before the first observer can register", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  query.emit({
    type: "system",
    subtype: "informational",
    content: "Early provider event",
    level: "info",
    uuid: "early-event",
    session_id: "session-1",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const messages: ClaudeSdkMessage[] = [];
  session.onMessage((message) => messages.push(message));
  assert.ok(messages.some((message) =>
    message.type === "system"
    && message.subtype === "init"
  ));
  assert.ok(messages.some((message) =>
    message.type === "system"
    && message.subtype === "informational"
    && message.content === "Early provider event"
  ));
  session.dispose();
});

test("fails closed when SDK or Claude Code versions do not match the steer gate", async () => {
  const badSdk = new FakeRuntime();
  badSdk.sdkVersion = "0.3.219";
  await assert.rejects(
    ClaudeManagedSession.start(badSdk, {
      cwd: "/workspace",
      mode: "default",
    }),
    /Unsupported Claude Agent SDK/,
  );

  const oldClaude = new FakeRuntime();
  oldClaude.codeVersion = "2.1.219";
  const session = await ClaudeManagedSession.start(oldClaude, {
    cwd: "/workspace",
    mode: "default",
  });
  assert.equal(session.snapshot.canSteer, false);
  assert.throws(() => session.send("steer", "steer"), /unavailable/);
  session.dispose();
});

test("withdraws the input consumer when the Agent SDK stream closes", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
  });
  const query = runtime.queries[0];
  assert.ok(query);

  query.close();
  await eventually(() => session.snapshot.activity === "closed");

  assert.equal(query.closed, true);
  assert.throws(
    () => session.send("must not disappear into a dead inbox"),
    /no live Agent SDK consumer/,
  );
  await assert.rejects(session.interrupt(), /no live Agent SDK consumer/);
  await assert.rejects(
    session.setMode("plan"),
    /no live Agent SDK consumer/,
  );
  session.dispose();
});

test("withdraws the input consumer when the Agent SDK reports terminal failure", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  const pending = query.params.options.canUseTool(
    "Bash",
    { command: "pwd" },
    {
      signal: new AbortController().signal,
      requestId: "terminal-permission",
      toolUseID: "terminal-tool",
    },
  );

  query.emit({
    type: "result",
    subtype: "error_during_execution",
    errors: ["provider stream failed"],
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.activity === "failed");

  assert.equal(query.closed, true);
  assert.equal(session.snapshot.lastError, "provider stream failed");
  assert.equal(session.snapshot.pendingRequests.length, 0);
  assert.deepEqual(await pending, {
    behavior: "deny",
    message: "Claude cancelled the permission request",
    interrupt: false,
    toolUseID: "terminal-tool",
    decisionClassification: "user_reject",
  });
  assert.throws(
    () => session.send("must fail instead of queueing"),
    /no live Agent SDK consumer/,
  );
  session.dispose();
});

test("preserves interrupt still_queued receipts and marks old receipts unknown", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  const queuedId = session.send("later", "queue");
  query.interruptResult = {
    still_queued: [queuedId, "provider-internal-id"],
    cancelled: ["cancelled-id"],
  };

  assert.deepEqual(await session.interrupt(), {
    receiptSupported: true,
    stillQueuedMessageIds: [queuedId, "provider-internal-id"],
    cancelledMessageIds: ["cancelled-id"],
  });
  assert.deepEqual(session.snapshot.stillQueuedMessageIds, [
    queuedId,
    "provider-internal-id",
  ]);

  query.interruptResult = undefined;
  assert.deepEqual(await session.interrupt(), {
    receiptSupported: false,
    stillQueuedMessageIds: [],
    cancelledMessageIds: [],
  });
  assert.equal(session.snapshot.queueKnowledge, "unknown");
  session.dispose();
});

test("retains exact tool requests, answers questions, and replays duplicate responses", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "plan",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  const abort = new AbortController();
  const options = {
    signal: abort.signal,
    requestId: "request-1",
    toolUseID: "tool-1",
    title: "Choose a database",
  };
  const first = query.params.options.canUseTool(
    "AskUserQuestion",
    {
      questions: [{ question: "Database?", options: ["SQLite", "Postgres"] }],
    },
    options,
  );

  assert.equal(session.snapshot.activity, "requires_action");
  assert.equal(session.snapshot.pendingRequests[0]?.kind, "question");
  session.respondToRequest("request-1", {
    decision: "answer",
    answers: { "Database?": "SQLite" },
  });
  const answer = await first;
  assert.equal(answer.behavior, "allow");
  if (answer.behavior === "allow") {
    assert.deepEqual(answer.updatedInput.answers, { "Database?": "SQLite" });
    assert.ok("questions" in answer.updatedInput);
  }
  assert.equal(session.snapshot.pendingRequests.length, 0);

  const replay = await query.params.options.canUseTool(
    "AskUserQuestion",
    { questions: [] },
    options,
  );
  assert.deepEqual(replay, answer);
  assert.equal(session.snapshot.pendingRequests.length, 0);

  const planApproval = query.params.options.canUseTool(
    "ExitPlanMode",
    { plan: "Ship it" },
    {
      signal: new AbortController().signal,
      requestId: "request-2",
      toolUseID: "tool-2",
    },
  );
  assert.equal(session.snapshot.pendingRequests[0]?.kind, "plan-approval");
  session.respondToRequest("request-2", { decision: "allow" });
  assert.deepEqual(await planApproval, {
    behavior: "allow",
    updatedInput: { plan: "Ship it" },
    toolUseID: "tool-2",
    decisionClassification: "user_temporary",
  });

  const suggestions = [{
    type: "addRules" as const,
    rules: [{ toolName: "Write", ruleContent: "/workspace/**" }],
    behavior: "allow" as const,
    destination: "session" as const,
  }];
  const persistent = query.params.options.canUseTool(
    "Write",
    { file_path: "/workspace/output.txt", content: "done" },
    {
      signal: new AbortController().signal,
      requestId: "request-3",
      toolUseID: "tool-3",
      suggestions,
    },
  );
  session.respondToRequest("request-3", { decision: "allow", persist: true });
  assert.deepEqual(await persistent, {
    behavior: "allow",
    updatedInput: { file_path: "/workspace/output.txt", content: "done" },
    updatedPermissions: suggestions,
    toolUseID: "tool-3",
    decisionClassification: "user_permanent",
  });

  const temporaryOnly = query.params.options.canUseTool(
    "Bash",
    { command: "pwd" },
    {
      signal: new AbortController().signal,
      requestId: "request-4",
      toolUseID: "tool-4",
    },
  );
  assert.throws(
    () => session.respondToRequest("request-4", { decision: "allow", persist: true }),
    /did not expose a persistent permission choice/,
  );
  session.respondToRequest("request-4", { decision: "allow" });
  await temporaryOnly;
  session.dispose();
});

test("retains elicitation requests and cancels them on abort", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  const firstAbort = new AbortController();
  const elicitation = query.params.options.onElicitation(
    {
      serverName: "calendar",
      message: "Pick an account",
      mode: "form",
      elicitationId: "elicit-1",
      requestedSchema: { type: "object" },
    },
    { signal: firstAbort.signal },
  );
  assert.equal(
    session.snapshot.pendingRequests[0]?.id,
    "elicitation:elicit-1",
  );
  session.respondToRequest("elicitation:elicit-1", {
    decision: "accept",
    content: { account: "personal" },
  });
  assert.deepEqual(await elicitation, {
    action: "accept",
    content: { account: "personal" },
  });

  const secondAbort = new AbortController();
  const cancelled = query.params.options.onElicitation(
    {
      serverName: "calendar",
      message: "Authenticate",
      mode: "url",
      elicitationId: "elicit-2",
      url: "https://example.test/auth",
    },
    { signal: secondAbort.signal },
  );
  secondAbort.abort();
  assert.deepEqual(await cancelled, { action: "cancel" });
  assert.equal(session.snapshot.pendingRequests.length, 0);
  session.dispose();
});

test("hands off only an idle, drained session and reclaims after wrapper exit", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
  });
  const firstQuery = runtime.queries[0];
  assert.ok(firstQuery);
  firstQuery.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.activity === "idle");

  const handoff = session.prepareCliHandoff();
  assert.deepEqual(handoff.command, {
    executable: "claude",
    args: ["--resume", "session-1"],
    cwd: "/workspace",
  });
  assert.equal(firstQuery.closed, true);
  assert.equal(session.snapshot.owner, "native");
  assert.throws(() => session.send("unsafe"), /native CLI/);

  session.markCliAttached(handoff.id, 4242);
  await assert.rejects(session.reclaimFromCli(handoff.id), /expected exited/);
  session.markCliExited(handoff.id, 0);
  await session.reclaimFromCli(handoff.id);

  assert.equal(runtime.queries.length, 2);
  assert.equal(runtime.queries[1]?.params.options.resume, "session-1");
  assert.equal(session.snapshot.owner, "manager");
  assert.equal(session.snapshot.sessionId, "session-1");
  assert.equal(session.snapshot.handoff, null);
  session.dispose();
});

test("settles idle from a terminal result only after all tracked work drains", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  query.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.activity === "idle");
  const firstId = session.send("first", "queue");
  const secondId = session.send("second", "queue");
  query.emit({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.activity === "running");
  assert.throws(() => session.prepareCliHandoff(), /idle session/);

  query.emit({
    type: "result",
    subtype: "success",
    user_message_uuid: firstId,
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.outstandingMessageIds.length === 1);
  assert.equal(session.snapshot.activity, "running");
  assert.throws(() => session.prepareCliHandoff(), /idle session/);

  // The installed streaming SDK does not consistently emit a later idle
  // state. The terminal result is therefore the safe fallback once the final
  // tracked message completes.
  query.emit({
    type: "result",
    subtype: "success",
    user_message_uuid: secondId,
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.activity === "idle");
  assert.doesNotThrow(() => session.prepareCliHandoff());
  session.dispose();
});

test("correlates an id-less terminal result when exactly one message is outstanding", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
    initialMessage: "single turn",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  await eventually(() => query.input.length === 1);

  query.emit({
    type: "result",
    subtype: "success",
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.activity === "idle");
  assert.deepEqual(session.snapshot.outstandingMessageIds, []);
  session.dispose();
});

test("keeps a completed turn running until Claude background work drains", async () => {
  const runtime = new FakeRuntime();
  const session = await ClaudeManagedSession.start(runtime, {
    cwd: "/workspace",
    mode: "default",
    initialMessage: "start background work",
  });
  const query = runtime.queries[0];
  assert.ok(query);
  await eventually(() => query.input.length === 1);

  query.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: "task-1", task_type: "agent", description: "Working" }],
    session_id: "session-1",
  });
  query.emit({
    type: "result",
    subtype: "success",
    user_message_uuid: query.input[0]?.uuid,
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.outstandingMessageIds.length === 0);
  assert.equal(session.snapshot.activity, "running");

  query.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [],
    session_id: "session-1",
  });
  await eventually(() => session.snapshot.activity === "idle");
  session.dispose();
});
