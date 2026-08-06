import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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

test("composed startup sweeps retired Codex hooks from the configured home, never the real one", async () => {
  const root = mkdtempSync("/tmp/am-codex-sweep-");
  const home = join(root, "home");
  const shimDirectory = join(home, "Library", "Application Support", "agent-manager", "hooks");
  const settingsPath = join(home, ".codex", "hooks.json");
  const shimPath = join(shimDirectory, "codex-user-hook.mjs");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(shimDirectory, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: shimPath, timeout: 5 }] },
        { hooks: [{ type: "command", command: "/opt/operator-hook", timeout: 9 }] },
      ],
    },
  }, null, 2));
  writeFileSync(shimPath, "#!/usr/bin/env node\n");

  /*
    The real home must be untouched. A composed server reaching for `homedir()`
    instead of its configured home would rewrite the developer's own Codex
    configuration every time this suite runs — which is exactly what happened
    before the sweep took its home as an argument.
  */
  const realSettings = join(homedir(), ".codex", "hooks.json");
  const realBefore = existsSync(realSettings) ? readFileSync(realSettings, "utf8") : null;

  const backend = await createAgentManagerServer({
    managedProviders: false,
    staticDir: false,
    discovery: false,
    homeDirectory: home,
    runtimeDirectory: join(root, "runtime"),
    databasePath: join(root, "state.sqlite"),
  });
  try {
    const after = readFileSync(settingsPath, "utf8");
    assert.doesNotMatch(after, /agent-manager/u, "our own hook entries are removed");
    assert.match(after, /operator-hook/u, "the operator's own hook survives");
    assert.equal(existsSync(shimPath), false, "the generated shim is removed");
    assert.equal(
      existsSync(realSettings) ? readFileSync(realSettings, "utf8") : null,
      realBefore,
      "the real home is never touched by a configured-home sweep",
    );
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});
