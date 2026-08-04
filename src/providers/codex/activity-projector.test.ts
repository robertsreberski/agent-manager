import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityItemDraft, ActivityMutation } from "../../activity/index.ts";
import {
  codexActivityOffset,
  projectCodexNotification,
  projectCodexQueue,
  projectCodexRequestResolved,
  projectCodexServerRequest,
  recordCodexActivityOffsets,
  recordCodexTodoProjectionState,
  type CodexTodoProjectionState,
} from "./activity-projector.ts";
import type { JsonRpcNotification, JsonRpcServerRequest } from "./rpc.ts";
import type { JsonObject, JsonValue } from "./types.ts";

function notification(
  method: string,
  params: JsonObject,
  emittedAtMs = 1_787_500_000_000,
): JsonRpcNotification {
  return { method, params, emittedAtMs };
}

function upsertItem(mutation: ActivityMutation): ActivityItemDraft {
  assert.equal(mutation.type, "upsert");
  return mutation.item;
}

function onlyItem(projection: ReturnType<typeof projectCodexNotification>): ActivityItemDraft {
  assert.ok(projection);
  assert.equal(projection.mutations.length, 1);
  return upsertItem(projection.mutations[0] as ActivityMutation);
}

test("assistant deltas use UTF-8 offsets and completed snapshots remain authoritative", () => {
  const started = projectCodexNotification(notification("item/started", {
    threadId: "thread/one",
    turnId: "turn-1",
    startedAtMs: 1_787_499_999_000,
    item: { type: "agentMessage", id: "message-1", text: "", phase: "commentary" },
  }));
  assert.ok(started);
  const startedItem = upsertItem(started.mutations[0] as ActivityMutation);
  assert.equal(startedItem.kind, "message");
  assert.equal(startedItem.id, "codex/item/thread%2Fone/turn-1/message-1");
  assert.equal(startedItem.state, "running");
  assert.equal(startedItem.source, "provider-api");
  assert.equal(startedItem.exposure, "provider-exposed");
  assert.equal(startedItem.startedAt, "2026-08-23T15:46:39.000Z");

  const offsets = new Map<string, number>();
  recordCodexActivityOffsets(offsets, started.mutations[0] as ActivityMutation);
  const first = projectCodexNotification(notification("item/agentMessage/delta", {
    threadId: "thread/one",
    turnId: "turn-1",
    itemId: "message-1",
    delta: "hé",
  }), (id, channel) => codexActivityOffset(offsets, id, channel));
  assert.ok(first);
  assert.deepEqual(first.mutations[0], {
    type: "append",
    id: startedItem.id,
    channel: "text",
    offset: 0,
    text: "hé",
  });
  recordCodexActivityOffsets(offsets, first.mutations[0] as ActivityMutation);
  const second = projectCodexNotification(notification("item/agentMessage/delta", {
    threadId: "thread/one",
    turnId: "turn-1",
    itemId: "message-1",
    delta: "!",
  }), (id, channel) => codexActivityOffset(offsets, id, channel));
  assert.ok(second);
  assert.equal(second.mutations[0]?.type, "append");
  if (second.mutations[0]?.type === "append") assert.equal(second.mutations[0].offset, 3);

  const completed = onlyItem(projectCodexNotification(notification("item/completed", {
    threadId: "thread/one",
    turnId: "turn-1",
    completedAtMs: 1_787_500_000_000,
    item: {
      type: "agentMessage",
      id: "message-1",
      text: "hé! canonical",
      phase: "final_answer",
    },
  })));
  assert.equal(completed.id, startedItem.id);
  assert.equal(completed.state, "complete");
  assert.equal(completed.updatedAt, "2026-08-23T15:46:40.000Z");
  assert.equal(completed.completedAt, "2026-08-23T15:46:40.000Z");
  if (completed.kind === "message") {
    assert.equal(completed.phase, "final");
    assert.equal(completed.text, "hé! canonical");
  }
});

