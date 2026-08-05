import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub, type ActivityFrame } from "../activity/index.ts";
import type { SessionView } from "../core/types.ts";
import { observeOnlyControl } from "../shared/session.ts";
import { SelectedTranscriptActivityObserver } from "./activity-observer.ts";
import type { TranscriptItem, TranscriptReadResult } from "./transcript.ts";
import { unknownSandbox } from "../shared/session.ts";

function externalSession(): SessionView {
  return {
    sandbox: unknownSandbox(),
    id: "codex:external-thread",
    provider: "codex",
    providerThreadId: "external-thread",
    providerTreeId: "external-thread",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "External",
    cwd: "/tmp",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "running",
    providerStatus: "running",
    pid: 42,
    runtimePid: 42,
    startedAt: null,
    updatedAt: "2026-08-03T00:00:00.000Z",
    childSummary: {
      total: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    },
    statusSource: "transcript",
    source: "fixture",
    profile: {
      value: null,
      providerValue: null,
      source: "transcript",
      confidence: "inferred",
    },
    model: {
      value: null,
      providerValue: null,
      source: "transcript",
      confidence: "inferred",
    },
    effort: {
      value: null,
      providerValue: null,
      source: "transcript",
      confidence: "inferred",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: observeOnlyControl(),
    workspaceIdentity: null,
    generation: 1,
  };
}

function available(items: TranscriptItem[], truncated = false): TranscriptReadResult {
  return {
    items,
    transcript: {
      state: "available",
      truncated,
      source: "codex-rollout",
      itemCount: items.length,
      reason: null,
    },
  };
}

function transcript(id: string, text: string, truncated = false): TranscriptReadResult {
  return available([{
    kind: "message",
    id,
    role: "assistant",
    text,
    createdAt: "2026-08-03T00:00:01.000Z",
    status: "running",
    label: null,
  }], truncated);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("observes a selected transcript live and stops polling after release", async () => {
  const hub = new ActivityHub({ streamEpoch: "observer-test" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  let current = transcript("message-1", "first partial");
  let reads = 0;
  const frames: ActivityFrame[] = [];
  const unsubscribe = hub.subscribe(session.id, (frame) => frames.push(frame));
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: {
      read() {
        reads += 1;
        return structuredClone(current);
      },
    },
    runningPollMs: 100,
    idlePollMs: 200,
  });

  const release = observer.acquire(session);
  const initial = hub.snapshot(session.id)?.items[0];
  assert.equal(initial?.kind, "message");
  assert.equal(
    initial?.kind === "message" ? initial.text : null,
    "first partial",
  );

  current = transcript("message-1", "second partial");
  await delay(140);
  const updated = hub.snapshot(session.id)?.items[0];
  assert.equal(updated?.kind === "message" ? updated.text : null, "second partial");

  current = transcript("replacement-message", "replacement branch", true);
  await delay(140);
  const lastFrame = frames.at(-1);
  assert.equal(lastFrame?.type, "activity.reset");
  assert.equal(
    lastFrame?.type === "activity.reset" ? lastFrame.reason : null,
    "truncation",
  );

  release();
  const readsAfterRelease = reads;
  current = transcript("replacement-message", "must not be observed", true);
  await delay(160);
  assert.equal(reads, readsAfterRelease);
  const settled = hub.snapshot(session.id)?.items[0];
  assert.equal(settled?.kind === "message" ? settled.text : null, "replacement branch");

  unsubscribe();
  observer.dispose();
  hub.dispose();
});

test("projects transcript failure reasons into the sole activity timeline", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-unavailable" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  let reason: "not-found" | "unreadable" = "not-found";
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: {
      read() {
        return {
          items: [],
          transcript: {
            state: "unavailable",
            truncated: false,
            source: null,
            itemCount: 0,
            reason,
          },
        };
      },
    },
  });

  const release = observer.acquire(session);
  let item = hub.snapshot(session.id)?.items[0];
  assert.equal(item?.kind, "lifecycle");
  assert.equal(item?.kind === "lifecycle" ? item.title : null, "No transcript found");
  assert.equal(item?.source, "transcript");
  assert.equal(item?.confidence, "inferred");

  reason = "unreadable";
  observer.seedOnce(session);
  item = hub.snapshot(session.id)?.items[0];
  assert.equal(item?.kind === "lifecycle" ? item.title : null, "Transcript unreadable");
  assert.equal(item?.state, "failed");

  release();
  observer.dispose();
  hub.dispose();
});

test("replaces an unavailable lifecycle fact when transcript content appears", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-recovered" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  let current: TranscriptReadResult = {
    items: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      itemCount: 0,
      reason: "not-found",
    },
  };
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: { read: () => structuredClone(current) },
  });

  const release = observer.acquire(session);
  current = transcript("recovered", "History is now available");
  observer.seedOnce(session);
  const items = hub.snapshot(session.id)?.items ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "message");
  assert.equal(items[0]?.kind === "message" ? items[0].text : null, "History is now available");

  release();
  observer.dispose();
  hub.dispose();
});

