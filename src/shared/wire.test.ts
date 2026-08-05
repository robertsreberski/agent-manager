import assert from "node:assert/strict";
import test from "node:test";

import { providerControlCoordination, sessionRecordId } from "./session.ts";
import {
  AGENT_MANAGER_BUILD_ID,
  parseStateEvent,
  parseStateSnapshot,
  WireUpgradeRequiredError,
  WIRE_SCHEMA_VERSION,
} from "./wire.ts";

function snapshot(): unknown {
  return {
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    generatedAt: "2026-08-04T10:00:00.000Z",
    seq: 1,
    stale: false,
    diagnostics: [],
    sessions: [{
      id: "local:codex:thread-1",
      provider: "codex",
      providerThreadId: "thread-1",
      providerTreeId: "tree-1",
      parentId: null,
      providerTurnId: null,
      depth: 0,
      hostId: "local",
      hostLabel: "This Mac",
      name: null,
      cwd: "/tmp/project",
      kind: "interactive",
      archived: false,
      presence: "live",
      status: "idle",
      providerStatus: "idle",
      pid: 123,
      runtimePid: 123,
      startedAt: "2026-08-04T09:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z",
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
      statusSource: "provider-api",
      source: "thread/list",
      profile: {
        value: null,
        providerValue: null,
        source: "inferred",
        confidence: "heuristic",
      },
      sandbox: {
        value: null,
        providerValue: null,
        source: "inferred",
        confidence: "heuristic",
      },
      model: {
        value: "gpt-5.6",
        providerValue: "gpt-5.6",
        source: "provider-api",
        confidence: "exact",
      },
      effort: {
        value: "medium",
        providerValue: "medium",
        source: "provider-api",
        confidence: "exact",
      },
      todoProgress: null,
      attention: [],
      terminal: null,
      control: {
        plane: "codex-private",
        authority: "manager",
        coordination: {
          mode: "shared",
          nativeAttach: "join",
          responseResolution: "first-response-wins",
        },
        recovery: null,
        capabilities: ["queue", "set-profile"],
        withheld: [],
        takeover: null,
      },
      workspaceIdentity: null,
      generation: 4,
    }],
  };
}

test("parses the exact current wire epoch", () => {
  const parsed = parseStateSnapshot(snapshot());
  assert.equal(parsed.schemaVersion, 7);
  assert.equal(parsed.buildId, AGENT_MANAGER_BUILD_ID);
  assert.equal(parsed.sessions[0]?.providerThreadId, "thread-1");
  assert.equal(parsed.sessions[0]?.id, sessionRecordId("local", "codex", "thread-1"));
  assert.equal(parsed.sessions[0]?.profile.value, null);
  assert.deepEqual(providerControlCoordination("codex"), {
    mode: "shared",
    nativeAttach: "join",
    responseResolution: "first-response-wins",
  });
  assert.deepEqual(providerControlCoordination("claude"), {
    mode: "exclusive",
    nativeAttach: "handoff",
    responseResolution: "single-controller",
  });
});

