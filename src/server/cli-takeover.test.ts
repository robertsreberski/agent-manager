import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import { providerControlCoordination, unknownSandbox } from "../shared/session.ts";
import { sessionRecordSchema } from "../shared/wire.ts";
import {
  CliTakeoverCoordinator,
  localCliSignalIntentFingerprint,
  SystemLocalCliProcessInspector,
  type CliTakeoverSignalIntent,
  type CliTakeoverSignalJournal,
  type LocalCliInspection,
  type LocalCliProcessIdentity,
  type LocalCliProcessInspector,
} from "./cli-takeover.ts";

function session(overrides: Partial<SessionView> = {}): SessionView {
  const provider = overrides.provider ?? "codex";
  return {
    id: "local:codex:thread-1",
    provider,
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
    sandbox: unknownSandbox(),
    model: { value: "gpt-test", providerValue: "gpt-test", source: "provider-cli", confidence: "exact" },
    effort: { value: "high", providerValue: "high", source: "provider-cli", confidence: "exact" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "observe-only",
      authority: "none",
      coordination: providerControlCoordination(provider),
      recovery: null,
      capabilities: [],
      withheld: [],
      takeover: null,
    },
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

  inspect(
    _session: SessionView,
    _expected?: LocalCliProcessIdentity,
    _options?: Parameters<LocalCliProcessInspector["inspect"]>[2],
  ): Promise<LocalCliInspection> | LocalCliInspection {
    return structuredClone(this.inspection);
  }

  terminate(value: LocalCliProcessIdentity): void {
    this.signals.push(structuredClone(value));
    if (this.exitOnSignal) this.inspection = { state: "exited" };
  }
}

class ResumeInspector extends FakeInspector {
  associated: LocalCliInspection = { state: "exited" };

  findAssociated(): LocalCliInspection {
    return structuredClone(this.associated);
  }
}

function resumableSession(provider: "codex" | "claude" = "codex"): SessionView {
  return session({
    id: `local:${provider}:thread-1`,
    provider,
    providerTreeId: "thread-1",
    pid: null,
    runtimePid: null,
    status: "completed",
    presence: "recent",
    control: {
      plane: "resume-only",
      authority: "manager",
      coordination: providerControlCoordination(provider),
      recovery: null,
      capabilities: ["resume"],
      withheld: [],
      takeover: null,
    },
  });
}

function takeoverSession(overrides: Partial<SessionView> = {}): SessionView {
  return session({
    id: "local:claude:thread-1",
    provider: "claude",
    providerTreeId: "thread-1",
    control: {
      plane: "observe-only",
      authority: "none",
      coordination: providerControlCoordination("claude"),
      recovery: null,
      capabilities: [],
      withheld: [],
      takeover: null,
    },
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for takeover state");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function hasCapability(
  value: SessionView,
  capability: SessionView["control"]["capabilities"][number],
): boolean {
  return value.control.capabilities.includes(capability);
}

function fixture(
  inspector: LocalCliProcessInspector,
  overrides: Partial<ConstructorParameters<typeof CliTakeoverCoordinator>[0]> = {},
  initial = takeoverSession(),
) {
  let current = initial;
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
          coordination: providerControlCoordination(original.provider),
          recovery: null,
          capabilities: ["queue"],
          withheld: [],
          takeover: null,
        },
      });
    },
    persist: () => { persistedCalls += 1; },
    rollback: () => { rollbackCalls += 1; },
    verifyTranscriptAssociation: () => ({ state: "associated" }),
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

async function confirmGraceful(value: ReturnType<typeof fixture>): Promise<string> {
  const prepared = await value.coordinator.begin(value.current(), "graceful-stop");
  assert.equal(value.current().control.takeover?.state, "awaiting-confirmation");
  await value.coordinator.begin(
    value.current(),
    "graceful-stop",
    prepared.takeoverId,
  );
  return prepared.takeoverId;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class SetSignalJournal implements CliTakeoverSignalJournal {
  readonly claimed = new Set<string>();
  readonly intents: CliTakeoverSignalIntent[] = [];

  claimSignalIntent(intent: CliTakeoverSignalIntent): boolean {
    this.intents.push(structuredClone(intent));
    if (this.claimed.has(intent.fingerprint)) return false;
    this.claimed.add(intent.fingerprint);
    return true;
  }
}

test("guided takeover is cancelable while waiting and never signals the CLI", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector);
  assert.equal(value.current().control.takeover?.fallbackProfile, "ask-first");
  assert.ok(value.current().control.capabilities.includes("take-control"));

  const begun = await value.coordinator.begin(value.current(), "guided-exit");
  assert.equal(value.current().control.takeover?.state, "waiting-for-exit");
  assert.ok(value.current().control.capabilities.includes("take-control"));
  assert.ok(value.current().control.capabilities.includes("cancel-take-control"));
  value.coordinator.cancel(value.current().id, begun.takeoverId);

  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  assert.equal(value.current().control.takeover?.state, "available");
  await value.coordinator.dispose();
});

test("guided takeover can be revalidated into a fresh separately-confirmed safe stop", async () => {
  const inspector = new FakeInspector();
  const ids = ["guided-1", "graceful-2"];
  const value = fixture(
    inspector,
    { randomId: () => ids.shift() ?? "unexpected-takeover-id" },
    session(),
  );
  const guided = await value.coordinator.begin(value.current(), "guided-exit");

  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop", "stale-guided-id"),
    /stale/u,
  );
  await assert.rejects(
    value.coordinator.begin(
      { ...value.current(), providerThreadId: "different-thread" },
      "graceful-stop",
      guided.takeoverId,
    ),
    /conversation changed/u,
  );
  assert.equal(value.current().control.takeover?.state, "waiting-for-exit");
  assert.equal(inspector.signals.length, 0);

  const prepared = await value.coordinator.begin(
    value.current(),
    "graceful-stop",
    guided.takeoverId,
  );
  assert.equal(prepared.takeoverId, "graceful-2");
  assert.notEqual(prepared.takeoverId, guided.takeoverId);
  assert.equal(value.current().control.takeover?.state, "awaiting-confirmation");
  assert.equal(value.current().control.takeover?.method, "graceful-stop");
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);

  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop", guided.takeoverId),
    /confirmation is stale/u,
  );
  inspector.exitOnSignal = true;
  await value.coordinator.begin(value.current(), "graceful-stop", prepared.takeoverId);
  await waitFor(() => value.current().control.authority === "manager");
  assert.equal(inspector.signals.length, 1);
  assert.equal(value.adoptedCalls(), 1);
  await value.coordinator.dispose();
});

