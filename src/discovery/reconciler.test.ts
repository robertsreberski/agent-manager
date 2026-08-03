import assert from "node:assert/strict";
import test from "node:test";

import type { DiscoveryWorkerMessage } from "./protocol.ts";
import {
  DiscoveryReconciler,
  type DiscoveryUpdate,
  type WorkerPort,
} from "./reconciler.ts";

class FakeWorker implements WorkerPort {
  readonly requests: Array<{ type: "scan"; id: number; recentWindowSeconds: number }> = [];
  terminated = false;
  readonly #messageListeners = new Set<(message: DiscoveryWorkerMessage) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #exitListeners = new Set<(code: number) => void>();

  postMessage(message: { type: "scan"; id: number; recentWindowSeconds: number }): void {
    this.requests.push(message);
  }

  on(event: "message", listener: (message: DiscoveryWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(
    event: "message" | "error" | "exit",
    listener: ((message: DiscoveryWorkerMessage) => void)
      | ((error: Error) => void)
      | ((code: number) => void),
  ): this {
    if (event === "message") {
      this.#messageListeners.add(listener as (message: DiscoveryWorkerMessage) => void);
    } else if (event === "error") {
      this.#errorListeners.add(listener as (error: Error) => void);
    } else {
      this.#exitListeners.add(listener as (code: number) => void);
    }
    return this;
  }

  emitMessage(message: DiscoveryWorkerMessage): void {
    for (const listener of this.#messageListeners) listener(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

test("runs discovery immediately and coalesces overlapping scans", async () => {
  const worker = new FakeWorker();
  const updates: DiscoveryUpdate[] = [];
  const reconciler = new DiscoveryReconciler({
    onUpdate: (update) => updates.push(update),
    intervalMs: 60_000,
    workerFactory: () => worker,
  });

  reconciler.start();
  assert.equal(worker.requests.length, 1);
  reconciler.scan();
  reconciler.scan();
  assert.equal(worker.requests.length, 1);

  worker.emitMessage({
    type: "result",
    id: worker.requests[0]!.id,
    generatedAt: "2026-08-03T00:00:00.000Z",
    sessions: [],
    diagnostics: [],
  } satisfies DiscoveryWorkerMessage);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.ok, true);
  assert.equal(worker.requests.length, 2);
  await reconciler.stop();
  assert.equal(worker.terminated, true);
});

test("publishes stale diagnostics without replacing the previous snapshot", async () => {
  const worker = new FakeWorker();
  const updates: DiscoveryUpdate[] = [];
  const reconciler = new DiscoveryReconciler({
    onUpdate: (update) => updates.push(update),
    intervalMs: 60_000,
    workerFactory: () => worker,
    now: () => new Date("2026-08-03T01:02:03.000Z"),
  });

  reconciler.start();
  worker.emitMessage({
    type: "error",
    id: worker.requests[0]!.id,
    generatedAt: "2026-08-03T01:02:03.000Z",
    message: "fixture failure",
  } satisfies DiscoveryWorkerMessage);

  assert.deepEqual(updates, [{
    ok: false,
    stale: true,
    generatedAt: "2026-08-03T01:02:03.000Z",
    diagnostic: {
      provider: "system",
      level: "error",
      message: "fixture failure",
    },
  }]);
  await reconciler.stop();
});
