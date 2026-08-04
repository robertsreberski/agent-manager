import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityFrame, ActivityMessageItem } from "../types";
import { encodeActivityCursor } from "../lib/session-activity";
import { useSessionActivity } from "./use-session-activity";

const SESSION_ID = "codex:live/thread with spaces";
const EPOCH = "epoch-1";

function message(overrides: Partial<ActivityMessageItem> = {}): ActivityMessageItem {
  return {
    schemaVersion: 3,
    id: "message-1",
    sessionId: SESSION_ID,
    provider: "codex",
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
    text: "Streaming",
    label: null,
    ...overrides,
  };
}

function frame(value: { type: ActivityFrame["type"]; seq: number; [key: string]: unknown }): ActivityFrame {
  return {
    schemaVersion: 3,
    streamEpoch: EPOCH,
    sessionId: SESSION_ID,
    provider: "codex",
    cursor: encodeActivityCursor(EPOCH, SESSION_ID, value.seq),
    at: "2026-08-03T12:00:01.000Z",
    ...value,
  } as ActivityFrame;
}

class TestEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: TestEventSource[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readyState = TestEventSource.CONNECTING;
  readonly close = vi.fn(() => {
    this.readyState = TestEventSource.CLOSED;
  });
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(
    readonly url: string | URL,
    readonly init?: EventSourceInit,
  ) {
    TestEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function"
      ? listener as (event: MessageEvent<string>) => void
      : (event: MessageEvent<string>) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  emit(type: ActivityFrame["type"], value: ActivityFrame): void {
    const event = new MessageEvent<string>(type, { data: JSON.stringify(value) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("useSessionActivity", () => {
  const scheduled = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;

  beforeEach(() => {
    TestEventSource.instances = [];
    scheduled.clear();
    nextFrame = 1;
    vi.stubGlobal("EventSource", TestEventSource);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      scheduled.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      scheduled.delete(id);
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens a credentialed selected-session stream and batches frames into one commit", () => {
    const { result } = renderHook(() => useSessionActivity(SESSION_ID));
    const source = TestEventSource.instances[0]!;
    const url = new URL(String(source.url));
    expect(url.pathname).toBe(`/api/v1/sessions/${encodeURIComponent(SESSION_ID)}/activity/events`);
    expect(url.searchParams.get("clientId")).toMatch(/^web-/u);
    expect(source.init).toEqual({ withCredentials: true });

    act(() => {
      source.emit("activity.snapshot", frame({
        type: "activity.snapshot",
        seq: 2,
        items: [message()],
        truncated: false,
      }));
      source.emit("activity.upsert", frame({
        type: "activity.upsert",
        seq: 3,
        item: message({ revision: 2, state: "complete", text: "Complete" }),
      }));
    });
    expect(result.current.streamEpoch).toBeNull();
    expect(scheduled).toHaveLength(1);

    act(() => scheduled.values().next().value?.(16));
    expect(result.current.streamEpoch).toBe(EPOCH);
    expect(result.current.items[0]).toMatchObject({ text: "Complete", state: "complete" });
    expect(result.current.updateCount).toBe(2);
  });

  it("retains activity while the browser reconnects and clears on a terminal auth failure", () => {
    const { result } = renderHook(() => useSessionActivity(SESSION_ID));
    const source = TestEventSource.instances[0]!;
    act(() => {
      source.readyState = TestEventSource.OPEN;
      source.onopen?.(new Event("open"));
      source.emit("activity.snapshot", frame({
        type: "activity.snapshot",
        seq: 1,
        items: [message()],
        truncated: false,
      }));
      scheduled.values().next().value?.(16);
    });
    expect(result.current.connection).toBe("open");
    expect(result.current.items).toHaveLength(1);

    act(() => {
      source.readyState = TestEventSource.CONNECTING;
      source.onerror?.(new Event("error"));
    });
    expect(result.current.connection).toBe("retrying");
    expect(result.current.items).toHaveLength(1);

    act(() => {
      source.readyState = TestEventSource.CLOSED;
      source.onerror?.(new Event("error"));
    });
    expect(result.current).toMatchObject({ connection: "offline", streamEpoch: null, items: [] });
  });

  it("reconnects without a cursor when an append exposes a protocol gap", () => {
    const { result } = renderHook(() => useSessionActivity(SESSION_ID));
    const source = TestEventSource.instances[0]!;
    act(() => {
      source.emit("activity.snapshot", frame({
        type: "activity.snapshot",
        seq: 1,
        items: [message({ text: "visible" })],
        truncated: false,
      }));
      scheduled.values().next().value?.(16);
    });
    expect(result.current.streamEpoch).toBe(EPOCH);

    act(() => {
      source.emit("activity.append", frame({
        type: "activity.append",
        seq: 2,
        id: "message-1",
        revision: 2,
        channel: "text",
        offset: 99,
        text: "gap",
        truncated: false,
      }));
      scheduled.values().next().value?.(32);
    });

    expect(source.close).toHaveBeenCalledOnce();
    expect(TestEventSource.instances).toHaveLength(2);
    expect(result.current).toMatchObject({ connection: "connecting", streamEpoch: null, items: [] });
  });

  it("closes and clears the old stream on deselect or session change", () => {
    const { result, rerender, unmount } = renderHook(
      ({ selectedId }) => useSessionActivity(selectedId),
      { initialProps: { selectedId: SESSION_ID as string | null } },
    );
    const first = TestEventSource.instances[0]!;

    rerender({ selectedId: null });
    expect(first.close).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ sessionId: null, items: [], streamEpoch: null });

    rerender({ selectedId: "claude:new" });
    expect(TestEventSource.instances).toHaveLength(2);
    expect(result.current).toMatchObject({ sessionId: "claude:new", items: [], streamEpoch: null });
    const second = TestEventSource.instances[1]!;
    unmount();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
