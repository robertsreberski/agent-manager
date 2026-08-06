import assert from "node:assert/strict";
import test from "node:test";

import type { SessionControlRecovery } from "../shared/session.ts";
import type { ManagedSessionRecoveryRecord } from "./contracts.ts";
import { ManagedRecoveryCoordinator } from "./managed-recovery.ts";

function record(id: string): ManagedSessionRecoveryRecord {
  return {
    managerSessionId: `local:claude:${id}`,
    provider: "claude",
    providerThreadId: id,
    workspaceId: "workspace",
    workspacePath: "/workspace",
    name: id,
    profile: "ask-first",
    model: null,
    effort: null,
    createdAt: "2026-08-05T10:00:00.000Z",
  };
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
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

test("managed recovery isolates failures, retries, and clears successful state", async () => {
  const attempts = new Map<string, number>();
  const states = new Map<string, SessionControlRecovery | null>();
  const coordinator = new ManagedRecoveryCoordinator({
    concurrency: 2,
    attemptTimeoutMs: 100,
    retryDelaysMs: [5],
    recover: async (candidate) => {
      const count = (attempts.get(candidate.managerSessionId) ?? 0) + 1;
      attempts.set(candidate.managerSessionId, count);
      if (candidate.providerThreadId === "flaky" && count === 1) {
        throw new Error("temporary provider failure");
      }
      if (candidate.providerThreadId === "terminal") throw new Error("identity drift");
    },
    onState: (candidate, recovery) => states.set(candidate.managerSessionId, recovery),
  });

  coordinator.start([record("healthy"), record("flaky"), record("terminal")]);
  await eventually(() => {
    assert.equal(states.get("local:claude:healthy"), null);
    assert.equal(states.get("local:claude:flaky"), null);
    assert.equal(states.get("local:claude:terminal")?.state, "needs-attention");
  });
  assert.equal(attempts.get("local:claude:healthy"), 1);
  assert.equal(attempts.get("local:claude:flaky"), 2);
  assert.equal(attempts.get("local:claude:terminal"), 2);
  await coordinator.dispose();
});

test("managed recovery dispose is bounded when active provider work ignores abort", async () => {
  let aborted = false;
  const provider = deferred<void>();
  const states: Array<SessionControlRecovery | null> = [];
  const coordinator = new ManagedRecoveryCoordinator({
    attemptTimeoutMs: 10_000,
    recover: (_record, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      return provider.promise;
    },
    onState: (_record, recovery) => states.push(recovery),
  });
  coordinator.start([record("hanging")]);
  await eventually(() => assert.equal(states.at(-1)?.state, "reconnecting"));
  await Promise.race([
    coordinator.dispose(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("dispose remained coupled to provider settlement")), 100);
    }),
  ]);
  assert.equal(aborted, true);
  assert.notEqual(states.at(-1), null);
  provider.resolve();
});

test("managed recovery deadlines release slots and fence late provider settlement", async () => {
  const lateSuccess = deferred<void>();
  const lateFailure = deferred<void>();
  const signals = new Map<string, AbortSignal>();
  const states = new Map<string, SessionControlRecovery | null>();
  const calls: string[] = [];
  const coordinator = new ManagedRecoveryCoordinator({
    concurrency: 1,
    attemptTimeoutMs: 8,
    retryDelaysMs: [],
    recover: (candidate, signal) => {
      const id = candidate.providerThreadId;
      calls.push(id);
      signals.set(id, signal);
      if (id === "late-success") return lateSuccess.promise;
      if (id === "late-failure") return lateFailure.promise;
      return Promise.resolve();
    },
    onState: (candidate, recovery) => states.set(candidate.providerThreadId, recovery),
  });

  coordinator.start([
    record("late-success"),
    record("late-failure"),
    record("healthy"),
  ]);
  await eventually(() => {
    assert.equal(states.get("late-success")?.state, "needs-attention");
    assert.equal(states.get("late-failure")?.state, "needs-attention");
    assert.equal(states.get("healthy"), null);
  });
  assert.deepEqual(calls, ["late-success", "late-failure", "healthy"]);
  assert.equal(signals.get("late-success")?.aborted, true);
  assert.equal(signals.get("late-failure")?.aborted, true);
  assert.match(states.get("late-success")?.error ?? "", /timed out/u);

  lateSuccess.resolve();
  lateFailure.reject(new Error("late provider failure"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(states.get("late-success")?.state, "needs-attention");
  assert.equal(states.get("late-failure")?.state, "needs-attention");
  assert.equal(coordinator.has("local:claude:late-success"), true);
  assert.equal(coordinator.has("local:claude:late-failure"), true);
  await coordinator.dispose();
});

test("forced retry supersedes stale success and guarantees one fresh attempt", async () => {
  const pending: Array<{
    signal: AbortSignal;
    resolve: () => void;
  }> = [];
  const states: Array<SessionControlRecovery | null> = [];
  const coordinator = new ManagedRecoveryCoordinator({
    attemptTimeoutMs: 10_000,
    recover: (_candidate, signal) => new Promise<void>((resolve) => {
      pending.push({ signal, resolve });
    }),
    onState: (_candidate, recovery) => states.push(recovery),
  });

  coordinator.start([record("superseded")]);
  await eventually(() => assert.equal(pending.length, 1));
  assert.equal(coordinator.forceRetry("local:claude:superseded"), true);
  assert.equal(coordinator.forceRetry("local:claude:superseded"), true);
  assert.equal(pending[0]?.signal.aborted, true);

  await eventually(() => assert.equal(pending.length, 2));

  // The provider can still settle successfully after observing cancellation.
  // That stale success must neither clear recovery state nor consume the rerun.
  pending[0]?.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(states.includes(null), false);

  pending[1]?.resolve();
  await eventually(() => assert.equal(states.at(-1), null));
  assert.equal(pending.length, 2, "repeated force requests coalesce into one rerun");
  assert.equal(coordinator.has("local:claude:superseded"), false);
  await coordinator.dispose();
});

test("cancel fences all later state from an in-flight provider operation", async () => {
  let settle: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const states: Array<SessionControlRecovery | null> = [];
  const coordinator = new ManagedRecoveryCoordinator({
    attemptTimeoutMs: 10_000,
    recover: (_candidate, candidateSignal) => new Promise<void>((resolve) => {
      signal = candidateSignal;
      settle = resolve;
    }),
    onState: (_candidate, recovery) => states.push(recovery),
  });

  coordinator.start([record("cancelled")]);
  await eventually(() => assert.ok(settle));
  const stateCountAtCancel = states.length;
  assert.equal(coordinator.cancel("local:claude:cancelled"), true);
  assert.equal(coordinator.cancel("local:claude:cancelled"), false);
  assert.equal(signal?.aborted, true);
  assert.equal(coordinator.has("local:claude:cancelled"), false);
  assert.equal(coordinator.retry("local:claude:cancelled"), false);

  settle?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(states.length, stateCountAtCancel);
  assert.notEqual(states.at(-1), null);
  await coordinator.dispose();
});
