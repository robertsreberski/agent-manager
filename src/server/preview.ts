import { spawn } from "node:child_process";

import type { SessionTerminal } from "../core/types.ts";
import type {
  AttachInstruction,
  PaneCapture,
  PanePreviewAdapter,
} from "./contracts.ts";

export class PanePreviewError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PanePreviewError";
    this.code = code;
  }
}

export function tmuxSelector(terminal: SessionTerminal): string[] {
  if (terminal.socketPath) return ["-S", terminal.socketPath];
  if (terminal.socketName && terminal.socketName !== "default") {
    return ["-L", terminal.socketName];
  }
  return [];
}

export class TmuxPanePreviewAdapter implements PanePreviewAdapter {
  readonly executable: string;
  readonly timeoutMs: number;

  constructor(options: { executable?: string; timeoutMs?: number } = {}) {
    this.executable = options.executable ?? "tmux";
    this.timeoutMs = options.timeoutMs ?? 1_500;
  }

  capture(
    terminal: SessionTerminal,
    limits: { maxLines: number; maxBytes: number },
    signal: AbortSignal,
  ): Promise<PaneCapture> {
    const maxLines = Math.min(200, Math.max(1, Math.trunc(limits.maxLines)));
    const maxBytes = Math.min(65_536, Math.max(1_024, Math.trunc(limits.maxBytes)));
    const args = [
      ...tmuxSelector(terminal),
      "capture-pane",
      "-p",
      "-t",
      terminal.paneId,
      "-S",
      `-${maxLines}`,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      let retained = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let totalBytes = 0;
      let settled = false;

      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        operation();
      };
      const abort = (): void => {
        child.kill("SIGTERM");
        finish(() => reject(new PanePreviewError("PREVIEW_ABORTED", "pane preview was cancelled")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new PanePreviewError("PREVIEW_TIMEOUT", "tmux pane preview timed out")));
      }, this.timeoutMs);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        retained = Buffer.concat([retained, chunk]);
        if (retained.length > maxBytes) retained = retained.subarray(retained.length - maxBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > 4_096) stderr = stderr.subarray(stderr.length - 4_096);
      });
      child.once("error", (error) => {
        finish(() => reject(new PanePreviewError("TMUX_UNAVAILABLE", error.message)));
      });
      child.once("close", (code) => {
        finish(() => {
          if (code !== 0) {
            reject(new PanePreviewError(
              "TMUX_CAPTURE_FAILED",
              stderr.toString("utf8").trim() || `tmux exited with status ${code ?? "unknown"}`,
            ));
            return;
          }
          const content = retained.toString("utf8").replace(/\0/g, "");
          resolve({
            content,
            truncated: totalBytes > maxBytes,
            lineCount: content ? content.split("\n").length : 0,
            byteCount: Buffer.byteLength(content),
          });
        });
      });
    });
  }
}

export function tmuxAttachInstruction(terminal: SessionTerminal, cwd: string | null): AttachInstruction {
  return {
    kind: "tmux",
    argv: [
      "tmux",
      ...tmuxSelector(terminal),
      "attach-session",
      "-t",
      terminal.session,
    ],
    cwd,
    warning: `Attach opens tmux session ${terminal.session}; select pane ${terminal.paneId} if it is not already active.`,
  };
}

