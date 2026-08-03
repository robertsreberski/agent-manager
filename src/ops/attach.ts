import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export type AttachTarget =
  | {
      kind: "tmux";
      socketPath: string;
      session: string;
      windowHint?: string;
      tmuxExecutable: string;
    }
  | {
      kind: "codex";
      threadId: string;
      socketPath: string;
      cwd: string;
      codexExecutable: string;
    }
  | {
      kind: "claude";
      sessionId: string;
      cwd: string;
      claudeExecutable: string;
      handoffReady: boolean;
    };

export interface AttachSpec {
  executable: string;
  args: string[];
  cwd?: string;
  hint?: string;
}

function assertOpaqueIdentifier(value: string, label: string): string {
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertProviderIdentifier(value: string, label: string): string {
  const identifier = assertOpaqueIdentifier(value, label);
  if (identifier.startsWith("-")) {
    throw new Error(`Invalid ${label}: leading hyphens are not allowed`);
  }
  return identifier;
}

function assertPinnedExecutable(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("Attach executable must be a pinned absolute path");
  }
  return value;
}

export function buildAttachSpec(target: AttachTarget): AttachSpec {
  switch (target.kind) {
    case "tmux":
      return {
        executable: assertPinnedExecutable(target.tmuxExecutable),
        args: [
          "-S",
          assertOpaqueIdentifier(target.socketPath, "tmux socket"),
          "attach-session",
          "-t",
          assertProviderIdentifier(target.session, "tmux session"),
        ],
        ...(target.windowHint ? { hint: `Select window ${target.windowHint} after attaching.` } : {}),
      };
    case "codex":
      return {
        executable: assertPinnedExecutable(target.codexExecutable),
        args: [
          "resume",
          assertProviderIdentifier(target.threadId, "Codex thread id"),
          "--remote",
          `unix://${assertOpaqueIdentifier(target.socketPath, "Codex socket")}`,
        ],
        cwd: target.cwd,
      };
    case "claude":
      if (!target.handoffReady) {
        throw new Error("Claude session has not been safely handed off from the manager");
      }
      return {
        executable: assertPinnedExecutable(target.claudeExecutable),
        args: ["--resume", assertProviderIdentifier(target.sessionId, "Claude session id")],
        cwd: target.cwd,
      };
  }
}

export async function executeAttach(spec: AttachSpec): Promise<number> {
  assertPinnedExecutable(spec.executable);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Attach process terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
