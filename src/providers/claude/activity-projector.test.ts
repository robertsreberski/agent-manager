import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityMutation } from "../../activity/index.ts";
import { ActivityHub } from "../../activity/hub.ts";
import { ClaudeActivityProjector } from "./activity-projector.ts";
import type {
  ClaudeManagedSessionSnapshot,
  ClaudeSdkMessage,
} from "./types.ts";

function sdk(value: Record<string, unknown>): ClaudeSdkMessage {
  return value as unknown as ClaudeSdkMessage;
}

function upserts(mutations: readonly ActivityMutation[]) {
  return mutations.flatMap((mutation) =>
    mutation.type === "upsert" ? [mutation.item] : []
  );
}

function appends(mutations: readonly ActivityMutation[]) {
  return mutations.flatMap((mutation) =>
    mutation.type === "append" ? [mutation] : []
  );
}

function baseMessage(type: string, uuid: string): Record<string, unknown> {
  return {
    type,
    uuid,
    session_id: "provider-session",
  };
}

test("folds partial text, displayable thinking, and tool JSON into authoritative finals", () => {
  const projector = new ClaudeActivityProjector();
  projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-start"),
    parent_tool_use_id: null,
    event: {
      type: "message_start",
      message: {
        id: "api-message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  }));

  const textStart = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-text-start"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
  }));
  const streamedTextId = upserts(textStart).find((item) => item.kind === "message")?.id;
  assert.ok(streamedTextId);
  const textDelta = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-text-delta"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
  }));
  assert.deepEqual(appends(textDelta), [{
    type: "append",
    id: streamedTextId,
    channel: "text",
    offset: 0,
    text: "Hello",
  }]);

  const thinkingStart = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-thinking-start"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "", signature: "never-project" },
    },
  }));
  const streamedThinkingId = upserts(thinkingStart).find(
    (item) => item.kind === "reasoning",
  )?.id;
  assert.ok(streamedThinkingId);
  const thinkingDelta = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-thinking-delta"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "Check the files", estimated_tokens: 12 },
    },
  }));
  assert.equal(
    appends(thinkingDelta).find((mutation) => mutation.id === streamedThinkingId)?.text,
    "Check the files",
  );
  const signature = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-signature"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "private-signature" },
    },
  }));
  assert.equal(JSON.stringify(signature).includes("private-signature"), false);

  const redacted = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-redacted"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 2,
      content_block: { type: "redacted_thinking", data: "encrypted-reasoning" },
    },
  }));
  assert.equal(JSON.stringify(redacted).includes("encrypted-reasoning"), false);

  projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-tool-start"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} },
    },
  }));
  projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-tool-delta"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
    },
  }));
  const toolStop = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "stream-tool-stop"),
    parent_tool_use_id: null,
    event: { type: "content_block_stop", index: 3 },
  }));
  const partialTool = upserts(toolStop).find((item) => item.kind === "tool");
  assert.deepEqual(partialTool?.arguments, { command: "pwd" });
  assert.equal(partialTool?.state, "pending");

  const final = projector.projectMessage(sdk({
    ...baseMessage("assistant", "assistant-final"),
    parent_tool_use_id: null,
    message: {
      id: "api-message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      content: [
        { type: "text", text: "Hello", citations: null },
        { type: "thinking", thinking: "Check the files", signature: "final-secret" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }));
  assert.equal(final.some((mutation) => mutation.type === "remove"), false);
  const finalText = upserts(final).find((item) => item.kind === "message");
  const finalThinking = upserts(final).find((item) => item.kind === "reasoning");
  assert.equal(finalText?.id, streamedTextId);
  assert.equal(finalText?.text, "Hello");
  assert.equal(finalText?.phase, "commentary");
  assert.equal(finalThinking?.id, streamedThinkingId);
  assert.equal(finalThinking?.text, "Check the files");
  assert.equal(JSON.stringify(final).includes("final-secret"), false);
  assert.deepEqual(
    upserts(final).find((item) => item.kind === "tool")?.arguments,
    { command: "pwd" },
  );
});