test("guided safe-stop replacement rejects concurrent actions until its exact pin is ready", async () => {
  const inspector = new FakeInspector();
  const revalidation = deferred<LocalCliInspection>();
  let holdRevalidation = false;
  let revalidationStarted = false;
  inspector.inspect = (_session, _expected, options) => {
    if (holdRevalidation && options?.revalidateAssociation !== false) {
      revalidationStarted = true;
      return revalidation.promise;
    }
    return structuredClone(inspector.inspection);
  };
  const ids = ["guided-1", "graceful-2"];
  const value = fixture(
    inspector,
    { randomId: () => ids.shift() ?? "unexpected-takeover-id" },
    session(),
  );
  const guided = await value.coordinator.begin(value.current(), "guided-exit");
  holdRevalidation = true;
  const replacing = value.coordinator.begin(
    value.current(),
    "graceful-stop",
    guided.takeoverId,
  );
  await waitFor(() => revalidationStarted);

  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop", guided.takeoverId),
    /transition is already active/u,
  );
  assert.throws(
    () => value.coordinator.cancel(value.current().id, guided.takeoverId),
    /transition is already active/u,
  );
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);

  revalidation.resolve({ state: "running", identity });
  const prepared = await replacing;
  assert.equal(prepared.takeoverId, "graceful-2");
  value.coordinator.cancel(value.current().id, prepared.takeoverId);
  await value.coordinator.dispose();
});

test("disposal aborts a blocked guided safe-stop replacement without signalling or leaking an attempt", async () => {
  const inspector = new FakeInspector();
  const revalidation = deferred<LocalCliInspection>();
  let holdRevalidation = false;
  let revalidationStarted = false;
  inspector.inspect = (_session, _expected, options) => {
    if (holdRevalidation && options?.revalidateAssociation !== false) {
      revalidationStarted = true;
      return revalidation.promise;
    }
    return structuredClone(inspector.inspection);
  };
  const ids = ["guided-1", "graceful-2"];
  const value = fixture(
    inspector,
    { randomId: () => ids.shift() ?? "unexpected-takeover-id" },
    session(),
  );
  const guided = await value.coordinator.begin(value.current(), "guided-exit");
  holdRevalidation = true;
  const replacing = value.coordinator.begin(
    value.current(),
    "graceful-stop",
    guided.takeoverId,
  );
  await waitFor(() => revalidationStarted);

  const disposing = value.coordinator.dispose();
  await assert.rejects(replacing, /coordinator stopped/u);
  await disposing;
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  assert.equal(value.current().control.takeover, null);
  revalidation.resolve({ state: "running", identity });
});

test("guided safe-stop replacement fails closed on process identity drift", async () => {
  const inspector = new FakeInspector();
  const ids = ["guided-1", "graceful-2"];
  const value = fixture(
    inspector,
    { randomId: () => ids.shift() ?? "unexpected-takeover-id" },
    session(),
  );
  const guided = await value.coordinator.begin(value.current(), "guided-exit");
  inspector.inspection = {
    state: "running",
    identity: { ...identity, startedAt: "reused PID" },
  };

  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop", guided.takeoverId),
    /identity changed/u,
  );
  assert.equal(value.current().control.takeover?.state, "failed");
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  await value.coordinator.dispose();
});

test("guided safe-stop replacement preserves the live guided poll when a fresh id cannot be issued", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector, {}, session());
  const guided = await value.coordinator.begin(value.current(), "guided-exit");

  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop", guided.takeoverId),
    /fresh safe-stop confirmation/u,
  );
  assert.equal(value.current().control.takeover?.state, "waiting-for-exit");
  assert.equal(inspector.signals.length, 0);

  inspector.inspection = { state: "exited" };
  await waitFor(() => value.current().control.authority === "manager");
  assert.equal(value.adoptedCalls(), 1);
  await value.coordinator.dispose();
});

test("remote takeover and resume capabilities remain owned by the remote node", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector);
  const remote = session({
    hostId: "ssh:remote",
    hostLabel: "Remote",
    control: {
      plane: "resume-only",
      authority: "foreign",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["take-control", "cancel-take-control", "resume"],
      withheld: [],
      takeover: {
        id: "remote-takeover",
        state: "waiting-for-exit",
        methods: ["guided-exit"],
        method: "guided-exit",
        requestedAt: "2026-08-05T10:00:00.000Z",
        deadlineAt: "2026-08-05T10:05:00.000Z",
        fallbackProfile: null,
        fallbackSandbox: null,
        error: null,
      },
    },
  });

  assert.deepEqual(value.coordinator.decorate(remote).control, remote.control);
  await value.coordinator.dispose();
});

test("local discovery offers web resume only for stopped conversations", async () => {
  const inspector = new ResumeInspector();
  const value = fixture(inspector);
  const recentCodex = value.coordinator.decorate(resumableSession("codex"));
  const recentClaude = value.coordinator.decorate(resumableSession("claude"));
  const liveCodex = value.coordinator.decorate(session());
  const liveClaude = value.coordinator.decorate(takeoverSession());

  assert.ok(recentCodex.control.capabilities.includes("resume"));
  assert.ok(recentClaude.control.capabilities.includes("resume"));
  assert.ok(liveCodex.control.capabilities.includes("take-control"));
  assert.ok(!liveCodex.control.capabilities.includes("resume"));
  assert.ok(liveClaude.control.capabilities.includes("take-control"));
  assert.ok(!liveClaude.control.capabilities.includes("resume"));
  await value.coordinator.dispose();
});

test("Claude control is not offered without a transcript association verifier", async () => {
  const inspector = new ResumeInspector();
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    canAdopt: () => true,
    adopt: async (original) => original,
    persist: () => undefined,
    onChange: () => undefined,
    onAdopted: () => undefined,
  });
  const live = coordinator.decorate(takeoverSession());
  const dormant = coordinator.decorate(resumableSession("claude"));

  assert.equal(live.control.takeover, null);
  assert.equal(hasCapability(live, "take-control"), false);
  assert.equal(hasCapability(dormant, "resume"), false);
  await assert.rejects(
    coordinator.begin(takeoverSession(), "guided-exit"),
    /takeover is unavailable/u,
  );
  await assert.rejects(
    coordinator.resume(resumableSession("claude")),
    /resume is unavailable/u,
  );
  await coordinator.dispose();
});

test("Claude takeover reports transcript mismatch before changing provider ownership", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector, {
    verifyTranscriptAssociation: () => ({
      state: "mismatch",
      reason: "the exact Claude transcript is ambiguous",
    }),
  });

  await assert.rejects(
    value.coordinator.begin(value.current(), "guided-exit"),
    /transcript association mismatch: the exact Claude transcript is ambiguous/u,
  );
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  assert.equal(value.current().control.takeover?.state, "available");
  await value.coordinator.dispose();
});

test("Claude transcript verifier failures remain read-only and retain their reason", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector, {
    verifyTranscriptAssociation: () => {
      throw new Error("transcript reader rejected an unsafe path");
    },
  });

  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop"),
    /verification failed: transcript reader rejected an unsafe path/u,
  );
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  assert.equal(value.current().control.takeover?.state, "available");
  await value.coordinator.dispose();
});

test("Claude takeover revalidates its transcript before signal and adoption", async () => {
  const inspector = new FakeInspector();
  inspector.exitOnSignal = true;
  let verifications = 0;
  const value = fixture(inspector, {
    verifyTranscriptAssociation: () => {
      verifications += 1;
      return verifications < 3
        ? { state: "associated" }
        : { state: "mismatch", reason: "the transcript association changed after exit" };
    },
  });

  await confirmGraceful(value);
  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(verifications, 3);
  assert.equal(inspector.signals.length, 1);
  assert.equal(value.adoptedCalls(), 0);
  assert.match(
    value.current().control.takeover?.error ?? "",
    /transcript association changed after exit/u,
  );
  await value.coordinator.dispose();
});

