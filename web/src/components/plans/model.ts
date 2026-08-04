export interface PlanArtifactView {
  id: string;
  path: string | null;
  version: number | null;
  markdown: string;
  writtenAt: string | null;
  supersededBy: string | null;
  approvedAt: string | null;
}

export type TodoStatus = "pending" | "in-progress" | "completed" | "removed";

export interface TodoStepView {
  id: string;
  text: string;
  status: TodoStatus;
  detail: string | null;
  removedReason: string | null;
  addedAfterStart: boolean;
}

export interface TodoListView {
  id: string;
  steps: readonly TodoStepView[];
  added: number;
  removed: number;
  running: boolean;
  active: boolean;
  hasMoved: boolean;
  duration: string | null;
  lastTransitionAt: string | null;
}

export function planHeading(markdown: string): string {
  const heading = markdown.split(/\r?\n/u).find((line) => /^#{1,6}\s+\S/u.test(line));
  return heading?.replace(/^#{1,6}\s+/u, "").trim() || "Untitled plan";
}

export function todoCounts(list: TodoListView): { completed: number; active: number; total: number } {
  const visible = list.steps.filter((step) => step.status !== "removed");
  return {
    completed: visible.filter((step) => step.status === "completed").length,
    active: visible.filter((step) => step.status === "in-progress").length,
    total: visible.length,
  };
}

export function todoStallMinutes(list: TodoListView, now = Date.now()): number | null {
  if (!list.running || !list.active || !list.hasMoved || !list.lastTransitionAt) return null;
  const then = Date.parse(list.lastTransitionAt);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / 60_000));
}