test("requires explicit control coordination and validates bounded recovery state", () => {
  const missingCoordination = snapshot() as { sessions: Array<Record<string, unknown>> };
  const missingControl = missingCoordination.sessions[0]!.control as Record<string, unknown>;
  delete missingControl.coordination;
  assert.throws(() => parseStateSnapshot(missingCoordination));

  const retrying = snapshot() as { sessions: Array<Record<string, unknown>> };
  const retryingControl = retrying.sessions[0]!.control as Record<string, unknown>;
  retryingControl.recovery = {
    state: "retrying",
    attempt: 2,
    startedAt: "2026-08-04T10:00:00.000Z",
    deadlineAt: null,
    nextRetryAt: "2026-08-04T10:00:30.000Z",
    error: "App Server connection closed",
  };
  assert.equal(parseStateSnapshot(retrying).sessions[0]?.control.recovery?.attempt, 2);

  const waiting = snapshot() as { sessions: Array<Record<string, unknown>> };
  const waitingControl = waiting.sessions[0]!.control as Record<string, unknown>;
  waitingControl.recovery = {
    state: "waiting-for-native-exit",
    attempt: 1,
    startedAt: "2026-08-04T10:00:00.000Z",
    deadlineAt: null,
    nextRetryAt: null,
    error: "Claude Code still owns this conversation",
  };
  assert.equal(
    parseStateSnapshot(waiting).sessions[0]?.control.recovery?.state,
    "waiting-for-native-exit",
  );

  for (const [field, value, expected] of [
    ["deadlineAt", "2026-08-04T10:00:30.000Z", /recovery deadline/u],
    ["nextRetryAt", "2026-08-04T10:00:30.000Z", /internal poll time/u],
    ["error", null, /ownership reason/u],
  ] as const) {
    const invalidWaiting = structuredClone(waiting);
    const invalidControl = invalidWaiting.sessions[0]!.control as Record<string, unknown>;
    const invalidRecovery = invalidControl.recovery as Record<string, unknown>;
    invalidRecovery[field] = value;
    assert.throws(() => parseStateSnapshot(invalidWaiting), expected);
  }

  const missingRetryTime = snapshot() as { sessions: Array<Record<string, unknown>> };
  const missingRetryControl = missingRetryTime.sessions[0]!.control as Record<string, unknown>;
  missingRetryControl.recovery = {
    state: "retrying",
    attempt: 1,
    startedAt: "2026-08-04T10:00:00.000Z",
    deadlineAt: null,
    nextRetryAt: null,
    error: "temporarily unavailable",
  };
  assert.throws(() => parseStateSnapshot(missingRetryTime), /next retry time/u);

  const attentionWithoutError = snapshot() as { sessions: Array<Record<string, unknown>> };
  const attentionControl = attentionWithoutError.sessions[0]!.control as Record<string, unknown>;
  attentionControl.recovery = {
    state: "needs-attention",
    attempt: 3,
    startedAt: "2026-08-04T10:00:00.000Z",
    deadlineAt: null,
    nextRetryAt: null,
    error: null,
  };
  assert.throws(() => parseStateSnapshot(attentionWithoutError), /requires an error/u);

  const impossibleCoordination = snapshot() as { sessions: Array<Record<string, unknown>> };
  const impossibleControl = impossibleCoordination.sessions[0]!.control as Record<string, unknown>;
  impossibleControl.coordination = {
    mode: "exclusive",
    nativeAttach: "join",
    responseResolution: "single-controller",
  };
  assert.throws(() => parseStateSnapshot(impossibleCoordination), /join requires shared/u);
});

test("parses the server-issued graceful-stop confirmation phase", () => {
  const value = snapshot() as { sessions: Array<Record<string, unknown>> };
  const control = value.sessions[0]!.control as Record<string, unknown>;
  control.takeover = {
    id: "takeover-1",
    state: "awaiting-confirmation",
    methods: ["guided-exit", "graceful-stop"],
    method: "graceful-stop",
    requestedAt: "2026-08-04T10:00:00.000Z",
    deadlineAt: null,
    fallbackProfile: null,
    fallbackSandbox: null,
    error: null,
  };
  assert.equal(
    parseStateSnapshot(value).sessions[0]?.control.takeover?.state,
    "awaiting-confirmation",
  );
  const invalid = structuredClone(value);
  const invalidControl = invalid.sessions[0]!.control as Record<string, unknown>;
  (invalidControl.takeover as Record<string, unknown>).method = "guided-exit";
  assert.throws(() => parseStateSnapshot(invalid), /exact method/u);
});

