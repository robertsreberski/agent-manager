import { afterEach, describe, expect, it, vi } from "vitest";

import { connectCockpitEvents, parseEvent } from "./sse";

function event(data: unknown): MessageEvent<string> {
  return new MessageEvent("message", { data: JSON.stringify(data) });
}

describe("cockpit SSE envelopes", () => {
  it("unwraps the payload of a named StateEvent", () => {
    const payload = {
      sessions: [{ id: "codex:live", provider: "codex" }],
      diagnostics: [],
      stale: false,
    };

    expect(parseEvent(event({ seq: 7, type: "snapshot", payload }), "snapshot")).toEqual({
      type: "snapshot",
      payload,
      seq: 7,
    });
  });

  it("unwraps an unnamed message envelope and rejects a mismatched named type", () => {
    const envelope = {
      seq: 8,
      type: "session.upsert",
      payload: { session: { id: "claude:live" } },
    };

    expect(parseEvent(event(envelope))).toEqual({
      type: "session.upsert",
      payload: envelope.payload,
      seq: 8,
    });
    expect(parseEvent(event(envelope), "snapshot")).toBeNull();
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
    });

    expect(instances).toHaveLength(1);
    const eventUrl = new URL(String(instances[0]!.url));
    expect(eventUrl.pathname).toBe("/api/v1/events");
    expect(eventUrl.searchParams.get("clientId")).toBe("web with/?&unsafe");
    expect(instances[0]!.init).toEqual({ withCredentials: true });

    disconnect();
    expect(instances[0]!.close).toHaveBeenCalledOnce();
  });
});