test("Claude takeover accepts a verified transcript at every ownership boundary", async () => {
  const inspector = new FakeInspector();
  inspector.exitOnSignal = true;
  let verifications = 0;
  const value = fixture(inspector, {
    verifyTranscriptAssociation: () => {
      verifications += 1;
      return { state: "associated" };
    },
  });

  await confirmGraceful(value);
  await waitFor(() => value.current().control.authority === "manager");
  assert.equal(verifications, 3);
  assert.equal(inspector.signals.length, 1);
  assert.equal(value.adoptedCalls(), 1);
  await value.coordinator.dispose();
});

test("in-web resume proves owner absence and persists before publishing controls", async () => {
  const inspector = new ResumeInspector();
  const original = resumableSession();
  const events: string[] = [];
  const writable = session({
    ...original,
    status: "idle",
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "resume"],
      withheld: [],
      takeover: null,
    },
  });
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    canAdopt: () => true,
    verifyTranscriptAssociation: () => ({ state: "associated" }),
    adopt: async () => { throw new Error("ordinary adoption must not be used"); },
    resume: async () => {
      events.push("resume");
      return writable;
    },
    persist: async () => {
      events.push("persist");
      return writable;
    },
    rollback: () => { events.push("rollback"); },
    onChange: () => undefined,
    onAdopted: () => { events.push("publish"); },
  });

  const result = await coordinator.resume(original);
  assert.equal(result.control.authority, "manager");
  assert.deepEqual(events, ["resume", "persist", "publish"]);
  assert.equal(inspector.signals.length, 0);
  await coordinator.dispose();
});

test("in-web Claude resume rejects any standalone owner before touching the provider", async () => {
  const inspector = new ResumeInspector();
  inspector.associated = { state: "running", identity };
  let resumeCalls = 0;
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    canAdopt: () => true,
    verifyTranscriptAssociation: () => ({ state: "associated" }),
    adopt: async () => { throw new Error("ordinary adoption must not be used"); },
    resume: async (original) => {
      resumeCalls += 1;
      return original;
    },
    persist: () => undefined,
    onChange: () => undefined,
    onAdopted: () => undefined,
  });

  await assert.rejects(
    coordinator.resume(resumableSession("claude")),
    /standalone Claude process still owns this conversation/u,
  );
  assert.equal(resumeCalls, 0);
  await coordinator.dispose();
});

test("in-web Codex resume rejects a standalone owner and requires migration", async () => {
  const inspector = new ResumeInspector();
  inspector.associated = { state: "running", identity };
  let resumeCalls = 0;
  const original = resumableSession("codex");
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    canAdopt: () => true,
    adopt: async () => { throw new Error("ordinary adoption must not be used"); },
    resume: async (view) => {
      resumeCalls += 1;
      return view;
    },
    persist: () => undefined,
    onChange: () => undefined,
    onAdopted: () => undefined,
  });
  const offered = coordinator.decorate(original);
  assert.deepEqual(offered.control.capabilities, ["resume"]);

  await assert.rejects(
    coordinator.resume(offered),
    /standalone Codex process still owns this conversation/u,
  );
  assert.equal(resumeCalls, 0);
  assert.equal(inspector.signals.length, 0);
  await coordinator.dispose();
});

test("in-web resume rolls back provisional provider control and excludes concurrent resumes", async () => {
  const inspector = new ResumeInspector();
  const original = resumableSession();
  const pending = deferred<SessionView>();
  let rollbackCalls = 0;
  let publishCalls = 0;
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    canAdopt: () => true,
    adopt: async () => { throw new Error("ordinary adoption must not be used"); },
    resume: () => pending.promise,
    persist: () => { throw new Error("durable commit failed"); },
    rollback: () => { rollbackCalls += 1; },
    onChange: () => undefined,
    onAdopted: () => { publishCalls += 1; },
  });

  const first = coordinator.resume(original);
  await assert.rejects(
    coordinator.resume(original),
    /ownership transition is already active/u,
  );
  pending.resolve(session({
    ...original,
    control: {
      ...original.control,
      plane: "codex-private",
      authority: "manager",
      capabilities: ["queue"],
    },
  }));
  await assert.rejects(first, /durable commit failed/u);
  assert.equal(rollbackCalls, 1);
  assert.equal(publishCalls, 0);
  await coordinator.dispose();
});

test("a timed-out cleanup is retryable and fences the late original rollback", async () => {
  const inspector = new ResumeInspector();
  const original = resumableSession("codex");
  const originalCleanup = deferred<void>();
  const retriedCleanup = deferred<void>();
  let cleanupCalls = 0;
  let current = original;
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    rollbackTimeoutMs: 20,
    canAdopt: () => true,
    verifyTranscriptAssociation: () => ({ state: "associated" }),
    adopt: async () => { throw new Error("ordinary adoption must not be used"); },
    resume: async () => session({
      ...original,
      control: {
        ...original.control,
        plane: "codex-private",
        authority: "manager",
        capabilities: ["queue"],
      },
    }),
    persist: () => { throw new Error("durable commit failed"); },
    rollback: () => {
      cleanupCalls += 1;
      return cleanupCalls === 1 ? originalCleanup.promise : retriedCleanup.promise;
    },
    onChange: () => { current = coordinator.decorate(current); },
    onAdopted: () => undefined,
  });
  current = coordinator.decorate(current);

  await assert.rejects(coordinator.resume(current), /durable commit failed/u);
  assert.equal(current.control.recovery?.state, "needs-attention");
  assert.match(current.control.recovery?.error ?? "", /cleanup timed out/u);
  assert.deepEqual(current.control.capabilities, ["retry-control"]);
  assert.equal(current.control.takeover, null);
  assert.ok(current.control.withheld.some(({ capability }) => capability === "resume"));
  assert.ok(current.control.withheld.some(({ capability }) => capability === "attach"));
  assert.ok(current.control.withheld.some(({ capability }) => capability === "take-control"));
  sessionRecordSchema.parse(current);
  assert.equal(coordinator.canResume(original), false);
  await assert.rejects(coordinator.resume(original), /unavailable/u);
  await assert.rejects(
    coordinator.begin(session({ ...takeoverSession(), id: original.id }), "guided-exit"),
    /unavailable/u,
  );

  assert.equal(coordinator.retryCleanup(original.id), true);
  assert.equal(current.control.recovery?.state, "reconnecting");
  assert.equal(current.control.recovery?.attempt, 2);
  assert.deepEqual(current.control.capabilities, []);
  assert.equal(coordinator.retryCleanup(original.id), false);

  originalCleanup.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(current.control.recovery?.state, "reconnecting");
  assert.equal(current.control.recovery?.attempt, 2);
  assert.equal(coordinator.canResume(original), false);

  retriedCleanup.resolve();
  await waitFor(() => current.control.recovery === null);
  assert.equal(cleanupCalls, 2);
  assert.equal(hasCapability(current, "resume"), true);
  assert.equal(coordinator.canResume(current), true);
  await coordinator.dispose();
});