test("accepts Codex ultra and preserves unknown provider effort outside the public value", () => {
  const ultra = snapshot() as { sessions: Array<Record<string, unknown>> };
  ultra.sessions[0]!.effort = {
    value: "ultra",
    providerValue: "ultra",
    source: "provider-api",
    confidence: "exact",
  };
  assert.equal(parseStateSnapshot(ultra).sessions[0]?.effort.value, "ultra");

  const unknown = snapshot() as { sessions: Array<Record<string, unknown>> };
  unknown.sessions[0]!.effort = {
    value: null,
    providerValue: "bogusvalue",
    source: "provider-cli",
    confidence: "exact",
  };
  assert.deepEqual(parseStateSnapshot(unknown).sessions[0]?.effort, {
    value: null,
    providerValue: "bogusvalue",
    source: "provider-cli",
    confidence: "exact",
  });

  const leaked = snapshot() as { sessions: Array<Record<string, unknown>> };
  leaked.sessions[0]!.effort = {
    value: "bogusvalue",
    providerValue: "bogusvalue",
    source: "provider-cli",
    confidence: "exact",
  };
  assert.throws(() => parseStateSnapshot(leaked));

  const unsupportedClaude = snapshot() as { sessions: Array<Record<string, unknown>> };
  unsupportedClaude.sessions[0]!.provider = "claude";
  unsupportedClaude.sessions[0]!.id = "local:claude:thread-1";
  unsupportedClaude.sessions[0]!.effort = {
    value: "ultra",
    providerValue: "ultra",
    source: "provider-api",
    confidence: "exact",
  };
  assert.throws(() => parseStateSnapshot(unsupportedClaude), /claude does not support ultra/u);
});

test("rejects old epochs and removed compatibility aliases", () => {
  const wrongEpoch = snapshot() as Record<string, unknown>;
  wrongEpoch.schemaVersion = 2;
  assert.throws(() => parseStateSnapshot(wrongEpoch), WireUpgradeRequiredError);

  const wrongBuild = snapshot() as Record<string, unknown>;
  wrongBuild.buildId = "stale-build";
  assert.throws(() => parseStateSnapshot(wrongBuild), (error: unknown) =>
    error instanceof WireUpgradeRequiredError
    && error.code === "UPGRADE_REQUIRED"
    && error.received.buildId === "stale-build");

  const missingBuild = snapshot() as Record<string, unknown>;
  delete missingBuild.buildId;
  assert.throws(() => parseStateSnapshot(missingBuild), WireUpgradeRequiredError);

  const aliased = snapshot() as { sessions: Array<Record<string, unknown>> };
  aliased.sessions[0]!.sessionId = "thread-1";
  assert.throws(() => parseStateSnapshot(aliased));
});

test("requires provider-qualified identity and nullable workspace identity", () => {
  const wrongId = snapshot() as { sessions: Array<Record<string, unknown>> };
  wrongId.sessions[0]!.id = "thread-1";
  assert.throws(() => parseStateSnapshot(wrongId), /provider-qualified/);

  const missingWorkspace = snapshot() as { sessions: Array<Record<string, unknown>> };
  delete missingWorkspace.sessions[0]!.workspaceIdentity;
  assert.throws(() => parseStateSnapshot(missingWorkspace));
});

