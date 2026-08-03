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
    sdkVersion: "0.3.220",
    claudeCodeVersion: "2.1.220",
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
            options: [{ label: "SQLite", description: "Local" }],
            multiSelect: false,
            isSecret: true,
          }],
        },
      },
      createdAt: "2026-08-03T12:00:00.000Z",
    }],
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
