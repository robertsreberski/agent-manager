import { describe, expect, it } from "vitest";

import { normalizeSession, normalizeSnapshot } from "./normalize";
import { SessionStateGuard } from "./session-state";

function session(id: string, generation: number, name: string) {
  return normalizeSession({
    id,
    provider: "codex",
    name,
    generation,
    status: "idle",
  });
}

function sessionDetail(
  id: string,
  generation: number,
  name: string,
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>,
  transcript: Record<string, unknown> = {},
) {
  return normalizeSession({
    id,
    provider: "codex",
    name,
    generation,
    status: "idle",
    messages,
    transcript: {
      state: "available",
      source: "provider-api",
      messageCount: messages.length,
      ...transcript,
    },
  });
}

function snapshot(seq: number, sessions: ReturnType<typeof session>[]) {
  return normalizeSnapshot({ seq, sessions, diagnostics: [], stale: false });
}

describe("SessionStateGuard", () => {
  it("accepts the server's initial sequence-zero snapshot", () => {
    const guard = new SessionStateGuard();
    const initial = normalizeSnapshot({ sessions: [], diagnostics: [], stale: false });
    const result = guard.applyEvent(initial, {
      type: "snapshot",
      seq: 0,
      payload: snapshot(0, [session("codex:first", 1, "first")]),
    });
    expect(result.accepted).toBe(true);
    expect(result.snapshot.seq).toBe(0);
    expect(result.snapshot.sessions[0]?.id).toBe("codex:first");
  });

  it("does not let a delayed collection refresh overwrite a newer SSE upsert", () => {
    const guard = new SessionStateGuard();
    let current = snapshot(10, [session("codex:one", 1, "old")]);
    const refresh = guard.beginRequest();

    const event = guard.applyEvent(current, {
      type: "session.upsert",
      seq: 11,
      payload: { session: session("codex:one", 2, "new from SSE") },
    });
    expect(event.accepted).toBe(true);
    current = event.snapshot;

    current = guard.applyRestSnapshot(
      current,
      snapshot(10, [session("codex:one", 1, "stale REST")]),
      refresh,
    );
    expect(current.sessions).toHaveLength(1);
    expect(current.sessions[0]).toEqual(expect.objectContaining({
      name: "new from SSE",
      generation: 2,
    }));
    expect(current.seq).toBe(11);
  });

  it("keeps an SSE tombstone against delayed detail and refresh responses", () => {
    const guard = new SessionStateGuard();
    let current = snapshot(20, [session("claude:gone", 4, "present")]);
    const detail = guard.beginRequest();
    const refresh = guard.beginRequest();

    current = guard.applyEvent(current, {
      type: "session.remove",
      seq: 21,
      payload: { id: "claude:gone" },
    }).snapshot;
    expect(current.sessions).toEqual([]);

    current = guard.applyRestSession(
      current,
      session("claude:gone", 4, "stale detail"),
      detail,
    );
    current = guard.applyRestSnapshot(
      current,
      snapshot(20, [session("claude:gone", 4, "stale refresh")]),
      refresh,
    );
    expect(current.sessions).toEqual([]);
    expect(current.seq).toBe(21);
  });

  it("protects a newer SSE snapshot from delayed detail and out-of-order events", () => {
    const guard = new SessionStateGuard();
    let current = snapshot(30, [session("codex:one", 2, "before")]);
    const detail = guard.beginRequest();

    current = guard.applyEvent(current, {
      type: "snapshot",
      seq: 32,
      payload: snapshot(32, [session("codex:one", 5, "authoritative SSE")]),
    }).snapshot;
    current = guard.applyRestSession(
      current,
      session("codex:one", 3, "delayed detail"),
      detail,
    );
    expect(current.sessions[0]).toEqual(expect.objectContaining({
      name: "authoritative SSE",
      generation: 5,
    }));

    const oldEvent = guard.applyEvent(current, {
      type: "session.upsert",
      seq: 31,
      payload: session("codex:one", 4, "out of order"),
    });
    expect(oldEvent.accepted).toBe(false);
    expect(oldEvent.snapshot.sessions[0]?.name).toBe("authoritative SSE");
  });

  it("merges a delayed detail transcript without reverting newer SSE live state", () => {
    const guard = new SessionStateGuard();
    let current = snapshot(40, [session("codex:one", 2, "before")]);
    const detail = guard.beginRequest();

    current = guard.applyEvent(current, {
      type: "session.upsert",
      seq: 41,
      payload: {
        session: normalizeSession({
          id: "codex:one",
          provider: "codex",
          name: "live from SSE",
          generation: 3,
          status: "running",
          control: { capabilities: ["turn.steer"] },
        }),
      },
    }).snapshot;
    current = guard.applyRestSession(
      current,
      sessionDetail(
        "codex:one",
        2,
        "stale detail summary",
        [{ id: "answer", role: "assistant", text: "Fetched transcript" }],
      ),
      detail,
    );

    expect(current.sessions[0]).toEqual(expect.objectContaining({
      name: "live from SSE",
      generation: 3,
      activity: "running",
      messages: [expect.objectContaining({ text: "Fetched transcript" })],
      transcript: expect.objectContaining({ state: "available" }),
    }));
    expect(current.sessions[0]?.control.capabilities).toEqual(["steer"]);
  });

  it("preserves loaded transcript detail across transcript-free SSE upserts", () => {
    const guard = new SessionStateGuard();
    let current = snapshot(50, [session("codex:one", 2, "before")]);
    const detail = guard.beginRequest();
    current = guard.applyRestSession(
      current,
      sessionDetail(
        "codex:one",
        2,
        "detail",
        [{ id: "answer", role: "assistant", text: "Keep me" }],
      ),
      detail,
    );

    current = guard.applyEvent(current, {
      type: "session.upsert",
      seq: 51,
      payload: { session: session("codex:one", 3, "updated") },
    }).snapshot;

    expect(current.sessions[0]).toEqual(expect.objectContaining({
      name: "updated",
      generation: 3,
      messages: [expect.objectContaining({ text: "Keep me" })],
      transcript: expect.objectContaining({ state: "available" }),
    }));
  });

  it("lets an explicit available-empty transcript replace prior messages", () => {
    const guard = new SessionStateGuard();
    let current = snapshot(60, [session("codex:one", 1, "one")]);
    const first = guard.beginRequest();
    current = guard.applyRestSession(
      current,
      sessionDetail(
        "codex:one",
        1,
        "one",
        [{ id: "answer", role: "assistant", text: "Old" }],
      ),
      first,
    );
    const second = guard.beginRequest();
    current = guard.applyRestSession(
      current,
      sessionDetail("codex:one", 1, "one", []),
      second,
    );

    expect(current.sessions[0]?.messages).toEqual([]);
    expect(current.sessions[0]?.transcript).toEqual(expect.objectContaining({
      state: "available",
      messageCount: 0,
    }));
  });

  it("does not let an older detail response overwrite a newer detail response", () => {
    const guard = new SessionStateGuard();
    let current = snapshot(70, [session("codex:one", 1, "one")]);
    const oldRequest = guard.beginRequest();
    const newRequest = guard.beginRequest();

    current = guard.applyRestSession(
      current,
      sessionDetail(
        "codex:one",
        1,
        "one",
        [{ id: "new", role: "assistant", text: "New transcript" }],
      ),
      newRequest,
    );
    current = guard.applyRestSession(
      current,
      sessionDetail(
        "codex:one",
        1,
        "one",
        [{ id: "old", role: "assistant", text: "Old transcript" }],
      ),
      oldRequest,
    );

    expect(current.sessions[0]?.messages[0]?.text).toBe("New transcript");
  });
});
