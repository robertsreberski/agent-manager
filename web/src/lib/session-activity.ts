import { parseActivityFrame as parseWireActivityFrame } from "../../../src/activity/wire.ts";
import {
  ACTIVITY_SCHEMA_VERSION,
  type ActivityAppendFrame,
  type ActivityFrame,
  type ActivityItem,
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

export function encodeActivityCursor(
  streamEpoch: string,
  sessionId: string,
  sequence: number,
): string {
  return `${streamEpoch}:${encodeURIComponent(sessionId)}:${sequence}`;
}

/**
 * The browser uses the same fail-closed decoder as the server. The extra
 * cursor and foreign-key checks bind a named SSE event to one activity
 * stream instead of trusting the transport event name.
 */
export function parseActivityFrame(
  event: MessageEvent<string>,
  forcedType?: ActivityFrame["type"],
): ActivityFrame | null {
  try {
    const frame = parseWireActivityFrame(JSON.parse(event.data) as unknown);
    if (forcedType && frame.type !== forcedType) return null;
    if (frame.cursor !== encodeActivityCursor(frame.streamEpoch, frame.sessionId, frame.seq)) return null;
    if ((frame.type === "activity.snapshot" || frame.type === "activity.reset")
      && frame.items.some((item) => item.sessionId !== frame.sessionId || item.provider !== frame.provider)) return null;
    if (frame.type === "activity.upsert"
      && (frame.item.sessionId !== frame.sessionId || frame.item.provider !== frame.provider)) return null;
    return frame;
  } catch {
    return null;
  }
}

export function emptySessionActivity(sessionId: string | null): SessionActivityView {
  return {
    sessionId,
    items: [],
    truncated: false,
    streamEpoch: null,
    cursor: null,
    seq: null,
    connection: sessionId ? "connecting" : "offline",
    updateCount: 0,
  };
}

function orderedUnique(items: readonly ActivityItem[]): ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || item.revision >= previous.revision) byId.set(item.id, item);
  }
  // Snapshot/reset array order is the server's canonical timeline. `seq` is a
  // stream cursor and can be reassigned during transcript reconciliation, so
  // sorting by it here made every reset rebuild the conversation in a new
  // order even when the provider order itself had not changed.
  return [...byId.values()];
}

function appendText(current: string | null, frame: ActivityAppendFrame): string | null {
  const value = current ?? "";
  if (new TextEncoder().encode(value).byteLength !== frame.offset) return null;
  return `${value}${frame.text}`;
}

function displayJson(value: ActivityJsonValue | string | null): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function applyAppend(item: ActivityItem, frame: ActivityAppendFrame): ActivityItem | null {
  if (frame.revision !== item.revision + 1) return null;
  let next: ActivityItem | null = null;
  if (frame.channel === "text" && (item.kind === "message" || item.kind === "reasoning")) {
    const text = appendText(item.text, frame);
    if (text !== null) next = { ...item, text };
  } else if (frame.channel === "markdown" && item.kind === "plan") {
    const markdown = appendText(item.markdown, frame);
    if (markdown !== null) next = { ...item, markdown };
  } else if (frame.channel === "arguments" && item.kind === "tool") {
    const argumentsText = appendText(displayJson(item.arguments), frame);
    if (argumentsText !== null) next = { ...item, arguments: argumentsText };
  } else if (frame.channel === "result" && item.kind === "tool") {
    const result = appendText(displayJson(item.result), frame);
    if (result !== null) next = { ...item, result };
  } else if (frame.channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
    const output = appendText(item.output, frame);
    if (output !== null) next = { ...item, output };
  } else if (frame.channel === "details" && item.kind === "lifecycle") {
    const details = appendText(item.details, frame);
    if (details !== null) next = { ...item, details };
  } else if (frame.channel === "diff" && item.kind === "file-change") {
    const change = item.changes.at(-1) ?? { path: "", previousPath: null, operation: "update" as const, diff: "" };
    const diff = appendText(change.diff, frame);
    if (diff !== null) next = {
      ...item,
      changes: [...item.changes.slice(0, -1), { ...change, diff }],
    };
  }
  return next ? {
    ...next,
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    revision: frame.revision,
    updatedAt: frame.at,
    truncated: next.truncated || frame.truncated,
  } : null;
}

export interface ActivityReduction {
  state: SessionActivityView;
  accepted: boolean;
  /** The materialized view cannot safely apply this delta. Reconnect for a snapshot. */
  requiresReset?: boolean;
}

/** Activity has an independent epoch and cursor from the board state stream. */
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
    return { state, accepted: false, requiresReset: true };
  }
  if (frame.streamEpoch === state.streamEpoch && state.seq !== null) {
    if (frame.seq <= state.seq) return { state, accepted: false };
    if (!baseline && frame.seq !== state.seq + 1) return { state, accepted: false, requiresReset: true };
  }
  if ((state.streamEpoch === null || state.seq === null) && !baseline) {
    return { state, accepted: false, requiresReset: true };
  }

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
      if (index < 0) return { state, accepted: false, requiresReset: true };
      const appended = applyAppend(items[index]!, frame);
      if (!appended) return { state, accepted: false, requiresReset: true };
      items = items.map((item, itemIndex) => itemIndex === index ? appended : item);
      changed = true;
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