test("a rejected cleanup exposes one retry that remains fail-closed until positive confirmation", async () => {
  const inspector = new ResumeInspector();
  const original = resumableSession("claude");
  const retriedCleanup = deferred<void>();
  let cleanupCalls = 0;
  let current = original;
  const coordinator = new CliTakeoverCoordinator({
    inspector,
    rollbackTimeoutMs: 20,
    canAdopt: () => true,
    verifyTranscriptAssociation: () => ({ state: "associated" }),
    adopt: async () => { throw new Error("ordinary adoption must not be used"); },
    resume: async () => session({
      ...original,
      control: {
        ...original.control,
        plane: "claude-sdk",
        authority: "manager",
        capabilities: ["queue"],
      },
    }),
    persist: () => { throw new Error("durable commit failed"); },
    rollback: () => {
      cleanupCalls += 1;
      return cleanupCalls === 1
        ? Promise.reject(new Error("provider refused provisional cleanup"))
        : retriedCleanup.promise;
    },
    onChange: () => { current = coordinator.decorate(current); },
    onAdopted: () => undefined,
  });
  current = coordinator.decorate(current);

  await assert.rejects(coordinator.resume(current), /durable commit failed/u);
  assert.equal(current.control.recovery?.state, "needs-attention");
  assert.match(current.control.recovery?.error ?? "", /provider refused provisional cleanup/u);
  assert.deepEqual(current.control.capabilities, ["retry-control"]);
  sessionRecordSchema.parse(current);
  assert.equal(coordinator.canResume(original), false);

  assert.equal(coordinator.retryCleanup(original.id), true);
  assert.equal(current.control.recovery?.state, "reconnecting");
  assert.equal(current.control.recovery?.attempt, 2);
  assert.deepEqual(current.control.capabilities, []);
  assert.equal(coordinator.retryCleanup(original.id), false);

  retriedCleanup.resolve();
  await waitFor(() => current.control.recovery === null);
  assert.equal(cleanupCalls, 2);
  assert.equal(hasCapability(current, "resume"), true);
  await coordinator.dispose();
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
  await value.coordinator.dispose();
});

test("graceful stop requires a server-issued identity-bound confirmation", async () => {
  const inspector = new FakeInspector();
  let adoptionAvailable = true;
  const value = fixture(inspector, { canAdopt: () => adoptionAvailable });
  const prepared = await value.coordinator.begin(value.current(), "graceful-stop");

  assert.equal(value.current().control.takeover?.state, "awaiting-confirmation");
  assert.equal(value.current().control.takeover?.deadlineAt, null);
  assert.equal(inspector.signals.length, 0);
  assert.ok(value.current().control.capabilities.includes("take-control"));
  assert.ok(value.current().control.capabilities.includes("cancel-take-control"));
  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop", "stale-takeover"),
    /confirmation is stale/u,
  );
  assert.equal(inspector.signals.length, 0);
  adoptionAvailable = false;
  await assert.rejects(
    value.coordinator.begin(value.current(), "graceful-stop", prepared.takeoverId),
    /adoption became unavailable; no signal was sent/u,
  );
  assert.equal(inspector.signals.length, 0);

  adoptionAvailable = true;
  value.coordinator.cancel(value.current().id, prepared.takeoverId);
  assert.equal(value.current().control.takeover?.state, "available");
  assert.equal(inspector.signals.length, 0);
  await value.coordinator.dispose();
});

test("graceful stop revalidates identity, sends one SIGTERM, and never repeats it", async () => {
  const inspector = new FakeInspector();
  inspector.exitOnSignal = true;
  const value = fixture(inspector);
  await confirmGraceful(value);

  await waitFor(() => value.current().control.authority === "manager");
  assert.equal(inspector.signals.length, 1);
  assert.deepEqual(inspector.signals[0], identity);
  await value.coordinator.dispose();
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
  await confirmGraceful(value);

  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(inspector.signals.length, 0);
  assert.equal(value.adoptedCalls(), 0);
  assert.equal(value.current().control.authority, "none");
  await value.coordinator.dispose();
});

test("signal intent stays stable across mutable terminal lineage while strict revalidation rejects it", async () => {
  const pinned: LocalCliProcessIdentity = {
    ...identity,
    executablePath: "/opt/agent-manager/bin/codex",
    ppid: 1,
    processGroupId: 42,
    foregroundProcessGroupId: 42,
    tty: "ttys001",
    interactive: true,
    members: [{
      pid: 42,
      ppid: 1,
      processGroupId: 42,
      foregroundProcessGroupId: 42,
      tty: "ttys001",
      startedAt: identity.startedAt,
      startedAtMs: Date.parse(`${identity.startedAt} UTC`),
      executablePath: "/opt/agent-manager/bin/codex",
      executableDevice: 9,
      executableInode: 99,
    }],
  };
  const detached: LocalCliProcessIdentity = {
    ...pinned,
    ppid: 900,
    processGroupId: 900,
    foregroundProcessGroupId: -1,
    tty: "?",
    interactive: false,
    members: pinned.members?.map((member) => ({
      ...member,
      ppid: 900,
      processGroupId: 900,
      foregroundProcessGroupId: -1,
      tty: "?",
    })),
  };
  assert.equal(
    localCliSignalIntentFingerprint(pinned),
    localCliSignalIntentFingerprint(detached),
    "a terminal detach cannot create a second durable signal authorization",
  );

  const inspector = new FakeInspector();
  let reads = 0;
  inspector.inspect = () => ({
    state: "running",
    identity: reads++ === 0 ? pinned : detached,
  });
  const value = fixture(inspector);
  await confirmGraceful(value);
  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(inspector.signals.length, 0);
  assert.match(value.current().control.takeover?.error ?? "", /identity changed/u);
  await value.coordinator.dispose();
});

test("graceful timeout sends exactly one signal and leaves retry guidance read-only", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector);
  await confirmGraceful(value);

  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(inspector.signals.length, 1);
  assert.equal(value.adoptedCalls(), 0);
  assert.ok(value.current().control.capabilities.includes("take-control"));
  assert.match(value.current().control.takeover?.error ?? "", /did not exit/u);
  await value.coordinator.dispose();
});

test("provider identity drift after exit never exposes manager capabilities", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector, {
    adopt: async (original) => session({
      ...original,
      id: "local:codex:different-thread",
      providerThreadId: "different-thread",
      control: {
        plane: "codex-private",
        authority: "manager",
        coordination: providerControlCoordination("codex"),
        recovery: null,
        capabilities: ["queue"],
        withheld: [],
        takeover: null,
      },
    }),
  });
  await value.coordinator.begin(value.current(), "guided-exit");
  inspector.inspection = { state: "exited" };

  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(value.current().control.authority, "none");
  assert.equal(value.persistedCalls(), 0);
  assert.equal(value.rollbackCalls(), 1);
  await value.coordinator.dispose();
});

