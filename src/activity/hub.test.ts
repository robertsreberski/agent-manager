import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub } from "./hub.ts";
import type { ActivityFrame, ActivityItemDraft } from "./types.ts";
import type { TodoProgress } from "../shared/session.ts";

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

test("preserves attention question headers separately from question text", () => {
  const hub = new ActivityHub({ streamEpoch: "attention-header" });
  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: {
      id: "question-1",
      kind: "attention",
      requestId: "s:random-pick",
      attentionKind: "question",
      title: "Codex needs your answer",
      summary: null,
      questions: [{
        id: "random_destination",
        header: "Random pick",
        text: "Which imaginary weekend destination would you choose?",
        options: [{ label: "Moon cabin", description: null, recommended: true }],
        multiSelect: false,
        allowFreeText: true,
        isSecret: false,
      }],
      respondable: true,
      resolved: false,
      isSecret: false,
    },
  });

  const item = hub.snapshot("session-a")?.items[0];
  assert.equal(item?.kind, "attention");
  if (item?.kind === "attention") {
    assert.equal(item.summary, null);
    assert.equal(item.questions[0]?.header, "Random pick");
    assert.equal(item.questions[0]?.options[0]?.recommended, true);
    assert.equal(
      item.questions[0]?.text,
      "Which imaginary weekend destination would you choose?",
    );
  }
});

test("materializes exact approval facts without filling unknowns", () => {
  const hub = new ActivityHub({ streamEpoch: "approval-facts" });
  const frame = hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "approval-1",
      kind: "attention",
      requestId: "request-1",
      attentionKind: "permission",
      approvalFacts: {
        command: "pnpm test",
        paths: ["/work/app"],
        writes: [],
        network: null,
        canPersist: false,
        deleteCount: null,
      },
      respondable: true,
      resolved: false,
    },
  });
  assert.equal(frame.type, "activity.upsert");
  if (frame.type !== "activity.upsert" || frame.item.kind !== "attention") return;
  assert.deepEqual(frame.item.approvalFacts, {
    command: "pnpm test",
    paths: ["/work/app"],
    writes: [],
    network: null,
    canPersist: false,
    deleteCount: null,
  });
});

test("keeps provider plan artifacts separate from live todo progress", () => {
  const hub = new ActivityHub({ streamEpoch: "plan-todo-split" });
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "plan-1",
      kind: "plan",
      path: "/provider/plans/plan.md",
      version: null,
      markdown: "# Plan\n\nDo the work.",
      supersededBy: null,
      approvedAt: null,
      state: "complete",
    },
  });
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "todos-1",
      kind: "todo",
      steps: [{
        id: "todo-1",
        text: "Implement",
        status: "in_progress",
        detail: "Editing the activity model",
        addedAfterStart: false,
        removedReason: null,
      }],
      added: 1,
      removed: 0,
      state: "running",
    },
  });
  const plan = hub.snapshot("session-a")?.items.find((item) => item.kind === "plan");
  const todo = hub.snapshot("session-a")?.items.find((item) => item.kind === "todo");
  assert.equal(plan?.kind === "plan" ? plan.markdown : null, "# Plan\n\nDo the work.");
  assert.equal(plan?.kind === "plan" ? plan.path : null, "/provider/plans/plan.md");
  assert.deepEqual(todo?.kind === "todo" ? todo.steps : null, [{
    id: "todo-1",
    text: "Implement",
    status: "in_progress",
    detail: "Editing the activity model",
    addedAfterStart: false,
    removedReason: null,
  }]);
});

test("streams plan markdown without inventing versions or checklist rows", () => {
  const hub = new ActivityHub({ streamEpoch: "plan-markdown" });
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "plan-1",
      kind: "plan",
      path: null,
      version: null,
      markdown: "# Pla",
      supersededBy: null,
      approvedAt: null,
    },
  });
  const frame = hub.ingest("session-a", "claude", {
    type: "append",
    id: "plan-1",
    channel: "markdown",
    offset: Buffer.byteLength("# Pla"),
    text: "n",
  });
  assert.equal(frame.type, "activity.append");
  const plan = hub.snapshot("session-a")?.items[0];
  assert.equal(plan?.kind === "plan" ? plan.markdown : null, "# Plan");
  assert.equal(plan?.kind === "plan" ? plan.version : 1, null);
});

