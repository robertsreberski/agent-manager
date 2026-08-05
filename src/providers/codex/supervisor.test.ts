import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, createServer } from "node:net";
import test from "node:test";

import type { MessageTransport } from "./rpc.ts";
import {
  CodexAppServerSupervisor,
  type ManagedChildProcess,
} from "./supervisor.ts";
import type { JsonObject } from "./types.ts";

class InitializingTransport implements MessageTransport {
  #messages = new Set<(message: string) => void>();
  #closes = new Set<(error: Error | null) => void>();

  async send(raw: string): Promise<void> {
    const message = JSON.parse(raw) as JsonObject;
    if (message.method === "initialize" && typeof message.id === "number") {
      queueMicrotask(() => {
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            codexHome: "/tmp/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
            userAgent: "codex-app-server/0.146.0",
          },
        });
        for (const listener of this.#messages) listener(response);
      });
    }
  }

  async close(): Promise<void> {
    for (const listener of this.#closes) listener(null);
  }

  onMessage(listener: (message: string) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }
}

class FakeChild implements ManagedChildProcess {
  pid: number;
  stderr = null;
  readonly signals: NodeJS.Signals[] = [];
  #exitListeners = new Set<(
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void>();
  #errorListeners = new Set<(error: Error) => void>();

  constructor(pid = 42_424) {
    this.pid = pid;
  }

  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this {
    assert.equal(event, "exit");
    this.#exitListeners.add(listener);
    return this;
  }

  once(event: "error", listener: (error: Error) => void): this {
    assert.equal(event, "error");
    this.#errorListeners.add(listener);
    return this;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    queueMicrotask(() => {
      for (const listener of this.#exitListeners) listener(null, signal);
    });
    return true;
  }

  exitUnexpectedly(code = 17): void {
    for (const listener of this.#exitListeners) listener(code, null);
  }
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function leaveStaleUnixSocket(socketPath: string): Promise<void> {
  const livePath = join(dirname(socketPath), "stale-source.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(livePath, () => resolve());
  });
  // Renaming the bound inode models a process crash without asking the test
  // runner to SIGKILL a helper process. Closing unlinks the original path, but
  // deliberately leaves the renamed socket inode behind with no listener.
  await rename(livePath, socketPath);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  assert.equal((await lstat(socketPath)).isSocket(), true);
}

test("launches only a fresh private 0.146 App Server socket with argv", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-supervisor-"));
  const child = new FakeChild();
  let launchRecord: { executable: string; args: readonly string[] } | null = null;
  let connectedPath: string | null = null;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.9",
    launch: (executable, args) => {
      launchRecord = { executable, args: [...args] };
      return child;
    },
    connect: async (socketPath) => {
      connectedPath = socketPath;
      return new InitializingTransport();
    },
  });