test("reasoning streams stay distinct and only structured Codex plans become todos", () => {
  const part = onlyItem(projectCodexNotification(notification(
    "item/reasoning/summaryPartAdded",
    { threadId: "t", turnId: "turn", itemId: "reason", summaryIndex: 1 },
  )));
  assert.equal(part.kind, "reasoning");
  assert.match(part.id, /summary-1$/u);

  const raw = projectCodexNotification(notification("item/reasoning/textDelta", {
    threadId: "t",
    turnId: "turn",
    itemId: "reason",
    contentIndex: 2,
    delta: "provider-visible thought",
  }));
  assert.ok(raw);
  assert.equal(raw.mutations[0]?.type, "append");
  if (raw.mutations[0]?.type === "append") {
    assert.match(raw.mutations[0].id, /raw-2$/u);
    assert.equal(raw.mutations[0].channel, "text");
  }

  const completed = projectCodexNotification(notification("item/completed", {
    threadId: "t",
    turnId: "turn",
    completedAtMs: 1_787_500_000_000,
    item: {
      type: "reasoning",
      id: "reason",
      summary: ["summary zero", "summary one"],
      content: ["raw zero"],
    },
  }));
  assert.ok(completed);
  assert.deepEqual(
    completed.mutations.map((mutation) => upsertItem(mutation).kind),
    ["reasoning", "reasoning", "reasoning"],
  );

  const prose = projectCodexNotification(notification("item/completed", {
    threadId: "t",
    turnId: "turn",
    completedAtMs: 1_787_500_000_000,
    item: { type: "plan", id: "plan-item", text: "Prose plan" },
  }));
  const proseDelta = projectCodexNotification(notification("item/plan/delta", {
    threadId: "t",
    turnId: "turn",
    itemId: "plan-item",
    delta: "Draft prose",
  }));
  assert.equal(prose, null);
  assert.equal(proseDelta, null);

  const structured = onlyItem(projectCodexNotification(notification("turn/plan/updated", {
    threadId: "t",
    turnId: "turn",
    explanation: "Why this order",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "inProgress" },
      { step: "Verify", status: "pending" },
    ],
  })));
  assert.equal(structured.kind, "todo");
  assert.equal(structured.state, "running");
  if (structured.kind === "todo") {
    assert.deepEqual(structured.steps?.map((step) => step.status), [
      "completed",
      "in_progress",
      "pending",
    ]);
    assert.ok(structured.steps?.every((step) => step.detail === null));
    assert.ok(structured.steps?.every((step) => !step.addedAfterStart && step.removedReason === null));
    assert.match(structured.steps?.[0]?.id ?? "", /^codex\/todo-step\/t\/turn\//u);
    assert.equal(structured.added, 0);
    assert.equal(structured.removed, 0);
  }
});

test("structured Codex todo rewrites retain stable steps and count churn", () => {
  const states = new Map<string, CodexTodoProjectionState>();
  const first = projectCodexNotification(notification("turn/plan/updated", {
    threadId: "t",
    turnId: "turn",
    plan: [
      { step: "Inspect", status: "inProgress" },
      { step: "Verify", status: "pending" },
    ],
  }), undefined, (id) => states.get(id) ?? null);
  assert.ok(first);
  recordCodexTodoProjectionState(states, first.mutations[0] as ActivityMutation);

  const second = onlyItem(projectCodexNotification(notification("turn/plan/updated", {
    threadId: "t",
    turnId: "turn",
    plan: [
      { step: "Verify", status: "inProgress" },
      { step: "Ship", status: "pending" },
    ],
  }), undefined, (id) => states.get(id) ?? null));
  assert.equal(second.kind, "todo");
  if (second.kind === "todo") {
    assert.equal(second.added, 1);
    assert.equal(second.removed, 1);
    assert.equal(second.steps?.[0]?.id, first.mutations[0]?.type === "upsert" &&
        first.mutations[0].item.kind === "todo"
      ? first.mutations[0].item.steps?.[1]?.id
      : null);
    assert.deepEqual(second.steps?.map((step) => ({
      text: step.text,
      status: step.status,
      addedAfterStart: step.addedAfterStart,
      removedReason: step.removedReason,
    })), [
      { text: "Verify", status: "in_progress", addedAfterStart: false, removedReason: null },
      { text: "Ship", status: "pending", addedAfterStart: true, removedReason: null },
      { text: "Inspect", status: "removed", addedAfterStart: false, removedReason: null },
    ]);
  }
});

