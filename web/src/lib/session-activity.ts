import {
  ACTIVITY_SCHEMA_VERSION,
  type ActivityAppendFrame,
  type ActivityFrame,
  type ActivityItem,
  type ActivityItemState,
  type ActivityJsonValue,
  type SessionActivityView,
} from "../types";

export const ACTIVITY_EVENT_TYPES: ActivityFrame["type"][] = [
  "activity.snapshot",
  "activity.upsert",
  "activity.append",
  "activity.remove",
  "activity.reset",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const ITEM_STATES: ActivityItemState[] = [
  "pending",
  "running",
  "waiting",
  "complete",
  "failed",
  "interrupted",
];

function hasActivityItemBase(value: Record<string, unknown>): boolean {
  return value.schemaVersion === ACTIVITY_SCHEMA_VERSION
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.sessionId === "string"
    && (value.provider === "codex" || value.provider === "claude")
    && isStringOrNull(value.turnId)
    && isStringOrNull(value.parentId)
    && isNonNegativeInteger(value.seq)
    && isNonNegativeInteger(value.revision)
    && ITEM_STATES.includes(value.state as ActivityItemState)
    && isStringOrNull(value.startedAt)
    && isStringOrNull(value.updatedAt)
    && isStringOrNull(value.completedAt)
    && (value.source === "provider-api" || value.source === "transcript")
    && (value.confidence === "exact" || value.confidence === "inferred" || value.confidence === "heuristic")
    && (value.exposure === "provider-exposed" || value.exposure === "transcript-derived")
    && typeof value.truncated === "boolean";
}

function isActivityItem(value: unknown): value is ActivityItem {
  if (!isRecord(value) || !hasActivityItemBase(value)) return false;
  switch (value.kind) {
    case "message":
      return (value.role === "user" || value.role === "assistant" || value.role === "system" || value.role === "tool")
        && (value.phase === "commentary" || value.phase === "final" || value.phase === null)
        && typeof value.text === "string"
        && isStringOrNull(value.label);
    case "reasoning":
      return (value.reasoningKind === "summary" || value.reasoningKind === "raw")
        && isStringOrNull(value.label)
        && typeof value.text === "string";
    case "plan":
      return typeof value.text === "string"
        && Array.isArray(value.steps)
        && value.steps.every((step) => isRecord(step)
          && typeof step.id === "string"
          && typeof step.text === "string"
          && (step.status === "pending" || step.status === "in_progress" || step.status === "completed"));
    case "tool":
      return typeof value.toolCallId === "string"
        && typeof value.name === "string"
        && typeof value.category === "string"
        && typeof value.output === "string";
    case "file-change":
      return typeof value.summary === "string"
        && Array.isArray(value.changes)
        && value.changes.every((change) => isRecord(change)
          && typeof change.path === "string"
          && (change.operation === "add" || change.operation === "update" || change.operation === "delete" || change.operation === "rename")
          && typeof change.diff === "string");
    case "subagent":
      return typeof value.taskId === "string"
        && typeof value.name === "string"
        && isStringOrNull(value.description)
        && typeof value.output === "string"
        && Array.isArray(value.childItemIds)
        && value.childItemIds.every((id) => typeof id === "string");
    case "attention":
      return typeof value.requestId === "string"
        && typeof value.attentionKind === "string"
        && isStringOrNull(value.title)
        && isStringOrNull(value.summary)
        && Array.isArray(value.questions)
        && typeof value.respondable === "boolean"
        && typeof value.resolved === "boolean"
        && typeof value.isSecret === "boolean";
    case "queue":
      return Array.isArray(value.messages)
        && value.messages.every((message) => isRecord(message)
          && typeof message.id === "string"
          && typeof message.text === "string"
          && typeof message.status === "string"
          && typeof message.enqueuedAt === "string"
          && isStringOrNull(message.turnId));
    case "lifecycle":
      return typeof value.event === "string"
        && (value.level === "info" || value.level === "warning" || value.level === "error")
        && typeof value.title === "string"
        && isStringOrNull(value.details);
    case "usage":
      return (value.scope === "turn" || value.scope === "thread" || value.scope === "session")
        && isNumberOrNull(value.inputTokens)
        && isNumberOrNull(value.outputTokens)
        && isNumberOrNull(value.cachedInputTokens)
        && isNumberOrNull(value.reasoningTokens)
        && isNumberOrNull(value.totalTokens)
        && isNumberOrNull(value.costUsd);
    default:
      return false;
  }
}

function hasActivityFrameBase(value: Record<string, unknown>): boolean {
  if (
    value.schemaVersion !== ACTIVITY_SCHEMA_VERSION
    || typeof value.streamEpoch !== "string"
    || value.streamEpoch.length === 0
    || typeof value.sessionId !== "string"
    || (value.provider !== "codex" && value.provider !== "claude")
    || !isNonNegativeInteger(value.seq)
    || typeof value.cursor !== "string"
    || typeof value.at !== "string"
  ) return false;
  const separator = value.cursor.lastIndexOf(":");
  return separator > 0
    && value.cursor.slice(0, separator) === value.streamEpoch
    && Number(value.cursor.slice(separator + 1)) === value.seq;
}

export function parseActivityFrame(
  event: MessageEvent<string>,
  forcedType?: ActivityFrame["type"],
): ActivityFrame | null {
  try {
    const decoded: unknown = JSON.parse(event.data);
    if (!isRecord(decoded) || !hasActivityFrameBase(decoded)) return null;
    if (!ACTIVITY_EVENT_TYPES.includes(decoded.type as ActivityFrame["type"])) return null;
    if (forcedType && decoded.type !== forcedType) return null;

    switch (decoded.type) {
      case "activity.snapshot":
      case "activity.reset":
        if (!Array.isArray(decoded.items)
          || !decoded.items.every(isActivityItem)
          || decoded.items.some((item) => item.sessionId !== decoded.sessionId)
          || typeof decoded.truncated !== "boolean") return null;
        if (decoded.type === "activity.reset" && typeof decoded.reason !== "string") return null;
        return decoded as unknown as ActivityFrame;
      case "activity.upsert":
        if (!isActivityItem(decoded.item) || decoded.item.sessionId !== decoded.sessionId) return null;
        return decoded as unknown as ActivityFrame;
      case "activity.append":
        if (typeof decoded.id !== "string"
          || !isNonNegativeInteger(decoded.revision)
          || !isNonNegativeInteger(decoded.offset)
          || typeof decoded.text !== "string"
          || typeof decoded.truncated !== "boolean"
          || !["text", "arguments", "result", "output", "diff", "details"].includes(String(decoded.channel))) return null;
        return decoded as unknown as ActivityFrame;
      case "activity.remove":
        return typeof decoded.id === "string" ? decoded as unknown as ActivityFrame : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function emptySessionActivity(sessionId: string | null): SessionActivityView {
  return {
    sessionId,
    items: [],
    hasSnapshot: false,
    truncated: false,
    streamEpoch: null,
    cursor: null,
    seq: null,
    connection: sessionId ? "connecting" : "offline",
    updateCount: 0,
  };
}

function orderedUnique(items: ActivityItem[]): ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || item.revision >= previous.revision) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

function appendText(current: string | null, frame: ActivityAppendFrame): string | null {
  const value = current ?? "";
  if (new TextEncoder().encode(value).byteLength !== frame.offset) return null;
  return `${value}${frame.text}`;
}

function applyAppend(item: ActivityItem, frame: ActivityAppendFrame): ActivityItem | null {
  if (frame.revision <= item.revision) return item;
  let next: ActivityItem | null = null;
  if (frame.channel === "text" && (item.kind === "message" || item.kind === "reasoning" || item.kind === "plan")) {
    const text = appendText(item.text, frame);
    if (text !== null) next = { ...item, text };
  } else if (frame.channel === "arguments" && item.kind === "tool") {
    const current = typeof item.arguments === "string"
      ? item.arguments
      : item.arguments === null ? "" : JSON.stringify(item.arguments);
    const text = appendText(current, frame);
    if (text !== null) next = { ...item, arguments: text };
  } else if (frame.channel === "result" && item.kind === "tool") {
    const current = typeof item.result === "string"
      ? item.result
      : item.result === null ? "" : JSON.stringify(item.result);
    const text = appendText(current, frame);
    if (text !== null) next = { ...item, result: text };
  } else if (frame.channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
    const output = appendText(item.output, frame);
    if (output !== null) next = { ...item, output };
  } else if (frame.channel === "details" && item.kind === "lifecycle") {
    const details = appendText(item.details, frame);
    if (details !== null) next = { ...item, details };
  } else if (frame.channel === "diff" && item.kind === "file-change") {
    const change = item.changes.at(-1) ?? { path: "", operation: "update" as const, diff: "" };
    const diff = appendText(change.diff, frame);
    if (diff !== null) next = {
      ...item,
      changes: [...item.changes.slice(0, -1), { ...change, diff }],
    };
  }
  return next ? {
    ...next,
    revision: frame.revision,
    updatedAt: frame.at,
    truncated: next.truncated || frame.truncated,
  } : null;
}

export interface ActivityReduction {
  state: SessionActivityView;
  accepted: boolean;
}

/**
 * Applies only frames for the currently selected session. It intentionally has
 * no relationship to SessionStateGuard: activity uses its own epoch/cursor.
 */
export function reduceSessionActivity(
  state: SessionActivityView,
  selectedSessionId: string | null,
  frame: ActivityFrame,
): ActivityReduction {
  if (!selectedSessionId || state.sessionId !== selectedSessionId || frame.sessionId !== selectedSessionId) {
    return { state, accepted: false };
  }

  const baseline = frame.type === "activity.snapshot" || frame.type === "activity.reset";
  if (state.streamEpoch !== null && frame.streamEpoch !== state.streamEpoch && !baseline) {
    return { state, accepted: false };
  }
  if (frame.streamEpoch === state.streamEpoch && state.seq !== null && frame.seq <= state.seq) {
    return { state, accepted: false };
  }
  if (!state.hasSnapshot && !baseline) return { state, accepted: false };

  let items = state.items;
  let truncated = state.truncated;
  let changed = false;
  switch (frame.type) {
    case "activity.snapshot":
    case "activity.reset":
      items = orderedUnique(frame.items);
      truncated = frame.truncated;
      changed = true;
      break;
    case "activity.upsert": {
      const index = items.findIndex((item) => item.id === frame.item.id);
      if (index < 0) {
        items = orderedUnique([...items, frame.item]);
        changed = true;
      } else if (frame.item.revision > items[index]!.revision) {
        items = orderedUnique(items.map((item, itemIndex) => itemIndex === index ? frame.item : item));
        changed = true;
      }
      break;
    }
    case "activity.append": {
      const index = items.findIndex((item) => item.id === frame.id);
      if (index >= 0) {
        const item = applyAppend(items[index]!, frame);
        if (item && item !== items[index]) {
          items = items.map((value, itemIndex) => itemIndex === index ? item : value);
          changed = true;
        }
      }
      break;
    }
    case "activity.remove": {
      const next = items.filter((item) => item.id !== frame.id);
      changed = next.length !== items.length;
      items = next;
      break;
    }
  }

  return {
    accepted: true,
    state: {
      ...state,
      items,
      hasSnapshot: state.hasSnapshot || baseline,
      truncated,
      streamEpoch: frame.streamEpoch,
      cursor: frame.cursor,
      seq: frame.seq,
      updateCount: state.updateCount + (changed ? 1 : 0),
    },
  };
}

export function jsonForDisplay(value: ActivityJsonValue | string | null): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
