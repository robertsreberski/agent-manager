import assert from "node:assert/strict";
import test from "node:test";

import type { PermissionRequestHookInput } from "@anthropic-ai/claude-agent-sdk";

import type { ActivityMutation } from "../../activity/index.ts";
import { digestHookBearerToken } from "./auth.ts";
import { ClaudeHookBridge } from "./claude-bridge.ts";
import {
  CLAUDE_PERMISSION_DEFAULT_DEADLINE_MS,
  CLAUDE_PERMISSION_FAIL_OPEN_MARGIN_MS,
  CLAUDE_PERMISSION_MAX_DEADLINE_MS,
  CLAUDE_PERMISSION_PROVIDER_TIMEOUT_MS,
  ClaudePermissionBroker,
} from "./claude-broker.ts";
import { ClaudeHookActivityProjector } from "./claude-projector.ts";
import {
  CLAUDE_MANAGER_OWNER_VALUE,
  ClaudeHookSourceArbiter,
} from "./claude-source.ts";
import { parseClaudeHookInput } from "./claude-types.ts";

function common(event: string): Record<string, unknown> {
  return {
    session_id: "session-1",
    transcript_path: "/tmp/session.jsonl",
    cwd: "/workspace",
    prompt_id: "prompt-1",
    permission_mode: "default",
    hook_event_name: event,
  };
}

function permission(): PermissionRequestHookInput {
  return parseClaudeHookInput({
    ...common("PermissionRequest"),
    tool_name: "Bash",
    tool_input: { command: "echo ok", apiKey: "secret-value" },
  }) as PermissionRequestHookInput;
}

test("parses only bounded Claude-specific hook payloads", () => {
  assert.equal(parseClaudeHookInput(permission()).hook_event_name, "PermissionRequest");
  assert.throws(
    () => parseClaudeHookInput({ ...common("PermissionRequest"), tool_name: "Bash" }),
    /tool_input is required/,
  );
  assert.throws(
    () => parseClaudeHookInput({ ...common("MadeUpHook") }),
    /Unsupported Claude hook event/,
  );
  assert.throws(
    () => parseClaudeHookInput({
      ...common("UserPromptSubmit"),
      prompt: "x".repeat(1_048_576),
    }),
    /payload exceeds/,
  );
  assert.throws(() => parseClaudeHookInput({
    ...common("PermissionRequest"),
    tool_name: "Write",
    tool_input: { file_path: "/workspace/output.txt" },
    permission_suggestions: [{ type: "addRules", destination: "nowhere", rules: [], behavior: "allow" }],
  }), /destination is unsupported/);
});

test("allocates one broker UUID per POST and answers only PermissionRequest", async () => {
  let nextId = 0;
  const broker = new ClaudePermissionBroker({
    randomUUID: () => `bridge-request-${++nextId}`,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
  });
  const first = broker.hold(permission());
  const second = broker.hold(permission());
  assert.notEqual(first.request.id, second.request.id);
  assert.equal(broker.pending().length, 2);

  assert.equal(broker.respond(first.request.id, {
    behavior: "allow",
    updatedInput: { command: "echo safe" },
  }), true);
  assert.deepEqual(await first.response, {
    statusCode: 200,
    body: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { command: "echo safe" } },
      },
    },
  });

  broker.shutdown();
  assert.deepEqual(await second.response, { statusCode: 200, body: null });
  assert.equal(broker.pending().length, 0);
});

test("never overwrites a held request when an injected UUID generator collides", () => {
  let call = 0;
  const broker = new ClaudePermissionBroker({
    randomUUID: () => call++ < 2 ? "same-id" : "second-id",
  });
  const first = broker.hold(permission());
  const second = broker.hold(permission());
  assert.equal(first.request.id, "same-id");
  assert.equal(second.request.id, "second-id");
  assert.equal(broker.pending().length, 2);
  broker.shutdown();
});

