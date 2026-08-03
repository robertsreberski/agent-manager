import assert from "node:assert/strict";
import test from "node:test";

import { SessionStateStore } from "./state.ts";

function transcriptBearingSession() {
  return {
    id: "codex:thread-1",
    provider: "codex" as const,
    sessionId: "thread-1",
    parentSessionId: null,
    rootSessionId: "thread-1",
    depth: 0,
    name: "Private conversation",
    cwd: "/tmp/workspace",
    kind: "interactive" as const,
    lifecycle: "live" as const,
    status: "idle" as const,
    providerStatus: "idle",
    waitingReason: null,
    pid: null,
    runtimePid: null,
    startedAt: null,
    updatedAt: "2026-08-03T00:00:00.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "transcript" as const,
    source: "fixture",
    ownership: "external" as const,
    runtimeAlive: false,
    mode: { value: "unknown" as const, providerValue: null, source: "inferred" as const, confidence: "heuristic" as const },
    activity: "idle" as const,
    attention: [],
    effectiveAccess: { permissionMode: null, sandboxMode: null, fullHostAccess: false },
    terminal: null,
    control: { plane: "observe-only" as const, capabilities: [], managerOwned: false, writableLease: false },
    generation: 0,
    messages: [{
      id: "private-message",
      role: "user" as const,
      text: "must stay out of global state",
      createdAt: null,
      status: "complete" as const,
      label: null,
    }],
    transcript: {
      state: "available" as const,
      truncated: false,
      source: "codex-rollout" as const,
      messageCount: 1,
      reason: null,
    },
  };
}

test("never retains transcript content in snapshots or replay events", () => {
  const state = new SessionStateStore();
  state.upsert(transcriptBearingSession());

  const stored = state.snapshot().sessions[0]!;
  assert.equal("messages" in stored, false);
  assert.equal("transcript" in stored, false);
  const event = state.events.replayAfter(0).events[0]!;
  assert.equal(JSON.stringify(event).includes("must stay out of global state"), false);
});

test("runtime diagnostics survive discovery diagnostic replacement", () => {
  const state = new SessionStateStore();
  const runtime = {
    provider: "codex" as const,
    level: "error" as const,
    message: "Managed Codex runtime exited unexpectedly",
  };
  const discovery = {
    provider: "claude" as const,
    level: "warning" as const,
    message: "Claude discovery was temporarily unavailable",
  };

  state.addDiagnostic(runtime);
  state.replace([], [discovery]);
  assert.deepEqual(state.snapshot().diagnostics, [discovery, runtime]);

  state.replace([], []);
  assert.deepEqual(state.snapshot().diagnostics, [runtime]);
});
