import type { ActivityState } from "../../types";

interface FileChangeState {
  turnId: string | null;
  state: ActivityState;
}

interface GroupActivityState {
  turnId: string | null;
  kind: string;
  event?: string;
}

const ACTIVE_STATES: ReadonlySet<ActivityState> = new Set(["pending", "running", "waiting"]);
const TERMINAL_EVENTS = new Set(["turn-completed", "turn-failed", "turn-interrupted"]);

/**
 * A Codex turn diff can remain marked running after its terminal lifecycle item
 * arrives. Treat that exact lifecycle event as the group completion signal so
 * the final full-replacement diff is never left behind the active debounce.
 */
export function fileChangeIsUpserting(
  item: FileChangeState,
  group: readonly GroupActivityState[],
): boolean {
  const turnCompleted = item.turnId !== null && group.some((candidate) => (
    candidate.turnId === item.turnId
    && candidate.kind === "lifecycle"
    && candidate.event !== undefined
    && TERMINAL_EVENTS.has(candidate.event)
  ));
  return !turnCompleted && ACTIVE_STATES.has(item.state);
}