test("deadline and session release always fail open with empty 2xx", async () => {
  let deadline: (() => void) | null = null;
  const broker = new ClaudePermissionBroker({
    deadlineMs: 1_000,
    setTimeout: ((callback: () => void) => {
      deadline = callback;
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const timed = broker.hold(permission());
  assert.ok(deadline);
  (deadline as () => void)();
  assert.deepEqual(await timed.response, { statusCode: 200, body: null });

  const released = broker.hold(permission());
  broker.releaseSession("session-1");
  assert.deepEqual(await released.response, { statusCode: 200, body: null });

  const browserLost = broker.hold(permission());
  assert.equal(broker.failOpen(browserLost.request.id, "browser-lost"), true);
  assert.equal(broker.failOpen(browserLost.request.id, "browser-lost"), false);
  assert.deepEqual(await browserLost.response, { statusCode: 200, body: null });
});

test("default hold fails open promptly and every accepted deadline beats Claude's timeout", () => {
  let scheduledAfter = 0;
  const broker = new ClaudePermissionBroker({
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    setTimeout: ((_: () => void, delay?: number) => {
      scheduledAfter = delay ?? 0;
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const held = broker.hold(permission());
  assert.equal(scheduledAfter, CLAUDE_PERMISSION_DEFAULT_DEADLINE_MS);
  assert.equal(scheduledAfter, 60_000);
  assert.ok(
    CLAUDE_PERMISSION_PROVIDER_TIMEOUT_MS - scheduledAfter
      >= CLAUDE_PERMISSION_FAIL_OPEN_MARGIN_MS,
  );
  assert.equal(
    held.request.deadlineAt,
    new Date(Date.parse(held.request.createdAt) + scheduledAfter).toISOString(),
  );
  broker.shutdown();
  assert.throws(
    () => new ClaudePermissionBroker({
      deadlineMs: CLAUDE_PERMISSION_MAX_DEADLINE_MS + 1,
    }),
    /1-470 seconds/u,
  );
});

test("projects redacted exact activity and requires broker correlation", () => {
  const projector = new ClaudeHookActivityProjector();
  assert.throws(() => projector.project(permission()), /broker request UUID/);
  const projected = projector.project(permission(), { permissionRequestId: "held-1" });
  const attention = projected.mutations[0];
  assert.equal(attention?.type, "upsert");
  assert.equal(attention?.type === "upsert" ? attention.item.kind : null, "attention");
  assert.equal(JSON.stringify(attention).includes("secret-value"), false);
  assert.equal(
    attention?.type === "upsert" && attention.item.kind === "attention"
      ? attention.item.approvalFacts?.command
      : null,
    "echo ok",
  );

  const tool = projector.project(parseClaudeHookInput({
    ...common("PreToolUse"),
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'" },
  }));
  assert.equal(JSON.stringify(tool).includes("abcdefghijklmnop"), false);
});

test("links Claude hook child activity only by exact agent identity", () => {
  const projector = new ClaudeHookActivityProjector();
  const started = projector.project(parseClaudeHookInput({
    ...common("SubagentStart"),
    agent_id: "agent-1",
    agent_type: "reviewer",
  }));
  const subagent = started.mutations.find(
    (mutation) => mutation.type === "upsert" && mutation.item.kind === "subagent",
  );
  assert.equal(
    subagent?.type === "upsert" && subagent.item.kind === "subagent"
      ? subagent.item.parentId
      : "missing",
    null,
  );

  const child = projector.project(parseClaudeHookInput({
    ...common("PreToolUse"),
    agent_id: "agent-1",
    agent_type: "reviewer",
    tool_name: "Read",
    tool_use_id: "read-1",
    tool_input: { file_path: "/workspace/auth.ts" },
  }));
  const childTool = child.mutations.find(
    (mutation) => mutation.type === "upsert" && mutation.item.kind === "tool",
  );
  assert.equal(
    childTool?.type === "upsert" ? childTool.item.parentId : null,
    subagent?.type === "upsert" ? subagent.item.id : null,
  );

  const nested = projector.project(parseClaudeHookInput({
    ...common("SubagentStart"),
    agent_id: "agent-2",
    agent_type: "explorer",
  }));
  const nestedSubagent = nested.mutations.find(
    (mutation) => mutation.type === "upsert" && mutation.item.kind === "subagent",
  );
  assert.equal(
    nestedSubagent?.type === "upsert" && nestedSubagent.item.kind === "subagent"
      ? nestedSubagent.item.parentId
      : "missing",
    null,
  );
});

test("projects external Claude plans, questions, todo rewrites, and task hooks honestly", () => {
  const projector = new ClaudeHookActivityProjector();
  const question = projector.project(parseClaudeHookInput({
    ...common("PermissionRequest"),
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{
        header: "Storage",
        question: "Which database?",
        options: [{ label: "SQLite", description: "Local", recommended: false }],
        isSecret: true,
      }],
    },
  }), { permissionRequestId: "question-request" });
  const attention = question.mutations.find(
    (mutation) => mutation.type === "upsert" && mutation.item.kind === "attention",
  );
  assert.equal(attention?.type === "upsert" && attention.item.kind === "attention"
    ? attention.item.questions?.[0]?.text
    : null, "Which database?");
  assert.equal(attention?.type === "upsert" && attention.item.kind === "attention"
    ? attention.item.isSecret
    : null, true);
  assert.equal(attention?.type === "upsert" && attention.item.kind === "attention"
    ? attention.item.questions?.[0]?.options[0]?.recommended
    : null, false);
  assert.equal(attention?.type === "upsert" && attention.item.kind === "attention"
    ? attention.item.approvalFacts
    : undefined, null);

  const plan = projector.project(parseClaudeHookInput({
    ...common("PermissionRequest"),
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "# Exact markdown",
      planFilePath: "/tmp/plan.md",
    },
  }), { permissionRequestId: "plan-request" });
  const planItem = plan.mutations.find(
    (mutation) => mutation.type === "upsert" && mutation.item.kind === "plan",
  );
  assert.equal(planItem?.type === "upsert" && planItem.item.kind === "plan"
    ? planItem.item.markdown
    : null, "# Exact markdown");
  assert.equal(planItem?.type === "upsert" && planItem.item.kind === "plan"
    ? planItem.item.path
    : null, "/tmp/plan.md");
  assert.equal(planItem?.type === "upsert" && planItem.item.kind === "plan"
    ? planItem.item.approvalRequestId
    : null, "plan-request");

  const todo = (toolUseId: string, todos: unknown[]) => projector.project(parseClaudeHookInput({
    ...common("PreToolUse"),
    tool_name: "TodoWrite",
    tool_use_id: toolUseId,
    tool_input: { todos },
  })).mutations.find(
    (mutation) => mutation.type === "upsert" && mutation.item.kind === "todo",
  );
  const initial = todo("todo-1", [
    { content: "Inspect", status: "pending", activeForm: "Inspecting" },
    { content: "Build", status: "in_progress", activeForm: "Building" },
  ]);
  assert.equal(initial?.type === "upsert" && initial.item.kind === "todo"
    ? initial.item.steps?.[1]?.detail
    : null, "Building");
  const rewritten = todo("todo-2", [
    { content: "Inspect", status: "completed", activeForm: "Inspecting" },
    { content: "Verify", status: "in_progress", activeForm: "Verifying" },
  ]);
  assert.deepEqual(rewritten?.type === "upsert" && rewritten.item.kind === "todo"
    ? [rewritten.item.added, rewritten.item.removed]
    : null, [1, 1]);
  assert.deepEqual(rewritten?.type === "upsert" && rewritten.item.kind === "todo"
    ? rewritten.item.steps?.map((step) => ({
        text: step.text,
        status: step.status,
        addedAfterStart: step.addedAfterStart,
        removedReason: step.removedReason,
      }))
    : null, [
    { text: "Inspect", status: "completed", addedAfterStart: false, removedReason: null },
    { text: "Verify", status: "in_progress", addedAfterStart: true, removedReason: null },
    { text: "Build", status: "removed", addedAfterStart: false, removedReason: null },
  ]);

  projector.project(parseClaudeHookInput({
    ...common("TaskCreated"),
    task_id: "task-1",
    task_subject: "First",
  }));
  const secondTask = projector.project(parseClaudeHookInput({
    ...common("TaskCreated"),
    task_id: "task-2",
    task_subject: "Second",
  })).mutations[0];
  assert.deepEqual(secondTask?.type === "upsert" && secondTask.item.kind === "todo"
    ? [
        secondTask.item.steps?.length,
        secondTask.item.added,
        secondTask.item.steps?.[0]?.addedAfterStart,
        secondTask.item.steps?.[1]?.addedAfterStart,
      ]
    : null, [2, 1, false, true]);
});

test("folds MessageDisplay deltas without replaying duplicates", () => {
  const projector = new ClaudeHookActivityProjector();
  const first = parseClaudeHookInput({
    ...common("MessageDisplay"),
    turn_id: "turn-1",
    message_id: "message-1",
    index: 0,
    final: false,
    delta: "hello ",
  });
  const second = parseClaudeHookInput({
    ...common("MessageDisplay"),
    turn_id: "turn-1",
    message_id: "message-1",
    index: 1,
    final: true,
    delta: "world",
  });
  projector.project(first);
  const final = projector.project(second).mutations.at(-1);
  assert.equal(final?.type === "upsert" && final.item.kind === "message" ? final.item.text : null, "hello world");
  assert.deepEqual(projector.project(second).mutations, []);
});

test("source arbitration excludes manager-owned sessions and never re-opens transcript polling beside a live bridge", () => {
  const hook = parseClaudeHookInput({ ...common("Stop"), stop_hook_active: false });
  const arbiter = new ClaudeHookSourceArbiter();
  assert.deepEqual(arbiter.accept(hook, { ownerMarker: CLAUDE_MANAGER_OWNER_VALUE, now: 0 }), {
    accepted: false,
    reason: "manager-owned",
  });
  assert.equal(arbiter.shouldPollTranscript("session-1"), true);
  assert.equal(arbiter.accept(hook, { now: 10 }).accepted, true);
  assert.equal(arbiter.shouldPollTranscript("session-1"), false);
  // A single long tool call used to exceed the old health window and hand the
  // same session to the poller as well, so every hook item gained a
  // `transcript:`-prefixed twin. Silence is not evidence the bridge is gone.
  assert.equal(arbiter.lastHookAt("session-1"), 10);
  assert.equal(arbiter.shouldPollTranscript("session-1"), false);
  arbiter.markManagerOwned("session-1");
  assert.equal(arbiter.shouldPollTranscript("session-1"), false);
  arbiter.forget("session-1");
  assert.equal(arbiter.shouldPollTranscript("session-1"), true);
});

test("bridge authenticates, projects, holds, answers, and resolves one external permission", async () => {
  const token = "bridge-token-with-at-least-thirty-two-characters";
  const activity: unknown[] = [];
  const permissionEvents: string[] = [];
  const bridge = new ClaudeHookBridge({
    authorizationRecords: [{
      id: "install-1",
      provider: "claude",
      tokenDigest: digestHookBearerToken(token),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.claude/settings.json",
    }],
    onActivity: (sessionId, mutation) => activity.push({ sessionId, mutation }),
    onPermissionChanged: (event) => permissionEvents.push(event.type),
  });

  const pendingResponse = bridge.handle({
    authorization: `Bearer ${token}`,
    body: permission(),
  });
  await Promise.resolve();
  const request = bridge.pending()[0];
  assert.ok(request);
  assert.equal(permissionEvents[0], "opened");
  assert.equal(bridge.respond(request.id, { behavior: "deny", message: "No" }), true);
  assert.deepEqual(await pendingResponse, {
    statusCode: 200,
    body: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "No" },
      },
    },
  });
  assert.deepEqual(permissionEvents, ["opened", "closed"]);
  assert.equal(activity.length, 2);
  assert.match(JSON.stringify(activity[0]), /"resolved":false/);
  assert.match(JSON.stringify(activity[1]), /"resolved":true/);
  assert.equal(bridge.respond(request.id, { behavior: "allow" }), false);
  bridge.shutdown();
});

test("bridge links and completes only the exact held plan approval", async () => {
  const token = "bridge-token-with-at-least-thirty-two-characters";
  const activity: ActivityMutation[] = [];
  const bridge = new ClaudeHookBridge({
    authorizationRecords: [{
      id: "install-1",
      provider: "claude",
      tokenDigest: digestHookBearerToken(token),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.claude/settings.json",
    }],
    now: () => new Date("2026-08-04T12:01:00.000Z"),
    onActivity: (_sessionId, mutation) => activity.push(mutation),
  });
  const response = bridge.handle({
    authorization: `Bearer ${token}`,
    body: parseClaudeHookInput({
      ...common("PermissionRequest"),
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Execute exactly this" },
    }),
  });
  await Promise.resolve();
  const request = bridge.pending()[0];
  assert.ok(request);
  const pendingPlan = activity.find((mutation) =>
    mutation.type === "upsert" && mutation.item.kind === "plan"
  );
  assert.equal(
    pendingPlan?.type === "upsert" && pendingPlan.item.kind === "plan"
      ? pendingPlan.item.approvalRequestId
      : null,
    request.id,
  );

  assert.equal(bridge.respond(request.id, { behavior: "allow" }), true);
  await response;
  const approvedPlan = [...activity].reverse().find((mutation) =>
    mutation.type === "upsert"
    && mutation.item.kind === "plan"
    && mutation.item.approvedAt !== null
  );
  assert.equal(
    approvedPlan?.type === "upsert" && approvedPlan.item.kind === "plan"
      ? approvedPlan.item.approvedAt
      : null,
    "2026-08-04T12:01:00.000Z",
  );
  assert.equal(
    approvedPlan?.type === "upsert" && approvedPlan.item.kind === "plan"
      ? approvedPlan.item.state
      : null,
    "complete",
  );
  bridge.shutdown();
});

test("bridge rejects unknown auth and ignores manager-owned global hooks", async () => {
  const token = "bridge-token-with-at-least-thirty-two-characters";
  const activity: unknown[] = [];
  const bridge = new ClaudeHookBridge({
    authorizationRecords: [{
      id: "install-1",
      provider: "claude",
      tokenDigest: digestHookBearerToken(token),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.claude/settings.json",
    }],
    onActivity: (_sessionId, mutation) => activity.push(mutation),
  });
  assert.deepEqual(await bridge.handle({
    authorization: "Bearer definitely-not-the-token-but-long-enough",
    body: { ...common("Stop"), stop_hook_active: false },
  }), { statusCode: 401, body: null });
  assert.deepEqual(await bridge.handle({
    authorization: `Bearer ${token}`,
    ownerMarker: CLAUDE_MANAGER_OWNER_VALUE,
    body: { ...common("Stop"), stop_hook_active: false },
  }), { statusCode: 200, body: null });
  assert.deepEqual(activity, []);
  bridge.shutdown();
});

test("bridge maps an AskUserQuestion answer envelope without losing provider input", async () => {
  const token = "bridge-token-with-at-least-thirty-two-characters";
  const bridge = new ClaudeHookBridge({
    authorizationRecords: [{
      id: "install-1",
      provider: "claude",
      tokenDigest: digestHookBearerToken(token),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.claude/settings.json",
    }],
  });
  const body = {
    ...common("PermissionRequest"),
    tool_name: "AskUserQuestion",
    tool_input: {
      metadata: "preserved",
      questions: [{
        header: "Storage",
        question: "Which database?",
        options: [{ label: "SQLite" }, { label: "Postgres" }],
        multiSelect: false,
      }],
    },
  };
  const response = bridge.handle({ authorization: `Bearer ${token}`, body });
  await Promise.resolve();
  const pending = bridge.pending()[0];
  assert.ok(pending);
  assert.equal(bridge.respondWithEnvelope(pending.id, {
    kind: "answer",
    selectedOptions: ["SQLite"],
    value: "with WAL",
  }), true);
  assert.deepEqual(await response, {
    statusCode: 200,
    body: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            metadata: "preserved",
            questions: [{
              header: "Storage",
              question: "Which database?",
              options: [{ label: "SQLite" }, { label: "Postgres" }],
              multiSelect: false,
            }],
            answers: { "Which database?": "SQLite, with WAL" },
          },
        },
      },
    },
  });
  bridge.shutdown();
});

