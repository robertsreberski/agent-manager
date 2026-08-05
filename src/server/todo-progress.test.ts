import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub } from "../activity/index.ts";
import {
  providerControlCoordination,
  type SessionRecord,
} from "../shared/session.ts";
import { createAgentManagerServer } from "./server.ts";

function session(updatedAt = "2026-08-04T10:00:00.000Z"): SessionRecord {
  return {
    id: "local:claude:thread-1",
    provider: "claude",
    providerThreadId: "thread-1",
    providerTreeId: "thread-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Todo session",
    cwd: "/tmp/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "running",
    providerStatus: "running",
    pid: null,
    runtimePid: null,
    startedAt: "2026-08-04T09:00:00.000Z",
    updatedAt,
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
    todoProgress: null,
    statusSource: "provider-api",
    source: "fixture",
    profile: { value: "execute", providerValue: "default", source: "provider-api", confidence: "exact" },
    model: { value: null, providerValue: null, source: "provider-api", confidence: "exact" },
    effort: { value: null, providerValue: null, source: "provider-api", confidence: "exact" },
    attention: [],
    terminal: null,
    control: {
      plane: "claude-hook-bridge",
      authority: "foreign",
      coordination: providerControlCoordination("claude"),
      recovery: null,
      capabilities: [],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 0,
  };
}

test("server projects todo counts globally without leaking selected-session content", async (t) => {
  let now = Date.parse("2026-08-04T10:00:00.000Z");
  const activityHub = new ActivityHub({ streamEpoch: "global-todo-progress", now: () => now });
  activityHub.ingest("local:claude:thread-1", "claude", {
    type: "upsert",
    item: {
      id: "todos",
      kind: "todo",
      steps: [
        { id: "one", text: "private completed todo", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
        { id: "two", text: "private current todo", status: "in_progress", detail: "secret detail", addedAfterStart: false, removedReason: null },
      ],
      added: 2,
      removed: 0,
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    activityHub,
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  assert.deepEqual(backend.state.get("local:claude:thread-1")?.todoProgress, {
    completed: 1,
    total: 2,
    hasMoved: false,
    lastTransitionAt: null,
    active: true,
  });

  backend.replaceSessions([session("2026-08-04T10:01:00.000Z")]);
  assert.deepEqual(backend.state.get("local:claude:thread-1")?.todoProgress, {
    completed: 1,
    total: 2,
    hasMoved: false,
    lastTransitionAt: null,
    active: true,
  });

  now = Date.parse("2026-08-04T10:02:00.000Z");
  activityHub.ingest("local:claude:thread-1", "claude", {
    type: "upsert",
    item: {
      id: "todos",
      kind: "todo",
      steps: [
        { id: "one", text: "private completed todo", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
        { id: "two", text: "private current todo", status: "completed", detail: "secret detail", addedAfterStart: false, removedReason: null },
      ],
    },
  });
  assert.deepEqual(backend.state.get("local:claude:thread-1")?.todoProgress, {
    completed: 2,
    total: 2,
    hasMoved: true,
    lastTransitionAt: "2026-08-04T10:02:00.000Z",
    active: false,
  });

  for (const serialized of [
    JSON.stringify(backend.state.snapshot()),
    JSON.stringify(backend.state.events.replayAfter(0)),
  ]) {
    assert.match(serialized, /"todoProgress":\{"completed":2,"total":2,"hasMoved":true,"lastTransitionAt":"2026-08-04T10:02:00.000Z","active":false\}/);
    assert.doesNotMatch(serialized, /private completed|private current|secret detail|"steps"/);
  }

  activityHub.ingest("local:claude:thread-1", "claude", {
    type: "remove",
    id: "todos",
  });
  assert.equal(backend.state.get("local:claude:thread-1")?.todoProgress, null);
});