test("a transient transcript read failure preserves already reconciled history", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-transient-unavailable" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  let current: TranscriptReadResult = transcript("retained", "History stays visible");
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: { read: () => structuredClone(current) },
  });

  const release = observer.acquire(session);
  current = {
    items: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      itemCount: 0,
      reason: "unreadable",
    },
  };
  observer.seedOnce(session);

  const unavailable = hub.snapshot(session.id)?.items ?? [];
  assert.deepEqual(
    unavailable.map((item) => item.kind === "message" ? item.text : item.kind === "lifecycle" ? item.title : item.kind),
    ["History stays visible", "Transcript unreadable"],
  );
  const sequence = hub.snapshot(session.id)?.seq;
  observer.seedOnce(session);
  assert.equal(hub.snapshot(session.id)?.seq, sequence, "the same unavailable fact is a no-op");

  current = transcript("retained", "History stays visible");
  observer.seedOnce(session);
  const recovered = hub.snapshot(session.id)?.items ?? [];
  assert.deepEqual(recovered.map((item) => item.kind), ["message"]);
  assert.equal(recovered[0]?.kind === "message" ? recovered[0].text : null, "History stays visible");

  release();
  observer.dispose();
  hub.dispose();
});

test("reselecting during a transient transcript failure retains history and one availability fact", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-reselect-unavailable" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  let current: TranscriptReadResult = transcript("retained", "History survives reselect");
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: { read: () => structuredClone(current) },
  });

  observer.acquire(session)();
  current = {
    items: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      itemCount: 0,
      reason: "unreadable",
    },
  };

  observer.acquire(session)();
  const firstReselect = hub.snapshot(session.id)!;
  assert.deepEqual(
    firstReselect.items.map((item) => item.id),
    ["transcript:retained", "transcript:availability"],
  );
  assert.equal(
    firstReselect.items.filter((item) => item.id === "transcript:availability").length,
    1,
  );

  observer.acquire(session)();
  const secondReselect = hub.snapshot(session.id)!;
  assert.equal(secondReselect.seq, firstReselect.seq, "the bounded fact is not rewritten on every reselect");
  assert.deepEqual(
    secondReselect.items.map((item) => item.id),
    ["transcript:retained", "transcript:availability"],
  );

  observer.dispose();
  hub.dispose();
});

test("projects transcript tool and reasoning items with transcript-derived provenance", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-tools" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: {
      read: () => available([
        {
          kind: "reasoning",
          id: "claude:msg-one:thinking:0",
          text: "Read the reader first.",
          createdAt: "2026-08-03T00:00:01.000Z",
          status: "complete",
          label: null,
        },
        {
          kind: "tool",
          id: "claude:tool:toolu_01",
          toolCallId: "toolu_01",
          name: "Read",
          arguments: { file_path: "/repo/README.md" },
          result: "# Agent Manager",
          isError: false,
          createdAt: "2026-08-03T00:00:02.000Z",
          status: "complete",
        },
        {
          kind: "tool",
          id: "claude:tool:toolu_02",
          toolCallId: "toolu_02",
          name: "Bash",
          arguments: { command: "rg -n seq" },
          result: "rg: command not found",
          isError: true,
          createdAt: "2026-08-03T00:00:03.000Z",
          status: "complete",
        },
      ]),
    },
  });

  const release = observer.acquire(session);
  const items = hub.snapshot(session.id)?.items ?? [];
  assert.deepEqual(items.map((item) => [item.kind, item.id]), [
    ["reasoning", "transcript:claude:msg-one:thinking:0"],
    ["tool", "transcript:claude:tool:toolu_01"],
    ["tool", "transcript:claude:tool:toolu_02"],
  ]);
  for (const item of items) {
    assert.equal(item.source, "transcript");
    assert.equal(item.confidence, "inferred");
    assert.equal(item.exposure, "transcript-derived");
  }

  const reasoning = items[0];
  assert.equal(reasoning?.kind === "reasoning" ? reasoning.text : null, "Read the reader first.");
  assert.equal(reasoning?.kind === "reasoning" ? reasoning.reasoningKind : null, "summary");

  const read = items[1];
  assert.equal(read?.kind === "tool" ? read.name : null, "Read");
  assert.equal(read?.kind === "tool" ? read.toolCallId : null, "toolu_01");
  assert.deepEqual(read?.kind === "tool" ? read.arguments : null, { file_path: "/repo/README.md" });
  assert.equal(read?.kind === "tool" ? read.result : null, "# Agent Manager");
  assert.equal(read?.state, "complete");
  assert.equal(items[2]?.state, "failed");

  release();
  observer.dispose();
  hub.dispose();
});

