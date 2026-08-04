import { describe, expect, it } from "vitest";

import type { ActivityTodoItem, SessionActivityView } from "../types";
import { currentTodo, sessionTodoProgress, todoView } from "./session-activity";

const todo: ActivityTodoItem = {
  schemaVersion: 3,
  id: "todo-1",
  sessionId: "local:codex:thread-1",
  provider: "codex",
  kind: "todo",
  turnId: "turn-1",
  parentId: null,
  seq: 4,
  revision: 2,
  state: "running",
  startedAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:01:00.000Z",
  completedAt: null,
  source: "provider-api",
  confidence: "exact",
  exposure: "provider-exposed",
  truncated: false,
  steps: [
    { id: "keep", text: "Keep", status: "in_progress", detail: "Working", addedAfterStart: false, removedReason: null },
    { id: "new", text: "New", status: "pending", detail: null, addedAfterStart: true, removedReason: null },
    { id: "drop", text: "Dropped", status: "removed", detail: null, addedAfterStart: false, removedReason: null },
  ],
  added: 1,
  removed: 1,
};

describe("todo activity view", () => {
  it("carries real provider churn rows instead of hard-coded defaults", () => {
    expect(todoView(todo).steps).toEqual([
      { id: "keep", text: "Keep", status: "in-progress", detail: "Working", addedAfterStart: false, removedReason: null },
      { id: "new", text: "New", status: "pending", detail: null, addedAfterStart: true, removedReason: null },
      { id: "drop", text: "Dropped", status: "removed", detail: null, addedAfterStart: false, removedReason: null },
    ]);
  });

  it("excludes retained tombstones from selected-session progress", () => {
    const activity: SessionActivityView = {
      sessionId: todo.sessionId,
      items: [todo],
      truncated: false,
      streamEpoch: "epoch",
      cursor: "cursor",
      seq: 4,
      connection: "open",
      updateCount: 1,
    };
    expect(todo.kind).toBe("todo");
    expect(currentTodo(activity)).toBe(todo);
    expect(sessionTodoProgress(activity)).toEqual({ completed: 0, total: 2, current: "Keep" });
  });
});