test("todo progress is required metadata and cannot carry content", () => {
  const value = snapshot() as { sessions: Array<Record<string, unknown>> };
  value.sessions[0]!.todoProgress = {
    completed: 2,
    total: 3,
    hasMoved: true,
    lastTransitionAt: "2026-08-04T09:59:00.000Z",
    active: true,
  };
  assert.deepEqual(parseStateSnapshot(value).sessions[0]?.todoProgress, {
    completed: 2,
    total: 3,
    hasMoved: true,
    lastTransitionAt: "2026-08-04T09:59:00.000Z",
    active: true,
  });

  const missing = snapshot() as { sessions: Array<Record<string, unknown>> };
  delete missing.sessions[0]!.todoProgress;
  assert.throws(() => parseStateSnapshot(missing));

  const content = snapshot() as { sessions: Array<Record<string, unknown>> };
  content.sessions[0]!.todoProgress = {
    completed: 1,
    total: 2,
    hasMoved: false,
    lastTransitionAt: null,
    active: true,
    current: "secret todo text",
  };
  assert.throws(() => parseStateSnapshot(content));

  const impossible = snapshot() as { sessions: Array<Record<string, unknown>> };
  impossible.sessions[0]!.todoProgress = {
    completed: 3,
    total: 2,
    hasMoved: false,
    lastTransitionAt: null,
    active: false,
  };
  assert.throws(() => parseStateSnapshot(impossible), /cannot exceed/);

  const inventedMovement = snapshot() as { sessions: Array<Record<string, unknown>> };
  inventedMovement.sessions[0]!.todoProgress = {
    completed: 1,
    total: 2,
    hasMoved: false,
    lastTransitionAt: "2026-08-04T09:59:00.000Z",
    active: true,
  };
  assert.throws(() => parseStateSnapshot(inventedMovement), /must agree/);

  const completedActive = snapshot() as { sessions: Array<Record<string, unknown>> };
  completedActive.sessions[0]!.todoProgress = {
    completed: 2,
    total: 2,
    hasMoved: true,
    lastTransitionAt: "2026-08-04T09:59:00.000Z",
    active: true,
  };
  assert.throws(() => parseStateSnapshot(completedActive), /cannot be active/);
});

test("rejects respondable heuristic attention without an exact request id", () => {
  const value = snapshot() as { sessions: Array<Record<string, unknown>> };
  value.sessions[0]!.attention = [{
    id: null,
    kind: "question",
    summary: "looks blocked",
    source: "transcript",
    confidence: "heuristic",
    details: {
      title: null,
      questions: null,
      toolName: null,
      inputSummary: null,
      respondable: true,
    },
  }];
  assert.throws(() => parseStateSnapshot(value), /cannot be respondable/);
});

test("state events carry the same epoch and exact typed payloads", () => {
  assert.equal(parseStateEvent({
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    seq: 2,
    at: "2026-08-04T10:00:01.000Z",
    type: "action.updated",
    payload: {
      id: "action-1",
      sessionId: "local:codex:thread-1",
      type: "set-profile",
      status: "succeeded",
      createdAt: "2026-08-04T10:00:00.000Z",
      completedAt: "2026-08-04T10:00:01.000Z",
      error: null,
    },
  }).type, "action.updated");

  const retryEvent = parseStateEvent({
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    seq: 3,
    at: "2026-08-04T10:00:02.000Z",
    type: "action.updated",
    payload: {
      id: "action-2",
      sessionId: "local:codex:thread-1",
      type: "retry-control",
      status: "succeeded",
      createdAt: "2026-08-04T10:00:01.000Z",
      completedAt: "2026-08-04T10:00:02.000Z",
      error: null,
    },
  });
  assert.equal(retryEvent.type, "action.updated");
  if (retryEvent.type !== "action.updated") assert.fail("retry event was not an action update");
  assert.equal(retryEvent.payload.type, "retry-control");

  const resumeEvent = parseStateEvent({
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    seq: 4,
    at: "2026-08-04T10:00:03.000Z",
    type: "action.updated",
    payload: {
      id: "action-3",
      sessionId: "local:codex:thread-1",
      type: "resume",
      status: "succeeded",
      createdAt: "2026-08-04T10:00:02.000Z",
      completedAt: "2026-08-04T10:00:03.000Z",
      error: null,
    },
  });
  assert.equal(resumeEvent.type, "action.updated");
  if (resumeEvent.type !== "action.updated") assert.fail("resume event was not an action update");
  assert.equal(resumeEvent.payload.type, "resume");

  assert.throws(() => parseStateEvent({
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    seq: 2,
    at: "2026-08-04T10:00:01.000Z",
    type: "session.remove",
    payload: { id: "local:codex:thread-1", sessionId: "removed-alias" },
  }));
});
