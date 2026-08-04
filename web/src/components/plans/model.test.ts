import { describe, expect, it } from "vitest";
import { planHeading, todoCounts, todoStallMinutes, type TodoListView } from "./model";

const list: TodoListView = { id: "t", running: true, active: true, hasMoved: true, added: 1, removed: 1, duration: null, lastTransitionAt: "2026-08-04T12:00:00Z", steps: [
  { id: "a", text: "Done", status: "completed", detail: null, removedReason: null, addedAfterStart: false },
  { id: "b", text: "Now", status: "in-progress", detail: "working", removedReason: null, addedAfterStart: true },
  { id: "c", text: "Dropped", status: "removed", detail: null, removedReason: "no longer needed", addedAfterStart: false },
] };

describe("plan and todos", () => {
  it("keeps the plan prose and extracts only its own first heading", () => expect(planHeading("intro\n## Exact title\nbody")).toBe("Exact title"));
  it("does not count removed entries as live progress", () => expect(todoCounts(list)).toEqual({ completed: 1, active: 1, total: 2 }));
  it("derives stalling only after an observed todo transition", () => {
    expect(todoStallMinutes(list, Date.parse("2026-08-04T12:20:00Z"))).toBe(20);
    expect(todoStallMinutes({ ...list, hasMoved: false, lastTransitionAt: null }, Date.parse("2026-08-04T12:20:00Z"))).toBeNull();
  });
});
