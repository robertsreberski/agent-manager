import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub, type ActivityFrame } from "../activity/index.ts";
import { RemoteActivityMirror } from "./activity-stream.ts";

function relay(mirror: RemoteActivityMirror, frame: ActivityFrame): void {
  mirror.accept({
    type: "stream.frame",
    id: "stream-1",
    eventId: frame.cursor,
    data: frame,
  });
}

test("reprojects a strict snapshot and incremental frames under the local session id", () => {
  const remote = new ActivityHub({ streamEpoch: "remote-one" });
  remote.ensureSession("codex:thread-1", "codex");
  remote.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: {
      id: "message-1",
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "é",
      label: null,
      state: "running",
    },
  });
  const local = new ActivityHub({ streamEpoch: "local" });
  const mirror = new RemoteActivityMirror({
    hub: local,
    localSessionId: "remote:mac:thread-1",
    remoteSessionId: "codex:thread-1",
    provider: "codex",
  });

  relay(mirror, remote.snapshot("codex:thread-1")!);
  const append = remote.ingest("codex:thread-1", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: 2,
    text: " complete",
  });
  relay(mirror, append);

  const item = local.snapshot("remote:mac:thread-1")?.items[0];
  assert.equal(item?.sessionId, "remote:mac:thread-1");
  assert.equal(item?.kind === "message" ? item.text : null, "é complete");
  assert.equal(mirror.resumeCursor, append.cursor);
});

test("preserves an honest remote retention boundary", () => {
  const remote = new ActivityHub({ streamEpoch: "remote-truncated", maxItems: 1 });
  remote.ingest("claude:one", "claude", {
    type: "upsert",
    item: { id: "old", kind: "message", role: "user", text: "old" },
  });
  remote.ingest("claude:one", "claude", {
    type: "upsert",
    item: { id: "new", kind: "message", role: "assistant", text: "new" },
  });
  const local = new ActivityHub({ streamEpoch: "local" });
  const mirror = new RemoteActivityMirror({
    hub: local,
    localSessionId: "remote:host:claude-one",
    remoteSessionId: "claude:one",
    provider: "claude",
  });
  relay(mirror, remote.snapshot("claude:one")!);
  const snapshot = local.snapshot("remote:host:claude-one")!;
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.items.map((item) => item.id), ["new"]);
});

test("rejects cross-session frames, sequence gaps, and cursor substitution", () => {
  const remote = new ActivityHub({ streamEpoch: "remote-strict" });
  remote.ensureSession("codex:thread-1", "codex");
  const local = new ActivityHub({ streamEpoch: "local" });
  const mirror = new RemoteActivityMirror({
    hub: local,
    localSessionId: "remote:mac:thread-1",
    remoteSessionId: "codex:thread-1",
    provider: "codex",
  });
  relay(mirror, remote.snapshot("codex:thread-1")!);

  const first = remote.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: { id: "first", kind: "message", role: "assistant", text: "first" },
  });
  const second = remote.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: { id: "second", kind: "message", role: "assistant", text: "second" },
  });
  assert.throws(() => relay(mirror, second), /sequence gap/);

  assert.throws(() => mirror.accept({
    type: "stream.frame",
    id: "stream-1",
    eventId: "substituted",
    data: first,
  }), /event id/);

  const foreign = structuredClone(first);
  foreign.sessionId = "codex:other";
  assert.throws(() => relay(mirror, foreign), /another session/);
});

test("requires a replacement snapshot after transport corruption", () => {
  const remote = new ActivityHub({ streamEpoch: "epoch-a" });
  remote.ensureSession("codex:thread-1", "codex");
  const local = new ActivityHub({ streamEpoch: "local" });
  const mirror = new RemoteActivityMirror({
    hub: local,
    localSessionId: "remote:mac:thread-1",
    remoteSessionId: "codex:thread-1",
    provider: "codex",
  });
  relay(mirror, remote.snapshot("codex:thread-1")!);
  mirror.requireSnapshot();
  const incremental = remote.ingest("codex:thread-1", "codex", {
    type: "upsert",
    item: { id: "message", kind: "message", role: "assistant", text: "must reset" },
  });
  assert.throws(() => relay(mirror, incremental), /atomic snapshot/);
  relay(mirror, remote.snapshot("codex:thread-1")!);
  assert.equal(local.snapshot("remote:mac:thread-1")?.items[0]?.id, "message");
});