test("begin reserves the session before its first asynchronous inspection", async () => {
  const inspector = new FakeInspector();
  const inspection = deferred<LocalCliInspection>();
  inspector.inspect = async () => inspection.promise;
  const value = fixture(inspector, { inspectionTimeoutMs: 100 });

  const first = value.coordinator.begin(value.current(), "guided-exit");
  await assert.rejects(
    value.coordinator.begin(value.current(), "guided-exit"),
    /already active/u,
  );
  inspection.resolve({ state: "running", identity });
  const begun = await first;
  value.coordinator.cancel(value.current().id, begun.takeoverId);
  await value.coordinator.dispose();
});

test("an initial process inspection is bounded and disposal cancels it", async () => {
  const inspector = new FakeInspector();
  let inspectedSignal = false;
  inspector.inspect = () => new Promise<LocalCliInspection>(() => undefined);
  const value = fixture(inspector, { inspectionTimeoutMs: 10 });

  await assert.rejects(
    value.coordinator.begin(value.current(), "guided-exit"),
    /inspection timed out/u,
  );

  const blocked = deferred<LocalCliInspection>();
  inspector.inspect = async () => {
    try {
      return await blocked.promise;
    } finally {
      inspectedSignal = true;
    }
  };
  const beginning = value.coordinator.begin(value.current(), "guided-exit");
  await Promise.resolve();
  await value.coordinator.dispose();
  await assert.rejects(beginning, /stopped/u);
  assert.equal(inspectedSignal, false, "an uncooperative inspector stays detached but cannot block disposal");
});

test("graceful stop is unavailable for noninteractive or unproven provider processes", async () => {
  const inspector = new FakeInspector();
  const batch = fixture(inspector, {}, takeoverSession({ kind: "batch" }));
  assert.deepEqual(batch.current().control.takeover?.methods, ["guided-exit"]);
  await assert.rejects(
    batch.coordinator.begin(batch.current(), "graceful-stop"),
    /requires a proven interactive/u,
  );
  await batch.coordinator.dispose();

  inspector.inspection = { state: "running", identity: { ...identity, interactive: false } };
  const background = fixture(inspector);
  await assert.rejects(
    background.coordinator.begin(background.current(), "graceful-stop"),
    /foreground interactive/u,
  );
  assert.equal(inspector.signals.length, 0);
  await background.coordinator.dispose();
});

test("a failed graceful retry reuses the exact identity and never repeats SIGTERM", async () => {
  const inspector = new FakeInspector();
  const journal = new SetSignalJournal();
  const value = fixture(inspector, {
    gracefulExitTimeoutMs: 12,
    signalJournal: journal,
  });

  await confirmGraceful(value);
  await waitFor(() => value.current().control.takeover?.state === "failed");
  await confirmGraceful(value);
  await waitFor(() => value.current().control.takeover?.state === "failed" && journal.intents.length === 2);

  assert.equal(inspector.signals.length, 1);
  assert.equal(journal.claimed.size, 1);
  assert.equal(journal.intents[0]?.fingerprint, journal.intents[1]?.fingerprint);
  await value.coordinator.dispose();
});

test("a failed attempt can adopt after the exact provider lineage exits later", async () => {
  const inspector = new FakeInspector();
  const value = fixture(inspector, { guidedTimeoutMs: 10 });

  await value.coordinator.begin(value.current(), "guided-exit");
  await waitFor(() => value.current().control.takeover?.state === "failed");
  inspector.inspection = { state: "exited" };
  await value.coordinator.begin(value.current(), "guided-exit");
  await waitFor(() => value.current().control.authority === "manager");

  assert.equal(value.adoptedCalls(), 1);
  await value.coordinator.dispose();
});

test("adoption, persistence, and rollback phases are independently bounded", async (t) => {
  await t.test("adoption timeout aborts provider work and rolls back", async () => {
    const inspector = new FakeInspector();
    let adoptionAborted = false;
    let rolledBack = 0;
    const value = fixture(inspector, {
      adoptionTimeoutMs: 10,
      rollbackTimeoutMs: 10,
      adopt: (_session, _profile, signal) => new Promise<SessionView>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          adoptionAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      rollback: () => { rolledBack += 1; },
    });
    await value.coordinator.begin(value.current(), "guided-exit");
    inspector.inspection = { state: "exited" };
    await waitFor(() => value.current().control.takeover?.state === "failed");
    assert.equal(adoptionAborted, true);
    assert.equal(rolledBack, 1);
    assert.match(value.current().control.takeover?.error ?? "", /adoption timed out/u);
    await value.coordinator.dispose();
  });

  await t.test("persistence timeout never publishes manager control", async () => {
    const inspector = new FakeInspector();
    let persistenceAborted = false;
    let rolledBack = 0;
    const value = fixture(inspector, {
      persistenceTimeoutMs: 10,
      persist: (_original, _adopted, _profile, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          persistenceAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      rollback: () => { rolledBack += 1; },
    });
    await value.coordinator.begin(value.current(), "guided-exit");
    inspector.inspection = { state: "exited" };
    await waitFor(() => value.current().control.takeover?.state === "failed");
    assert.equal(persistenceAborted, true);
    assert.equal(rolledBack, 1);
    assert.equal(value.current().control.authority, "none");
    assert.match(value.current().control.takeover?.error ?? "", /persistence timed out/u);
    await value.coordinator.dispose();
  });

  await t.test("an uncooperative rollback becomes explicit cleanup failure", async () => {
    const inspector = new FakeInspector();
    const value = fixture(inspector, {
      rollbackTimeoutMs: 10,
      adopt: async (original) => session({ ...original, providerThreadId: "wrong-thread" }),
      rollback: () => new Promise<void>(() => undefined),
    });
    await value.coordinator.begin(value.current(), "guided-exit");
    inspector.inspection = { state: "exited" };
    await waitFor(() => value.current().control.recovery?.state === "needs-attention");
    assert.deepEqual(value.current().control.capabilities, ["retry-control"]);
    assert.match(value.current().control.recovery?.error ?? "", /cleanup timed out/u);
    assert.equal(value.current().control.takeover, null);
    assert.ok(value.current().control.withheld.some(({ capability }) => capability === "take-control"));
    assert.equal(value.coordinator.retainedSession(value.current().id)?.id, value.current().id);
    await assert.rejects(
      value.coordinator.begin(value.current(), "guided-exit"),
      /unavailable/u,
    );
    await value.coordinator.dispose();
  });
});

test("async disposal aborts adoption and waits for its bounded rollback", async () => {
  const inspector = new FakeInspector();
  let adoptionAborted = false;
  let rollbackFinished = false;
  const value = fixture(inspector, {
    adoptionTimeoutMs: 200,
    rollbackTimeoutMs: 100,
    adopt: (_session, _profile, signal) => new Promise<SessionView>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        adoptionAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    rollback: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      rollbackFinished = true;
    },
  });
  await value.coordinator.begin(value.current(), "guided-exit");
  inspector.inspection = { state: "exited" };
  await waitFor(() => value.current().control.takeover?.state === "adopting");

  await value.coordinator.dispose();
  assert.equal(adoptionAborted, true);
  assert.equal(rollbackFinished, true);
  assert.equal(value.coordinator.retainedSession(value.current().id), null);
});

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

