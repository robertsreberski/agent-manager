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

/** Argument names, in the order a human scans a tool row for "what did it touch". */
const DETAIL_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
] as const;
/** Wrappers a provider uses when it hands the real arguments over as text. */
const WRAPPER_KEYS = ["input", "arguments", "args"] as const;
const DETAIL_MAX_CHARS = 200;
const MAX_DETAIL_DEPTH = 2;

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedObject(value: string): Record<string, unknown> | null {
  const candidate = value.trim();
  if (!candidate.startsWith("{")) return null;
  try {
    return plainObject(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function serializedShape(value: string): boolean {
  const candidate = value.trim();
  return (candidate.startsWith("{") && candidate.endsWith("}"))
    || (candidate.startsWith("[") && candidate.endsWith("]"));
}

function summarise(value: string): string | null {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > DETAIL_MAX_CHARS
    ? `${collapsed.slice(0, DETAIL_MAX_CHARS - 1)}…`
    : collapsed;
}

function detailFrom(value: unknown, depth: number): string | null {
  if (typeof value === "string") {
    const parsed = depth < MAX_DETAIL_DEPTH ? parsedObject(value) : null;
    if (parsed) return detailFrom(parsed, depth + 1);
    return serializedShape(value) ? null : summarise(value);
  }
  const record = plainObject(value);
  if (!record) return null;
  for (const key of DETAIL_KEYS) {
    const named = record[key];
    if (typeof named === "string") {
      const detail = summarise(named);
      if (detail) return detail;
    }
  }
  for (const key of WRAPPER_KEYS) {
    const wrapped = record[key];
    if (typeof wrapped !== "string" || depth >= MAX_DETAIL_DEPTH) continue;
    const parsed = parsedObject(wrapped);
    const detail = parsed ? detailFrom(parsed, depth + 1) : null;
    if (detail) return detail;
  }
  for (const entry of Object.values(record)) {
    if (typeof entry !== "string" || serializedShape(entry)) continue;
    const detail = summarise(entry);
    if (detail) return detail;
  }
  return null;
}

/**
 * One line of exact provider argument text for the collapsed tool row. Only a
 * value the provider actually supplied is shown — a serialized argument object
 * is never rendered as if it were a human-readable detail.
 */
export function toolCallDetail(args: unknown): string | null {
  return detailFrom(args, 0);
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