test("commands and file changes expose lifecycle snapshots, output, and normalized diffs", () => {
  const command = onlyItem(projectCodexNotification(notification("item/started", {
    threadId: "t",
    turnId: "turn",
    startedAtMs: 1_787_499_999_000,
    item: {
      type: "commandExecution",
      id: "cmd",
      command: "pnpm test",
      cwd: "/workspace",
      source: "unifiedExec",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
    },
  })));
  assert.equal(command.kind, "tool");
  if (command.kind === "tool") {
    assert.equal(command.category, "command");
    assert.match(String(command.arguments), /pnpm test/u);
  }
  const output = projectCodexNotification(notification("item/commandExecution/outputDelta", {
    threadId: "t",
    turnId: "turn",
    itemId: "cmd",
    delta: "ok\n",
  }));
  assert.equal(output?.mutations[0]?.type, "append");
  if (output?.mutations[0]?.type === "append") {
    assert.equal(output.mutations[0].channel, "output");
  }

  const files = onlyItem(projectCodexNotification(notification("item/fileChange/patchUpdated", {
    threadId: "t",
    turnId: "turn",
    itemId: "patch",
    changes: [
      { path: "src/new.ts", kind: { type: "add" }, diff: "+new" },
      {
        path: "src/old.ts",
        kind: { type: "update", move_path: "src/moved.ts" },
        diff: "rename",
      },
    ],
  })));
  assert.equal(files.kind, "file-change");
  if (files.kind === "file-change") {
    assert.deepEqual(files.changes?.map((change) => change.operation), ["add", "rename"]);
    assert.deepEqual(files.changes?.[0], {
      path: "src/new.ts",
      previousPath: null,
      operation: "add",
      diff: "+new",
    });
    assert.deepEqual(files.changes?.[1], {
      path: "src/moved.ts",
      previousPath: "src/old.ts",
      operation: "rename",
      diff: "rename",
    });
  }

  const aggregate = onlyItem(projectCodexNotification(notification("turn/diff/updated", {
    threadId: "t",
    turnId: "turn",
    diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  })));
  assert.equal(aggregate.kind, "file-change");
  if (aggregate.kind === "file-change") {
    assert.equal(aggregate.changes?.[0]?.path, "a.ts");
    assert.equal(aggregate.changes?.[0]?.previousPath, null);
    assert.equal(aggregate.changes?.[0]?.operation, "update");
  }

  const aggregateRename = onlyItem(projectCodexNotification(notification("turn/diff/updated", {
    threadId: "t",
    turnId: "rename-turn",
    diff: "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
  })));
  assert.equal(aggregateRename.kind, "file-change");
  if (aggregateRename.kind === "file-change") {
    assert.deepEqual(aggregateRename.changes?.[0], {
      path: "new.ts",
      previousPath: "old.ts",
      operation: "rename",
      diff: "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
    });
  }
});

test("provider tools map to explicit categories", () => {
  const cases: Array<[JsonObject, ActivityItemDraft["kind"], string | null]> = [
    [{
      type: "mcpToolCall",
      id: "mcp",
      server: "github",
      tool: "search",
      status: "completed",
      arguments: { q: "repo" },
      result: { content: [] },
      error: null,
    }, "tool", "mcp"],
    [{
      type: "dynamicToolCall",
      id: "dynamic",
      namespace: "plugin",
      tool: "act",
      status: "completed",
      arguments: {},
      contentItems: [],
    }, "tool", "dynamic"],
    [{
      type: "webSearch",
      id: "web",
      query: "query",
      action: { type: "search", query: "query" },
      results: [],
    }, "tool", "web-search"],
    [{ type: "imageView", id: "image", path: "/tmp/image.png" }, "tool", "image-view"],
  ];
  for (const [item, kind, category] of cases) {
    const projected = onlyItem(projectCodexNotification(notification("item/completed", {
      threadId: "t",
      turnId: "turn",
      completedAtMs: 1_787_500_000_000,
      item,
    })));
    assert.equal(projected.kind, kind);
    if (projected.kind === "tool") assert.equal(projected.category, category);
  }
});

test("spawn and subagent activity share one child-thread hierarchy item", () => {
  const spawned = projectCodexNotification(notification("item/completed", {
    threadId: "t",
    turnId: "turn",
    completedAtMs: 1_787_500_000_000,
    item: {
      type: "collabAgentToolCall",
      id: "collab",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "t",
      receiverThreadIds: ["child/thread"],
      prompt: "inspect",
      agentsStates: { "child/thread": { status: "completed", message: "Inspection complete" } },
    },
  }));
  assert.ok(spawned);
  assert.equal(spawned.mutations.length, 2);
  const tool = upsertItem(spawned.mutations[0] as ActivityMutation);
  const child = upsertItem(spawned.mutations[1] as ActivityMutation);
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") assert.equal(tool.category, "collaboration");
  assert.equal(child.kind, "subagent");
  assert.equal(child.id, "codex/subagent/child%2Fthread");
  assert.equal(child.parentId, tool.id);
  assert.equal(child.state, "complete");
  if (child.kind === "subagent") {
    assert.equal(child.taskId, "child/thread");
    assert.equal(child.output, "Inspection complete");
  }

  const activity = onlyItem(projectCodexNotification(notification("item/completed", {
    threadId: "t",
    turnId: "later-turn",
    completedAtMs: 1_787_500_000_000,
    item: {
      type: "subAgentActivity",
      id: "subagent-event",
      kind: "started",
      agentThreadId: "child/thread",
      agentPath: "reviewer",
    },
  })));
  assert.equal(activity.kind, "subagent");
  assert.equal(activity.id, child.id);
  assert.equal(activity.parentId, undefined);
  if (activity.kind === "subagent") assert.equal(activity.taskId, "child/thread");
});