test("keeps 1,250 streamed tokens linear and preserves text-tool-final identity order", () => {
  const projector = new ClaudeActivityProjector();
  const hub = new ActivityHub({
    streamEpoch: "claude-stress",
    replayMaxFrames: 2_000,
    replayMaxBytes: 4 * 1_024 * 1_024,
  });
  const ingest = (mutations: readonly ActivityMutation[]) =>
    mutations.map((mutation) => hub.ingest("managed-claude", "claude", mutation));

  ingest(projector.projectMessage(sdk({
    ...baseMessage("stream_event", "linear-start"),
    parent_tool_use_id: null,
    event: {
      type: "message_start",
      message: {
        id: "linear-api-message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  })));
  const started = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "linear-block-start"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
  }));
  ingest(started);
  const id = upserts(started).find((item) => item.kind === "message")?.id;
  assert.ok(id);

  const deltaCount = 1_250;
  let appendFrameCount = 0;
  let serializedMutationBytes = 0;
  let serializedFrameBytes = 0;
  for (let index = 0; index < deltaCount; index += 1) {
    const delta = projector.projectMessage(sdk({
      ...baseMessage("stream_event", `linear-delta-${index}`),
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "é" },
      },
    }));
    assert.deepEqual(delta, [{
      type: "append",
      id,
      channel: "text",
      offset: index * 2,
      text: "é",
    }]);
    serializedMutationBytes += Buffer.byteLength(JSON.stringify(delta), "utf8");
    for (const frame of ingest(delta)) {
      if (frame.type === "activity.append") appendFrameCount += 1;
      serializedFrameBytes += Buffer.byteLength(JSON.stringify(frame), "utf8");
    }
  }
  assert.equal(appendFrameCount, deltaCount);
  // Both producer payload and actual wire frames stay bounded per token. A
  // cumulative full-text upsert would instead grow quadratically.
  assert.ok(serializedMutationBytes < deltaCount * 160);
  assert.ok(serializedFrameBytes < deltaCount * 640);

  const toolStarted = projector.projectMessage(sdk({
    ...baseMessage("stream_event", "linear-tool-start"),
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "linear-tool",
        name: "Bash",
        input: { command: "pwd" },
      },
    },
  }));
  ingest(toolStarted);
  const toolId = upserts(toolStarted).find((item) => item.kind === "tool")?.id;
  assert.ok(toolId);
  assert.deepEqual(
    hub.snapshot("managed-claude")?.items
      .filter((item) => item.id === id || item.id === toolId)
      .map((item) => item.id),
    [id, toolId],
  );

  const final = projector.projectMessage(sdk({
    ...baseMessage("assistant", "linear-final"),
    parent_tool_use_id: null,
    message: {
      // Even if an SDK release reports a different wrapper message id on the
      // authoritative event, the already-rendered content block keeps its id.
      id: "linear-api-message-final",
      role: "assistant",
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      content: [
        { type: "text", text: "é".repeat(deltaCount), citations: null },
        { type: "tool_use", id: "linear-tool", name: "Bash", input: { command: "pwd" } },
      ],
      usage: { input_tokens: 1, output_tokens: deltaCount },
    },
  }));
  assert.equal(final.some((mutation) => mutation.type === "remove"), false);
  const finalText = upserts(final).find((item) => item.kind === "message");
  assert.equal(finalText?.id, id);
  assert.equal(finalText?.text, "é".repeat(deltaCount));
  assert.equal(finalText?.state, "complete");
  ingest(final);
  const ordered = hub.snapshot("managed-claude")?.items.filter(
    (item) => item.id === id || item.id === toolId,
  );
  assert.deepEqual(ordered?.map((item) => item.id), [id, toolId]);
  assert.equal(ordered?.[0]?.kind, "message");
  assert.equal(ordered?.[0]?.kind === "message" ? ordered[0].text : null, "é".repeat(deltaCount));
  assert.equal(ordered?.[1]?.kind, "tool");
});

