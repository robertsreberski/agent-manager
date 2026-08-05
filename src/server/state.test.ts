import assert from "node:assert/strict";
import test from "node:test";

import { observeOnlyControl, type SessionRecord } from "../shared/session.ts";
import { AGENT_MANAGER_BUILD_ID, WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import { SessionStateStore } from "./state.ts";
import { unknownSandbox } from "../shared/session.ts";

function strictSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "local:codex:thread-1",
    provider: "codex",
    providerThreadId: "thread-1",
    providerTreeId: "thread-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Private conversation",
    cwd: "/tmp/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: null,
    runtimePid: null,
    startedAt: null,
    updatedAt: "2026-08-03T00:00:00.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "transcript",
    source: "fixture",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    sandbox: unknownSandbox(),
    model: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    effort: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: observeOnlyControl(),
    workspaceIdentity: null,
    generation: 0,
    ...overrides,
  };
}

test("snapshot and replay use the strict shared wire epoch", () => {
  const state = new SessionStateStore();
  state.upsert(strictSession());

  assert.equal(state.snapshot().schemaVersion, WIRE_SCHEMA_VERSION);
  assert.equal(state.snapshot().buildId, AGENT_MANAGER_BUILD_ID);
  const event = state.events.replayAfter(0).events[0]!;
  assert.equal(event.schemaVersion, WIRE_SCHEMA_VERSION);
  assert.equal(event.buildId, AGENT_MANAGER_BUILD_ID);
  assert.equal(event.type, "session.upsert");
});

test("global state retains request identity but strips selected-session content", () => {
  const state = new SessionStateStore();
  state.upsert(strictSession({
    attention: [{
      id: "request-sensitive-1",
      kind: "question",
      summary: "Which production credential should I use?",
      source: "provider-api",
      confidence: "exact",
      details: {
        title: "Sensitive choice",
        inputSummary: "authorization=Bearer should-not-leak",
        toolName: "request_user_input",
        respondable: true,
        questions: [{
          id: "credential",
          header: "Credential",
          text: "Which production credential should I use?",
          options: [{ label: "The secret production token", description: "Exact provider detail" }],
          multiSelect: false,
          allowFreeText: true,
          isSecret: true,
        }],
      },
    }],
  }));

  for (const serialized of [
    JSON.stringify(state.snapshot()),
    JSON.stringify(state.events.replayAfter(0)),
  ]) {
    assert.doesNotMatch(serialized, /production credential|secret production token|Bearer|Sensitive choice/);
    assert.match(serialized, /request-sensitive-1/);
    assert.match(serialized, /"respondable":true/);
  }
});

test("runtime diagnostics survive discovery diagnostic replacement", () => {
  const state = new SessionStateStore();
  const runtime = {
    provider: "codex" as const,
    level: "error" as const,
    message: "Managed Codex runtime exited unexpectedly",
  };
  const discovery = {
    provider: "claude" as const,
    level: "warning" as const,
    message: "Claude discovery was temporarily unavailable",
  };

  state.addDiagnostic(runtime);
  state.replace([], [discovery]);
  assert.deepEqual(state.snapshot().diagnostics, [discovery, runtime]);
  state.replace([], []);
  assert.deepEqual(state.snapshot().diagnostics, [runtime]);
});

test("a transient unknown profile does not erase the last resolved profile", () => {
  const state = new SessionStateStore();
  state.replace([strictSession({
    profile: {
      value: "plan",
      providerValue: "collaboration=plan",
      source: "rollout-events",
      confidence: "inferred",
    },
  })]);

  state.replace([strictSession({
    updatedAt: "2026-08-03T00:01:00.000Z",
  })]);
  assert.deepEqual(state.get("local:codex:thread-1")?.profile, {
    value: "plan",
    providerValue: "collaboration=plan",
    source: "rollout-events",
    confidence: "inferred",
  });

  state.replace([strictSession({
    updatedAt: "2026-08-03T00:02:00.000Z",
    profile: {
      value: null,
      providerValue: "future-provider-mode",
      source: "provider-api",
      confidence: "exact",
    },
  })]);
  assert.deepEqual(state.get("local:codex:thread-1")?.profile, {
    value: null,
    providerValue: "future-provider-mode",
    source: "provider-api",
    confidence: "exact",
  });
});

test("activity todo metadata survives discovery refresh and never carries content", () => {
  const state = new SessionStateStore();
  const movingProgress = {
    completed: 1,
    total: 3,
    hasMoved: true,
    lastTransitionAt: "2026-08-03T00:00:30.000Z",
    active: true,
  } as const;
  state.setTodoProgress("local:codex:thread-1", movingProgress);
  state.replace([strictSession()]);
  assert.deepEqual(state.get("local:codex:thread-1")?.todoProgress, {
    completed: 1,
    total: 3,
    hasMoved: true,
    lastTransitionAt: "2026-08-03T00:00:30.000Z",
    active: true,
  });

  state.replace([strictSession({
    updatedAt: "2026-08-03T00:01:00.000Z",
    todoProgress: null,
  })]);
  assert.deepEqual(state.get("local:codex:thread-1")?.todoProgress, {
    completed: 1,
    total: 3,
    hasMoved: true,
    lastTransitionAt: "2026-08-03T00:00:30.000Z",
    active: true,
  });
  for (const serialized of [
    JSON.stringify(state.snapshot()),
    JSON.stringify(state.events.replayAfter(0)),
  ]) {
    assert.match(serialized, /"todoProgress":\{"completed":1,"total":3,"hasMoved":true,"lastTransitionAt":"2026-08-03T00:00:30.000Z","active":true\}/);
    assert.doesNotMatch(serialized, /steps|private todo|detail/);
  }

  state.setTodoProgress("local:codex:thread-1", null);
  state.replace([strictSession({
    todoProgress: {
      completed: 3,
      total: 3,
      hasMoved: true,
      lastTransitionAt: "2026-08-03T00:01:30.000Z",
      active: false,
    },
  })]);
  assert.equal(state.get("local:codex:thread-1")?.todoProgress, null);
  assert.throws(
    () => state.setTodoProgress("local:codex:thread-1", {
      completed: 4,
      total: 3,
      hasMoved: false,
      lastTransitionAt: null,
      active: false,
    }),
    /cannot exceed/,
  );
  assert.throws(
    () => state.setTodoProgress("local:codex:thread-1", {
      ...movingProgress,
      current: "private todo",
    } as typeof movingProgress),
    /exact metadata fields/,
  );
  assert.throws(
    () => state.setTodoProgress("local:codex:thread-1", {
      ...movingProgress,
      hasMoved: false,
    }),
    /must agree/,
  );

  state.setTodoProgress("local:codex:thread-1", {
    completed: 2,
    total: 4,
    hasMoved: false,
    lastTransitionAt: null,
    active: false,
  });
  state.replace([]);
  state.replace([strictSession()]);
  assert.equal(state.get("local:codex:thread-1")?.todoProgress, null);
});