test("spawn projects exact child states and defaults absent state to pending", () => {
  const cases: Array<[JsonValue | undefined, ActivityItemDraft["state"]]> = [
    [undefined, "pending"],
    ["pendingInit", "pending"],
    ["running", "running"],
    ["interrupted", "interrupted"],
    ["completed", "complete"],
    ["shutdown", "complete"],
    ["errored", "failed"],
    ["notFound", "failed"],
  ];
  for (const [providerState, expected] of cases) {
    const projection = projectCodexNotification(notification("item/completed", {
      threadId: "t",
      turnId: "turn",
      item: {
        type: "collabAgentToolCall",
        id: `spawn-${String(providerState)}`,
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "t",
        receiverThreadIds: ["child"],
        prompt: "inspect",
        agentsStates: providerState === undefined
          ? {}
          : { child: { status: providerState, message: "exact child message" } },
      },
    }));
    assert.ok(projection);
    const child = upsertItem(projection.mutations[1] as ActivityMutation);
    assert.equal(child.state, expected);
    if (child.kind === "subagent") {
      assert.equal(child.output, providerState === undefined ? "" : "exact child message");
    }
  }
});

test("non-spawn collaboration tools do not create subagent hierarchy edges", () => {
  for (const tool of ["sendInput", "wait", "resumeAgent", "closeAgent"]) {
    const projection = projectCodexNotification(notification("item/completed", {
      threadId: "t",
      turnId: "turn",
      completedAtMs: 1_787_500_000_000,
      item: {
        type: "collabAgentToolCall",
        id: `collab-${tool}`,
        tool,
        status: "completed",
        senderThreadId: "t",
        receiverThreadIds: ["child/thread"],
        prompt: null,
        agentsStates: {},
      },
    }));
    assert.ok(projection);
    assert.equal(projection.mutations.length, 1);
    const projected = upsertItem(projection.mutations[0] as ActivityMutation);
    assert.equal(projected.kind, "tool");
    assert.equal(projected.parentId, null);
  }
});

test("turn lifecycle, warning, compaction, errors, and usage publish replaceable items", () => {
  const started = onlyItem(projectCodexNotification(notification("turn/started", {
    threadId: "t",
    turn: {
      id: "turn",
      status: "inProgress",
      items: [],
      startedAt: 1_787_499_999,
      completedAt: null,
      error: null,
    },
  })));
  assert.equal(started.kind, "lifecycle");
  if (started.kind === "lifecycle") assert.equal(started.event, "turn-started");

  const failed = onlyItem(projectCodexNotification(notification("error", {
    threadId: "t",
    turnId: "turn",
    willRetry: false,
    error: { message: "boom", codexErrorInfo: null, additionalDetails: "detail" },
  })));
  assert.equal(failed.id, started.id);
  assert.equal(failed.state, "failed");
  if (failed.kind === "lifecycle") assert.equal(failed.event, "error");

  const warning = onlyItem(projectCodexNotification(notification("guardianWarning", {
    threadId: "t",
    message: "Review this command",
  })));
  assert.equal(warning.kind, "lifecycle");
  if (warning.kind === "lifecycle") assert.equal(warning.level, "warning");

  const compaction = onlyItem(projectCodexNotification(notification("thread/compacted", {
    threadId: "t",
    turnId: "turn",
  })));
  assert.equal(compaction.kind, "lifecycle");
  if (compaction.kind === "lifecycle") assert.equal(compaction.event, "context-compaction");

  const usageOne = projectCodexNotification(notification("thread/tokenUsage/updated", {
    threadId: "t",
    turnId: "turn",
    tokenUsage: {
      last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 3, totalTokens: 15 },
      total: { inputTokens: 20, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 4, totalTokens: 28 },
    },
  }));
  const usageTwo = projectCodexNotification(notification("thread/tokenUsage/updated", {
    threadId: "t",
    turnId: "turn",
    tokenUsage: {
      last: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 6, reasoningOutputTokens: 3, totalTokens: 17 },
      total: { inputTokens: 21, cachedInputTokens: 4, outputTokens: 9, reasoningOutputTokens: 4, totalTokens: 30 },
    },
  }));
  assert.ok(usageOne && usageTwo);
  assert.deepEqual(
    usageOne.mutations.map((mutation) => upsertItem(mutation).id),
    usageTwo.mutations.map((mutation) => upsertItem(mutation).id),
  );
  const turnUsage = upsertItem(usageTwo.mutations[0] as ActivityMutation);
  assert.equal(turnUsage.kind, "usage");
  if (turnUsage.kind === "usage") assert.equal(turnUsage.inputTokens, 11);
});

