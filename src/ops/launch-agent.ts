import { randomUUID } from "node:crypto";
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
  panicLockFile: string;
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
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>${xml(options.panicLockFile)}</key><false/>
    </dict>
  </dict>
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