  try {
    const adapter = await supervisor.start();
    assert.equal(adapter.capabilities.compatible, true);
    assert.deepEqual(launchRecord, {
      executable: "codex",
      args: [
        "app-server",
        "--listen",
        `unix://${supervisor.socketPath}`,
      ],
    });
    assert.equal(connectedPath, supervisor.socketPath);
    assert.equal(supervisor.state.status, "running");
    assert.equal(supervisor.state.pid, 42_424);
    await supervisor.stop();
    assert.deepEqual(child.signals, ["SIGTERM"]);
    assert.equal(supervisor.state.status, "stopped");
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("adopts a validated live private Codex App Server instead of launching over it", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-adopt-live-"));
  const socketPath = join(runtimeDir, "codex-private.sock");
  const liveServer = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    liveServer.once("error", reject);
    liveServer.listen(socketPath, () => resolve());
  });
  let launches = 0;
  let inspections = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.0",
    inspectLiveListener: async (candidate) => {
      inspections += 1;
      assert.equal(candidate, socketPath);
      return {
        pid: 65_788,
        command: `codex app-server --listen unix://${socketPath}`,
      };
    },
    launch: () => {
      launches += 1;
      return new FakeChild();
    },
    connect: async (candidate) => {
      assert.equal(candidate, socketPath);
      return new InitializingTransport();
    },
  });

  try {
    const adapter = await supervisor.start();
    assert.equal(adapter.capabilities.compatible, true);
    assert.equal(inspections, 1);
    assert.equal(launches, 0);
    assert.equal(supervisor.state.status, "running");
    assert.equal(supervisor.state.pid, 65_788);
    await supervisor.stop();
    assert.equal((await lstat(socketPath)).isSocket(), true);
  } finally {
    await supervisor.stop();
    await new Promise<void>((resolve) => liveServer.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("reconnects to an adopted listener when its WebSocket closes", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-adopt-reconnect-"));
  const socketPath = join(runtimeDir, "codex-private.sock");
  const liveServer = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    liveServer.once("error", reject);
    liveServer.listen(socketPath, () => resolve());
  });
  const transports: InitializingTransport[] = [];
  let launches = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.0",
    inspectLiveListener: async () => ({
      pid: 65_788,
      command: `codex app-server --listen unix://${socketPath}`,
    }),
    connect: async () => {
      const transport = new InitializingTransport();
      transports.push(transport);
      return transport;
    },
    launch: () => {
      launches += 1;
      return new FakeChild();
    },
    restartInitialDelayMs: 0,
    restartMaxDelayMs: 0,
  });

  try {
    await supervisor.start();
    await transports[0]!.close();
    await eventually(() => {
      assert.equal(supervisor.state.status, "running");
      assert.equal(transports.length, 2);
    });
    assert.equal(launches, 0);
    assert.equal(supervisor.state.pid, 65_788);
  } finally {
    await supervisor.stop();
    await new Promise<void>((resolve) => liveServer.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("rejects incompatible CLI versions before spawning", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-version-"));
  let launches = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.147.0",
    restartMaxAttempts: 1,
    restartInitialDelayMs: 0,
    restartMaxDelayMs: 0,
    launch: () => {
      launches += 1;
      return new FakeChild();
    },
  });
  try {
    await assert.rejects(supervisor.start(), /unsupported; expected 0\.146\.x/u);
    assert.equal(launches, 0);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("recovers a cold launch failure before publishing the initial adapter", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-cold-recover-"));
  let launches = 0;
  let probes = 0;
  let recoveredCallbacks = 0;
  const child = new FakeChild();
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    restartMaxAttempts: 3,
    restartInitialDelayMs: 1,
    restartMaxDelayMs: 2,
    probeVersion: async () => {
      probes += 1;
      return "0.146.9";
    },
    launch: () => {
      launches += 1;
      if (launches === 1) throw new Error("transient cold launch failure");
      return child;
    },
    connect: async () => new InitializingTransport(),
    onRecovered: () => {
      recoveredCallbacks += 1;
    },
  });

  try {
    const adapter = await supervisor.start();
    assert.equal(adapter.capabilities.compatible, true);
    assert.equal(supervisor.adapter, adapter);
    assert.equal(supervisor.state.status, "running");
    assert.equal(supervisor.state.restartAttempt, 1);
    assert.equal(supervisor.state.terminalFailure, null);
    assert.equal(launches, 2);
    assert.equal(probes, 2);
    assert.equal(
      recoveredCallbacks,
      0,
      "cold recovery returns through start() and must not publish as a replacement",
    );
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("ensureRunning starts one fresh series after terminal cold-start exhaustion", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-manual-retry-"));
  let launches = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    restartMaxAttempts: 1,
    restartInitialDelayMs: 0,
    restartMaxDelayMs: 0,
    probeVersion: async () => "0.146.9",
    launch: () => {
      launches += 1;
      if (launches <= 2) throw new Error(`cold failure ${launches}`);
      return new FakeChild();
    },
    connect: async () => new InitializingTransport(),
  });

  try {
    await assert.rejects(supervisor.start(), /cold failure 2/u);
    assert.equal(supervisor.state.status, "failed");
    assert.equal(supervisor.adapter, null);

    const [first, second] = await Promise.all([
      supervisor.ensureRunning(),
      supervisor.ensureRunning(),
    ]);
    assert.equal(first, second, "concurrent manual retries must share one start task");
    assert.equal(supervisor.adapter, first);
    assert.equal(supervisor.state.status, "running");
    assert.equal(launches, 3);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("stop cancels a cold-start recovery without launching again", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-cold-stop-"));
  let launches = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    restartMaxAttempts: 3,
    restartInitialDelayMs: 100,
    restartMaxDelayMs: 100,
    probeVersion: async () => "0.146.9",
    launch: () => {
      launches += 1;
      throw new Error("cold launch failed");
    },
  });

  const starting = supervisor.start().then(
    () => ({ ok: true as const, error: null }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await eventually(() => {
      assert.equal(supervisor.state.status, "recovering");
      assert.equal(supervisor.state.restartAttempt, 1);
    });
    await supervisor.stop();
    const result = await starting;
    assert.equal(result.ok, false);
    assert.match(result.error instanceof Error ? result.error.message : "", /cancelled/u);
    await wait(130);
    assert.equal(launches, 1);
    assert.equal(supervisor.state.status, "stopped");
    assert.equal(supervisor.state.nextRestartAt, null);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("reclaims an exact same-UID stale Unix socket before cold launch", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-stale-socket-"));
  const socketPath = join(runtimeDir, "codex-private.sock");
  await leaveStaleUnixSocket(socketPath);
  let launches = 0;
  let stalePathPresentAtLaunch: boolean | null = null;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.9",
    launch: () => {
      launches += 1;
      stalePathPresentAtLaunch = existsSync(socketPath);
      return new FakeChild();
    },
    connect: async () => new InitializingTransport(),
  });

  try {
    await supervisor.start();
    assert.equal(launches, 1);
    assert.equal(stalePathPresentAtLaunch, false);
    assert.equal(supervisor.state.status, "running");
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("publishes unexpected death after withdrawing adapter controls", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-death-"));
  const child = new FakeChild();
  let adapterAtCallback: Awaited<ReturnType<CodexAppServerSupervisor["start"]>> | null = null;
  const callbacks: Array<{ code: number | null; alive: boolean | null }> = [];
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.9",
    launch: () => child,
    connect: async () => new InitializingTransport(),
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    restartMaxAttempts: 2,
    restartInitialDelayMs: 10_000,
    restartMaxDelayMs: 10_000,
    onUnexpectedExit: (event) => callbacks.push({
      code: event.code,
      alive: adapterAtCallback?.runtimeAlive ?? null,
    }),
  });

  try {
    adapterAtCallback = await supervisor.start();
    child.exitUnexpectedly(17);

    assert.equal(supervisor.state.status, "recovering");
    assert.equal(supervisor.state.pid, null);
    assert.equal(supervisor.state.restartAttempt, 1);
    assert.equal(supervisor.state.nextRestartAt, "2026-08-03T12:00:10.000Z");
    assert.equal(supervisor.state.terminalFailure, null);
    assert.deepEqual(supervisor.state.lastUnexpectedExit, {
      occurredAt: "2026-08-03T12:00:00.000Z",
      code: 17,
      signal: null,
      message: "Codex App Server exited with exit code 17",
      stderrTail: "",
      wasRunning: true,
    });
    assert.deepEqual(callbacks, [{ code: 17, alive: false }]);
    assert.equal(adapterAtCallback.runtimeAlive, false);
    assert.equal(adapterAtCallback.capabilities.compatible, false);
    assert.deepEqual(adapterAtCallback.capabilities.controls, []);
    assert.match(adapterAtCallback.runtimeFailure ?? "", /exit code 17/u);

    await supervisor.stop();
    assert.equal(supervisor.state.status, "stopped");
    assert.equal(supervisor.state.lastUnexpectedExit?.code, 17);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("restarts a crashed App Server and publishes only an initialized adapter", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-recover-"));
  const children: FakeChild[] = [];
  const launchArgs: string[][] = [];
  const recovered: Array<{
    adapter: Awaited<ReturnType<CodexAppServerSupervisor["start"]>>;
    attempt: number;
    initialized: boolean;
  }> = [];
  let probes = 0;
  let publicationCommits = 0;
  let supervisor!: CodexAppServerSupervisor;
  supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => {
      probes += 1;
      return "0.146.9";
    },
    restartInitialDelayMs: 1,
    restartMaxDelayMs: 2,
    launch: (_executable, args) => {
      launchArgs.push([...args]);
      const child = new FakeChild(42_424 + children.length);
      children.push(child);
      return child;
    },
    connect: async () => new InitializingTransport(),
    onRecovered: (adapter, attempt) => {
      recovered.push({
        adapter,
        attempt,
        initialized: adapter.capabilities.compatible,
      });
      assert.equal(
        supervisor.adapter,
        null,
        "the recovered adapter must not publish before the recovery callback succeeds",
      );
      return {
        commit: () => {
          publicationCommits += 1;
          assert.equal(
            supervisor.adapter,
            adapter,
            "the supervisor adapter must publish before the bridge commit",
          );
        },
        rollback: () => assert.fail("successful publication must not roll back"),
      };
    },
  });

  try {
    const original = await supervisor.start();
    children[0]?.exitUnexpectedly(17);

    await eventually(() => {
      assert.equal(supervisor.state.status, "running");
      assert.equal(children.length, 2);
      assert.equal(recovered.length, 1);
    });
    const replacement = supervisor.adapter;
    assert.ok(replacement);
    assert.notEqual(replacement, original);
    assert.equal(original.runtimeAlive, false);
    assert.equal(replacement.runtimeAlive, true);
    assert.deepEqual(recovered.map(({ attempt, initialized }) => ({ attempt, initialized })), [
      { attempt: 1, initialized: true },
    ]);
    assert.equal(supervisor.state.restartAttempt, 1);
    assert.equal(publicationCommits, 1);
    assert.equal(probes, 2, "every restart revalidates the pinned executable version");
    assert.equal(supervisor.state.terminalFailure, null);
    assert.deepEqual(launchArgs, [
      ["app-server", "--listen", `unix://${supervisor.socketPath}`],
      ["app-server", "--listen", `unix://${supervisor.socketPath}`],
    ]);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("a failed recovery publication disposes the staged adapter and publishes nothing", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-stage-fail-"));
  const children: FakeChild[] = [];
  let callbacks = 0;
  let commits = 0;
  let rollbacks = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    restartMaxAttempts: 1,
    restartInitialDelayMs: 0,
    restartMaxDelayMs: 0,
    probeVersion: async () => "0.146.9",
    launch: () => {
      const child = new FakeChild(60_000 + children.length);
      children.push(child);
      return child;
    },
    connect: async () => new InitializingTransport(),
    onRecovered: (adapter) => {
      callbacks += 1;
      assert.equal(supervisor.adapter, null);
      assert.equal(adapter.runtimeAlive, true);
      return {
        commit: () => {
          commits += 1;
        },
        rollback: () => {
          rollbacks += 1;
        },
      };
    },
  });
  supervisor.onRecovered(() => {
    throw new Error("bridge publication failed");
  });

  try {
    const original = await supervisor.start();
    children[0]?.exitUnexpectedly(17);
    await eventually(() => assert.equal(supervisor.state.status, "failed"));

    assert.equal(callbacks, 1);
    assert.equal(commits, 0);
    assert.equal(rollbacks, 1);
    assert.equal(supervisor.adapter, null);
    assert.equal(original.runtimeAlive, false);
    assert.deepEqual(children[1]?.signals, ["SIGTERM"]);
    assert.match(supervisor.state.terminalFailure?.lastError ?? "", /bridge publication failed/u);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("uses bounded exponential backoff and publishes terminal recovery failure", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-retry-fail-"));
  const child = new FakeChild();
  const recoveryLaunches: number[] = [];
  const failures: Array<{
    attempts: number;
    message: string;
    lastError: string;
  }> = [];
  let launches = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.9",
    restartMaxAttempts: 3,
    restartInitialDelayMs: 10,
    restartMaxDelayMs: 20,
    launch: () => {
      launches += 1;
      if (launches === 1) return child;
      recoveryLaunches.push(Date.now());
      throw new Error(`restart launch ${launches - 1} failed`);
    },
    connect: async () => new InitializingTransport(),
    onRecoveryFailed: ({ attempts, message, lastError }) => {
      failures.push({ attempts, message, lastError });
    },
  });

  try {
    await supervisor.start();
    const crashedAt = Date.now();
    child.exitUnexpectedly(17);
    await eventually(() => assert.equal(supervisor.state.status, "failed"));

    assert.equal(launches, 4, "initial launch plus exactly three bounded retries");
    assert.equal(recoveryLaunches.length, 3);
    assert.ok((recoveryLaunches[0] ?? 0) - crashedAt >= 7);
    assert.ok((recoveryLaunches[1] ?? 0) - (recoveryLaunches[0] ?? 0) >= 15);
    assert.ok((recoveryLaunches[2] ?? 0) - (recoveryLaunches[1] ?? 0) >= 15);
    assert.deepEqual(failures, [{
      attempts: 3,
      message: "Codex App Server recovery failed after 3 attempts: restart launch 3 failed",
      lastError: "restart launch 3 failed",
    }]);
    assert.deepEqual(supervisor.state.terminalFailure, {
      occurredAt: supervisor.state.terminalFailure?.occurredAt,
      attempts: 3,
      message: "Codex App Server recovery failed after 3 attempts: restart launch 3 failed",
      lastError: "restart launch 3 failed",
    });
    assert.equal(supervisor.state.nextRestartAt, null);
    assert.equal(supervisor.adapter, null);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("stop cancels recovery backoff and prevents any restart", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-stop-backoff-"));
  const child = new FakeChild();
  let launches = 0;
  let recovered = 0;
  let terminalFailures = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.9",
    restartMaxAttempts: 3,
    restartInitialDelayMs: 100,
    restartMaxDelayMs: 100,
    launch: () => {
      launches += 1;
      return launches === 1 ? child : new FakeChild(50_000 + launches);
    },
    connect: async () => new InitializingTransport(),
    onRecovered: () => {
      recovered += 1;
    },
    onRecoveryFailed: () => {
      terminalFailures += 1;
    },
  });

  try {
    await supervisor.start();
    child.exitUnexpectedly(17);
    assert.equal(supervisor.state.status, "recovering");
    assert.equal(supervisor.state.restartAttempt, 1);
    assert.ok(supervisor.state.nextRestartAt);

    await supervisor.stop();
    await wait(130);
    assert.equal(supervisor.state.status, "stopped");
    assert.equal(supervisor.state.nextRestartAt, null);
    assert.equal(launches, 1);
    assert.equal(recovered, 0);
    assert.equal(terminalFailures, 0);
  } finally {
    await supervisor.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("refuses an active socket and never unlinks its listener", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-existing-"));
  const socketPath = join(runtimeDir, "codex-private.sock");
  const otherServer = createServer();
  await new Promise<void>((resolve, reject) => {
    otherServer.once("error", reject);
    otherServer.listen(socketPath, () => resolve());
  });
  let launches = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.146.0",
    restartMaxAttempts: 2,
    restartInitialDelayMs: 0,
    restartMaxDelayMs: 0,
    launch: () => {
      launches += 1;
      return new FakeChild();
    },
  });
  try {
    await assert.rejects(
      supervisor.start(),
      /Refusing to connect to or replace an existing Codex socket with a live listener/u,
    );
    assert.equal(launches, 0);
    await supervisor.stop();
    assert.equal((await lstat(socketPath)).isSocket(), true);
    await new Promise<void>((resolve, reject) => {
      const connection = createConnection({ path: socketPath });
      connection.once("error", reject);
      connection.once("connect", () => {
        connection.destroy();
        resolve();
      });
    });
  } finally {
    await new Promise<void>((resolve) => otherServer.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
