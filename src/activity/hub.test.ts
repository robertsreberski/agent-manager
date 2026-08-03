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

function applyMessageFrame(current: string, frame: ActivityFrame): string {
  if (frame.type === "activity.append") {
    assert.equal(frame.channel, "text");
    assert.equal(frame.offset, Buffer.byteLength(current, "utf8"));
    return current + frame.text;
  }
  if (frame.type === "activity.upsert") {
    assert.equal(frame.item.kind, "message");
    return frame.item.kind === "message" ? frame.item.text : current;
  }
  if (frame.type === "activity.reset") {
    const item = frame.items.find((candidate) => candidate.id === "message-1");
    return item?.kind === "message" ? item.text : current;
  }
  return current;
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(allStrings);
  }
  return [];
}

test("creates an atomic empty snapshot and clones all public values", () => {
  const hub = new ActivityHub({ streamEpoch: "epoch-one" });
  hub.ensureSession("session-a", "codex");

  const empty = hub.snapshot("session-a")!;
  assert.equal(empty.cursor, "epoch-one:session-a:0");
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

test("emits browser offsets for redacted deltas while validating provider offsets", () => {
  const hub = new ActivityHub({ streamEpoch: "redacted-append" });
  hub.ingest("session-a", "codex", { type: "upsert", item: message("message-1", "") });
  const rawSecret = "Bearer abcdefghijklmnop";
  const first = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: 0,
    text: rawSecret,
  });
  assert.equal(first.type, "activity.append");
  if (first.type !== "activity.append") return;
  assert.equal(first.offset, 0);
  assert.equal(first.text, "[REDACTED]");

  const second = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: Buffer.byteLength(rawSecret, "utf8"),
    text: " remains live",
  });
  assert.equal(second.type, "activity.append");
  if (second.type !== "activity.append") return;
  assert.equal(second.offset, Buffer.byteLength("[REDACTED]", "utf8"));
  assert.equal(second.text, " remains live");
  const stored = hub.snapshot("session-a")!.items[0];
  assert.equal(stored?.kind === "message" ? stored.text : null, "[REDACTED] remains live");

  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: message("message-2", rawSecret),
  });
  const afterRedactedUpsert = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-2",
    channel: "text",
    offset: Buffer.byteLength(rawSecret, "utf8"),
    text: " after upsert",
  });
  assert.equal(afterRedactedUpsert.type, "activity.append");
  if (afterRedactedUpsert.type !== "activity.append") return;
  assert.equal(afterRedactedUpsert.offset, Buffer.byteLength("[REDACTED]", "utf8"));
  const secondStored = hub.snapshot("session-a")!.items.find((item) => item.id === "message-2");
  assert.equal(
    secondStored?.kind === "message" ? secondStored.text : null,
    "[REDACTED] after upsert",
  );
});

test("atomically replaces text when a credential becomes recognizable across appends", () => {
  const hub = new ActivityHub({ streamEpoch: "split-secret" });
  hub.ingest("session-a", "codex", { type: "upsert", item: message("message-1", "") });

  const prefix = "ghp_abc";
  const suffix = "defghijklmnopqrstuvwxyz123456";
  const first = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: 0,
    text: prefix,
  });
  assert.equal(first.type, "activity.append");
  if (first.type !== "activity.append") return;
  assert.equal(first.text, prefix);

  const completed = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: Buffer.byteLength(prefix, "utf8"),
    text: suffix,
  });
  assert.equal(completed.type, "activity.upsert");
  if (completed.type !== "activity.upsert" || completed.item.kind !== "message") return;
  assert.equal(completed.item.text, "[REDACTED]");
  assert.equal(JSON.stringify(completed).includes(suffix), false);

  const continuation = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: Buffer.byteLength(prefix + suffix, "utf8"),
    text: " complete",
  });
  assert.equal(continuation.type, "activity.append");
  if (continuation.type !== "activity.append") return;
  assert.equal(continuation.offset, Buffer.byteLength("[REDACTED]", "utf8"));
  assert.equal(continuation.text, " complete");
  const stored = hub.snapshot("session-a")!.items[0];
  assert.equal(stored?.kind === "message" ? stored.text : null, "[REDACTED] complete");
});

