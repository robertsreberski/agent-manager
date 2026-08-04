import { describe, expect, it } from "vitest";
import type { SelectedTodoDetailResponse } from "../lib/api";
import { hydrateTodoDetails, todoDetailCandidates, type TodoDetailCandidate } from "./use-todo-details";

describe("todo detail hydration", () => {
  it("selects only sessions with a real counts-only todo projection", () => {
    expect(todoDetailCandidates([
      { id: "none", generation: 1, todoProgress: null },
      { id: "empty", generation: 2, todoProgress: { completed: 0, total: 0, active: false, hasMoved: false, lastTransitionAt: null } },
      { id: "live", generation: 3, todoProgress: { completed: 1, total: 3, active: true, hasMoved: true, lastTransitionAt: "2026-08-04T12:00:00Z" } },
    ])).toEqual([{ sessionId: "live", generation: 3, completed: 1, total: 3 }]);
  });

  it("keeps stale or count-mismatched content off the board", async () => {
    const candidates: TodoDetailCandidate[] = [
      { sessionId: "exact", generation: 4, completed: 1, total: 3 },
      { sessionId: "stale", generation: 8, completed: 0, total: 2 },
      { sessionId: "mismatch", generation: 5, completed: 0, total: 2 },
      { sessionId: "metadata-only", generation: 2, completed: 2, total: 2 },
    ];
    const responses: Record<string, SelectedTodoDetailResponse> = {
      exact: { sessionId: "exact", generation: 4, todo: { completed: 1, total: 3, current: "Current exact todo" } },
      stale: { sessionId: "stale", generation: 7, todo: { completed: 0, total: 2, current: "Stale private todo" } },
      mismatch: { sessionId: "mismatch", generation: 5, todo: { completed: 1, total: 2, current: "Mismatched private todo" } },
      "metadata-only": { sessionId: "metadata-only", generation: 2, todo: null },
    };

    const result = await hydrateTodoDetails(candidates, async (sessionId) => responses[sessionId]!);
    expect([...result.entries()]).toEqual([
      ["exact", { completed: 1, total: 3, current: "Current exact todo" }],
      ["metadata-only", { completed: 2, total: 2, current: null }],
    ]);
    expect(JSON.stringify([...result.values()])).not.toContain("private todo");
  });

  it("bounds concurrent per-session reads", async () => {
    let active = 0;
    let maximum = 0;
    const candidates = Array.from({ length: 8 }, (_, index): TodoDetailCandidate => ({
      sessionId: `session-${index}`,
      generation: 1,
      completed: 0,
      total: 1,
    }));
    await hydrateTodoDetails(candidates, async (sessionId) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return { sessionId, generation: 1, todo: { completed: 0, total: 1, current: null } };
    }, 2);
    expect(maximum).toBe(2);
  });
});
