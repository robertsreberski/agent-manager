import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub } from "./hub.ts";
import type { ActivityFrame, ActivityItemDraft } from "./types.ts";

function message(id: string, text: string, state: "running" | "complete" = "running"): ActivityItemDraft {
  return {
    id,
    kind: "message",
    role: "assistant",
    phase: "commentary",
    text,
    state,
  };
}

test("creates an atomic empty snapshot and clones all public values", () => {
  const hub = new ActivityHub({ streamEpoch: "epoch-one" });
  hub.ensureSession("session-a", "codex");

  const empty = hub.snapshot("session-a")!;
  assert.equal(empty.cursor, "epoch-one:0");
  assert.deepEqual(empty.items, []);
  assert.doesNotThrow(() => JSON.stringify(empty));

  const frame = hub.ingest("session-a", "codex", {
    type: "upsert",
    item: message("message-1", "hello"),
  });
  assert.equal(frame.type, "activity.upsert");
  if (frame.type !== "activity.upsert") return;
  assert.equal(frame.item.kind, "message");
  if (frame.item.kind !== "message") return;
  frame.item.text = "tampered";
  const stored = hub.snapshot("session-a")!.items[0];
  assert.equal(stored?.kind === "message" ? stored.text : null, "hello");
});

test("upserts merge omitted fields, increment revisions, and preserve semantic ordering", () => {
  const hub = new ActivityHub({ streamEpoch: "merge-test" });
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "Bash",
      category: "command",
      arguments: { command: "pwd" },
      output: "first",
      state: "running",
    },
  });
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "message-2",
      kind: "message",
      role: "assistant",
      text: "later",
    },
  });
  const update = hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "Bash",
      result: "done",
      state: "complete",
    },
  });

  assert.equal(update.type, "activity.upsert");
  if (update.type !== "activity.upsert" || update.item.kind !== "tool") return;
  assert.deepEqual(update.item.arguments, { command: "pwd" });
  assert.equal(update.item.output, "first");
  assert.equal(update.item.result, "done");
  assert.equal(update.item.revision, 2);
  assert.deepEqual(hub.snapshot("session-a")!.items.map((item) => item.id), ["tool-1", "message-2"]);
});

test("redacts and bounds activity before snapshots, replay, and subscribers", () => {
  const hub = new ActivityHub({ streamEpoch: "safe", maxFieldBytes: 64 });
  const observed: ActivityFrame[] = [];
  hub.ensureSession("session-a", "codex");
  hub.subscribe("session-a", (frame) => observed.push(frame));
  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: {
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "shell",
      arguments: {
        token: "sk-proj-abcdefghijklmnopqrstuv",
        command: `printf '${"x".repeat(200)}'`,
      },
      output: "\u001bBearer abcdefghijklmnop",
    },
  });

  const serialized = JSON.stringify({ observed, snapshot: hub.snapshot("session-a"), replay: hub.replay("session-a", null) });
  assert.equal(serialized.includes("sk-proj-"), false);
  assert.equal(serialized.includes("abcdefghijklmnop"), false);
  assert.equal(serialized.includes("\u001b"), false);
  const item = hub.snapshot("session-a")!.items[0];
  assert.equal(item?.kind === "tool" ? item.truncated : false, true);
});

test("validates UTF-8 append offsets and streams only the accepted delta", () => {
  const hub = new ActivityHub({ streamEpoch: "append-test" });
  hub.ingest("session-a", "codex", { type: "upsert", item: message("message-1", "é") });
  const accepted = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: 2,
    text: "!",
  });
  assert.equal(accepted.type, "activity.append");
  if (accepted.type === "activity.append") assert.equal(accepted.text, "!");
  const mismatch = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: 99,
    text: "must not land",
  });
  assert.equal(mismatch.type, "activity.reset");
  const stored = hub.snapshot("session-a")!.items[0];
  assert.equal(stored?.kind === "message" ? stored.text : null, "é!");
});

test("bounds the materialized view and exposes eviction as an atomic reset", () => {
  const hub = new ActivityHub({
    streamEpoch: "view-test",
    maxItems: 2,
    maxViewBytes: 8_192,
    maxFieldBytes: 512,
  });
  hub.ingest("session-a", "codex", { type: "upsert", item: message("one", "1", "complete") });
  hub.ingest("session-a", "codex", { type: "upsert", item: message("two", "2", "complete") });
  const frame = hub.ingest("session-a", "codex", { type: "upsert", item: message("three", "3") });

  assert.equal(frame.type, "activity.reset");
  const snapshot = hub.snapshot("session-a")!;
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.items.map((item) => item.id), ["two", "three"]);
});

test("replays valid cursors and resets stale or cross-epoch cursors", () => {
  const hub = new ActivityHub({ streamEpoch: "replay", replayMaxFrames: 2 });
  hub.ensureSession("session-a", "codex");
  const initial = hub.snapshot("session-a")!.cursor;
  hub.ingest("session-a", "codex", { type: "upsert", item: message("one", "1") });
  const firstCursor = hub.snapshot("session-a")!.cursor;
  hub.ingest("session-a", "codex", { type: "upsert", item: message("two", "2") });
  hub.ingest("session-a", "codex", { type: "upsert", item: message("three", "3") });

  assert.deepEqual(hub.replay("session-a", firstCursor).frames.map((frame) => frame.seq), [2, 3]);
  assert.equal(hub.replay("session-a", initial).gap, true);
  const wrongEpoch = hub.replay("session-a", "other:3");
  assert.equal(wrongEpoch.gap, true);
  assert.equal(wrongEpoch.frames[0]?.type, "activity.reset");
});

test("isolates subscribers by session and clears sensitive material", () => {
  const hub = new ActivityHub({ streamEpoch: "privacy" });
  hub.ensureSession("a", "codex");
  hub.ensureSession("b", "claude");
  const seenA: ActivityFrame[] = [];
  const seenB: ActivityFrame[] = [];
  hub.subscribe("a", (frame) => seenA.push(frame));
  hub.subscribe("b", (frame) => seenB.push(frame));

  hub.ingest("a", "codex", { type: "upsert", item: message("private", "only a") });
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 0);
  hub.clearSession("a");
  assert.equal(seenA.at(-1)?.type, "activity.reset");
  assert.equal(hub.snapshot("a"), null);
});
