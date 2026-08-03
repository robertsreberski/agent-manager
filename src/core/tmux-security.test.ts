import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverTmuxPanes } from "./tmux.ts";
import type { Runtime } from "./types.ts";

test("tmux discovery never probes regular files or an unsafe shared directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-tmux-security-"));
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const privateDirectory = join(root, `tmux-${uid}`);
  mkdirSync(privateDirectory, { mode: 0o700 });
  for (let index = 0; index < 64; index += 1) {
    writeFileSync(join(privateDirectory, `not-a-socket-${index}`), "untrusted");
  }
  writeFileSync(join(root, "shared-entry"), "untrusted");

  const calls: string[][] = [];
  const runtime: Runtime = {
    now: Date.now,
    homeDir: root,
    env: { TMUX_TMPDIR: root },
    run(_command, args) {
      calls.push(args);
      return { stdout: "", stderr: "missing", status: 1, error: null };
    },
  };

  try {
    discoverTmuxPanes(runtime);
    assert.equal(
      calls.some((args) => args[0] === "-S" && args[1]?.startsWith(privateDirectory)),
      false,
      "regular files must not become tmux subprocess probes",
    );

    calls.length = 0;
    chmodSync(privateDirectory, 0o777);
    discoverTmuxPanes(runtime);
    assert.equal(
      calls.some((args) => args[0] === "-S" && args[1]?.startsWith(privateDirectory)),
      false,
      "an unsafe per-user directory must not be enumerated",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmux discovery bounds aggregate configured-socket probing", () => {
  let now = 1_000;
  const timeouts: number[] = [];
  const runtime: Runtime = {
    now: () => now,
    homeDir: "/tmp",
    env: {
      AGENT_MANAGER_TMUX_SOCKETS: Array.from(
        { length: 64 },
        (_, index) => `candidate-${index}`,
      ).join(","),
    },
    run(_command, _args, timeoutMs) {
      assert.notEqual(timeoutMs, undefined);
      if (timeoutMs === undefined) throw new Error("tmux probe must have a timeout");
      timeouts.push(timeoutMs);
      now += timeoutMs;
      return { stdout: "", stderr: "timed out", status: 1, error: null };
    },
  };

  const result = discoverTmuxPanes(runtime);
  assert.equal(timeouts.length, 4);
  assert.deepEqual(timeouts, [750, 750, 750, 750]);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("probe budget")));
});

test("tmux discovery uses the pinned executable from its runtime", () => {
  const commands: string[] = [];
  const runtime: Runtime = {
    now: Date.now,
    homeDir: "/tmp",
    env: { AGENT_MANAGER_TMUX_EXECUTABLE: "/opt/pinned/bin/tmux" },
    run(command) {
      commands.push(command);
      return { stdout: "", stderr: "missing", status: 1, error: null };
    },
  };

  discoverTmuxPanes(runtime);
  assert.ok(commands.length > 0);
  assert.equal(commands.every((command) => command === "/opt/pinned/bin/tmux"), true);
});
