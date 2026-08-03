import { spawn, type ChildProcess } from "node:child_process";
import { basename, isAbsolute } from "node:path";

import { buildAttachSpec, type AttachSpec } from "../ops/attach.ts";
import type { AttachExecutables } from "../ops/executables.ts";
import type { AttachInstruction } from "../server/contracts.ts";

export interface AttachLifecycle {
  started(pid: number): Promise<void>;
  exited(exitCode: number | null): Promise<void>;
  failed(message: string): Promise<void>;
}

export interface LifecycleAttachOptions {
  /** Test seam; production always uses node:child_process spawn. */
  spawnProcess?: typeof spawn;
  terminationGraceMs?: number;
  killGraceMs?: number;
}

interface ExitOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function assertSafeArgument(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || /[\r\n]/u.test(value)
  ) {
    throw new Error(`Invalid ${label} in attach instruction`);
  }
  return value;
}

function assertCommandIdentity(value: unknown, expectedBasename: string): void {
  const command = assertSafeArgument(value, `${expectedBasename} executable`);
  if (basename(command) !== expectedBasename) {
    throw new Error(`Attach instruction expected the ${expectedBasename} executable`);
  }
}

function assertProviderIdentifier(value: unknown, label: string): string {
  const identifier = assertSafeArgument(value, label);
  if (identifier.startsWith("-")) {
    throw new Error(`Invalid ${label} in attach instruction: leading hyphens are not allowed`);
  }
  return identifier;
}

function optionalCwd(value: string | null): string | undefined {
  return value === null ? undefined : assertSafeArgument(value, "working directory");
}

function tmuxAttachSpec(
  instruction: AttachInstruction,
  executables: AttachExecutables,
): AttachSpec {
  const argv = instruction.argv;
  assertCommandIdentity(argv[0], "tmux");
  const args = argv.slice(1);
  const direct = args.length === 3
    && args[0] === "attach-session"
    && args[1] === "-t";
  const selected = args.length === 5
    && (args[0] === "-S" || args[0] === "-L")
    && args[2] === "attach-session"
    && args[3] === "-t";
  if (!direct && !selected) {
    throw new Error("Unsupported tmux attach instruction");
  }
  for (const [index, argument] of args.entries()) {
    assertSafeArgument(argument, `tmux argument ${index + 1}`);
  }
  assertProviderIdentifier(args.at(-1), "tmux session");
  const cwd = optionalCwd(instruction.cwd);
  return {
    // The owner socket is allowed to choose only the grammar and arguments.
    // Executable identity is always pinned by this local client.
    executable: executables.tmux,
    args,
    ...(cwd ? { cwd } : {}),
    ...(instruction.warning ? { hint: instruction.warning } : {}),
  };
}

/**
 * Convert the server's closed attach instruction union into the argv-only
 * process spec accepted by the operations layer. The server controls only the
 * closed grammar and opaque arguments; executable paths come from the local,
 * canonical configuration and are never accepted from the socket response.
 */
export function attachSpecFromInstruction(
  instruction: AttachInstruction,
  executables: AttachExecutables,
): AttachSpec {
  switch (instruction.kind) {
    case "manager-cli":
      throw new Error("Manager CLI attach instructions are browser-only");
    case "tmux":
      return tmuxAttachSpec(instruction, executables);
    case "codex-remote": {
      const [rawExecutable, verb, threadId, remoteFlag, remote] = instruction.argv;
      if (instruction.argv.length !== 5 || verb !== "resume" || remoteFlag !== "--remote") {
        throw new Error("Unsupported Codex attach instruction");
      }
      assertCommandIdentity(rawExecutable, "codex");
      const remoteValue = assertSafeArgument(remote, "Codex remote socket");
      if (!remoteValue.startsWith("unix:///") || remoteValue.length <= "unix://".length) {
        throw new Error("Codex attach instruction must use an absolute Unix socket");
      }
      const cwd = optionalCwd(instruction.cwd);
      if (!cwd) throw new Error("Codex attach instruction is missing its working directory");
      return buildAttachSpec({
        kind: "codex",
        codexExecutable: executables.codex,
        threadId: assertProviderIdentifier(threadId, "Codex thread id"),
        socketPath: remoteValue.slice("unix://".length),
        cwd,
      });
    }
    case "claude-resume": {
      const [rawExecutable, resumeFlag, sessionId] = instruction.argv;
      if (instruction.argv.length !== 3 || resumeFlag !== "--resume") {
        throw new Error("Unsupported Claude attach instruction");
      }
      assertCommandIdentity(rawExecutable, "claude");
      const cwd = optionalCwd(instruction.cwd);
      if (!cwd) throw new Error("Claude attach instruction is missing its working directory");
      return buildAttachSpec({
        kind: "claude",
        claudeExecutable: executables.claude,
        sessionId: assertProviderIdentifier(sessionId, "Claude session id"),
        cwd,
        handoffReady: true,
      });
    }
  }
}