test("attention preserves provider IDs, marks secrets, resolves, and queue upserts replace", () => {
  const request: JsonRpcServerRequest = {
    id: "ask-1",
    method: "item/tool/requestUserInput",
    emittedAtMs: 1_787_500_000_000,
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "question-item",
      questions: [{
        id: "token",
        header: "Credential",
        question: "Enter the token",
        isOther: true,
        isSecret: true,
        multiSelect: true,
        options: null,
      }],
    },
  };
  const pending = projectCodexServerRequest(request);
  assert.ok(pending);
  const attention = upsertItem(pending.mutations[0] as ActivityMutation);
  assert.equal(attention.kind, "attention");
  if (attention.kind === "attention") {
    assert.equal(attention.requestId, "s:ask-1");
    assert.equal(attention.respondable, true);
    assert.equal(attention.isSecret, true);
    assert.equal(attention.questions?.[0]?.isSecret, true);
    assert.equal(attention.questions?.[0]?.multiSelect, false);
  }

  const resolved = projectCodexRequestResolved("t", "ask-1", 1_787_500_001_000, {
    id: "ask-1",
    method: request.method,
    kind: "user-input",
    threadId: "t",
    turnId: "turn",
    params: request.params,
    respondable: true,
    receivedAt: "2026-08-23T03:20:00.000Z",
  });
  const resolvedAttention = upsertItem(resolved.mutations[0] as ActivityMutation);
  assert.equal(resolvedAttention.kind, "attention");
  assert.equal(resolvedAttention.state, "complete");
  if (resolvedAttention.kind === "attention") {
    assert.equal(resolvedAttention.resolved, true);
    assert.equal(resolvedAttention.isSecret, true);
    assert.equal(resolvedAttention.respondable, false);
  }

  const queueOne = projectCodexQueue("t", [{
    id: "queued",
    text: "next",
    status: "queued",
    enqueuedAt: "2026-08-23T03:20:00.000Z",
    turnId: null,
  }], "2026-08-23T03:20:00.000Z");
  const queueTwo = projectCodexQueue("t", [], "2026-08-23T03:20:01.000Z");
  const firstQueue = upsertItem(queueOne.mutations[0] as ActivityMutation);
  const secondQueue = upsertItem(queueTwo.mutations[0] as ActivityMutation);
  assert.equal(firstQueue.id, secondQueue.id);
  assert.equal(firstQueue.state, "waiting");
  assert.equal(secondQueue.state, "complete");
});

