import assert from "node:assert/strict";
import test from "node:test";

import { selectedTodoDetailResponseSchema } from "./todo-detail.ts";

test("selected todo detail accepts only one bounded current projection", () => {
  assert.deepEqual(selectedTodoDetailResponseSchema.parse({
    sessionId: "local:codex:thread-1",
    generation: 4,
    todo: {
      completed: 1,
      total: 3,
      current: "Implement the exact route",
    },
  }), {
    sessionId: "local:codex:thread-1",
    generation: 4,
    todo: {
      completed: 1,
      total: 3,
      current: "Implement the exact route",
    },
  });

  assert.throws(() => selectedTodoDetailResponseSchema.parse({
    sessionId: "local:codex:thread-1",
    generation: 4,
    todo: {
      completed: 2,
      total: 1,
      current: null,
      pending: ["must not cross the boundary"],
    },
  }));
});
