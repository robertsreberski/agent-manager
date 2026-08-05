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

export interface ToolArgumentField {
  name: string;
  value: string;
  /** The value needs its own block and a clamp, not a single row. */
  multiline: boolean;
}

/** A value long enough that printing it whole buries the rest of the turn. */
const FIELD_CLAMP_CHARS = 240;

function fieldValue(value: unknown): string | null {
  if (typeof value === "string") {
    // A provider that hands its arguments over as serialized text is unwrapped
    // once, the same way `detailFrom` does, so the operator sees fields rather
    // than an escaped blob.
    const parsed = parsedObject(value);
    return parsed ? JSON.stringify(parsed, null, 2) : value;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

/**
 * The provider's tool arguments as named fields. A tool row used to print
 * `JSON.stringify(args, null, 2)`, so a single agent call arrived as a wall of
 * escaped prompt text — the argument names were there, but nothing separated
 * them from their values and every newline was rendered as `\n`.
 *
 * Only what the provider actually sent is shown: no key is renamed, dropped or
 * reordered, and a value that is not a scalar keeps its serialized form.
 */
export function toolArgumentFields(args: unknown): readonly ToolArgumentField[] {
  const record = plainObject(args);
  if (!record) {
    const single = fieldValue(args);
    return single === null ? [] : [{ name: "", value: single, multiline: isMultiline(single) }];
  }
  return Object.entries(record).flatMap(([name, value]) => {
    const rendered = fieldValue(value);
    return rendered === null ? [] : [{ name, value: rendered, multiline: isMultiline(rendered) }];
  });
}

function isMultiline(value: string): boolean {
  return value.includes("\n") || value.length > 80;
}

/** True when a field is long enough to be worth collapsing behind a control. */
export function fieldIsClamped(value: string): boolean {
  return value.length > FIELD_CLAMP_CHARS || value.split("\n").length > 6;
}

export function displayDuration(timing: { startedAt: number; completedAt?: number } | undefined): string | null {
  if (!timing || timing.completedAt === undefined) return null;
  const elapsed = timing.completedAt - timing.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return elapsed < 1_000 ? `${Math.round(elapsed)}ms` : `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0)}s`;
}

interface GroupedPart {
  type: string;
}

/**
 * True when no tool call in the message comes after this group.
 *
 * All tool calls sit in the same intra-turn band, and `turnRank` sorts the
 * turn's artifacts — the todo list, the turn diff, usage, the lifecycle events —
 * behind them, so "no `tool-call` part at a higher index" identifies the run the
 * provider is still adding to. A `TodoWrite` landing mid-run does not disturb it.
 */
export function isTrailingToolRun(
  parts: readonly GroupedPart[],
  indices: readonly number[],
): boolean {
  const last = indices.at(-1) ?? -1;
  return !parts.some((part, index) => part.type === "tool-call" && index > last);
}

/**
 * Whether a run is still in motion, which is not the same question as whether
 * any of its calls is running right now.
 *
 * A provider goes quiet between calls: the moment the last call reports its
 * result every part in the group reads `complete`, and deriving the group's
 * open state from that alone collapsed the panel in every gap and reopened it
 * on the next call — once per tool, for the length of the turn. A run whose
 * turn is still going and which nothing has been appended after is a run the
 * next call is about to join, so it stays active.
 *
 * Only the trailing run: a run that a message or a thought already closed is
 * genuinely finished, and holding every group of a long turn open would bury
 * the turn in its own detail.
 */
export function toolRunActive(
  status: { type: string },
  parts: readonly GroupedPart[],
  indices: readonly number[],
  turnInMotion: boolean,
): boolean {
  if (status.type !== "complete") return true;
  return turnInMotion && isTrailingToolRun(parts, indices);
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
