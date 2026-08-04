import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  buildControlledServicePath,
  type ServiceExecutables,
} from "./executables.ts";

export const LAUNCH_AGENT_LABEL = "local.agent-manager.cockpit";
const CLEAN_ENV_EXECUTABLE = "/usr/bin/env";
const LAUNCHCTL_EXECUTABLE = "/bin/launchctl";
// launchd can keep the exact job record around briefly after bootout while the
// process is already exiting. Five seconds is still a tight personal-tool
// bound, but avoids turning an ordinary macOS handoff into a failed deploy.
const JOB_DISAPPEARANCE_CHECKS = 101;
const JOB_DISAPPEARANCE_POLL_MS = 50;
const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_MS = 100;
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface LaunchctlCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface LaunchctlRunner {
  run(args: readonly string[]): LaunchctlCommandResult;
}

export interface ReloadLaunchAgentDependencies {
  runner?: LaunchctlRunner;
  sleep?: (milliseconds: number) => void;
}

const defaultLaunchctlRunner: LaunchctlRunner = {
  run(args) {
    const result = spawnSync(LAUNCHCTL_EXECUTABLE, args, {
      encoding: "utf8",
      shell: false,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  },
};

function sleep(milliseconds: number): void {
  Atomics.wait(sleepCell, 0, 0, milliseconds);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface LaunchAgentOptions {
  executables: ServiceExecutables;
  cliEntrypoint: string;
  homeDirectory: string;
  label?: string;
  backendPort?: number;
  /** Test/preview override; the installed service normally uses the OS account name. */
  userName?: string;
  /** Test/preview override; the installed service normally uses the OS login shell. */
  shell?: string;
  /** Test/preview override; the installed service normally uses the per-user temp directory. */
  temporaryDirectory?: string;
  /** Optional stable SSH agent socket; ambient per-login socket paths are never captured. */
  sshAuthSocket?: string | null;
}

function environmentValue(name: string, value: string, absolute = false): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`LaunchAgent ${name} must be non-empty and contain no control characters`);
  }
  if (absolute && !isAbsolute(value)) {
    throw new Error(`LaunchAgent ${name} must be an absolute path`);
  }
  return `${name}=${value}`;
}

function launchAgentProgramArguments(options: LaunchAgentOptions): string[] {
  const account = userInfo();
  const servicePath = buildControlledServicePath(options.executables);
  const sshAuthSocket = options.sshAuthSocket ?? undefined;
  return [
    CLEAN_ENV_EXECUTABLE,
    "-i",
    environmentValue("HOME", options.homeDirectory, true),
    environmentValue("USER", options.userName ?? account.username),
    environmentValue("LOGNAME", options.userName ?? account.username),
    environmentValue("TMPDIR", options.temporaryDirectory ?? tmpdir(), true),
    environmentValue("SHELL", options.shell ?? account.shell ?? "/bin/zsh", true),
    ...(sshAuthSocket
      ? [environmentValue("SSH_AUTH_SOCK", sshAuthSocket, true)]
      : []),
    environmentValue("PATH", servicePath),
    environmentValue("AGENT_MANAGER_CODEX_EXECUTABLE", options.executables.codex, true),
    environmentValue("AGENT_MANAGER_CLAUDE_EXECUTABLE", options.executables.claude, true),
    environmentValue("AGENT_MANAGER_TMUX_EXECUTABLE", options.executables.tmux, true),
    environmentValue("AGENT_MANAGER_TAILSCALE_EXECUTABLE", options.executables.tailscale, true),
    options.executables.node,
    options.cliEntrypoint,
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(options.backendPort ?? 43_127),
  ];
}

export function renderLaunchAgent(options: LaunchAgentOptions): string {
  const label = options.label ?? LAUNCH_AGENT_LABEL;
  const logDirectory = join(options.homeDirectory, "Library", "Logs", "agent-manager");
  const programArguments = launchAgentProgramArguments(options);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(join(logDirectory, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDirectory, "stderr.log"))}</string>
