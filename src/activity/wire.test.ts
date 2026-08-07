import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub } from "./hub.ts";
import type { ActivityJsonValue } from "./types.ts";
import { ActivityWireError, parseActivityFrame } from "./wire.ts";

function validFrame() {
  const hub = new ActivityHub({ streamEpoch: "remote-epoch" });
  return hub.ingest("remote-session", "codex", {
    type: "upsert",
    item: {
      id: "message-1",
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "hello",
      label: null,
      state: "running",
    },
  });
}

test("accepts and clones an exact activity frame", () => {
  const input = validFrame();
  const parsed = parseActivityFrame(input);
  assert.deepEqual(parsed, input);
  if (parsed.type === "activity.upsert" && parsed.item.kind === "message") {
    parsed.item.text = "changed";
  }
  assert.equal(
    input.type === "activity.upsert" && input.item.kind === "message" ? input.item.text : null,
    "hello",
  );
});

test("round-trips an opaque reasoning marker and validates its flag", () => {
  const frame = new ActivityHub({ streamEpoch: "opaque-reasoning" }).ingest(
    "remote-session",
    "codex",
    {
      type: "upsert",
      item: {
        id: "reasoning-1",
        kind: "reasoning",
        reasoningKind: "summary",
        text: "",
        opaque: true,
      },
    },
  );
  const parsed = parseActivityFrame(frame);
  assert.equal(
    parsed.type === "activity.upsert" && parsed.item.kind === "reasoning"
      ? parsed.item.opaque
      : null,
    true,
  );

  const invalid = structuredClone(frame) as unknown as {
    item: Record<string, unknown>;
  };
  invalid.item.opaque = "true";
  assert.throws(() => parseActivityFrame(invalid), /opaque/u);
});

test("strictly validates structured message memory citations", () => {
  const frame = validFrame();
  if (frame.type !== "activity.upsert" || frame.item.kind !== "message") return;
  frame.item.memoryCitation = {
    entries: [{ path: "MEMORY.md", lineStart: 1, lineEnd: 3, note: "prior context" }],
    rolloutIds: ["019fcbd5-7a38-7c31-a5f7-e199f5b06f4e"],
  };
  assert.doesNotThrow(() => parseActivityFrame(frame));

  const invalid = structuredClone(frame);
  if (invalid.type !== "activity.upsert" || invalid.item.kind !== "message" || !invalid.item.memoryCitation) return;
  invalid.item.memoryCitation.rolloutIds = ["not-a-rollout-id"];
  assert.throws(() => parseActivityFrame(invalid), /rolloutIds/u);
});

test("rejects unknown, incomplete, and unsafe nested wire data", () => {
  const unknown = { ...validFrame(), compatibilityAlias: true };
  assert.throws(() => parseActivityFrame(unknown), ActivityWireError);

  const incomplete = structuredClone(validFrame()) as unknown as Record<string, unknown>;
  delete incomplete.cursor;
  assert.throws(() => parseActivityFrame(incomplete), /missing field cursor/);

  const tool = new ActivityHub({ streamEpoch: "tool-epoch" }).ingest("remote-session", "claude", {
    type: "upsert",
    item: {
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "Read",
      arguments: { path: "README.md" },
      result: null,
      output: "",
    },
  });
  if (tool.type === "activity.upsert" && tool.item.kind === "tool") {
    tool.item.arguments = JSON.parse('{"__proto__":{"polluted":true}}') as ActivityJsonValue;
  }
  assert.throws(() => parseActivityFrame(tool), /unsafe key/);
});

test("rejects a schema or provider mismatch before remote projection", () => {
  const wrongSchema = { ...validFrame(), schemaVersion: 99 };
  assert.throws(() => parseActivityFrame(wrongSchema), /schema version/);

  const wrongProvider = { ...validFrame(), provider: "other" };
  assert.throws(() => parseActivityFrame(wrongProvider), /provider/);
});

test("rejects the removed merged plan/checklist wire shape", () => {
  const frame = validFrame();
  if (frame.type !== "activity.upsert") return;
  const removed = {
    ...frame,
    item: {
      ...frame.item,
      kind: "plan",
      text: "not a document contract",
      steps: [],
    },
  };
  assert.throws(() => parseActivityFrame(removed), /unknown field/);
});