test("publishes content-free progress from the newest authoritative todo", () => {
  let now = Date.parse("2026-08-04T10:00:00.000Z");
  const hub = new ActivityHub({ streamEpoch: "todo-metadata", now: () => now });
  const observed: Array<{ sessionId: string; progress: TodoProgress | null }> = [];
  const unsubscribe = hub.subscribeTodoProgress((sessionId, progress) => {
    observed.push({ sessionId, progress });
  });

  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: message("message-1", "todo text must not leak"),
  });
  now = Date.parse("2026-08-04T10:01:00.000Z");
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "todos-1",
      kind: "todo",
      steps: [
        { id: "one", text: "private first todo", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
        { id: "two", text: "private current todo", status: "in_progress", detail: "private detail", addedAfterStart: false, removedReason: null },
      ],
      added: 2,
      removed: 0,
    },
  });
  now = Date.parse("2026-08-04T10:02:00.000Z");
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "todos-1",
      kind: "todo",
      steps: [
        { id: "one", text: "rewritten private text", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
        { id: "two", text: "rewritten current text", status: "in_progress", detail: null, addedAfterStart: false, removedReason: null },
      ],
    },
  });
  now = Date.parse("2026-08-04T10:03:00.000Z");
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: {
      id: "todos-1",
      kind: "todo",
      steps: [
        { id: "one", text: "private first todo", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
        { id: "two", text: "private current todo", status: "completed", detail: null, addedAfterStart: false, removedReason: null },
      ],
    },
  });
  hub.ingest("session-a", "claude", {
    type: "upsert",
    item: { id: "todos-2", kind: "todo", steps: [], added: 0, removed: 0 },
  });
  hub.ingest("session-a", "claude", { type: "remove", id: "todos-2" });
  hub.ingest("session-a", "claude", { type: "reset", reason: "provider-reset", items: [] });

  assert.deepEqual(observed, [
    {
      sessionId: "session-a",
      progress: {
        completed: 1,
        total: 2,
        hasMoved: false,
        lastTransitionAt: null,
        active: true,
      },
    },
    {
      sessionId: "session-a",
      progress: {
        completed: 2,
        total: 2,
        hasMoved: true,
        lastTransitionAt: "2026-08-04T10:03:00.000Z",
        active: false,
      },
    },
    { sessionId: "session-a", progress: null },
    {
      sessionId: "session-a",
      progress: {
        completed: 2,
        total: 2,
        hasMoved: false,
        lastTransitionAt: null,
        active: false,
      },
    },
    { sessionId: "session-a", progress: null },
  ]);
  assert.doesNotMatch(JSON.stringify(observed), /private|todo text|detail/);
  assert.equal(hub.todoProgress("session-a"), null);
  unsubscribe();
});

test("marks an ordered todo-list change as movement without exposing its contents", () => {
  let now = Date.parse("2026-08-04T11:00:00.000Z");
  const hub = new ActivityHub({ streamEpoch: "todo-list-movement", now: () => now });
  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: {
      id: "todos",
      kind: "todo",
      steps: [
        { id: "one", text: "private active", status: "in_progress", detail: null, addedAfterStart: false, removedReason: null },
        { id: "two", text: "private pending", status: "pending", detail: null, addedAfterStart: false, removedReason: null },
      ],
    },
  });
  now = Date.parse("2026-08-04T11:04:00.000Z");
  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: {
      id: "todos",
      kind: "todo",
      steps: [
        { id: "one", text: "private active", status: "in_progress", detail: null, addedAfterStart: false, removedReason: null },
        { id: "two", text: "private pending", status: "pending", detail: null, addedAfterStart: false, removedReason: null },
        { id: "three", text: "private added", status: "pending", detail: null, addedAfterStart: true, removedReason: null },
      ],
    },
  });

  assert.deepEqual(hub.todoProgress("session-a"), {
    completed: 0,
    total: 3,
    hasMoved: true,
    lastTransitionAt: "2026-08-04T11:04:00.000Z",
    active: true,
  });
  assert.doesNotMatch(
    JSON.stringify(hub.todoProgress("session-a")),
    /private active|private pending|private added/,
  );
});

