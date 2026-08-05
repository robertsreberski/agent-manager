import type { SessionControlRecovery } from "../shared/session.ts";
import type { ManagedSessionRecoveryRecord } from "./contracts.ts";

export interface ManagedRecoveryDeferral {
  readonly kind: "defer";
  readonly retryAfterMs: number;
  readonly reason: string;
}

/**
 * Ask the coordinator to wait and inspect the same identity again without
 * consuming a provider-failure retry. This is intended for valid transitional
 * states such as an exact, persisted native owner that is still running.
 */
export function deferManagedRecovery(
  retryAfterMs: number,
  reason: string | null = null,
): ManagedRecoveryDeferral {
  const ownershipReason = reason?.trim()
    || "Waiting for the exact native CLI owner to exit before restoring web control";
  return {
    kind: "defer",
    retryAfterMs: boundedDelay(retryAfterMs),
    reason: boundedError(ownershipReason),
  };
}

export interface ManagedRecoveryCoordinatorOptions {
  recover(
    record: ManagedSessionRecoveryRecord,
    signal: AbortSignal,
  ): Promise<void | ManagedRecoveryDeferral>;
  onState(
    record: ManagedSessionRecoveryRecord,
    recovery: SessionControlRecovery | null,
  ): void;
  concurrency?: number;
  attemptTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
}

/**
 * Await provider work only while its coordinator signal remains live. Provider
 * implementations are required to observe cancellation, but the coordinator's
 * deadline and lifecycle cannot depend on that cooperation. Both settlement
 * handlers remain attached to absorb a provider's eventual late result.
 */
function settleOnAbort<T>(
  start: () => Promise<T> | T,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown | null, value?: T): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error === null) resolve(value as T);
      else reject(error);
    };
    const abort = (): void => {
      finish(signal.reason ?? new Error("managed recovery cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return start();
      })
      .then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
  });
}

interface RecoveryTarget {
  record: ManagedSessionRecoveryRecord;
  attempts: number;
  failureAttempts: number;
  generation: number;
  queued: boolean;
  running: boolean;
  runningGeneration: number | null;
  rerunRequested: boolean;
  retryTimer: NodeJS.Timeout | null;
  waitingStartedAt: number | null;
  waitingReason: string | null;
}

interface ActiveController {
  target: RecoveryTarget;
  generation: number;
  controller: AbortController;
}

/**
 * Per-record managed control recovery. A hung or failed identity cannot cancel
 * successful siblings, and cancellation is propagated into the provider
 * operation instead of being represented by an unowned Promise.race.
 *
 * Every state publication is fenced by both target identity and generation.
 * A forced retry therefore cannot be accidentally completed or failed by the
 * provider operation it superseded.
 */
export class ManagedRecoveryCoordinator {
  readonly #options: ManagedRecoveryCoordinatorOptions;
  readonly #concurrency: number;
  readonly #attemptTimeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #now: () => number;
  readonly #targets = new Map<string, RecoveryTarget>();
  readonly #queue: RecoveryTarget[] = [];
  readonly #controllers = new Map<string, ActiveController>();
  readonly #active = new Set<Promise<void>>();
  #running = 0;
  #disposed = false;