function processLine(input: {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid?: number;
  uid: number;
  tty?: string;
  startedAt?: string;
  command: string;
}): string {
  return [
    input.pid,
    input.ppid,
    input.pgid,
    input.tpgid ?? input.pgid,
    input.uid,
    input.tty ?? "ttys001",
    input.startedAt ?? "Wed Aug  5 10:00:00 2026",
    input.command,
  ].join(" ");
}

test("Codex inspection pins the wrapper/leaf lineage to one trusted rollout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-codex-takeover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 501;
  const workspace = join(root, "workspace");
  const sessionsRoot = join(root, ".codex", "sessions");
  const wrapperDirectory = join(root, "wrapper");
  const leafDirectory = join(root, "leaf");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(wrapperDirectory, { recursive: true });
  mkdirSync(leafDirectory, { recursive: true });
  const wrapper = join(wrapperDirectory, "codex");
  const leaf = join(leafDirectory, "codex");
  executable(wrapper);
  executable(leaf);
  const rolloutDirectory = join(sessionsRoot, "2026", "08", "05");
  mkdirSync(rolloutDirectory, { recursive: true });
  const rollout = join(rolloutDirectory, "rollout-2026-08-05T10-00-00-thread-1.jsonl");
  writeFileSync(rollout, "{}\n");

  const wrapperRow = processLine({
    pid: 42,
    ppid: 1,
    pgid: 42,
    uid,
    command: `node ${wrapper} --dangerously-bypass-approvals-and-sandbox`,
  });
  const leafRow = processLine({
    pid: 43,
    ppid: 42,
    pgid: 42,
    uid,
    command: `${leaf} --dangerously-bypass-approvals-and-sandbox`,
  });
  let psOutput = `${wrapperRow}\n${leafRow}\n`;
  const inspector = new SystemLocalCliProcessInspector({
    uid,
    home: root,
    env: {
      CODEX_HOME: join(root, ".codex"),
      AGENT_MANAGER_CODEX_EXECUTABLE: wrapper,
      PATH: `${wrapperDirectory}:${leafDirectory}`,
    },
    run: (command, args) => {
      if (command === "ps") return { stdout: psOutput, status: 0, error: null };
      const pids = (args[args.indexOf("-p") + 1] ?? "").split(",");
      return {
        stdout: pids.map((pid) => pid === "43"
          ? `p43\nfcwd\nn${workspace}\nf10\nn${rollout}\n`
          : `p${pid}\nfcwd\nn${workspace}\n`).join(""),
        status: 0,
        error: null,
      };
    },
  });
  const selected = session({ cwd: workspace, pid: 42, runtimePid: 42 });

  const initial = inspector.inspect(selected);
  assert.equal(initial.state, "running");
  if (initial.state !== "running") return;
  assert.equal(initial.identity.pid, 43, "the rollout-owning native leaf is the signal target");
  assert.equal(initial.identity.interactive, true);
  assert.equal(initial.identity.members?.length, 2);
  assert.equal(initial.identity.members?.[0]?.startedAtMs, Date.parse("Wed Aug  5 10:00:00 2026 UTC"));

  psOutput = `${wrapperRow}\n`;
  assert.equal(inspector.inspect(selected, initial.identity).state, "running", "the wrapper must also exit");

  const replacement = processLine({
    pid: 44,
    ppid: 42,
    pgid: 42,
    uid,
    command: `${leaf} resume thread-1`,
  });
  psOutput = `${wrapperRow}\n${replacement}\n`;
  const drifted = inspector.inspect(selected, initial.identity);
  assert.equal(drifted.state, "mismatch");
  if (drifted.state === "mismatch") assert.match(drifted.reason, /unvalidated replacement/u);

  psOutput = "";
  assert.equal(inspector.inspect(selected, initial.identity).state, "exited");

  psOutput = `${wrapperRow}\n${leafRow}\n`;
  const outside = join(root, "rollout-outside-thread-1.jsonl");
  writeFileSync(outside, "{}\n");
  unlinkSync(rollout);
  symlinkSync(outside, rollout);
  const unsafe = inspector.inspect(selected);
  assert.equal(unsafe.state, "mismatch");
  if (unsafe.state === "mismatch") assert.match(unsafe.reason, /outside the trusted live root/u);
});

test("Codex resume argv remains exactly associated after the rollout descriptor closes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-codex-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 501;
  const threadId = "019fcb63-0d46-7de3-818b-4e372feb60d5";
  const workspace = join(root, "workspace");
  const codexHome = join(root, ".codex");
  const sessionsRoot = join(codexHome, "sessions");
  const bin = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, "codex");
  executable(codex);
  const rollout = join(sessionsRoot, `rollout-2026-08-05T10-00-00-${threadId}.jsonl`);
  writeFileSync(rollout, "{}\n");
  const databasePath = join(codexHome, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER DEFAULT 0)");
  database.prepare("INSERT INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)")
    .run(threadId, rollout, workspace);
  database.close();

  const psOutput = [
    processLine({
      pid: 82,
      ppid: 1,
      pgid: 82,
      uid,
      command: `node ${codex} --dangerously-bypass-approvals-and-sandbox resume ${threadId}`,
    }),
    processLine({
      pid: 83,
      ppid: 82,
      pgid: 82,
      uid,
      command: `${codex} --dangerously-bypass-approvals-and-sandbox resume ${threadId}`,
    }),
  ].join("\n");
  const inspector = new SystemLocalCliProcessInspector({
    uid,
    home: root,
    env: { CODEX_HOME: codexHome, AGENT_MANAGER_CODEX_EXECUTABLE: codex, PATH: bin },
    run: (command, args) => command === "ps"
      ? { stdout: psOutput, status: 0, error: null }
      : {
          stdout: (args[args.indexOf("-p") + 1] ?? "").split(",")
            .map((pid) => `p${pid}\nfcwd\nn${workspace}\n`)
            .join(""),
          status: 0,
          error: null,
        },
  });
  const selected = session({
    id: `local:codex:${threadId}`,
    providerThreadId: threadId,
    providerTreeId: threadId,
    cwd: workspace,
    pid: 82,
    runtimePid: 82,
  });

  const inspected = inspector.inspect(selected);
  assert.equal(inspected.state, "running");
  if (inspected.state !== "running") return;
  assert.equal(inspected.identity.pid, 83);

  const alternate = join(sessionsRoot, `alternate-rollout-${threadId}.jsonl`);
  writeFileSync(alternate, "{}\n");
  const updated = new DatabaseSync(databasePath);
  updated.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(alternate, threadId);
  updated.close();
  const drifted = inspector.inspect(selected, inspected.identity);
  assert.equal(drifted.state, "mismatch");
  if (drifted.state === "mismatch") assert.match(drifted.reason, /association changed/u);
});