test("keeps removed todo tombstones out of global progress counts", () => {
  let now = Date.parse("2026-08-04T11:00:00.000Z");
  const hub = new ActivityHub({ streamEpoch: "todo-tombstone-progress", now: () => now });
  const live = (id: string) => ({
    id,
    text: `private ${id}`,
    status: "pending" as const,
    detail: null,
    addedAfterStart: false,
    removedReason: null,
  });
  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: { id: "todos", kind: "todo", steps: [live("one"), live("two")] },
  });
  now = Date.parse("2026-08-04T11:04:00.000Z");
  hub.ingest("session-a", "codex", {
    type: "upsert",
    item: {
      id: "todos",
      kind: "todo",
      steps: [
        live("two"),
        { ...live("one"), status: "removed", removedReason: null },
      ],
      added: 0,
      removed: 1,
    },
  });
  assert.deepEqual(hub.todoProgress("session-a"), {
    completed: 0,
    total: 1,
    hasMoved: true,
    lastTransitionAt: "2026-08-04T11:04:00.000Z",
    active: false,
  });
});

test("late todo-progress subscribers receive only an existing non-empty summary", () => {
  const hub = new ActivityHub({ streamEpoch: "todo-late-subscriber" });
  hub.ingest("with-progress", "codex", {
    type: "upsert",
    item: {
      id: "todos",
      kind: "todo",
      steps: [{ id: "one", text: "private", status: "pending", detail: null, addedAfterStart: false, removedReason: null }],
      added: 1,
      removed: 0,
    },
  });
  hub.ensureSession("without-progress", "claude");
  const observed: Array<[string, TodoProgress | null]> = [];
  hub.subscribeTodoProgress((sessionId, progress) => observed.push([sessionId, progress]));
  assert.deepEqual(observed, [["with-progress", {
    completed: 0,
    total: 1,
    hasMoved: false,
    lastTransitionAt: null,
    active: false,
  }]]);

  hub.clearSession("with-progress");
  assert.deepEqual(observed.at(-1), ["with-progress", null]);
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

test("a reset keeps the order it was submitted in rather than the order ids sort in", () => {
  // Every reset item used to share one seq, so the view's
  // `seq - seq || id.localeCompare(id)` fell through to the id — and provider
  // ids are random tokens. The whole timeline re-sorted alphabetically on every
  // reset (first observation, truncation, replay gap, hook resume), which reads
  // as events appearing twice in different places.
  const hub = new ActivityHub();
  const submitted = ["zeta", "alpha", "mu"];
  const frame = hub.ingest("session-1", "claude", {
    type: "reset",
    reason: "transcript-reset",
    items: submitted.map((id) => message(id, id, "complete")),
  });

  assert.equal(frame.type, "activity.reset");
  assert.deepEqual(
    frame.type === "activity.reset" ? frame.items.map((item) => item.id) : [],
    submitted,
  );
  assert.deepEqual(
    hub.snapshot("session-1")?.items.map((item) => item.id) ?? [],
    submitted,
  );
});

test("a later mutation still sequences after every item a reset placed", () => {
  const hub = new ActivityHub();
  hub.ingest("session-1", "claude", {
    type: "reset",
    reason: "transcript-reset",
    items: ["zeta", "alpha", "mu"].map((id) => message(id, id, "complete")),
  });
  hub.ingest("session-1", "claude", { type: "upsert", item: message("omega", "last", "complete") });

  assert.deepEqual(
    hub.snapshot("session-1")?.items.map((item) => item.id) ?? [],
    ["zeta", "alpha", "mu", "omega"],
  );
});

test("atomically reconciles transcript history with exact correlated activity", () => {
  const hub = new ActivityHub({ streamEpoch: "transcript-reconcile" });
  hub.ingest("session-1", "codex", {
    type: "upsert",
    item: {
      id: "hook-tool",
      kind: "tool",
      toolCallId: "call-1",
      name: "Bash",
      state: "complete",
      correlationId: "tool:call-1",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });

  assert.equal(hub.reconcileTranscript("session-1", "codex", [
    {
      id: "transcript:user",
      kind: "message",
      role: "user",
      text: "initial prompt",
      state: "complete",
      source: "transcript",
      confidence: "inferred",
      exposure: "transcript-derived",
    },
    {
      id: "transcript:reasoning",
      kind: "reasoning",
      reasoningKind: "summary",
      text: "uncovered reasoning",
      source: "transcript",
      confidence: "inferred",
      exposure: "transcript-derived",
    },
    {
      id: "transcript:tool",
      kind: "tool",
      toolCallId: "call-1",
      name: "Bash",
      correlationId: "tool:call-1",
      source: "transcript",
      confidence: "inferred",
      exposure: "transcript-derived",
    },
  ], false), true);

  assert.deepEqual(
    hub.snapshot("session-1")?.items.map((item) => item.id),
    ["transcript:user", "transcript:reasoning", "hook-tool"],
  );
  assert.equal(
    hub.snapshot("session-1")?.items.filter((item) => item.correlationId === "tool:call-1").length,
    1,
  );
});

test("repeated transcript hydration is a no-op and hook to API correlation keeps one slot", () => {
  const hub = new ActivityHub({ streamEpoch: "transcript-noop" });
  const transcript = [{
    ...message("transcript:tool", "placeholder", "complete"),
    kind: "tool" as const,
    toolCallId: "call-1",
    name: "Bash",
    correlationId: "tool:call-1",
    source: "transcript" as const,
    confidence: "inferred" as const,
    exposure: "transcript-derived" as const,
  }];
  assert.equal(hub.reconcileTranscript("session-1", "claude", transcript, false), true);
  const hydratedSeq = hub.snapshot("session-1")!.seq;
  assert.equal(hub.reconcileTranscript("session-1", "claude", transcript, false), false);
  assert.equal(hub.snapshot("session-1")!.seq, hydratedSeq);

  const hook = hub.ingest("session-1", "claude", {
    type: "upsert",
    item: {
      id: "hook-tool",
      kind: "tool",
      toolCallId: "call-1",
      name: "Bash",
      correlationId: "tool:call-1",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  assert.equal(hook.type, "activity.reset");
  assert.deepEqual(hub.snapshot("session-1")!.items.map((item) => item.id), ["hook-tool"]);

  const managed = hub.ingest("session-1", "claude", {
    type: "upsert",
    item: {
      id: "sdk-tool",
      kind: "tool",
      toolCallId: "call-1",
      name: "Bash",
      result: "done",
      correlationId: "tool:call-1",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    },
  });
  assert.equal(managed.type, "activity.reset");
  assert.deepEqual(hub.snapshot("session-1")!.items.map((item) => item.id), ["sdk-tool"]);
  assert.equal(hub.reconcileTranscript("session-1", "claude", transcript, false), false);
});

test("a source withdraws only its own items when it hands the session over", () => {
  // A hook bridge and the transcript reader id the same event differently and
  // the hub dedupes by id, so a producer that falls silent without withdrawing
  // leaves every item duplicated for the life of the session.
  const hub = new ActivityHub();
  hub.ingest("session-1", "claude", {
    type: "reset",
    reason: "transcript-reset",
    items: [
      message("transcript:one", "polled", "complete"),
      message("claude-hook:one", "bridged", "complete"),
      message("transcript:two", "polled", "complete"),
    ],
  });

  assert.equal(hub.removeMatching("session-1", (id) => id.startsWith("transcript:")), true);
  assert.deepEqual(
    hub.snapshot("session-1")?.items.map((item) => item.id) ?? [],
    ["claude-hook:one"],
  );
  assert.equal(hub.removeMatching("session-1", (id) => id.startsWith("transcript:")), false);
});