  constructor(options: ManagedRecoveryCoordinatorOptions) {
    this.#options = options;
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? 30_000);
    this.#retryDelaysMs = options.retryDelaysMs ?? [2_000, 8_000, 30_000, 120_000];
    this.#now = options.now ?? Date.now;
  }

  start(records: readonly ManagedSessionRecoveryRecord[]): void {
    if (this.#disposed) throw new Error("managed recovery coordinator is stopped");
    for (const record of records) {
      const existing = this.#targets.get(record.managerSessionId);
      if (existing) {
        // A later catalog read may contain more authoritative persisted data.
        // It is used by the next attempt without disturbing an active one.
        existing.record = record;
        continue;
      }
      const target: RecoveryTarget = {
        record,
        attempts: 0,
        failureAttempts: 0,
        generation: 1,
        queued: false,
        running: false,
        runningGeneration: null,
        rerunRequested: false,
        retryTimer: null,
        waitingStartedAt: null,
        waitingReason: null,
      };
      this.#targets.set(record.managerSessionId, target);
      this.#enqueue(target);
    }
    this.#pump();
  }

  /** User-facing retry is always a fresh recovery series. */
  retry(managerSessionId: string): boolean {
    return this.forceRetry(managerSessionId);
  }

  /**
   * Force a fresh recovery attempt. If one is running, its signal is aborted
   * and exactly one rerun is queued after it settles. Repeated requests while
   * that generation is settling are coalesced, so the request cannot be lost
   * and cannot create an unbounded retry fan-out.
   */
  forceRetry(managerSessionId: string): boolean {
    const target = this.#targets.get(managerSessionId);
    if (!target || this.#disposed) return false;

    target.generation += 1;
    target.attempts = 0;
    target.failureAttempts = 0;
    target.waitingStartedAt = null;
    target.waitingReason = null;
    if (target.retryTimer) {
      clearTimeout(target.retryTimer);
      target.retryTimer = null;
    }

    const active = this.#controllers.get(managerSessionId);
    if (active?.target === target) {
      active.controller.abort(new Error("managed recovery superseded by a fresh attempt"));
    }

    if (target.running) {
      target.rerunRequested = true;
      return true;
    }

    target.rerunRequested = false;
    if (target.queued) this.#removeFromQueue(target);
    this.#enqueue(target, true);
    this.#pump();
    return true;
  }

  /** Stop all current and future work for one identity without publishing. */
  cancel(managerSessionId: string): boolean {
    const target = this.#targets.get(managerSessionId);
    if (!target) return false;

    this.#targets.delete(managerSessionId);
    target.generation += 1;
    target.rerunRequested = false;
    if (target.retryTimer) clearTimeout(target.retryTimer);
    target.retryTimer = null;
    if (target.queued) this.#removeFromQueue(target);

    const active = this.#controllers.get(managerSessionId);
    if (active?.target === target) {
      this.#controllers.delete(managerSessionId);
      active.controller.abort(new Error("managed recovery cancelled"));
    }
    return true;
  }

  has(managerSessionId: string): boolean {
    return this.#targets.has(managerSessionId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      await Promise.allSettled([...this.#active]);
      return;
    }
    this.#disposed = true;
    this.#queue.length = 0;
    for (const target of this.#targets.values()) {
      target.generation += 1;
      target.queued = false;
      target.rerunRequested = false;
      if (target.retryTimer) clearTimeout(target.retryTimer);
      target.retryTimer = null;
    }
    this.#targets.clear();
    for (const active of this.#controllers.values()) {
      active.controller.abort(new Error("managed recovery coordinator stopped"));
    }
    this.#controllers.clear();
    await Promise.allSettled([...this.#active]);
  }

  #isCurrent(target: RecoveryTarget, generation: number): boolean {
    return !this.#disposed
      && this.#targets.get(target.record.managerSessionId) === target
      && target.generation === generation;
  }

  #publish(
    target: RecoveryTarget,
    generation: number,
    recovery: SessionControlRecovery | null,
  ): boolean {
    if (!this.#isCurrent(target, generation)) return false;
    this.#options.onState(target.record, recovery);
    return true;
  }

  #removeFromQueue(target: RecoveryTarget): void {
    const index = this.#queue.indexOf(target);
    if (index >= 0) this.#queue.splice(index, 1);
    target.queued = false;
  }

  #enqueue(target: RecoveryTarget, front = false): void {
    if (
      this.#disposed
      || this.#targets.get(target.record.managerSessionId) !== target
      || target.queued
      || target.running
    ) return;
    target.queued = true;
    if (front) this.#queue.unshift(target);
    else this.#queue.push(target);
  }

  #pump(): void {
    while (!this.#disposed && this.#running < this.#concurrency) {
      const target = this.#queue.shift();
      if (!target) return;
      if (
        !target.queued
        || target.running
        || this.#targets.get(target.record.managerSessionId) !== target
      ) continue;
      target.queued = false;
      target.running = true;
      const generation = target.generation;
      target.runningGeneration = generation;
      this.#running += 1;
      const task = this.#attempt(target, generation).finally(() => {
        if (target.runningGeneration === generation) {
          target.running = false;
          target.runningGeneration = null;
        }
        this.#running -= 1;
        this.#active.delete(task);
        if (
          !this.#disposed
          && this.#targets.get(target.record.managerSessionId) === target
          && target.rerunRequested
          && !target.running
        ) {
          target.rerunRequested = false;
          this.#enqueue(target, true);
        }
        this.#pump();
      });
      this.#active.add(task);
    }
  }

  async #attempt(target: RecoveryTarget, generation: number): Promise<void> {
    target.attempts += 1;
    const attempt = target.attempts;
    const controller = new AbortController();
    const active: ActiveController = { target, generation, controller };
    this.#controllers.set(target.record.managerSessionId, active);
    const started = this.#now();
    if (
      target.waitingStartedAt === null
      && !this.#publish(target, generation, {
        state: "reconnecting",
        attempt,
        startedAt: new Date(started).toISOString(),
        deadlineAt: new Date(started + this.#attemptTimeoutMs).toISOString(),
        nextRetryAt: null,
        error: null,
      })
    ) return;

    const timeout = setTimeout(() => {
      if (this.#isCurrent(target, generation)) {
        controller.abort(new Error("provider control reconnection timed out"));
      }
    }, this.#attemptTimeoutMs);
    timeout.unref();

    try {
      const result = await settleOnAbort(
        () => this.#options.recover(target.record, controller.signal),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!this.#isCurrent(target, generation)) return;

      if (isManagedRecoveryDeferral(result)) {
        this.#scheduleDeferred(target, generation, attempt, started, result);
        return;
      }

      // Delete before publishing so a synchronous observer cannot retry a
      // target that has already recovered. The generation was fenced above.
      this.#targets.delete(target.record.managerSessionId);
      this.#options.onState(target.record, null);
    } catch (error) {
      if (!this.#isCurrent(target, generation)) return;
      target.waitingStartedAt = null;
      target.waitingReason = null;
      target.failureAttempts += 1;
      const message = boundedError(error);
      const retryDelay = this.#retryDelaysMs[target.failureAttempts - 1];
      if (retryDelay === undefined) {
        this.#publish(target, generation, {
          state: "needs-attention",
          attempt,
          startedAt: new Date(started).toISOString(),
          deadlineAt: null,
          nextRetryAt: null,
          error: message,
        });
        return;
      }
      this.#scheduleRetry(target, generation, attempt, started, retryDelay, message);
    } finally {
      clearTimeout(timeout);
      if (this.#controllers.get(target.record.managerSessionId) === active) {
        this.#controllers.delete(target.record.managerSessionId);
      }
    }
  }

  #scheduleDeferred(
    target: RecoveryTarget,
    generation: number,
    attempt: number,
    started: number,
    result: ManagedRecoveryDeferral,
  ): void {
    if (!this.#isCurrent(target, generation)) return;

    // A verified native owner is a healthy coordination state, not a failed
    // provider attempt. Keep the public attempt number and start time stable
    // across the bounded internal ownership polls.
    target.attempts = Math.max(0, target.attempts - 1);
    const waitingStartedAt = target.waitingStartedAt ?? started;
    const shouldPublish = target.waitingStartedAt === null
      || target.waitingReason !== result.reason;
    target.waitingStartedAt = waitingStartedAt;
    target.waitingReason = result.reason;

    const delay = boundedDelay(result.retryAfterMs);
    target.retryTimer = setTimeout(() => {
      target.retryTimer = null;
      if (!this.#isCurrent(target, generation)) return;
      this.#enqueue(target);
      this.#pump();
    }, delay);
    target.retryTimer.unref();

    if (shouldPublish) {
      this.#publish(target, generation, {
        state: "waiting-for-native-exit",
        attempt,
        startedAt: new Date(waitingStartedAt).toISOString(),
        deadlineAt: null,
        nextRetryAt: null,
        error: result.reason,
      });
    }
  }

  #scheduleRetry(
    target: RecoveryTarget,
    generation: number,
    attempt: number,
    started: number,
    retryDelayMs: number,
    error: string | null,
  ): void {
    if (!this.#isCurrent(target, generation)) return;
    const delay = boundedDelay(retryDelayMs);
    const nextRetry = this.#now() + delay;
    target.retryTimer = setTimeout(() => {
      target.retryTimer = null;
      if (!this.#isCurrent(target, generation)) return;
      this.#enqueue(target);
      this.#pump();
    }, delay);
    target.retryTimer.unref();
    this.#publish(target, generation, {
      state: "retrying",
      attempt,
      startedAt: new Date(started).toISOString(),
      deadlineAt: null,
      nextRetryAt: new Date(nextRetry).toISOString(),
      error,
    });
  }
}

function isManagedRecoveryDeferral(
  value: void | ManagedRecoveryDeferral,
): value is ManagedRecoveryDeferral {
  return value !== undefined
    && value.kind === "defer"
    && Number.isFinite(value.retryAfterMs)
    && value.retryAfterMs > 0;
}

function boundedDelay(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2_147_483_647, Math.max(1, Math.trunc(value)));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message.trim() || "provider control reconnection failed")
    .slice(0, 2_000)
    .join("");
}