test("requires explicit todo churn facts and scopes removal reasons to tombstones", () => {
  const frame = new ActivityHub({ streamEpoch: "todo-wire" }).ingest(
    "remote-session",
    "codex",
    {
      type: "upsert",
      item: {
        id: "todos",
        kind: "todo",
        steps: [{
          id: "step-1",
          text: "Implement",
          status: "pending",
          detail: null,
          addedAfterStart: true,
          removedReason: null,
        }],
        added: 1,
        removed: 0,
      },
    },
  );
  assert.doesNotThrow(() => parseActivityFrame(frame));
  if (frame.type !== "activity.upsert" || frame.item.kind !== "todo") return;

  const missing = structuredClone(frame);
  if (missing.type !== "activity.upsert" || missing.item.kind !== "todo") return;
  delete (missing.item.steps[0] as unknown as Record<string, unknown>).addedAfterStart;
  assert.throws(() => parseActivityFrame(missing), /addedAfterStart/u);

  const inventedReason = structuredClone(frame);
  if (inventedReason.type !== "activity.upsert" || inventedReason.item.kind !== "todo") return;
  inventedReason.item.steps[0]!.removedReason = "inferred from replacement";
  assert.throws(() => parseActivityFrame(inventedReason), /requires removed status/u);

  const duplicate = structuredClone(frame);
  if (duplicate.type !== "activity.upsert" || duplicate.item.kind !== "todo") return;
  duplicate.item.steps.push(structuredClone(duplicate.item.steps[0]!));
  assert.throws(() => parseActivityFrame(duplicate), /duplicate id/u);
});

test("requires the exact nullable plan approval identity edge", () => {
  const frame = new ActivityHub({ streamEpoch: "plan-wire" }).ingest(
    "remote-session",
    "claude",
    {
      type: "upsert",
      item: {
        id: "plan-1",
        kind: "plan",
        markdown: "# Exact plan",
        approvalRequestId: "request-1",
      },
    },
  );
  assert.doesNotThrow(() => parseActivityFrame(frame));
  if (frame.type !== "activity.upsert" || frame.item.kind !== "plan") return;
  const missing = structuredClone(frame) as typeof frame & {
    item: Record<string, unknown>;
  };
  delete missing.item.approvalRequestId;
  assert.throws(() => parseActivityFrame(missing), /missing field approvalRequestId/);
});

test("strictly validates approval facts and exact unknowns", () => {
  const frame = new ActivityHub({ streamEpoch: "approval-wire" }).ingest(
    "remote-session",
    "codex",
    {
      type: "upsert",
      item: {
        id: "approval-1",
        kind: "attention",
        requestId: "request-1",
        attentionKind: "approval",
        approvalFacts: {
          command: "git status",
          paths: null,
          writes: [],
          network: null,
          canPersist: true,
          deleteCount: null,
        },
      },
    },
  );
  assert.doesNotThrow(() => parseActivityFrame(frame));
  if (frame.type !== "activity.upsert" || frame.item.kind !== "attention") return;
  const invented = structuredClone(frame) as typeof frame & {
    item: { approvalFacts: Record<string, unknown> };
  };
  invented.item.approvalFacts.inferredDeletes = 412;
  assert.throws(() => parseActivityFrame(invented), /unknown field inferredDeletes/);

  const negative = structuredClone(frame);
  if (negative.type === "activity.upsert" && negative.item.kind === "attention" &&
      negative.item.approvalFacts) {
    negative.item.approvalFacts.deleteCount = -1;
  }
  assert.throws(() => parseActivityFrame(negative), /deleteCount must be an integer/);
});

test("requires the exact nullable provider recommendation fact", () => {
  const frame = new ActivityHub({ streamEpoch: "question-wire" }).ingest(
    "remote-session",
    "codex",
    {
      type: "upsert",
      item: {
        id: "question-1",
        kind: "attention",
        requestId: "request-1",
        attentionKind: "question",
        questions: [{
          id: "destination",
          text: "Where?",
          options: [{ label: "Moon", description: null }],
          multiSelect: false,
          allowFreeText: false,
          isSecret: false,
        }],
      },
    },
  );
  assert.doesNotThrow(() => parseActivityFrame(frame));
  if (frame.type !== "activity.upsert" || frame.item.kind !== "attention") return;
  assert.equal(frame.item.questions[0]?.options[0]?.recommended, null);

  const missing = structuredClone(frame);
  if (missing.type !== "activity.upsert" || missing.item.kind !== "attention") return;
  delete (missing.item.questions[0]!.options[0] as unknown as Record<string, unknown>).recommended;
  assert.throws(() => parseActivityFrame(missing), /missing field recommended/u);

  const invented = structuredClone(frame);
  if (invented.type !== "activity.upsert" || invented.item.kind !== "attention") return;
  (invented.item.questions[0]!.options[0] as unknown as Record<string, unknown>).recommended = "yes";
  assert.throws(() => parseActivityFrame(invented), /recommended must be boolean/u);
});

test("requires an explicit nullable previous path for every file change", () => {
  const frame = new ActivityHub({ streamEpoch: "file-wire" }).ingest(
    "remote-session",
    "codex",
    {
      type: "upsert",
      item: {
        id: "files-1",
        kind: "file-change",
        changes: [{
          path: "src/new.ts",
          previousPath: "src/old.ts",
          operation: "rename",
          diff: "rename",
        }],
      },
    },
  );
  assert.doesNotThrow(() => parseActivityFrame(frame));
  if (frame.type !== "activity.upsert" || frame.item.kind !== "file-change") return;
  const missing = structuredClone(frame) as typeof frame & {
    item: { changes: Array<Record<string, unknown>> };
  };
  delete missing.item.changes[0]!.previousPath;
  assert.throws(() => parseActivityFrame(missing), /missing field previousPath/);
});
