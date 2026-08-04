import type { ActivityTodoStep } from "./types.ts";

export interface ActivityTodoInputStep {
  id: string;
  text: string;
  status: Exclude<ActivityTodoStep["status"], "removed">;
  detail: string | null;
}

export interface ActivityTodoRewriteState {
  steps: readonly ActivityTodoStep[];
  added: number;
  removed: number;
}

/**
 * Preserve one provider-owned checklist across whole-list rewrites.
 *
 * The provider's stable ID is the only identity fact. Missing live IDs become
 * tombstones; new IDs become additions after the baseline. A removal reason is
 * accepted only through the explicit provider-supplied map and is never
 * synthesized from replacement order, text, or status.
 */
export function reconcileTodoRewrite(
  previous: ActivityTodoRewriteState | null,
  next: readonly ActivityTodoInputStep[],
  providerRemovalReasons: ReadonlyMap<string, string> = new Map(),
): ActivityTodoRewriteState {
  const nextIds = new Set<string>();
  for (const step of next) {
    if (nextIds.has(step.id)) throw new RangeError(`duplicate todo step id: ${step.id}`);
    nextIds.add(step.id);
  }

  const previousSteps = previous?.steps ?? [];
  const previousLive = new Map(
    previousSteps
      .filter((step) => step.status !== "removed")
      .map((step) => [step.id, step] as const),
  );
  const previousRemoved = previousSteps.filter((step) => step.status === "removed");
  const newlyRemoved = [...previousLive.values()].filter((step) => !nextIds.has(step.id));

  const live: ActivityTodoStep[] = next.map((step) => ({
    ...step,
    addedAfterStart: previous === null
      ? false
      : previousLive.get(step.id)?.addedAfterStart ?? true,
    removedReason: null,
  }));
  const retainedTombstones = previousRemoved.filter((step) => !nextIds.has(step.id));
  const tombstones: ActivityTodoStep[] = newlyRemoved.map((step) => ({
    ...step,
    status: "removed",
    removedReason: providerRemovalReasons.get(step.id) ?? null,
  }));

  return {
    steps: [...live, ...retainedTombstones, ...tombstones],
    added: (previous?.added ?? 0) + (previous === null
      ? 0
      : next.filter((step) => !previousLive.has(step.id)).length),
    removed: (previous?.removed ?? 0) + newlyRemoved.length,
  };
}