test("Claude inspection requires the exact bounded PID registry record and UTC process identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-claude-takeover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 501;
  const workspace = join(root, "workspace");
  const config = join(root, ".claude");
  const registry = join(config, "sessions");
  const bin = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(registry, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, "claude");
  executable(claude);
  const procStart = "Wed Aug  5 10:00:00 2026";
  const providerStartedAt = Date.parse(`${procStart} UTC`) + 1_250;
  const record = join(registry, "77.json");
  const writeRecord = (
    entrypoint: string,
    startedAt = providerStartedAt,
    kind = "interactive",
    sessionId = "claude-session-1",
  ): void => {
    writeFileSync(record, JSON.stringify({
      pid: 77,
      sessionId,
      cwd: workspace,
      procStart,
      startedAt,
      kind,
      entrypoint,
    }));
  };
  writeRecord("cli");
  const psOutput = `${processLine({
    pid: 77,
    ppid: 70,
    pgid: 77,
    uid,
    startedAt: procStart,
    command: `${claude} --resume claude-session-1`,
  })}\n`;
  const inspector = new SystemLocalCliProcessInspector({
    uid,
    home: root,
    env: {
      CLAUDE_CONFIG_DIR: config,
      AGENT_MANAGER_CLAUDE_EXECUTABLE: claude,
      PATH: bin,
    },
    run: (command) => command === "ps"
      ? { stdout: psOutput, status: 0, error: null }
      : { stdout: "", status: 1, error: null },
  });
  const selected = session({
    id: "local:claude:claude-session-1",
    provider: "claude",
    providerThreadId: "claude-session-1",
    providerTreeId: "claude-session-1",
    cwd: workspace,
    pid: 77,
    runtimePid: 77,
  });

  const initial = inspector.inspect(selected);
  assert.equal(initial.state, "running");
  if (initial.state !== "running") return;
  assert.equal(initial.identity.providerStartedAtMs, providerStartedAt);
  assert.equal(initial.identity.interactive, true);

  writeRecord("sdk-ts");
  const sdk = inspector.inspect(selected);
  assert.equal(sdk.state, "running");
  if (sdk.state === "running") assert.equal(sdk.identity.interactive, false);

  writeRecord("cli", providerStartedAt, "batch");
  const batch = inspector.inspect(selected);
  assert.equal(batch.state, "running");
  if (batch.state === "running") assert.equal(batch.identity.interactive, false);

  writeRecord("cli", providerStartedAt, "interactive", "different-session");
  const reassociated = inspector.inspect(selected, initial.identity);
  assert.equal(reassociated.state, "mismatch");
  if (reassociated.state === "mismatch") assert.match(reassociated.reason, /no longer associates/u);

  writeRecord("cli", providerStartedAt + 60_000);
  const stale = inspector.inspect(selected);
  assert.equal(stale.state, "mismatch");
  if (stale.state === "mismatch") assert.match(stale.reason, /high-resolution process identity/u);

  const outside = join(root, "outside-registry.json");
  writeRecord("cli");
  writeFileSync(outside, JSON.stringify({ pid: 77 }));
  unlinkSync(record);
  symlinkSync(outside, record);
  const linked = inspector.inspect(selected);
  assert.equal(linked.state, "mismatch");
  if (linked.state === "mismatch") assert.match(linked.reason, /exact live registry record/u);

  unlinkSync(record);
  writeFileSync(record, "x".repeat(64 * 1024 + 1));
  const oversized = inspector.inspect(selected);
  assert.equal(oversized.state, "mismatch");
});

test("Claude inspection pins a registry-not-ready process before accepting its association", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-claude-pending-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 501;
  const workspace = join(root, "workspace");
  const config = join(root, ".claude");
  const registry = join(config, "sessions");
  const bin = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(registry, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, "claude");
  executable(claude);
  const procStart = "Wed Aug  5 10:00:00 2026";
  const providerStartedAt = Date.parse(`${procStart} UTC`) + 1_250;
  let psOutput = `${processLine({
    pid: 77,
    ppid: 70,
    pgid: 77,
    uid,
    startedAt: procStart,
    command: `${claude} --resume claude-session-1`,
  })}\n`;
  const inspector = new SystemLocalCliProcessInspector({
    uid,
    home: root,
    env: {
      CLAUDE_CONFIG_DIR: config,
      AGENT_MANAGER_CLAUDE_EXECUTABLE: claude,
      PATH: bin,
    },
    run: (command) => command === "ps"
      ? { stdout: psOutput, status: 0, error: null }
      : { stdout: "", status: 1, error: null },
  });
  const selected = session({
    id: "local:claude:claude-session-1",
    provider: "claude",
    providerThreadId: "claude-session-1",
    providerTreeId: "claude-session-1",
    cwd: workspace,
    pid: 77,
    runtimePid: 77,
  });

  const pending = inspector.inspect(selected);
  assert.equal(pending.state, "pending");
  if (pending.state !== "pending") return;
  assert.match(pending.reason, /not ready/u);
  assert.equal(pending.identity.pid, 77);
  assert.equal(pending.identity.startedAt, procStart);
  assert.equal(pending.identity.executablePath, realpathSync.native(claude));
  assert.equal(pending.identity.providerStartedAtMs, null);
  assert.equal(pending.identity.members?.length, 1);

  const record = join(registry, "77.json");
  writeFileSync(record, JSON.stringify({
    pid: 77,
    sessionId: "claude-session-1",
    cwd: workspace,
    procStart,
    startedAt: providerStartedAt,
    kind: "interactive",
    entrypoint: "cli",
  }));
  const ready = inspector.inspect(selected, pending.identity);
  assert.equal(ready.state, "running");
  if (ready.state === "running") {
    assert.equal(ready.identity.providerStartedAtMs, providerStartedAt);
    assert.equal(ready.identity.associationPath, realpathSync.native(record));
    assert.equal(ready.identity.interactive, true);
  }

  psOutput = `${processLine({
    pid: 77,
    ppid: 70,
    pgid: 77,
    uid,
    startedAt: "Wed Aug  5 10:00:01 2026",
    command: `${claude} --resume claude-session-1`,
  })}\n`;
  const drifted = inspector.inspect(selected, pending.identity);
  assert.equal(drifted.state, "mismatch");
  if (drifted.state === "mismatch") assert.match(drifted.reason, /lineage changed/u);
});

test("Claude owner discovery rejects two standalone processes for one session", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-claude-owners-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 501;
  const workspace = join(root, "workspace");
  const config = join(root, ".claude");
  const registry = join(config, "sessions");
  const bin = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(registry, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, "claude");
  executable(claude);
  const starts = [
    "Wed Aug  5 10:00:00 2026",
    "Wed Aug  5 10:00:01 2026",
  ] as const;
  for (const [index, pid] of [77, 88].entries()) {
    const procStart = starts[index] as string;
    writeFileSync(join(registry, `${String(pid)}.json`), JSON.stringify({
      pid,
      sessionId: "claude-session-1",
      cwd: workspace,
      procStart,
      startedAt: Date.parse(`${procStart} UTC`) + 1_250,
      kind: "interactive",
      entrypoint: "cli",
    }));
  }
  const psOutput = [
    processLine({
      pid: 77,
      ppid: 1,
      pgid: 77,
      uid,
      tty: "ttys001",
      startedAt: starts[0],
      command: `${claude} --resume claude-session-1`,
    }),
    processLine({
      pid: 88,
      ppid: 1,
      pgid: 88,
      uid,
      tty: "ttys002",
      startedAt: starts[1],
      command: `${claude} --resume claude-session-1`,
    }),
  ].join("\n");
  const inspector = new SystemLocalCliProcessInspector({
    uid,
    home: root,
    env: {
      CLAUDE_CONFIG_DIR: config,
      AGENT_MANAGER_CLAUDE_EXECUTABLE: claude,
      PATH: bin,
    },
    run: (command) => command === "ps"
      ? { stdout: psOutput, status: 0, error: null }
      : { stdout: "", status: 1, error: null },
  });
  const selected = session({
    id: "local:claude:claude-session-1",
    provider: "claude",
    providerThreadId: "claude-session-1",
    providerTreeId: "claude-session-1",
    cwd: workspace,
    pid: null,
    runtimePid: null,
  });

  const owners = inspector.findAssociated(selected);
  assert.equal(owners.state, "mismatch");
  if (owners.state === "mismatch") assert.match(owners.reason, /Multiple Claude processes/u);
});

