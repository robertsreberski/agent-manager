import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
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
  pid = 42_424;
  stderr = null;
  readonly signals: NodeJS.Signals[] = [];
  #exitListeners = new Set<(
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void>();
  #errorListeners = new Set<(error: Error) => void>();

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

test("rejects incompatible CLI versions before spawning", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "am-codex-version-"));
  let launches = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtimeDir,
    probeVersion: async () => "0.147.0",
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
    onUnexpectedExit: (event) => callbacks.push({
      code: event.code,
      alive: adapterAtCallback?.runtimeAlive ?? null,
    }),
  });

  try {
    adapterAtCallback = await supervisor.start();
    child.exitUnexpectedly(17);

    assert.equal(supervisor.state.status, "failed");
    assert.equal(supervisor.state.pid, null);
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

test("never connects to or replaces a pre-existing socket path", async () => {
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
    launch: () => {
      launches += 1;
      return new FakeChild();
    },
  });
  try {
    await assert.rejects(
      supervisor.start(),
      /Refusing to connect to or replace an existing Codex socket/u,
    );
    assert.equal(launches, 0);
    await supervisor.stop();
    assert.equal((await lstat(socketPath)).isSocket(), true);
  } finally {
    await new Promise<void>((resolve) => otherServer.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