test("never appends split bearer or prefixed env credentials to the client", () => {
  const hub = new ActivityHub({ streamEpoch: "split-labels" });
  hub.ingest("session-a", "codex", { type: "upsert", item: message("bearer", "") });
  const bearerPrefix = "Bearer abc";
  const bearerFirst = hub.ingest("session-a", "codex", {
    type: "append",
    id: "bearer",
    channel: "text",
    offset: 0,
    text: bearerPrefix,
  });
  assert.equal(JSON.stringify(bearerFirst).includes("Bearer abc"), false);
  const bearerSecond = hub.ingest("session-a", "codex", {
    type: "append",
    id: "bearer",
    channel: "text",
    offset: Buffer.byteLength(bearerPrefix, "utf8"),
    text: "defghijklmnop",
  });
  assert.equal(JSON.stringify(bearerSecond).includes("defghijklmnop"), false);

  hub.ingest("session-a", "codex", { type: "upsert", item: message("env", "") });
  const envPrefix = "AWS_SECRET_ACCESS";
  const envFirst = hub.ingest("session-a", "codex", {
    type: "append",
    id: "env",
    channel: "text",
    offset: 0,
    text: envPrefix,
  });
  assert.equal(envFirst.type, "activity.append");
  const envSecond = hub.ingest("session-a", "codex", {
    type: "append",
    id: "env",
    channel: "text",
    offset: Buffer.byteLength(envPrefix, "utf8"),
    text: "_KEY=super-secret-value",
  });
  assert.equal(envSecond.type, "activity.append");
  assert.equal(JSON.stringify(envSecond).includes("super-secret-value"), false);

  const serialized = JSON.stringify(hub.snapshot("session-a"));
  assert.equal(serialized.includes("Bearer abcdefghijklmnop"), false);
  assert.equal(serialized.includes("super-secret-value"), false);
});

test("redacts representative credentials at every append boundary", () => {
  const credentials = [
    "Bearer abcdefghijklmnop",
    "sk-proj-abcdefghijklmnopqrstuv",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "AKIAABCDEFGHIJKLMNOP",
    "x-api-key=vendor-secret-value",
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    "OPENAI_API_KEY=openai-secret-value",
    "MY_APP_REFRESH_TOKEN=refresh-secret-value",
  ];

  for (const credential of credentials) {
    for (let boundary = 1; boundary < credential.length; boundary += 1) {
      const hub = new ActivityHub({ streamEpoch: `split-${boundary}` });
      hub.ingest("session-a", "codex", {
        type: "upsert",
        item: message("message-1", ""),
      });
      const prefix = credential.slice(0, boundary);
      const suffix = credential.slice(boundary);
      const first = hub.ingest("session-a", "codex", {
        type: "append",
        id: "message-1",
        channel: "text",
        offset: 0,
        text: prefix,
      });
      const second = hub.ingest("session-a", "codex", {
        type: "append",
        id: "message-1",
        channel: "text",
        offset: Buffer.byteLength(prefix, "utf8"),
        text: suffix,
      });

      let rendered = "";
      rendered = applyMessageFrame(rendered, first);
      assert.equal(rendered.includes(credential), false, `${credential} at ${boundary} after first`);
      rendered = applyMessageFrame(rendered, second);
      assert.equal(rendered.includes(credential), false, `${credential} at ${boundary} after second`);

      const snapshot = hub.snapshot("session-a")!;
      const snapshotItem = snapshot.items[0];
      assert.equal(
        snapshotItem?.kind === "message" ? snapshotItem.text.includes(credential) : false,
        false,
        `${credential} at ${boundary} in snapshot`,
      );
      assert.equal(
        JSON.stringify([first, second, snapshot]).includes(credential),
        false,
        `${credential} at ${boundary} in payload`,
      );
      assert.equal(
        allStrings([first, second]).join("").includes(credential),
        false,
        `${credential} at ${boundary} reconstructed from frames`,
      );
    }
  }
});

test("stops rendering after bounded raw streaming state saturates", () => {
  const hub = new ActivityHub({ streamEpoch: "bounded-source", maxFieldBytes: 8 });
  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: message("message-1", "12345678"),
  });
  const secret = "Bearer abcdefghijklmnop";
  const saturated = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: 8,
    text: secret,
  });
  assert.equal(saturated.type, "activity.append");
  if (saturated.type !== "activity.append") return;
  assert.equal(saturated.text, "");
  assert.equal(saturated.truncated, true);
  assert.equal(JSON.stringify(saturated).includes(secret), false);

  const acceptedAtSourceOffset = hub.ingest("session-a", "codex", {
    type: "append",
    id: "message-1",
    channel: "text",
    offset: 8 + Buffer.byteLength(secret, "utf8"),
    text: "!",
  });
  assert.equal(acceptedAtSourceOffset.type, "activity.append");
  const item = hub.snapshot("session-a")!.items[0];
  assert.equal(item?.kind === "message" ? item.text : null, "12345678");
  assert.equal(item?.truncated, true);
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

  hub.ensureSession("session-b", "codex");
  hub.ingest("session-b", "codex", { type: "upsert", item: message("other", "other") });
  assert.equal(hub.replay("session-b", firstCursor).gap, true);
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
