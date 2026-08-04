import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";

import { isSafeSshTarget } from "../ops/config.ts";
import type { NodeBridgeRequest, NodeBridgeResponse } from "./node-bridge.ts";

export class RemoteNodeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(
    message: string,
    status: number,
    code: string,
    body: unknown = null,
  ) {
    super(message);
    this.name = "RemoteNodeError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

interface PendingRequest {
  resolve: (response: NodeBridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function responseError(response: NodeBridgeResponse): RemoteNodeError {
  const envelope = response.body && typeof response.body === "object"
    ? response.body as Record<string, unknown>
    : {};
  const nested = envelope.error && typeof envelope.error === "object"
    ? envelope.error as Record<string, unknown>
    : envelope;
  return new RemoteNodeError(
    typeof nested.message === "string" ? nested.message : `Remote node request failed (${String(response.status)})`,
    response.status,
    typeof nested.code === "string" ? nested.code : "REMOTE_NODE_ERROR",
    response.body,
  );
}

export class SshNodeClient {
  readonly target: string;
  readonly sshExecutable: string;
  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: Interface | null = null;
  #ready: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  #pending = new Map<string, PendingRequest>();
  #stderr = "";

  constructor(options: { target: string; sshExecutable?: string }) {
    if (!isSafeSshTarget(options.target)) throw new Error("Invalid SSH target");
    this.target = options.target;
    this.sshExecutable = options.sshExecutable ?? "/usr/bin/ssh";
  }

  async request<T = unknown>(input: Omit<NodeBridgeRequest, "id">, timeoutMs = 20_000): Promise<T> {
    await this.#ensureReady();
    const child = this.#child;
    if (!child || child.killed || !child.stdin.writable) throw new Error("SSH node bridge is unavailable");
    const id = `rpc-${randomUUID()}`;
    const response = await new Promise<NodeBridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`SSH node request timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...input })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return response.body as T;
  }

  close(): void {
    const child = this.#child;
    this.#reset(new Error("SSH node bridge closed"));
    if (child && !child.killed) child.kill("SIGTERM");
  }

  async #ensureReady(): Promise<void> {
    if (!this.#child || this.#child.killed) this.#start();
    await this.#ready;
  }

  #start(): void {
    this.#stderr = "";
    const remoteCommand = "/bin/zsh -lc 'exec agent-manager node bridge'";
    const child = spawn(this.sshExecutable, [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      "--",
      this.target,
      remoteCommand,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines.on("line", (line) => this.#onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.once("error", (error) => this.#reset(error));
    child.once("exit", (code, signal) => {
      const detail = this.#stderr.trim();
      this.#reset(new Error(
        `SSH node bridge exited (${signal ?? String(code ?? "unknown")})${detail ? `: ${detail}` : ""}`,
      ));
    });
  }

  #onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "ready") {
      this.#resolveReady?.();
      this.#resolveReady = null;
      this.#rejectReady = null;
      return;
    }
    const response = value as Partial<NodeBridgeResponse>;
    if (typeof response.id !== "string" || typeof response.status !== "number") return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    pending.resolve(response as NodeBridgeResponse);
  }

  #reset(error: Error): void {
    this.#lines?.close();
    this.#lines = null;
    this.#rejectReady?.(error);
    this.#resolveReady = null;
    this.#rejectReady = null;
    this.#ready = null;
    this.#child = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