test("bridge returns provider permission suggestions only for explicit persistent approval", async () => {
  const token = "bridge-token-with-at-least-thirty-two-characters";
  const suggestions = [{
    type: "addRules" as const,
    rules: [{ toolName: "Write", ruleContent: "/workspace/**" }],
    behavior: "allow" as const,
    destination: "session" as const,
  }];
  const bridge = new ClaudeHookBridge({
    authorizationRecords: [{
      id: "install-1",
      provider: "claude",
      tokenDigest: digestHookBearerToken(token),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.claude/settings.json",
    }],
  });
  const body = parseClaudeHookInput({
    ...common("PermissionRequest"),
    tool_name: "Write",
    tool_input: { file_path: "/workspace/output.txt" },
    permission_suggestions: suggestions,
  });
  const response = bridge.handle({ authorization: `Bearer ${token}`, body });
  await Promise.resolve();
  const pending = bridge.pending()[0];
  assert.ok(pending);
  assert.deepEqual(pending.permissionSuggestions, suggestions);
  assert.equal(bridge.respondWithEnvelope(pending.id, {
    kind: "decision",
    decision: "allow",
    persist: true,
  }), true);
  assert.deepEqual(await response, {
    statusCode: 200,
    body: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: suggestions },
      },
    },
  });

  const withoutSuggestions = bridge.handle({
    authorization: `Bearer ${token}`,
    body: permission(),
  });
  await Promise.resolve();
  const temporary = bridge.pending()[0];
  assert.ok(temporary);
  assert.throws(() => bridge.respondWithEnvelope(temporary.id, {
    kind: "decision",
    decision: "allow",
    persist: true,
  }), /did not expose a persistent permission choice/);
  assert.equal(bridge.respondWithEnvelope(temporary.id, {
    kind: "decision",
    decision: "allow",
  }), true);
  await withoutSuggestions;
  bridge.shutdown();
});