test("approval projections preserve only exact Codex request facts", () => {
  const command = projectCodexServerRequest({
    id: "command-approval",
    method: "item/commandExecution/requestApproval",
    emittedAtMs: 1_787_500_000_000,
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "command-item",
      startedAtMs: 1_787_500_000_000,
      command: "cat README.md",
      cwd: "/work/app",
      commandActions: [{ type: "read", command: "cat README.md", name: "README.md", path: "README.md" }],
      networkApprovalContext: { host: "example.com", protocol: "https" },
      proposedNetworkPolicyAmendments: [{ action: "allow", host: "example.com" }],
      deleteCount: 7,
    },
  });
  assert.ok(command);
  const commandItem = upsertItem(command.mutations[0] as ActivityMutation);
  assert.equal(commandItem.kind, "attention");
  if (commandItem.kind === "attention") {
    assert.deepEqual(commandItem.approvalFacts, {
      command: "cat README.md",
      paths: ["/work/app/README.md"],
      writes: [],
      network: true,
      canPersist: true,
      deleteCount: null,
    });
  }

  const ambiguous = projectCodexServerRequest({
    id: "ambiguous-command",
    method: "item/commandExecution/requestApproval",
    emittedAtMs: 1_787_500_000_000,
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "ambiguous-item",
      startedAtMs: 1_787_500_000_000,
      command: "pnpm test",
      cwd: "/work/app",
      commandActions: [{ type: "unknown", command: "pnpm test" }],
    },
  });
  assert.ok(ambiguous);
  const ambiguousItem = upsertItem(ambiguous.mutations[0] as ActivityMutation);
  assert.equal(ambiguousItem.kind, "attention");
  if (ambiguousItem.kind === "attention") {
    assert.equal(ambiguousItem.approvalFacts?.paths, null);
    assert.deepEqual(ambiguousItem.approvalFacts?.writes, []);
    assert.equal(ambiguousItem.approvalFacts?.network, null);
    assert.equal(ambiguousItem.approvalFacts?.deleteCount, null);
  }

  const lookalikeNetwork = projectCodexServerRequest({
    id: "lookalike-network",
    method: "item/commandExecution/requestApproval",
    emittedAtMs: 1_787_500_000_000,
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "lookalike-item",
      startedAtMs: 1_787_500_000_000,
      networkApprovalContext: {},
      proposedNetworkPolicyAmendments: [{}],
    },
  });
  assert.ok(lookalikeNetwork);
  const lookalikeItem = upsertItem(lookalikeNetwork.mutations[0] as ActivityMutation);
  assert.equal(
    lookalikeItem.kind === "attention" ? lookalikeItem.approvalFacts?.network : true,
    null,
  );

  const permissions = projectCodexServerRequest({
    id: "permission-approval",
    method: "item/permissions/requestApproval",
    emittedAtMs: 1_787_500_000_000,
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "permission-item",
      startedAtMs: 1_787_500_000_000,
      cwd: "/work/app",
      permissions: {
        fileSystem: {
          entries: [{ access: "write", path: { type: "glob_pattern", pattern: "../cache/**" } }],
        },
        network: { enabled: false },
      },
    },
  });
  assert.ok(permissions);
  const permissionItem = upsertItem(permissions.mutations[0] as ActivityMutation);
  assert.equal(permissionItem.kind, "attention");
  if (permissionItem.kind === "attention") {
    assert.deepEqual(permissionItem.approvalFacts, {
      command: null,
      paths: null,
      writes: ["../cache/**"],
      network: false,
      canPersist: false,
      deleteCount: null,
    });
  }
});

test("Random pick projects one structured question without repeating its prompt", () => {
  const projection = projectCodexServerRequest({
    id: "random-pick",
    method: "item/tool/requestUserInput",
    emittedAtMs: 1_785_827_058_242,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-random-pick",
      questions: [{
        id: "random_destination",
        header: "Random pick",
        question: "Which imaginary weekend destination would you choose?",
        isOther: true,
        isSecret: false,
        options: [
          {
            label: "Moon cabin (Recommended)",
            description: "Quiet views, low gravity, and maximum novelty.",
            recommended: true,
          },
          { label: "Undersea hotel", description: "Ocean life outside every window." },
          { label: "Cloud city", description: "Endless sunsets and dramatic scenery." },
        ],
      }],
    },
  });
  assert.ok(projection);
  const attention = upsertItem(projection.mutations[0] as ActivityMutation);
  assert.equal(attention.kind, "attention");
  if (attention.kind === "attention") {
    assert.equal(attention.title, "Codex needs your answer");
    assert.equal(attention.summary, null);
    assert.deepEqual(attention.questions, [{
      id: "random_destination",
      header: "Random pick",
      text: "Which imaginary weekend destination would you choose?",
      options: [
        {
          label: "Moon cabin (Recommended)",
          description: "Quiet views, low gravity, and maximum novelty.",
          recommended: true,
        },
        { label: "Undersea hotel", description: "Ocean life outside every window.", recommended: null },
        { label: "Cloud city", description: "Endless sunsets and dramatic scenery.", recommended: null },
      ],
      multiSelect: false,
      allowFreeText: true,
      isSecret: false,
    }]);
  }
});

test("terminal stdin, raw envelopes, and connection-scoped output never project", () => {
  for (const method of [
    "item/commandExecution/terminalInteraction",
    "rawResponseItem/completed",
    "rawResponse/completed",
    "command/exec/outputDelta",
    "process/outputDelta",
    "process/exited",
  ]) {
    assert.equal(projectCodexNotification(notification(method, {
      threadId: "t",
      turnId: "turn",
      itemId: "item",
      delta: "secret stdin or raw envelope",
    })), null);
  }
});
