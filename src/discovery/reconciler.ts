import { Worker } from "node:worker_threads";

import type { Diagnostic, SessionRecord } from "../core/types.ts";
import { WorkspaceIdentityResolver } from "../core/worktree.ts";
import type {
  DiscoveryScanRequest,
  DiscoveryWorkerMessage,
} from "./protocol.ts";

export type DiscoveryUpdate =
  | {
      ok: true;
      stale: false;
      generatedAt: string;
      sessions: SessionRecord[];
      diagnostics: Diagnostic[];
    }
  | {
      ok: false;
      stale: true;
      generatedAt: string;
      diagnostic: Diagnostic;
    };

export interface WorkerPort {
  postMessage(message: DiscoveryScanRequest): void;
  on(event: "message", listener: (message: DiscoveryWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export interface DiscoveryReconcilerOptions {
  onUpdate(update: DiscoveryUpdate): void;
  intervalMs?: number;
  scanTimeoutMs?: number;
  recentWindowSeconds?: number;
  workerFactory?: () => WorkerPort;
  now?: () => Date;
  workspaceBudgetMs?: number;
  workspaceResolver?: Pick<WorkspaceIdentityResolver, "resolveMany">;
}

function defaultWorkerFactory(): WorkerPort {
  // In source, this module and the worker are siblings. In production tsup
  // bundles this module into dist/server/index.js while keeping the worker as
  // the separate dist/discovery/worker.js entry.
  const workerUrl = import.meta.url.endsWith(".ts")
    ? new URL("./worker.ts", import.meta.url)
    : new URL("../discovery/worker.js", import.meta.url);
  return new Worker(workerUrl, {
    // `node --input-type=module -e` is useful for diagnostics but the flag is
    // invalid for file-backed Workers. Preserve real loaders (including tsx).
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
  }) as WorkerPort;
}

/**
 * Schedules synchronous provider discovery in a dedicated Worker. A slow scan
 * never overlaps another scan; one follow-up is coalesced and run immediately.
 */
export class DiscoveryReconciler {
  readonly intervalMs: number;
  readonly scanTimeoutMs: number;
  readonly recentWindowSeconds: number;

  #onUpdate: (update: DiscoveryUpdate) => void;
  #workerFactory: () => WorkerPort;
  #now: () => Date;
  #workspaceBudgetMs: number;
  #workspaceResolver: Pick<WorkspaceIdentityResolver, "resolveMany">;
  #worker: WorkerPort | null = null;
  #interval: NodeJS.Timeout | null = null;
  #scanTimeout: NodeJS.Timeout | null = null;
  #nextId = 0;
  #activeId: number | null = null;
  #queued = false;
  #started = false;
  #stopping = false;

  constructor(options: DiscoveryReconcilerOptions) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 15_000);
    this.scanTimeoutMs = Math.max(1_000, options.scanTimeoutMs ?? 20_000);
    this.recentWindowSeconds = Math.max(0, options.recentWindowSeconds ?? 15 * 60);
    this.#onUpdate = options.onUpdate;
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#now = options.now ?? (() => new Date());
    this.#workspaceBudgetMs = Math.max(100, options.workspaceBudgetMs ?? 2_500);
    this.#workspaceResolver = options.workspaceResolver ?? new WorkspaceIdentityResolver({
      totalBudgetMs: this.#workspaceBudgetMs,
    });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#ensureWorker();
    this.scan();
    this.#interval = setInterval(() => this.scan(), this.intervalMs);
    this.#interval.unref();
  }

  scan(): void {
    if (!this.#started || this.#stopping) return;
    if (this.#activeId !== null) {
      this.#queued = true;
      return;
    }
    const worker = this.#ensureWorker();
    const id = ++this.#nextId;
    this.#activeId = id;
    const request: DiscoveryScanRequest = {
      type: "scan",
      id,
      recentWindowSeconds: this.recentWindowSeconds,
    };
    worker.postMessage(request);
    this.#scanTimeout = setTimeout(() => {
      if (this.#activeId !== id || this.#stopping) return;
      this.#fail(`Discovery scan ${id} timed out after ${this.scanTimeoutMs}ms`);
      void this.#replaceWorker();
    }, this.scanTimeoutMs);
    this.#scanTimeout.unref();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopping = true;
    this.#started = false;
    this.#queued = false;
    this.#activeId = null;
    if (this.#interval) clearInterval(this.#interval);
    if (this.#scanTimeout) clearTimeout(this.#scanTimeout);
    this.#interval = null;
    this.#scanTimeout = null;
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.terminate().catch(() => 0);
    this.#stopping = false;
  }

  #ensureWorker(): WorkerPort {
    if (this.#worker) return this.#worker;
    const worker = this.#workerFactory();
    worker.on("message", (message) => this.#handleMessage(message));
    worker.on("error", (error) => {
      if (!this.#stopping) {
        this.#fail(`Discovery worker failed: ${error.message}`);
        void this.#replaceWorker();
      }
    });
    worker.on("exit", (code) => {
      if (!this.#stopping && this.#worker === worker) {
        this.#worker = null;
        if (code !== 0) {
          this.#fail(`Discovery worker exited with status ${code}`);
        }
      }
    });
    this.#worker = worker;
    return worker;
  }

  #handleMessage(message: DiscoveryWorkerMessage): void {
    if (message.id !== this.#activeId || this.#stopping) return;
    if (message.type === "result") {
      void this.#publishResult(message);
      return;
    } else {
      this.#clearActive();
      this.#fail(message.message);
    }
    this.#runQueued();
  }

  async #publishResult(
    message: Extract<DiscoveryWorkerMessage, { type: "result" }>,
  ): Promise<void> {
    const diagnostics = [...message.diagnostics];
    let sessions = message.sessions;
    try {
      const localCwds = sessions.flatMap((session) =>
        session.hostId === "local" && session.cwd !== null ? [session.cwd] : []
      );
      const identities = await this.#workspaceResolver.resolveMany(localCwds, {
        budgetMs: this.#workspaceBudgetMs,
      });
      sessions = sessions.map((session) => ({
        ...session,
        workspaceIdentity: session.hostId === "local" && session.cwd !== null
          ? identities.get(session.cwd) ?? null
          : session.workspaceIdentity,
      }));
    } catch {
      diagnostics.push({
        provider: "system",
        level: "warning",
        message: "Git workspace facts are temporarily unavailable.",
      });
    }
    if (message.id !== this.#activeId || this.#stopping) return;
    this.#clearActive();
    this.#onUpdate({
      ok: true,
      stale: false,
      generatedAt: message.generatedAt,
      sessions,
      diagnostics,
    });
    this.#runQueued();
  }

  #clearActive(): void {
    this.#activeId = null;
    if (this.#scanTimeout) clearTimeout(this.#scanTimeout);
    this.#scanTimeout = null;
  }

  #fail(message: string): void {
    this.#clearActive();
    this.#onUpdate({
      ok: false,
      stale: true,
      generatedAt: this.#now().toISOString(),
      diagnostic: {
        provider: "system",
        level: "error",
        message,
      },
    });
  }

  #runQueued(): void {
    if (!this.#queued || !this.#started || this.#stopping) return;
    this.#queued = false;
    queueMicrotask(() => this.scan());
  }

  async #replaceWorker(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.terminate().catch(() => 0);
    if (this.#started && !this.#stopping) {
      this.#ensureWorker();
      this.#runQueued();
    }
  }
}