test("does not invent a final phase for a complete transcript assistant message", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-message-phase" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: {
      read: () => available([{
        kind: "message",
        id: "assistant-between-tools",
        role: "assistant",
        text: "I checked the first result.",
        createdAt: "2026-08-03T00:00:02.000Z",
        status: "complete",
        label: null,
      }]),
    },
  });

  const release = observer.acquire(session);
  const item = hub.snapshot(session.id)?.items[0];
  assert.equal(item?.kind, "message");
  assert.equal(item?.kind === "message" ? item.phase : "unexpected", null);

  release();
  observer.dispose();
  hub.dispose();
});

test("re-observes a tool call when only its result arrives", async () => {
  const hub = new ActivityHub({ streamEpoch: "observer-tool-result" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  const pending: TranscriptItem = {
    kind: "tool",
    id: "codex:tool:call_shell",
    toolCallId: "call_shell",
    name: "exec",
    arguments: "ls -la",
    result: null,
    isError: false,
    createdAt: "2026-08-03T00:00:01.000Z",
    status: "running",
  };
  let current = available([pending]);
  const frames: ActivityFrame[] = [];
  const unsubscribe = hub.subscribe(session.id, (frame) => frames.push(frame));
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: { read: () => structuredClone(current) },
    runningPollMs: 100,
    idlePollMs: 200,
  });

  const release = observer.acquire(session);
  assert.equal(hub.snapshot(session.id)?.items[0]?.state, "running");

  current = available([{ ...pending, result: "README.md", status: "complete" }]);
  await delay(140);
  const settled = hub.snapshot(session.id)?.items[0];
  assert.equal(settled?.kind === "tool" ? settled.result : null, "README.md");
  assert.equal(settled?.state, "complete");
  assert.equal(frames.at(-1)?.type, "activity.reset");

  release();
  unsubscribe();
  observer.dispose();
  hub.dispose();
});

/*
  The activity window is volatile and nothing rehydrates it, so after a restart
  a manager-owned session has no history and neither provider replays one —
  Codex resumes with `excludeTurns`, and Claude's SDK child died with the
  process. The operator was shown "Waiting for provider activity", which is not
  what happened.
*/
test("hydrates an empty view from the transcript without taking the session over", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-seed" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  let reads = 0;
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: { read() { reads += 1; return transcript("message-1", "earlier turn"); } },
    // The seed deliberately bypasses eligibility: that predicate keeps two
    // *live* producers off one session, and here there is no producer at all.
    eligible: () => false,
  });

  assert.equal(observer.hydrate(session), true);
  assert.equal(reads, 1);
  const items = hub.snapshot(session.id)?.items ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === "message" ? items[0].text : null, "earlier turn");
  // Provenance stays honest: a transcript item is reconstructed, never exact.
  assert.equal(items[0]?.source, "transcript");
  assert.equal(items[0]?.confidence, "inferred");
  assert.equal(items[0]?.exposure, "transcript-derived");

  observer.dispose();
  hub.dispose();
});

test("hydrates history into a view that already holds provider activity", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-seed-live" });
  const session = externalSession();
  hub.ingest(session.id, session.provider, {
    type: "upsert",
    item: { id: "codex/live", kind: "message", role: "assistant", text: "live", state: "complete" },
  });
  let reads = 0;
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: { read() { reads += 1; return transcript("message-1", "earlier turn"); } },
  });

  assert.equal(hub.isEmpty(session.id), false);
  assert.equal(observer.hydrate(session), true);
  assert.equal(reads, 1);
  assert.deepEqual(
    hub.snapshot(session.id)?.items.map((item) => item.id),
    ["transcript:message-1", "codex/live"],
  );

  observer.dispose();
  hub.dispose();
});

test("reports an unreadable transcript instead of presenting silence", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-seed-missing" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: {
      read() {
        return {
          items: [],
          transcript: { state: "unavailable", truncated: false, source: null, itemCount: 0, reason: "not-found" },
        };
      },
    },
  });

  assert.equal(observer.hydrate(session), false);
  const items = hub.snapshot(session.id)?.items ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === "lifecycle" ? items[0].title : null, "No transcript found");

  observer.dispose();
  hub.dispose();
});

test("carries a provider truncation through the seed", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-seed-truncated" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  const observer = new SelectedTranscriptActivityObserver({
    hub,
    reader: { read() { return transcript("message-1", "earlier turn", true); } },
  });

  assert.equal(observer.hydrate(session), true);
  assert.equal(hub.snapshot(session.id)?.truncated, true);

  observer.dispose();
  hub.dispose();
});

test("the retention boundary is stated once, and only when something is missing", () => {
  const hub = new ActivityHub({ streamEpoch: "observer-boundary" });
  const session = externalSession();
  hub.ensureSession(session.id, session.provider);
  const frames: ActivityFrame[] = [];
  const unsubscribe = hub.subscribe(session.id, (frame) => frames.push(frame));

  hub.markRetentionBoundary(session.id);
  hub.markRetentionBoundary(session.id);

  assert.equal(frames.filter((frame) => frame.type === "activity.reset").length, 1);
  assert.equal(hub.snapshot(session.id)?.truncated, true);

  unsubscribe();
  hub.dispose();
});
