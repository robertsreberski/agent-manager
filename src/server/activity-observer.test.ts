import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHub, type ActivityFrame } from "../activity/index.ts";
import type { SessionView } from "../core/types.ts";
import { SelectedTranscriptActivityObserver } from "./activity-observer.ts";
import type { TranscriptReadResult } from "./transcript.ts";

function externalSession(): SessionView {
  return {
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
    control: {
      plane: "observe-only",
      authority: "none",
      capabilities: [],
      withheld: [],
    },
    workspaceIdentity: null,
    generation: 1,
  };
}

function transcript(id: string, text: string, truncated = false): TranscriptReadResult {
  return {
    messages: [{
      id,
      role: "assistant",
      text,
      createdAt: "2026-08-03T00:00:01.000Z",
      status: "running",
      label: null,
    }],
    transcript: {
      state: "available",
      truncated,
      source: "codex-rollout",
      messageCount: 1,
      reason: null,
    },
  };
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
          messages: [],
          transcript: {
            state: "unavailable",
            truncated: false,
            source: null,
            messageCount: 0,
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
    messages: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      messageCount: 0,
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
