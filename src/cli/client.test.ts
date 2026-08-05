import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import { attachSpecFromInstruction, executeLifecycleAttach } from "./client.ts";

const TRUSTED_EXECUTABLES = {
  codex: "/trusted/lib/openai/codex.js",
  claude: "/trusted/lib/anthropic/claude.exe",
  tmux: "/trusted/bin/tmux",
} as const;

test("accepts only the closed Codex, Claude, and tmux attach grammars", () => {
  assert.deepEqual(
    attachSpecFromInstruction({
      kind: "codex-remote",
      argv: [
        TRUSTED_EXECUTABLES.codex,
        "resume",
        "thread-1",
        "--remote",
        "unix:///private/tmp/agent-manager/codex.sock",
      ],
      cwd: "/tmp/project",
      warning: null,
    }, TRUSTED_EXECUTABLES),
    {
      executable: TRUSTED_EXECUTABLES.codex,
      args: [
        "resume",
        "thread-1",
        "--remote",
        "unix:///private/tmp/agent-manager/codex.sock",
      ],
      cwd: "/tmp/project",
    },
  );

  assert.deepEqual(
    attachSpecFromInstruction({
      kind: "claude-resume",
      argv: [TRUSTED_EXECUTABLES.claude, "--resume", "session-1"],
      cwd: "/tmp/project",
      warning: "Manager ownership is handed off.",
    }, TRUSTED_EXECUTABLES),
    {
      executable: TRUSTED_EXECUTABLES.claude,
      args: ["--resume", "session-1"],
      cwd: "/tmp/project",
    },
  );

  assert.deepEqual(
    attachSpecFromInstruction({
      kind: "tmux",
      argv: ["tmux", "-S", "/private/tmp/tmux-501/mobile-ssh", "attach-session", "-t", "fable"],
      cwd: null,
      warning: "Select the matching pane.",
    }, TRUSTED_EXECUTABLES),
    {
      executable: "/trusted/bin/tmux",
      args: ["-S", "/private/tmp/tmux-501/mobile-ssh", "attach-session", "-t", "fable"],
      hint: "Select the matching pane.",
    },
  );
});

test("refuses arbitrary executables, shell-shaped argv, and non-Unix Codex remotes", () => {
  assert.throws(
    () => attachSpecFromInstruction({
      kind: "codex-remote",
      argv: ["/untrusted/bin/codex", "resume", "thread-1", "--remote", "unix:///tmp/codex.sock"],
      cwd: "/tmp/project",
      warning: null,
    }, TRUSTED_EXECUTABLES),
    /codex executable/,
  );
  assert.throws(
    () => attachSpecFromInstruction({
      kind: "manager-cli",
      argv: ["agent-manager", "attach", "codex:thread-1"],
      cwd: "/tmp/project",
      warning: null,
    }, TRUSTED_EXECUTABLES),
    /browser-only/,
  );
  assert.throws(
    () => attachSpecFromInstruction({
      kind: "tmux",
      argv: ["/bin/sh", "-c", "echo unsafe"],
      cwd: null,
      warning: null,
    }, TRUSTED_EXECUTABLES),
    /tmux executable/,
  );
  assert.throws(
    () => attachSpecFromInstruction({
      kind: "claude-resume",
      argv: ["claude", "--resume", "session-1", "; rm -rf /tmp/example"],
      cwd: "/tmp/project",
      warning: null,
    }, TRUSTED_EXECUTABLES),
    /Unsupported Claude/,
  );
  assert.throws(
    () => attachSpecFromInstruction({
      kind: "codex-remote",
      argv: ["codex", "resume", "thread-1", "--remote", "ws://localhost:1234"],
      cwd: "/tmp/project",
      warning: null,
    }, TRUSTED_EXECUTABLES),
    /absolute Unix socket/,
  );
  assert.throws(
    () => attachSpecFromInstruction({
      kind: "codex-remote",
      argv: ["codex", "resume", "--help", "--remote", "unix:///tmp/codex.sock"],
      cwd: "/tmp/project",
      warning: null,
    }, TRUSTED_EXECUTABLES),
    /leading hyphens/,
  );
  assert.throws(
    () => attachSpecFromInstruction({
      kind: "claude-resume",
      argv: ["claude", "--resume", "--dangerously-skip-permissions"],
      cwd: "/tmp/project",
      warning: null,
    }, TRUSTED_EXECUTABLES),
    /leading hyphens/,
  );
});

