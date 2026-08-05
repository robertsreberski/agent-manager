import { describe, expect, it } from "vitest";
import {
  WIRE_SCHEMA_VERSION,
  type ActivityFrame,
  type ActivityMessageItem,
} from "../types";
import {
  encodeActivityCursor,
  emptySessionActivity,
  parseActivityFrame,
  reduceSessionActivity,
} from "./session-activity";

const SESSION_ID = "codex:live/thread";
const EPOCH = "epoch:with-colon";

function message(overrides: Partial<ActivityMessageItem> = {}): ActivityMessageItem {
  return {
    schemaVersion: WIRE_SCHEMA_VERSION,
    id: "message-1",
    sessionId: SESSION_ID,
    provider: "codex",
    correlationId: null,
    turnId: "turn-1",
    parentId: null,
    seq: 1,
    revision: 1,
    state: "running",
    startedAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
    completedAt: null,
    source: "provider-api",
    confidence: "exact",
    exposure: "provider-exposed",
    truncated: false,
    kind: "message",
    role: "assistant",
    phase: "commentary",
    text: "Hi",
    label: null,
    memoryCitation: null,
    ...overrides,
  };
}

function frame(
  value: { type: ActivityFrame["type"]; seq: number; [key: string]: unknown },
): ActivityFrame {
  return {
    schemaVersion: WIRE_SCHEMA_VERSION,
    streamEpoch: EPOCH,
    sessionId: SESSION_ID,
    provider: "codex",
    cursor: encodeActivityCursor(EPOCH, SESSION_ID, value.seq),
    at: "2026-08-03T12:00:01.000Z",
    ...value,
  } as ActivityFrame;
}

describe("parseActivityFrame", () => {
  it("accepts the versioned named frame contract", () => {
    const snapshot = frame({
      type: "activity.snapshot",
      seq: 2,
      items: [message()],
      truncated: false,
    });
    const event = new MessageEvent<string>("activity.snapshot", { data: JSON.stringify(snapshot) });

    expect(parseActivityFrame(event, "activity.snapshot")).toEqual(snapshot);
  });

  it("rejects mismatched event names, cursors, and cross-session items", () => {
    const snapshot = frame({
      type: "activity.snapshot",
      seq: 2,
      items: [message()],
      truncated: false,
    });
    const event = (value: unknown) => new MessageEvent<string>("message", { data: JSON.stringify(value) });

    expect(parseActivityFrame(event(snapshot), "activity.reset")).toBeNull();
    expect(parseActivityFrame(event({
      ...snapshot,
      cursor: encodeActivityCursor(EPOCH, SESSION_ID, 99),
    }))).toBeNull();
    expect(parseActivityFrame(event({
      ...snapshot,
      cursor: encodeActivityCursor(EPOCH, "codex:other", snapshot.seq),
    }))).toBeNull();
    expect(parseActivityFrame(event({
      ...snapshot,
      items: [message({ sessionId: "codex:other" })],
    }))).toBeNull();
  });
});

describe("reduceSessionActivity", () => {
  it("builds a snapshot and applies upsert, UTF-8 append, and remove frames", () => {
    const snapshot = frame({
      type: "activity.snapshot",
      seq: 2,
      items: [message({ text: "hé" })],
      truncated: false,
    });
    let state = reduceSessionActivity(emptySessionActivity(SESSION_ID), SESSION_ID, snapshot).state;
    expect(state.streamEpoch).toBe(EPOCH);
    expect((state.items[0] as ActivityMessageItem | undefined)?.text).toBe("hé");

    state = reduceSessionActivity(state, SESSION_ID, frame({
      type: "activity.append",
      seq: 3,
      id: "message-1",
      revision: 2,
      channel: "text",
      offset: 3,
      text: " there",
      truncated: false,
    })).state;
    expect(state.items[0]).toMatchObject({ text: "hé there", revision: 2 });

    state = reduceSessionActivity(state, SESSION_ID, frame({
      type: "activity.upsert",
      seq: 4,
      item: message({ revision: 3, state: "complete", text: "Done" }),
    })).state;
    expect(state.items[0]).toMatchObject({ text: "Done", revision: 3, state: "complete" });

    state = reduceSessionActivity(state, SESSION_ID, frame({
      type: "activity.remove",
      seq: 5,
      id: "message-1",
    })).state;
    expect(state.items).toEqual([]);
  });

  it("requests a fresh snapshot when an append cannot match the rendered bytes", () => {
    const snapshot = frame({
      type: "activity.snapshot",
      seq: 1,
      items: [message({ text: "[REDACTED]" })],
      truncated: false,
    });
    const current = reduceSessionActivity(
      emptySessionActivity(SESSION_ID),
      SESSION_ID,
      snapshot,
    ).state;
    const result = reduceSessionActivity(current, SESSION_ID, frame({
      type: "activity.append",
      seq: 2,
      id: "message-1",
      revision: 2,
      channel: "text",
      offset: 99,
      text: "must not silently disappear",
      truncated: false,
    }));

    expect(result.accepted).toBe(false);
    expect(result.requiresReset).toBe(true);
    expect(result.state).toBe(current);
  });

  it("rejects pre-baseline, prior-session, duplicate, and old-epoch frames", () => {
    const initial = emptySessionActivity(SESSION_ID);
    const upsert = frame({ type: "activity.upsert", seq: 1, item: message() });
    expect(reduceSessionActivity(initial, SESSION_ID, upsert).accepted).toBe(false);

    const snapshot = frame({
      type: "activity.snapshot",
      seq: 2,
      items: [message()],
      truncated: false,
    });
    const current = reduceSessionActivity(initial, SESSION_ID, snapshot).state;
    expect(reduceSessionActivity(current, "codex:other", snapshot).accepted).toBe(false);
    expect(reduceSessionActivity(current, SESSION_ID, snapshot).accepted).toBe(false);
    expect(reduceSessionActivity(current, SESSION_ID, {
      ...upsert,
      streamEpoch: "new-epoch",
      cursor: encodeActivityCursor("new-epoch", SESSION_ID, 3),
      seq: 3,
    }).accepted).toBe(false);
  });

  it("accepts a reset as a new epoch baseline", () => {
    const snapshot = frame({
      type: "activity.snapshot",
      seq: 2,
      items: [message()],
      truncated: false,
    });
    const current = reduceSessionActivity(emptySessionActivity(SESSION_ID), SESSION_ID, snapshot).state;
    const reset = {
      ...frame({
        type: "activity.reset",
        seq: 1,
        reason: "replay-gap",
        items: [message({ id: "replacement", seq: 9, revision: 1, state: "complete" })],
        truncated: true,
      }),
      streamEpoch: "replacement-epoch",
      cursor: encodeActivityCursor("replacement-epoch", SESSION_ID, 1),
    } as ActivityFrame;

    const result = reduceSessionActivity(current, SESSION_ID, reset);
    expect(result.accepted).toBe(true);
    expect(result.state).toMatchObject({
      streamEpoch: "replacement-epoch",
      seq: 1,
      truncated: true,
    });
    expect(result.state.items.map((item) => item.id)).toEqual(["replacement"]);
  });
});
