import { afterEach, describe, expect, it, vi } from "vitest";

import { connectCockpitEvents, parseEvent } from "./sse";
import { AGENT_MANAGER_BUILD_ID, WireUpgradeRequiredError, WIRE_SCHEMA_VERSION } from "../../../src/shared/wire.ts";

function event(data: unknown): MessageEvent<string> {
  return new MessageEvent("message", { data: JSON.stringify(data) });
}

describe("cockpit SSE envelopes", () => {
  it("unwraps the payload of a named StateEvent", () => {
    const payload = {
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      generatedAt: "2026-08-04T10:00:00.000Z",
      seq: 7,
      sessions: [],
      diagnostics: [],
      stale: false,
    };
    const envelope = {
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      seq: 7,
      at: "2026-08-04T10:00:00.000Z",
      type: "snapshot",
      payload,
    } as const;

    expect(parseEvent(event(envelope), "snapshot")).toEqual(envelope);
  });

  it("unwraps an unnamed message envelope and rejects a mismatched named type", () => {
    const envelope = {
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      seq: 8,
      at: "2026-08-04T10:00:01.000Z",
      type: "session.remove",
      payload: { id: "local:claude:live" },
    } as const;

    expect(parseEvent(event(envelope))).toEqual(envelope);
    expect(parseEvent(event(envelope), "snapshot")).toBeNull();
  });

  it("rejects missing epochs, unknown payload fields, and payload-only messages", () => {
    expect(() => parseEvent(event({
      seq: 8,
      at: "2026-08-04T10:00:01.000Z",
      type: "session.remove",
      payload: { id: "local:claude:live" },
    }))).toThrow(WireUpgradeRequiredError);
    expect(parseEvent(event({
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      seq: 8,
      at: "2026-08-04T10:00:01.000Z",
      type: "session.remove",
      payload: { id: "local:claude:live", sessionId: "legacy" },
    }))).toBeNull();
    expect(() => parseEvent(event({ id: "local:claude:live" }), "session.remove")).toThrow(WireUpgradeRequiredError);
  });
});

describe("connectCockpitEvents", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("identifies a browser client in the event URL and keeps credentialed SSE", () => {
    const instances: Array<{
      url: string | URL;
      init: EventSourceInit | undefined;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    class TestEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      readonly close = vi.fn();

      constructor(
        readonly url: string | URL,
        readonly init: EventSourceInit | undefined,
      ) {
        instances.push(this);
      }

      addEventListener() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);

    const disconnect = connectCockpitEvents({
      clientId: "web with/?&unsafe",
      onEvent: vi.fn(),
      onConnection: vi.fn(),
      onReconnect: vi.fn(),
      onUpgradeRequired: vi.fn(),
    });

    expect(instances).toHaveLength(1);
    const eventUrl = new URL(String(instances[0]!.url));
    expect(eventUrl.pathname).toBe("/api/v1/events");
    expect(eventUrl.searchParams.get("clientId")).toBe("web with/?&unsafe");
    expect(instances[0]!.init).toEqual({ withCredentials: true });

    disconnect();
    expect(instances[0]!.close).toHaveBeenCalledOnce();
  });

  it("closes immediately and reports an upgrade-required mismatch once", () => {
    const instances: TestEventSource[] = [];
    class TestEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      readonly close = vi.fn();
      constructor() { instances.push(this); }
      addEventListener() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const onUpgradeRequired = vi.fn(() => {
      expect(instances[0]?.close).toHaveBeenCalledOnce();
    });
    connectCockpitEvents({
      clientId: "web-fixture",
      onEvent: vi.fn(),
      onConnection: vi.fn(),
      onReconnect: vi.fn(),
      onUpgradeRequired,
    });

    const source = instances[0];
    if (!source?.onmessage) throw new Error("EventSource message handler was not installed");
    source.onmessage(event({
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: "old-build",
      seq: 8,
      at: "2026-08-04T10:00:01.000Z",
      type: "session.remove",
      payload: { id: "local:claude:live" },
    }));
    expect(onUpgradeRequired).toHaveBeenCalledOnce();
  });
});