function timer(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const handle = setTimeout(() => resolve(null), ms);
    handle.unref();
  });
}

async function awaitExitWithin(
  exitPromise: Promise<ExitOutcome>,
  timeoutMs: number,
): Promise<ExitOutcome | null> {
  return await Promise.race([exitPromise, timer(timeoutMs)]);
}

async function terminateAndConfirm(
  child: ChildProcess,
  exitPromise: Promise<ExitOutcome>,
  getExit: () => ExitOutcome | null,
  terminationGraceMs: number,
  killGraceMs: number,
): Promise<ExitOutcome> {
  const alreadyExited = getExit();
  if (alreadyExited) return alreadyExited;

  child.kill("SIGTERM");
  const terminated = await awaitExitWithin(exitPromise, terminationGraceMs);
  if (terminated) return terminated;

  child.kill("SIGKILL");
  const killed = await awaitExitWithin(exitPromise, killGraceMs);
  if (killed) return killed;
  throw new Error("Attach process did not exit after SIGTERM and SIGKILL");
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

/**
 * Run a provider attach handoff and settle its owner callback exactly once.
 * A failed `started` acknowledgement never reclaims the handoff until the
 * native child is confirmed dead (bounded SIGTERM followed by SIGKILL).
 */
export async function executeLifecycleAttach(
  spec: AttachSpec,
  lifecycle: AttachLifecycle,
  options: LifecycleAttachOptions = {},
): Promise<number> {
  if (
    !isAbsolute(spec.executable)
    || spec.executable.includes("\0")
    || /[\r\n]/u.test(spec.executable)
  ) {
    throw new Error("Attach executable must be a pinned absolute path");
  }
  const terminationGraceMs = options.terminationGraceMs ?? 2_000;
  const killGraceMs = options.killGraceMs ?? 2_000;
  if (terminationGraceMs < 0 || killGraceMs < 0) {
    throw new Error("Attach termination timeouts must not be negative");
  }

  let failedReported = false;
  const reportFailure = async (error: unknown): Promise<void> => {
    if (failedReported) return;
    failedReported = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      await lifecycle.failed(message);
    } catch {
      // Preserve the primary failure. The caller still receives it and can
      // report that the owner callback was unavailable.
    }
  };
  const spawnProcess = options.spawnProcess ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnProcess(spec.executable, spec.args, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
  } catch (error) {
    await reportFailure(error);
    throw error;
  }
  let exitOutcome: ExitOutcome | null = null;
  const exitPromise = new Promise<ExitOutcome>((resolve) => {
    child.once("exit", (code, signal) => {
      exitOutcome = { code, signal };
      resolve(exitOutcome);
    });
  });

  try {
    await waitForSpawn(child);
  } catch (error) {
    await reportFailure(error);
    throw error;
  }

  const pid = child.pid;
  if (pid === undefined) {
    const error = new Error("Attach process started without a process id");
    try {
      await terminateAndConfirm(
        child,
        exitPromise,
        () => exitOutcome,
        terminationGraceMs,
        killGraceMs,
      );
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        "Attach process ownership could not be safely reclaimed",
      );
    }
    await reportFailure(error);
    throw error;
  }

  try {
    await lifecycle.started(pid);
  } catch (error) {
    try {
      await terminateAndConfirm(
        child,
        exitPromise,
        () => exitOutcome,
        terminationGraceMs,
        killGraceMs,
      );
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        "Attach process ownership could not be safely reclaimed",
      );
    }
    await reportFailure(error);
    throw error;
  }

  const outcome = await exitPromise;
  await lifecycle.exited(outcome.code);
  if (outcome.signal) {
    throw new Error(`Attach process terminated by ${outcome.signal}`);
  }
  return outcome.code ?? 1;
}
