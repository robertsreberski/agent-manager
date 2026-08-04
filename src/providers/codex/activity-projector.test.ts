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
} from "./activity-projector.ts";
import type { JsonRpcNotification, JsonRpcServerRequest } from "./rpc.ts";
import type { JsonObject } from "./types.ts";

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

test("reasoning summary/raw streams and prose/structured plans use distinct stable IDs", () => {
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

  const prose = onlyItem(projectCodexNotification(notification("item/completed", {
    threadId: "t",
    turnId: "turn",
    completedAtMs: 1_787_500_000_000,
    item: { type: "plan", id: "plan-item", text: "Prose plan" },
  })));
  assert.equal(prose.kind, "plan");
  if (prose.kind === "plan") assert.equal(prose.text, "Prose plan");

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
  assert.equal(structured.kind, "plan");
  assert.equal(structured.state, "running");
  if (structured.kind === "plan") {
    assert.equal(structured.text, "Why this order");
    assert.deepEqual(structured.steps?.map((step) => step.status), [
      "completed",
      "in_progress",
      "pending",
    ]);
    assert.equal(structured.steps?.[0]?.id, "codex/plan-step/t/turn/0");
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
    assert.equal(files.changes?.[1]?.path, "src/old.ts → src/moved.ts");
  }

  const aggregate = onlyItem(projectCodexNotification(notification("turn/diff/updated", {
    threadId: "t",
    turnId: "turn",
    diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  })));
  assert.equal(aggregate.kind, "file-change");
  if (aggregate.kind === "file-change") {
    assert.equal(aggregate.changes?.[0]?.path, "a.ts");
    assert.equal(aggregate.changes?.[0]?.operation, "update");
  }
});

test("provider tools map to explicit categories and subagent activity stays separate", () => {
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
      type: "collabAgentToolCall",
      id: "collab",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "t",
      receiverThreadIds: ["child"],
      prompt: "inspect",
      agentsStates: {},
    }, "tool", "collaboration"],
    [{
      type: "webSearch",
      id: "web",
      query: "query",
      action: { type: "search", query: "query" },
      results: [],
    }, "tool", "web-search"],
    [{ type: "imageView", id: "image", path: "/tmp/image.png" }, "tool", "image-view"],
    [{
      type: "subAgentActivity",
      id: "subagent-event",
      kind: "started",
      agentThreadId: "child",
      agentPath: "reviewer",
    }, "subagent", null],
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
    if (projected.kind === "subagent") assert.equal(projected.taskId, "child");
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
        },
        { label: "Undersea hotel", description: "Ocean life outside every window." },
        { label: "Cloud city", description: "Endless sunsets and dramatic scenery." },
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