test("Codex owner discovery ignores only peers on the exact manager socket", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-codex-owners-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 501;
  const workspace = join(root, "workspace");
  const codexHome = join(root, ".codex");
  const sessionsRoot = join(codexHome, "sessions");
  const bin = join(root, "bin");
  const rogueBin = join(root, "rogue-bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(rogueBin, { recursive: true });
  const codex = join(bin, "codex");
  const rogueCodex = join(rogueBin, "codex");
  const managerSocket = join(root, "manager.sock");
  const otherSocket = join(root, "other.sock");
  executable(codex);
  executable(rogueCodex);
  const rollout = join(sessionsRoot, "rollout-2026-08-05T10-00-00-thread-1.jsonl");
  writeFileSync(rollout, "{}\n");
  const standaloneOne = processLine({
    pid: 101,
    ppid: 1,
    pgid: 101,
    uid,
    tty: "ttys001",
    command: `${codex} resume thread-1`,
  });
  const standaloneTwo = processLine({
    pid: 202,
    ppid: 1,
    pgid: 101,
    uid,
    tty: "ttys001",
    command: `${codex} resume thread-1`,
  });
  const remotePeer = processLine({
    pid: 303,
    ppid: 1,
    pgid: 303,
    uid,
    tty: "ttys003",
    command: `${codex} --remote unix://${managerSocket} resume thread-1`,
  });
  const remotePeerLeaf = processLine({
    pid: 304,
    ppid: 303,
    pgid: 303,
    uid,
    tty: "ttys003",
    command: `${codex} resume thread-1 --remote=unix://${managerSocket}`,
  });
  const otherRemote = processLine({
    pid: 404,
    ppid: 1,
    pgid: 404,
    uid,
    tty: "ttys004",
    command: `${codex} --remote unix://${otherSocket} resume thread-1`,
  });
  const wrongExecutableRemote = processLine({
    pid: 505,
    ppid: 1,
    pgid: 505,
    uid,
    tty: "ttys005",
    command: `${rogueCodex} --remote unix://${managerSocket} resume thread-1`,
  });
  let psOutput = [standaloneOne, standaloneTwo, remotePeer, remotePeerLeaf].join("\n");
  const inspector = new SystemLocalCliProcessInspector({
    uid,
    home: root,
    codexSharedSocketPath: managerSocket,
    env: { CODEX_HOME: codexHome, AGENT_MANAGER_CODEX_EXECUTABLE: codex, PATH: bin },
    run: (command, args) => {
      if (command === "ps") return { stdout: psOutput, status: 0, error: null };
      const requested = new Set((args[args.indexOf("-p") + 1] ?? "").split(","));
      return {
        stdout: [101, 202, 303, 304, 404, 505]
          .filter((pid) => requested.has(String(pid)))
          .map((pid) => `p${String(pid)}\nfcwd\nn${workspace}\nf10\nn${rollout}\n`)
          .join(""),
        status: 0,
        error: null,
      };
    },
  });
  const selected = session({ pid: null, runtimePid: null, cwd: workspace });

  const duplicate = inspector.findAssociated(selected);
  assert.equal(duplicate.state, "mismatch");
  if (duplicate.state === "mismatch") assert.match(duplicate.reason, /Multiple standalone Codex processes/u);

  psOutput = [standaloneOne, remotePeer, remotePeerLeaf].join("\n");
  const withRemotePeer = inspector.findAssociated(selected);
  assert.equal(withRemotePeer.state, "running");
  if (withRemotePeer.state === "running") assert.equal(withRemotePeer.identity.pid, 101);

  psOutput = [remotePeer, remotePeerLeaf].join("\n");
  assert.deepEqual(inspector.findAssociated(selected), { state: "exited" });

  psOutput = [remotePeer, remotePeerLeaf, otherRemote].join("\n");
  const withOtherRemote = inspector.findAssociated(selected);
  assert.equal(withOtherRemote.state, "running");
  if (withOtherRemote.state === "running") assert.equal(withOtherRemote.identity.pid, 404);

  psOutput = [remotePeer, remotePeerLeaf, wrongExecutableRemote].join("\n");
  const withWrongExecutable = inspector.findAssociated(selected);
  assert.equal(withWrongExecutable.state, "mismatch");
  if (withWrongExecutable.state === "mismatch") {
    assert.match(withWrongExecutable.reason, /pinned executable/u);
  }

  const unpinnedInspector = new SystemLocalCliProcessInspector({
    uid,
    home: root,
    env: { CODEX_HOME: codexHome, AGENT_MANAGER_CODEX_EXECUTABLE: codex, PATH: bin },
    run: (command, args) => {
      if (command === "ps") {
        return { stdout: [remotePeer, remotePeerLeaf].join("\n"), status: 0, error: null };
      }
      const requested = new Set((args[args.indexOf("-p") + 1] ?? "").split(","));
      return {
        stdout: [303, 304]
          .filter((pid) => requested.has(String(pid)))
          .map((pid) => `p${String(pid)}\nfcwd\nn${workspace}\nf10\nn${rollout}\n`)
          .join(""),
        status: 0,
        error: null,
      };
    },
  });
  const unpinnedRemote = unpinnedInspector.findAssociated(selected);
  assert.equal(unpinnedRemote.state, "running");
  if (unpinnedRemote.state === "running") assert.equal(unpinnedRemote.identity.pid, 304);
});

test("journal intent is durable before final identity validation and no stale PID is signalled", async () => {
  const inspector = new FakeInspector();
  const journal = new SetSignalJournal();
  let reads = 0;
  inspector.inspect = () => {
    reads += 1;
    return reads < 3
      ? { state: "running", identity }
      : { state: "mismatch", reason: "PID was reused before signal" };
  };
  const value = fixture(inspector, { signalJournal: journal });
  await confirmGraceful(value);
  await waitFor(() => value.current().control.takeover?.state === "failed");
  assert.equal(journal.intents.length, 1);
  assert.equal(inspector.signals.length, 0);
  assert.match(value.current().control.takeover?.error ?? "", /reused before signal/u);
  await value.coordinator.dispose();
});