test("projects Claude plan documents and live todo rewrites without inventing artifacts", () => {
  const projector = new ClaudeActivityProjector();
  const first = projector.projectMessage(sdk({
    ...baseMessage("assistant", "artifact-first"),
    parent_tool_use_id: null,
    message: {
      id: "artifact-message-1",
      role: "assistant",
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      content: [
        {
          type: "tool_use",
          id: "exit-plan-1",
          name: "ExitPlanMode",
          input: {
            plan: "# Ship it\n\nKeep this markdown verbatim.",
            planFilePath: "/tmp/claude/plans/ship.md",
          },
        },
        {
          type: "tool_use",
          id: "todo-write-1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Inspect", status: "pending", activeForm: "Inspecting" },
              { content: "Build", status: "in_progress", activeForm: "Building now" },
            ],
          },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const plan = upserts(first).find((item) => item.kind === "plan");
  assert.equal(plan?.markdown, "# Ship it\n\nKeep this markdown verbatim.");
  assert.equal(plan?.path, "/tmp/claude/plans/ship.md");
  assert.equal(plan?.version, null);
  assert.equal(plan?.supersededBy, null);
  assert.equal(plan?.approvalRequestId, null);
  const initialTodo = upserts(first).find((item) => item.kind === "todo");
  assert.deepEqual(initialTodo && {
    statuses: initialTodo.steps?.map((step) => step.status),
    details: initialTodo.steps?.map((step) => step.detail),
    added: initialTodo.added,
    removed: initialTodo.removed,
  }, {
    statuses: ["pending", "in_progress"],
    details: [null, "Building now"],
    added: 0,
    removed: 0,
  });

  const rewrite = projector.projectMessage(sdk({
    ...baseMessage("assistant", "artifact-rewrite"),
    parent_tool_use_id: null,
    message: {
      id: "artifact-message-2",
      role: "assistant",
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      content: [{
        type: "tool_use",
        id: "todo-write-2",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Inspect", status: "completed", activeForm: "Inspecting" },
            { content: "Verify", status: "in_progress", activeForm: "Verifying" },
          ],
        },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const rewrittenTodo = upserts(rewrite).find((item) => item.kind === "todo");
  assert.equal(rewrittenTodo?.id, initialTodo?.id);
  assert.equal(rewrittenTodo?.added, 1);
  assert.equal(rewrittenTodo?.removed, 1);
  assert.deepEqual(rewrittenTodo?.steps?.map((step) => ({
    text: step.text,
    status: step.status,
    addedAfterStart: step.addedAfterStart,
    removedReason: step.removedReason,
  })), [
    { text: "Inspect", status: "completed", addedAfterStart: false, removedReason: null },
    { text: "Verify", status: "in_progress", addedAfterStart: true, removedReason: null },
    { text: "Build", status: "removed", addedAfterStart: false, removedReason: null },
  ]);

  const noPath = projector.projectMessage(sdk({
    ...baseMessage("assistant", "plan-no-path"),
    parent_tool_use_id: null,
    message: {
      id: "artifact-message-3",
      role: "assistant",
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      content: [{
        type: "tool_use",
        id: "exit-plan-2",
        name: "ExitPlanMode",
        input: { plan: "# No file supplied" },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  assert.equal(upserts(noPath).find((item) => item.kind === "plan")?.path, null);
});

test("projects tool progress, summaries, structured results, and replace-style usage", () => {
  const projector = new ClaudeActivityProjector();
  const progress = projector.projectMessage(sdk({
    ...baseMessage("tool_progress", "progress-1"),
    tool_use_id: "tool-1",
    tool_name: "Bash",
    parent_tool_use_id: null,
    elapsed_time_seconds: 1.5,
  }));
  assert.equal(upserts(progress)[0]?.state, "running");

  const summary = projector.projectMessage(sdk({
    ...baseMessage("tool_use_summary", "summary-1"),
    summary: "Inspected repository status",
    preceding_tool_use_ids: ["tool-1"],
  }));
  assert.equal(
    upserts(summary).find((item) => item.kind === "tool")?.output,
    "Inspected repository status",
  );

  const result = projector.projectMessage(sdk({
    ...baseMessage("user", "tool-result-message"),
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "done",
        is_error: false,
      }],
    },
    tool_use_result: { stdout: "done", exitCode: 0 },
  }));
  const completedTool = upserts(result).find((item) => item.kind === "tool");
  assert.equal(completedTool?.state, "complete");
  assert.deepEqual(completedTool?.result, { stdout: "done", exitCode: 0 });

  const terminal = projector.projectMessage(sdk({
    ...baseMessage("result", "result-1"),
    subtype: "success",
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens_details: { thinking_tokens: 4 },
    },
    modelUsage: {},
    permission_denials: [],
    user_message_uuid: "user-turn",
  }));
  const usage = upserts(terminal).find((item) => item.kind === "usage");
  assert.equal(usage?.inputTokens, 5);
  assert.equal(usage?.cachedInputTokens, 5);
  assert.equal(usage?.outputTokens, 7);
  assert.equal(usage?.reasoningTokens, 4);
  assert.equal(usage?.totalTokens, 17);
  assert.equal(usage?.costUsd, 0.01);
});

test("settles an active request status when a terminal result omits the status clear", () => {
  const projector = new ClaudeActivityProjector();
  const hub = new ActivityHub({ streamEpoch: "claude-request-status" });
  const ingest = (mutations: readonly ActivityMutation[]) => {
    for (const mutation of mutations) hub.ingest("managed-claude", "claude", mutation);
  };

  ingest(projector.projectMessage(sdk({
    ...baseMessage("system", "requesting-1"),
    subtype: "status",
    status: "requesting",
  })));
  assert.equal(
    hub.snapshot("managed-claude")?.items.find(
      (item) => item.id === "claude:lifecycle:request-status",
    )?.state,
    "running",
  );

  ingest(projector.projectMessage(sdk({
    ...baseMessage("rate_limit_event", "rate-limit-terminal"),
    rate_limit_info: {
      status: "rejected",
      resetsAt: 1_785_542_400,
    },
  })));
  const terminal = projector.projectMessage(sdk({
    ...baseMessage("result", "result-after-rate-limit"),
    subtype: "success",
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: "Request failed due to the rate limit.",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    user_message_uuid: "user-turn",
  }));
  ingest(terminal);

  const requestStatus = hub.snapshot("managed-claude")?.items.find(
    (item) => item.id === "claude:lifecycle:request-status",
  );
  assert.equal(requestStatus?.state, "complete");
  assert.equal(
    requestStatus?.kind === "lifecycle" ? requestStatus.title : null,
    "Claude request status cleared",
  );
  assert.equal(
    hub.snapshot("managed-claude")?.items.some((item) => item.state === "running"),
    false,
  );

  const repeated = projector.projectMessage(sdk({
    ...baseMessage("result", "repeated-result"),
    subtype: "success",
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: "Complete",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    user_message_uuid: "user-turn",
  }));
  assert.equal(
    upserts(repeated).some((item) => item.id === "claude:lifecycle:request-status"),
    false,
  );
});

test("projects tasks, hooks, errors, supersedes, retractions, and provider reset", () => {
  const projector = new ClaudeActivityProjector();
  const started = projector.projectMessage(sdk({
    ...baseMessage("system", "task-start-event"),
    subtype: "task_started",
    task_id: "task-1",
    tool_use_id: "task-tool",
    description: "Review authentication",
    subagent_type: "reviewer",
  }));
  const task = upserts(started).find((item) => item.kind === "subagent");
  assert.equal(task?.taskId, "task-1");
  assert.equal(task?.name, "reviewer");
  assert.equal(task?.state, "running");

  const taskProgress = projector.projectMessage(sdk({
    ...baseMessage("system", "task-progress-event"),
    subtype: "task_progress",
    task_id: "task-1",
    tool_use_id: "task-tool",
    description: "Review authentication",
    usage: { total_tokens: 42, tool_uses: 2, duration_ms: 1000 },
    last_tool_name: "Read",
    summary: "Reading auth middleware",
  }));
  assert.equal(
    upserts(taskProgress).find((item) => item.kind === "usage")?.totalTokens,
    42,
  );
  assert.equal(
    upserts(taskProgress).find((item) => item.kind === "subagent")?.output,
    "Reading auth middleware",
  );

  const hook = projector.projectMessage(sdk({
    ...baseMessage("system", "hook-response-event"),
    subtype: "hook_response",
    hook_id: "hook-1",
    hook_name: "lint",
    hook_event: "PostToolUse",
    output: "passed",
    stdout: "",
    stderr: "",
    outcome: "success",
  }));
  const hookItem = upserts(hook).find((item) => item.kind === "lifecycle");
  assert.equal(hookItem?.event, "hook");
  assert.equal(hookItem?.state, "complete");

  const first = projector.projectMessage(sdk({
    ...baseMessage("assistant", "old-assistant"),
    parent_tool_use_id: null,
    message: {
      id: "old-api-message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      content: [{ type: "text", text: "Old answer", citations: null }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const oldId = upserts(first).find((item) => item.kind === "message")?.id;
  assert.ok(oldId);
  const replacement = projector.projectMessage(sdk({
    ...baseMessage("assistant", "new-assistant"),
    parent_tool_use_id: null,
    supersedes: ["old-assistant"],
    message: {
      id: "new-api-message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      content: [{ type: "text", text: "New answer", citations: null }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  assert.ok(replacement.some((mutation) =>
    mutation.type === "remove" && mutation.id === oldId
  ));

  const reset = projector.projectMessage(sdk({
    ...baseMessage("conversation_reset", "reset-1"),
    new_conversation_id: "conversation-2",
  }));
  assert.deepEqual(reset, [{ type: "reset", reason: "provider-reset" }]);
});

test("projects only provider-identified Claude subagents and their exact child edge", () => {
  const projector = new ClaudeActivityProjector();
  const started = projector.projectMessage(sdk({
    ...baseMessage("system", "subagent-started"),
    subtype: "task_started",
    task_id: "agent-task",
    tool_use_id: "agent-tool",
    description: "Inspect authentication",
    subagent_type: "reviewer",
  }));
  const subagent = upserts(started).find((item) => item.kind === "subagent");
  assert.ok(subagent);
  assert.equal(subagent.parentId, "claude:tool:agent-tool");

  const child = projector.projectMessage(sdk({
    ...baseMessage("assistant", "subagent-message"),
    parent_tool_use_id: "agent-tool",
    message: {
      id: "subagent-api-message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      content: [{ type: "text", text: "Found the exact boundary", citations: null }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const childMessage = upserts(child).find((item) => item.kind === "message");
  const updatedSubagent = [...upserts(child)].reverse().find(
    (item) => item.kind === "subagent",
  );
  assert.ok(childMessage);
  assert.equal(childMessage.parentId, subagent.id);
  assert.equal(
    updatedSubagent?.kind === "subagent"
      ? updatedSubagent.childItemIds?.includes(childMessage.id)
      : false,
    true,
  );
});

test("does not manufacture Claude subagents from generic or level-only task events", () => {
  const projector = new ClaudeActivityProjector();
  const workflow = projector.projectMessage(sdk({
    ...baseMessage("system", "workflow-started"),
    subtype: "task_started",
    task_id: "workflow-task",
    tool_use_id: "workflow-tool",
    description: "Run the local spec workflow",
    task_type: "local_workflow",
    workflow_name: "spec",
  }));
  assert.equal(upserts(workflow).some((item) => item.kind === "subagent"), false);
  assert.equal(upserts(workflow).some((item) =>
    item.kind === "lifecycle" && item.id === "claude:task:workflow-task"
  ), true);

  const level = projector.projectMessage(sdk({
    ...baseMessage("system", "background-level"),
    subtype: "background_tasks_changed",
    tasks: [{
      task_id: "bash-task",
      task_type: "shell",
      description: "Run tests",
    }],
  }));
  assert.equal(upserts(level).some((item) => item.kind === "subagent"), false);

  const unparentedProgress = projector.projectMessage(sdk({
    ...baseMessage("tool_progress", "tool-progress"),
    tool_use_id: "child-tool",
    tool_name: "Read",
    parent_tool_use_id: null,
    elapsed_time_seconds: 1,
    task_id: "unidentified-task",
    subagent_type: "reviewer",
  }));
  assert.equal(
    upserts(unparentedProgress).some((item) => item.kind === "subagent"),
    false,
  );
});

test("turns exact SDK callbacks into resolvable attention activity", () => {
  const projector = new ClaudeActivityProjector();
  const base: ClaudeManagedSessionSnapshot = {
    localId: "local",
    sessionId: "provider-session",
    resumedFrom: null,
    cwd: "/workspace",
    owner: "manager",
    activity: "requires_action",
    mode: "default",
    desiredMode: "default",
    model: "sonnet",
    desiredModel: "sonnet",
    effort: "high",
    sdkVersion: "0.3.220",
    claudeCodeVersion: "2.1.221",
    capabilities: [],
    canSteer: true,
    pendingRequests: [{
      id: "question-1",
      kind: "question",
      title: "Claude needs your answer",
      toolName: "AskUserQuestion",
      toolUseId: "question-tool",
      payload: {
        input: {
          questions: [{
            header: "Storage",
            question: "Which database?",
            options: [{ label: "SQLite", description: "Local", recommended: true }],
            multiSelect: false,
            isSecret: true,
          }],
        },
      },
      createdAt: "2026-08-03T12:00:00.000Z",
    }],
    stagedMessages: [],
    outstandingMessageIds: [],
    stillQueuedMessageIds: [],
    queueKnowledge: "known",
    handoff: null,
    lastError: null,
    generation: 1,
    startedAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  };
  const pending = projector.projectSnapshot(base);
  const attention = upserts(pending).find((item) => item.kind === "attention");
  assert.equal(attention?.attentionKind, "question");
  assert.equal(attention?.respondable, true);
  assert.equal(attention?.isSecret, true);
  assert.equal(attention?.questions?.[0]?.text, "Which database?");
  assert.equal(attention?.questions?.[0]?.options[0]?.recommended, true);

  const resolved = projector.projectSnapshot({
    ...base,
    activity: "idle",
    pendingRequests: [],
    generation: 2,
  });
  const resolvedAttention = upserts(resolved).find(
    (item) => item.kind === "attention",
  );
  assert.equal(resolvedAttention?.resolved, true);
  assert.equal(resolvedAttention?.state, "complete");
});

test("Claude approval activity carries SDK-supplied facts without shell inference", () => {
  const projector = new ClaudeActivityProjector();
  const snapshot: ClaudeManagedSessionSnapshot = {
    localId: "local",
    sessionId: "provider-session",
    resumedFrom: null,
    cwd: "/workspace/app",
    owner: "manager",
    activity: "requires_action",
    mode: "default",
    desiredMode: "default",
    model: "sonnet",
    desiredModel: "sonnet",
    effort: "high",
    sdkVersion: "0.3.220",
    claudeCodeVersion: "2.1.221",
    capabilities: [],
    canSteer: true,
    pendingRequests: [{
      id: "permission-1",
      kind: "permission",
      title: "Claude wants to write a file",
      toolName: "Write",
      toolUseId: "write-tool",
      payload: {
        input: {
          file_path: "../shared/output.txt",
          deleteCount: 2,
          network: false,
        },
        suggestions: [{ type: "addRules", destination: "session" }],
      },
      createdAt: "2026-08-03T12:00:00.000Z",
    }, {
      id: "permission-2",
      kind: "permission",
      title: "Claude wants to run a command",
      toolName: "Bash",
      toolUseId: "bash-tool",
      payload: { input: { command: "rm -rf /tmp/output" } },
      createdAt: "2026-08-03T12:00:00.000Z",
    }, {
      id: "plan-approval-1",
      kind: "plan-approval",
      title: "Claude wants to leave plan mode",
      toolName: "ExitPlanMode",
      toolUseId: "exit-plan-tool",
      payload: { input: { plan: "# Exact plan" } },
      createdAt: "2026-08-03T12:00:00.000Z",
    }],
    stagedMessages: [],
    outstandingMessageIds: [],
    stillQueuedMessageIds: [],
    queueKnowledge: "known",
    handoff: null,
    lastError: null,
    generation: 1,
    startedAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  };
  const projected = upserts(projector.projectSnapshot(snapshot));
  const attention = projected.filter(
    (item) => item.kind === "attention",
  );
  const write = attention.find((item) => item.kind === "attention" && item.requestId === "permission-1");
  assert.equal(write?.kind, "attention");
  if (write?.kind === "attention") {
    assert.deepEqual(write.approvalFacts, {
      command: null,
      paths: ["/workspace/shared/output.txt"],
      writes: ["../shared/output.txt"],
      network: null,
      canPersist: true,
      deleteCount: null,
    });
  }
  const bash = attention.find((item) => item.kind === "attention" && item.requestId === "permission-2");
  assert.equal(bash?.kind, "attention");
  if (bash?.kind === "attention") {
    assert.equal(bash.approvalFacts?.command, "rm -rf /tmp/output");
    assert.equal(bash.approvalFacts?.paths, null);
    assert.deepEqual(bash.approvalFacts?.writes, []);
  }
  const plan = projected.find((item) => item.kind === "plan");
  assert.equal(plan?.kind, "plan");
  if (plan?.kind === "plan") {
    assert.equal(plan.approvalRequestId, "plan-approval-1");
    assert.equal(plan.approvedAt, null);
  }
  const approved = upserts(projector.projectPlanApproval(
    snapshot.pendingRequests[2]!,
    "2026-08-03T12:01:00.000Z",
  ))[0];
  assert.equal(approved?.kind, "plan");
  if (approved?.kind === "plan") {
    assert.equal(approved.approvalRequestId, "plan-approval-1");
    assert.equal(approved.approvedAt, "2026-08-03T12:01:00.000Z");
    assert.equal(approved.state, "complete");
  }
  const replayed = upserts(projector.projectMessage(sdk({
    ...baseMessage("assistant", "plan-replay"),
    parent_tool_use_id: null,
    message: {
      id: "plan-replay-message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      content: [{
        type: "tool_use",
        id: "exit-plan-tool",
        name: "ExitPlanMode",
        input: { plan: "# Exact plan" },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }))).find((item) => item.kind === "plan");
  assert.equal(replayed?.kind === "plan" ? replayed.approvalRequestId : null, "plan-approval-1");
  assert.equal(replayed?.kind === "plan" ? replayed.approvedAt : null, "2026-08-03T12:01:00.000Z");
  assert.equal(replayed?.state, "complete");
});

test("renders Claude rate-limit reset timestamps from Unix seconds", () => {
  const projector = new ClaudeActivityProjector();
  const mutations = projector.projectMessage(sdk({
    ...baseMessage("rate_limit_event", "rate-limit-1"),
    rate_limit_info: {
      status: "allowed_warning",
      resetsAt: 1_785_542_400,
    },
  }));
  const warning = upserts(mutations).find((item) =>
    item.id === "claude:lifecycle:rate-limit"
  );
  assert.equal(warning?.kind, "lifecycle");
  assert.equal(
    warning?.kind === "lifecycle" ? warning.details : null,
    "Resets at 2026-08-01T00:00:00.000Z",
  );
});

/*
  The SDK mirrors the interactive REPL's notification queue, where one
  notification is re-emitted as its state changes. Each emission carries a fresh
  `uuid` and the same `key`, so keying the activity item on `uuid` made every
  re-emission a brand-new row and the operator watched one sentence stack up.
*/
test("a re-emitted provider notification replaces its row rather than stacking another", () => {
  const projector = new ClaudeActivityProjector();
  const notification = (uuid: string, text: string) => sdk({
    ...baseMessage("system", uuid),
    subtype: "notification",
    key: "usage-limit",
    text,
    priority: "medium",
  });

  const first = upserts(projector.projectMessage(notification("emit-1", "Approaching the usage limit")));
  const second = upserts(projector.projectMessage(notification("emit-2", "Usage limit reached")));

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0]?.id, second[0]?.id, "one notification, one row");
  assert.equal(second[0]?.kind === "lifecycle" ? second[0].title : null, "Usage limit reached");
});

/*
  Slash-command output and status banners used to share one branch, which threw
  away the banner's `level` and left command output anonymous. `/clear` then
  arrived as an unlabelled slab of grey text indistinguishable from a warning.
*/
test("slash-command output is a labelled message and a loud banner is a lifecycle row", () => {
  const projector = new ClaudeActivityProjector();

  const command = upserts(projector.projectMessage(sdk({
    ...baseMessage("system", "command-1"),
    subtype: "local_command_output",
    content: "## Context\n\n42% used",
  })));
  assert.equal(command.length, 1);
  assert.equal(command[0]?.kind, "message");
  assert.equal(command[0]?.kind === "message" ? command[0].role : null, "system");
  assert.equal(command[0]?.kind === "message" ? command[0].label : null, "Command output");
  assert.equal(command[0]?.kind === "message" ? command[0].text : null, "## Context\n\n42% used");

  const loud = upserts(projector.projectMessage(sdk({
    ...baseMessage("system", "banner-1"),
    subtype: "informational",
    content: "A Stop hook denied continuation",
    level: "warning",
  })));
  assert.equal(loud.length, 1);
  assert.equal(loud[0]?.kind, "lifecycle");
  assert.equal(loud[0]?.kind === "lifecycle" ? loud[0].level : null, "warning");
  assert.equal(loud[0]?.kind === "lifecycle" ? loud[0].title : null, "A Stop hook denied continuation");

  const quiet = upserts(projector.projectMessage(sdk({
    ...baseMessage("system", "banner-2"),
    subtype: "informational",
    content: "Reading the workspace",
    level: "info",
  })));
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0]?.kind, "message");
  assert.equal(quiet[0]?.kind === "message" ? quiet[0].label : "unset", null);
});

test("two genuinely different notifications keep their own rows", () => {
  const projector = new ClaudeActivityProjector();
  const first = upserts(projector.projectMessage(sdk({
    ...baseMessage("system", "emit-1"),
    subtype: "notification",
    key: "usage-limit",
    text: "Approaching the usage limit",
    priority: "medium",
  })));
  const second = upserts(projector.projectMessage(sdk({
    ...baseMessage("system", "emit-2"),
    subtype: "notification",
    key: "update-available",
    text: "An update is available",
    priority: "low",
  })));

  assert.notEqual(first[0]?.id, second[0]?.id);
});

test("a notification without a key still gets a row of its own", () => {
  // `key` is required by the SDK type, but the wire is not the type system.
  const projector = new ClaudeActivityProjector();
  const mutations = upserts(projector.projectMessage(sdk({
    ...baseMessage("system", "emit-1"),
    subtype: "notification",
    text: "Something happened",
    priority: "high",
  })));

  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.kind === "lifecycle" ? mutations[0].level : null, "warning");
});

/*
  Both providers put the model's context window on the wire and both projectors
  dropped it, so a token count had no denominator and any "% of context used"
  would have been the cockpit guessing at the one number it lacked.
*/
test("carries the context window the result message reported", () => {
  const projector = new ClaudeActivityProjector();
  const usage = upserts(projector.projectMessage(sdk({
    ...baseMessage("result", "result-1"),
    subtype: "success",
    usage: { input_tokens: 120, output_tokens: 40 },
    total_cost_usd: 0.01,
    permission_denials: [],
    modelUsage: { "claude-sonnet": { contextWindow: 200_000, inputTokens: 120, outputTokens: 40 } },
  }))).filter((item) => item.kind === "usage");

  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.kind === "usage" ? usage[0].contextWindow : null, 200_000);
});

test("states no window when the turn's models disagree about one", () => {
  // `modelUsage` is keyed by model and a turn can touch more than one. A single
  // denominator is only a fact when they agree.
  const projector = new ClaudeActivityProjector();
  const usage = upserts(projector.projectMessage(sdk({
    ...baseMessage("result", "result-1"),
    subtype: "success",
    usage: { input_tokens: 120, output_tokens: 40 },
    total_cost_usd: 0.01,
    permission_denials: [],
    modelUsage: {
      "claude-sonnet": { contextWindow: 200_000 },
      "claude-haiku": { contextWindow: 100_000 },
    },
  }))).filter((item) => item.kind === "usage");

  assert.equal(usage[0]?.kind === "usage" ? usage[0].contextWindow : "missing", null);
});

test("states no window when the provider reported none", () => {
  const projector = new ClaudeActivityProjector();
  const usage = upserts(projector.projectMessage(sdk({
    ...baseMessage("result", "result-1"),
    subtype: "success",
    usage: { input_tokens: 120, output_tokens: 40 },
    total_cost_usd: 0.01,
    permission_denials: [],
    modelUsage: {},
  }))).filter((item) => item.kind === "usage");

  assert.equal(usage[0]?.kind === "usage" ? usage[0].contextWindow : "missing", null);
});
