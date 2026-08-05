import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createAgentManagerServer } from "./index.ts";

test("production composition creates and enforces its private runtime boundary", async () => {
  // Keep Unix-domain socket paths below macOS's short sockaddr_un limit.
  const root = mkdtempSync("/tmp/am-composition-");
  const safeRuntime = join(root, "safe-runtime");
  const unsafeRuntime = join(root, "unsafe-runtime");
  const realRuntime = join(root, "real-runtime");
  const linkedRuntime = join(root, "linked-runtime");
  mkdirSync(unsafeRuntime, { mode: 0o700 });
  chmodSync(unsafeRuntime, 0o755);
  mkdirSync(realRuntime, { mode: 0o700 });
  symlinkSync(realRuntime, linkedRuntime);

  try {
    await assert.rejects(
      createAgentManagerServer({
        managedProviders: false,
        discovery: false,
        staticDir: false,
        runtimeDirectory: unsafeRuntime,
        databasePath: join(root, "unsafe.sqlite"),
      }),
      /mode 0700/,
    );
    await assert.rejects(
      createAgentManagerServer({
        managedProviders: false,
        discovery: false,
        staticDir: false,
        runtimeDirectory: linkedRuntime,
        databasePath: join(root, "linked.sqlite"),
      }),
      /not a real directory/,
    );

    const backend = await createAgentManagerServer({
      managedProviders: false,
      discovery: false,
      staticDir: false,
      runtimeDirectory: safeRuntime,
      databasePath: join(root, "safe.sqlite"),
    });
    try {
      assert.equal(statSync(safeRuntime).mode & 0o777, 0o700);
      assert.equal(backend.controlSocketPath, join(safeRuntime, "control.sock"));
      await assert.rejects(
        createAgentManagerServer({
          managedProviders: false,
          discovery: false,
          staticDir: false,
          runtimeDirectory: safeRuntime,
          databasePath: join(root, "contender.sqlite"),
        }),
        /another Agent Manager already owns this runtime/,
      );
    } finally {
      await backend.close();
    }

    const replacement = await createAgentManagerServer({
      managedProviders: false,
      discovery: false,
      staticDir: false,
      runtimeDirectory: safeRuntime,
      databasePath: join(root, "replacement.sqlite"),
    });
    await replacement.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production composition releases its instance lease when user shutdown hangs", async () => {
  const root = mkdtempSync("/tmp/am-shutdown-hang-");
  const runtimeDirectory = join(root, "runtime");
  try {
    const backend = await createAgentManagerServer({
      managedProviders: false,
      discovery: false,
      staticDir: false,
      runtimeDirectory,
      databasePath: join(root, "owner.sqlite"),
      shutdownTimeoutMs: 300,
      onShutdown: () => new Promise<void>(() => undefined),
    });

    await assert.rejects(backend.close());

    const replacement = await createAgentManagerServer({
      managedProviders: false,
      discovery: false,
      staticDir: false,
      runtimeDirectory,
      databasePath: join(root, "replacement.sqlite"),
    });
    await replacement.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production composition releases its instance lease after synchronous provider cleanup failure", async () => {
  const root = mkdtempSync("/tmp/am-shutdown-fail-");
  const runtimeDirectory = join(root, "runtime");
  try {
    const backend = await createAgentManagerServer({
      managedProviders: false,
      discovery: false,
      staticDir: false,
      runtimeDirectory,
      databasePath: join(root, "owner.sqlite"),
      shutdownTimeoutMs: 300,
      adapters: {
        codex: {
          async createSession() {
            throw new Error("not used by this shutdown test");
          },
          async performAction() {
            return { status: "succeeded" };
          },
          dispose() {
            throw new Error("provider cleanup failed synchronously");
          },
        },
      },
    });

    await assert.rejects(backend.close());

    const replacement = await createAgentManagerServer({
      managedProviders: false,
      discovery: false,
      staticDir: false,
      runtimeDirectory,
      databasePath: join(root, "replacement.sqlite"),
    });
    await replacement.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
