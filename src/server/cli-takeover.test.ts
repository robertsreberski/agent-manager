import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import {
  CliTakeoverCoordinator,
  type LocalCliInspection,
  type LocalCliProcessIdentity,
  type LocalCliProcessInspector,
} from "./cli-takeover.ts";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "local:codex:thread-1",
    provider: "codex",
    providerThreadId: "thread-1",
    providerTreeId: "thread-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "CLI session",
    cwd: "/tmp/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: 42,
    runtimePid: 42,
    startedAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:00:00.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "process",
    source: "fixture",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: "gpt-test", providerValue: "gpt-test", source: "provider-cli", confidence: "exact" },
    effort: { value: "high", providerValue: "high", source: "provider-cli", confidence: "exact" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
    workspaceIdentity: null,
    generation: 1,
    ...overrides,
  };
}

const identity: LocalCliProcessIdentity = {
  pid: 42,
  uid: 501,
  executable: "codex",
  startedAt: "Wed Aug 5 10:00:00 2026",
  providerSessionId: "thread-1",
  cwd: "/tmp/workspace",
};

class FakeInspector implements LocalCliProcessInspector {
  inspection: LocalCliInspection = { state: "running", identity };
  signals: LocalCliProcessIdentity[] = [];
  exitOnSignal = false;

  inspect(): LocalCliInspection {
    return structuredClone(this.inspection);
  }

  terminate(value: LocalCliProcessIdentity): void {
    this.signals.push(structuredClone(value));
    if (this.exitOnSignal) this.inspection = { state: "exited" };
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for takeover state");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function fixture(inspector: FakeInspector, overrides: Partial<ConstructorParameters<typeof CliTakeoverCoordinator>[0]> = {}) {
  let current = session();
  let adoptedCalls = 0;
  let persistedCalls = 0;
  let rollbackCalls = 0;
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    canAdopt: () => true,
    randomId: () => "takeover-1",
    guidedTimeoutMs: 80,
    gracefulExitTimeoutMs: 20,
    adoptionTimeoutMs: 40,
    pollIntervalMs: 2,
    adopt: async (original, profile) => {
      adoptedCalls += 1;
      return session({
        ...original,
        profile: { value: profile, providerValue: profile, source: "provider-api", confidence: "exact" },
        pid: null,
        runtimePid: null,
        control: {
          plane: "codex-private",
          authority: "manager",
          capabilities: ["queue"],
          withheld: [],
          takeover: null,
        },
      });
    },
    persist: () => { persistedCalls += 1; },
    rollback: () => { rollbackCalls += 1; },
    onChange: () => { current = coordinator.decorate(current); },
    onAdopted: (adopted) => { current = adopted; },
    ...overrides,
  });
  current = coordinator.decorate(current);
  return {
    coordinator,
    current: () => current,
    adoptedCalls: () => adoptedCalls,
    persistedCalls: () => persistedCalls,
    rollbackCalls: () => rollbackCalls,
  };
}

test("guided takeover is cancelable while waiting and never signals the CLI", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector);
  assert.equal(value.current().control.takeover?.fallbackProfile, "plan");
  assert.ok(value.current().control.capabilities.includes("take-control"));

  const begun = await value.coordinator.begin(value.current(), "guided-exit");
  assert.equal(value.current().control.takeover?.state, "waiting-for-exit");
  assert.ok(value.current().control.capabilities.includes("cancel-take-control"));
  value.coordinator.cancel(value.current().id, begun.takeoverId);

  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  assert.equal(value.current().control.takeover?.state, "available");
  value.coordinator.dispose();
});

test("guided exit adopts the exact session and persists it before publishing controls", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector);
  await value.coordinator.begin(value.current(), "guided-exit");
  inspector.inspection = { state: "exited" };

  await waitFor(() => value.current().control.authority === "manager");
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 1);
  assert.equal(value.persistedCalls(), 1);
  assert.deepEqual(value.current().control.capabilities, ["queue"]);
  value.coordinator.dispose();
});

test("graceful stop revalidates identity, sends one SIGTERM, and never repeats it", async () => {
  const inspector = new FakeInspector();
  inspector.exitOnSignal = true;
  const value = fixture(inspector);
  await value.coordinator.begin(value.current(), "graceful-stop");

  await waitFor(() => value.current().control.authority === "manager");
  assert.equal(inspector.signals.length, 1);
  assert.deepEqual(inspector.signals[0], identity);
  value.coordinator.dispose();
});

test("rejects PID identity drift before graceful stop without signalling or adopting", async () => {
  const inspector = new FakeInspector();
  let reads = 0;
  inspector.inspect = () => {
    reads += 1;
    return reads === 1
      ? { state: "running", identity }
      : { state: "running", identity: { ...identity, startedAt: "reused PID" } };
  };
  const value = fixture(inspector);
  await value.coordinator.begin(value.current(), "graceful-stop");

  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  assert.equal(value.current().control.authority, "none");
  value.coordinator.dispose();
});

test("graceful timeout sends exactly one signal and leaves retry guidance read-only", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector);
  await value.coordinator.begin(value.current(), "graceful-stop");

  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(inspector.signals.length, 1);
  assert.equal(value.adoptedCalls(), 0);
  assert.ok(value.current().control.capabilities.includes("take-control"));
  assert.match(value.current().control.takeover?.error ?? "", /did not exit/u);
  value.coordinator.dispose();
});

test("provider identity drift after exit never exposes manager capabilities", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector, {
    adopt: async (original) => session({
      ...original,
      id: "local:codex:different-thread",
      providerThreadId: "different-thread",
      control: { plane: "codex-private", authority: "manager", capabilities: ["queue"], withheld: [], takeover: null },
    }),
  });
  await value.coordinator.begin(value.current(), "guided-exit");
  inspector.inspection = { state: "exited" };

  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(value.current().control.authority, "none");
  assert.equal(value.persistedCalls(), 0);
  assert.equal(value.rollbackCalls(), 1);
  value.coordinator.dispose();
});