class FakeChild extends EventEmitter {
  pid: number | undefined = 4_242;
  readonly signals: NodeJS.Signals[] = [];
  exitOnKill: NodeJS.Signals | null = "SIGTERM";

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === this.exitOnKill) {
      queueMicrotask(() => this.emit("exit", null, signal));
    }
    return true;
  }
}

function fakeSpawner(child: FakeChild): typeof spawn {
  return (() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as typeof spawn;
}

test("sends one SIGTERM and confirms the native child before reclaiming a failed started acknowledgement", async () => {
  const child = new FakeChild();
  const events: string[] = [];
  child.once("exit", () => events.push("child-exited"));

  await assert.rejects(
    executeLifecycleAttach(
      { executable: "/trusted/bin/claude", args: ["--resume", "session-1"] },
      {
        async started() {
          events.push("started");
          throw new Error("started acknowledgement failed");
        },
        async exited() {
          events.push("owner-exited");
        },
        async failed() {
          events.push("owner-failed");
        },
      },
      {
        spawnProcess: fakeSpawner(child),
        terminationGraceMs: 10,
      },
    ),
    /started acknowledgement failed/,
  );

  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual(events, ["started", "child-exited", "owner-failed"]);
});

test("does not reclaim ownership when the child cannot be confirmed dead", async () => {
  const child = new FakeChild();
  child.exitOnKill = null;
  let failedCalls = 0;

  await assert.rejects(
    executeLifecycleAttach(
      { executable: "/trusted/bin/claude", args: ["--resume", "session-1"] },
      {
        async started() {
          throw new Error("started acknowledgement failed");
        },
        async exited() {
          throw new Error("unexpected exited callback");
        },
        async failed() {
          failedCalls += 1;
        },
      },
      {
        spawnProcess: fakeSpawner(child),
        terminationGraceMs: 1,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(
        error.message,
        /cleanup is uncertain.*provider CLI may still be running.*ownership was not reclaimed/,
      );
      const cleanupError = error.errors.at(1);
      assert.ok(cleanupError instanceof Error);
      assert.match(
        cleanupError.message,
        /single permitted SIGTERM; cleanup is uncertain and ownership was not reclaimed/,
      );
      return true;
    },
  );

  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(failedCalls, 0);
});

test("never retries or escalates when signalling the native child throws", async () => {
  class ThrowingSignalChild extends FakeChild {
    override kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
      this.signals.push(signal);
      throw new Error("signal delivery failed");
    }
  }
  const child = new ThrowingSignalChild();

  await assert.rejects(
    executeLifecycleAttach(
      { executable: "/trusted/bin/claude", args: ["--resume", "session-1"] },
      {
        async started() {
          throw new Error("owner socket dropped");
        },
        async exited() {
          throw new Error("unexpected exited callback");
        },
        async failed() {
          throw new Error("ownership must remain fail-closed");
        },
      },
      {
        spawnProcess: fakeSpawner(child),
        terminationGraceMs: 1,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(
        error.message,
        /cleanup is uncertain.*provider CLI may still be running.*ownership was not reclaimed/,
      );
      const cleanupError = error.errors.at(1);
      assert.ok(cleanupError instanceof Error);
      assert.match(cleanupError.message, /could not be signalled \(signal delivery failed\)/);
      assert.match(cleanupError.message, /cleanup is uncertain/);
      return true;
    },
  );

  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("reports the native child lifecycle around an argv-only attach", async () => {
  const events: Array<string | number | null> = [];
  const exitCode = await executeLifecycleAttach(
    {
      executable: process.execPath,
      args: ["-e", "process.exit(3)"],
    },
    {
      async started(pid) {
        assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
        events.push("started", pid);
      },
      async exited(code) {
        events.push("exited", code);
      },
      async failed(message) {
        events.push("failed", message);
      },
    },
  );

  assert.equal(exitCode, 3);
  assert.equal(events[0], "started");
  assert.equal(typeof events[1], "number");
  assert.deepEqual(events.slice(2), ["exited", 3]);
});
