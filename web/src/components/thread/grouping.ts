export type ActivityGroupKey = "group-thought" | "group-tools" | "group-subagent";

export interface GroupablePart {
  type: string;
  name?: string;
  data?: unknown;
  toolName?: string;
}

/** Adjacent grouping only; provider order remains the rendered order. */
export function groupActivityPart(part: GroupablePart): readonly ActivityGroupKey[] {
  if (part.type === "reasoning") return ["group-thought"];
  if (part.type === "tool-call") return ["group-thought", "group-tools"];
  if (part.type === "data" && part.name === "agent-manager.subagent") return ["group-subagent"];
  return [];
}

export function displayDuration(timing: { startedAt: number; completedAt?: number } | undefined): string | null {
  if (!timing || timing.completedAt === undefined) return null;
  const elapsed = timing.completedAt - timing.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return elapsed < 1_000 ? `${Math.round(elapsed)}ms` : `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0)}s`;
}

interface TimedGroupPart {
  type: string;
  timing?: { startedAt: number; completedAt?: number } | undefined;
}

/** Returns an exact wall-clock span only when every tool in the group has complete timing. */
export function toolGroupTiming(
  parts: readonly TimedGroupPart[],
  indices: readonly number[],
): { startedAt: number; completedAt: number } | undefined {
  const tools = indices
    .map((index) => parts[index])
    .filter((part): part is TimedGroupPart => part?.type === "tool-call");
  if (tools.length === 0 || tools.some((part) => (
    part.timing === undefined
    || !Number.isFinite(part.timing.startedAt)
    || part.timing.completedAt === undefined
    || !Number.isFinite(part.timing.completedAt)
    || part.timing.completedAt < part.timing.startedAt
  ))) return undefined;
  return {
    startedAt: Math.min(...tools.map((part) => part.timing!.startedAt)),
    completedAt: Math.max(...tools.map((part) => part.timing!.completedAt!)),
  };
}