</dict>
</plist>
`;
}

export function installLaunchAgentFile(options: LaunchAgentOptions): string {
  const label = options.label ?? LAUNCH_AGENT_LABEL;
  const destination = join(
    options.homeDirectory,
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(join(options.homeDirectory, "Library", "Logs", "agent-manager"), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, renderLaunchAgent(options), { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original installation error.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The file may not have been created or may already have been renamed.
    }
    throw error;
  }
  return destination;
}

function commandSucceeded(result: LaunchctlCommandResult): boolean {
  return !result.error && result.status === 0;
}

function commandFailure(result: LaunchctlCommandResult): string {
  if (result.error) return result.error.message;
  return result.stderr.trim()
    || result.stdout.trim()
    || `status ${String(result.status)}`;
}

function isAbsentBootout(result: LaunchctlCommandResult): boolean {
  return !result.error
    && result.status === 3
    && /^Boot-out failed: 3: No such process\s*$/u.test(
      `${result.stderr}\n${result.stdout}`.trim(),
    );
}

function isAbsentPrint(
  result: LaunchctlCommandResult,
  label: string,
  uid: number,
): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return !result.error
    && result.status === 113
    && output.includes(
      `Could not find service "${label}" in domain for user gui: ${uid}`,
    );
}

function isTransientBootstrapFailure(result: LaunchctlCommandResult): boolean {
  return !result.error
    && result.status === 5
    && /^Bootstrap failed: 5: Input\/output error(?:\r?\n|$)/u.test(result.stderr);
}

function probeJob(
  runner: LaunchctlRunner,
  target: string,
  label: string,
  uid: number,
): "present" | "absent" {
  const result = runner.run(["print", target]);
  if (commandSucceeded(result)) return "present";
  if (isAbsentPrint(result, label, uid)) return "absent";
  throw new Error(`launchctl print failed: ${commandFailure(result)}`);
}

function waitForJobToDisappear(
  runner: LaunchctlRunner,
  pause: (milliseconds: number) => void,
  target: string,
  label: string,
  uid: number,
): void {
  for (let check = 0; check < JOB_DISAPPEARANCE_CHECKS; check += 1) {
    if (probeJob(runner, target, label, uid) === "absent") return;
    if (check + 1 < JOB_DISAPPEARANCE_CHECKS) {
      pause(JOB_DISAPPEARANCE_POLL_MS);
    }
  }
  throw new Error(
    `launchctl bootout did not remove ${target} within ${String(
      (JOB_DISAPPEARANCE_CHECKS - 1) * JOB_DISAPPEARANCE_POLL_MS,
    )}ms`,
  );
}

function bootstrapLaunchAgent(
  runner: LaunchctlRunner,
  pause: (milliseconds: number) => void,
  domain: string,
  target: string,
  destination: string,
  label: string,
  uid: number,
): void {
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt += 1) {
    const result = runner.run(["bootstrap", domain, destination]);
    if (commandSucceeded(result)) return;
    if (!isTransientBootstrapFailure(result)) {
      throw new Error(`launchctl bootstrap failed: ${commandFailure(result)}`);
    }

    // launchctl can return error 5 even though it registered the job. The exact
    // print target distinguishes that outcome from the short bootout race.
    if (probeJob(runner, target, label, uid) === "present") return;
    if (attempt === BOOTSTRAP_ATTEMPTS) {
      throw new Error(
        `launchctl bootstrap failed after ${String(BOOTSTRAP_ATTEMPTS)} attempts: ${commandFailure(result)}`,
      );
    }
    pause(BOOTSTRAP_RETRY_MS);
  }
}

function stopLaunchAgentJob(
  runner: LaunchctlRunner,
  pause: (milliseconds: number) => void,
  label: string,
  uid: number,
): void {
  const target = `gui/${uid}/${label}`;
  const bootout = runner.run(["bootout", target]);
  if (!commandSucceeded(bootout) && !isAbsentBootout(bootout)) {
    throw new Error(`launchctl bootout failed: ${commandFailure(bootout)}`);
  }
  waitForJobToDisappear(runner, pause, target, label, uid);
}

/** Stop only the exact per-user Agent Manager LaunchAgent; absence is success. */
export function stopLaunchAgent(
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  dependencies: ReloadLaunchAgentDependencies = {},
): void {
  if (uid === null) throw new Error("Stopping Agent Manager requires a macOS user id");
  stopLaunchAgentJob(
    dependencies.runner ?? defaultLaunchctlRunner,
    dependencies.sleep ?? sleep,
    LAUNCH_AGENT_LABEL,
    uid,
  );
}

/** Reload the one per-user service installed by this personal tool. */
export function reloadLaunchAgent(
  destination: string,
  label = LAUNCH_AGENT_LABEL,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  dependencies: ReloadLaunchAgentDependencies = {},
): void {
  if (uid === null) throw new Error("Reloading Agent Manager requires a macOS user id");
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const runner = dependencies.runner ?? defaultLaunchctlRunner;
  const pause = dependencies.sleep ?? sleep;

  // An absent previous job is the normal first-install case.
  stopLaunchAgentJob(runner, pause, label, uid);

  bootstrapLaunchAgent(runner, pause, domain, target, destination, label, uid);

  const kickstart = runner.run(["kickstart", "-k", target]);
  if (!commandSucceeded(kickstart)) {
    throw new Error(`launchctl kickstart failed: ${commandFailure(kickstart)}`);
  }
}
