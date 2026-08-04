import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";

import { isSafeSshTarget } from "../ops/config.ts";
import {
  parseNodeBridgeHello,
  parseNodeBridgeMessage,
  REMOTE_BRIDGE_MAX_LINE_BYTES,
  type NodeBridgeHello,
  type NodeBridgeResponse,
  type NodeBridgeRpcRequest,
  type NodeBridgeStreamFrame,
  type NodeBridgeStreamOpened,
} from "./protocol.ts";

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

interface PendingStream {
  opened: boolean;
  resolveOpen: () => void;
  rejectOpen: (error: Error) => void;
  timer: NodeJS.Timeout;
  onFrame: (frame: NodeBridgeStreamFrame) => void;
  onClose: (error: Error | null) => void;
}

export interface RemoteActivityStream {
  readonly remoteBuildId: string;
  close(): void;
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
  #streams = new Map<string, PendingStream>();
  #stderr = "";
  #hello: NodeBridgeHello | null = null;
  #readyTimer: NodeJS.Timeout | null = null;

  constructor(options: { target: string; sshExecutable?: string }) {
    if (!isSafeSshTarget(options.target)) throw new Error("Invalid SSH target");
    this.target = options.target;
    this.sshExecutable = options.sshExecutable ?? "/usr/bin/ssh";
  }

  async request<T = unknown>(
    input: Omit<NodeBridgeRpcRequest, "type" | "id">,
    timeoutMs = 20_000,
  ): Promise<T> {
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
      child.stdin.write(`${JSON.stringify({ type: "rpc", id, ...input })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return response.body as T;
  }

  async openActivityStream(options: {
    path: string;
    lastEventId?: string;
    onFrame: (frame: NodeBridgeStreamFrame) => void;
    onClose: (error: Error | null) => void;
    timeoutMs?: number;
  }): Promise<RemoteActivityStream> {
    await this.#ensureReady();
    const child = this.#child;
    const hello = this.#hello;
    if (!child || child.killed || !child.stdin.writable || !hello) {
      throw new Error("SSH node bridge is unavailable");
    }
    const id = `stream-${randomUUID()}`;
    const timeoutMs = options.timeoutMs ?? 20_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#streams.delete(id);
        const active = this.#child;
        if (active && !active.killed && active.stdin.writable) {
          active.stdin.write(`${JSON.stringify({ type: "stream.close", id })}\n`);
        }
        reject(new Error(`SSH activity stream timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      timer.unref();
      this.#streams.set(id, {
        opened: false,
        resolveOpen: resolve,
        rejectOpen: reject,
        timer,
        onFrame: options.onFrame,
        onClose: options.onClose,
      });
      const message = {
        type: "stream.open",
        id,
        path: options.path,
        ...(options.lastEventId ? { lastEventId: options.lastEventId } : {}),
      };
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        const stream = this.#streams.get(id);
        if (!stream) return;
        clearTimeout(stream.timer);
        this.#streams.delete(id);
        stream.rejectOpen(error);
      });
    });
    let closed = false;
    return {
      remoteBuildId: hello.buildId,
      close: () => {
        if (closed) return;
        closed = true;
        const stream = this.#streams.get(id);
        if (stream) {
          clearTimeout(stream.timer);
          this.#streams.delete(id);
        }
        const active = this.#child;
        if (active && !active.killed && active.stdin.writable) {
          active.stdin.write(`${JSON.stringify({ type: "stream.close", id })}\n`);
        }
      },
    };
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
    this.#readyTimer = setTimeout(() => {
      this.#reset(new Error("SSH node bridge handshake timed out"));
      if (!child.killed) child.kill("SIGTERM");
    }, 15_000);
    this.#readyTimer.unref();
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
    if (Buffer.byteLength(line, "utf8") > REMOTE_BRIDGE_MAX_LINE_BYTES) {
      const child = this.#child;
      this.#reset(new Error("SSH node bridge sent an oversized message"));
      child?.kill("SIGTERM");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      const child = this.#child;
      this.#reset(new Error("SSH node bridge sent invalid JSON"));
      child?.kill("SIGTERM");
      return;
    }
    if (!this.#hello) {
      try {
        this.#hello = parseNodeBridgeHello(value);
      } catch (error) {
        const child = this.#child;
        this.#reset(error instanceof Error ? error : new Error("Remote node protocol mismatch"));
        child?.kill("SIGTERM");
        return;
      }
      if (this.#readyTimer) clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
      const ready = this.#resolveReady;
      this.#resolveReady = null;
      this.#rejectReady = null;
      ready?.();
      return;
    }
    const message = parseNodeBridgeMessage(value);
    if (!message || message.type === "hello") {
      const child = this.#child;
      this.#reset(new Error("SSH node bridge sent an invalid message"));
      child?.kill("SIGTERM");
      return;
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    const stream = this.#streams.get(message.id);
    if (!stream) return;
    if (message.type === "stream.opened") {
      this.#onStreamOpened(message, stream);
      return;
    }
    if (message.type === "stream.frame") {
      if (!stream.opened) {
        this.#failStream(message.id, new Error("Remote activity frame arrived before stream acknowledgement"));
        return;
      }
      try {
        stream.onFrame(message);
      } catch (error) {
        this.#failStream(
          message.id,
          error instanceof Error ? error : new Error("Remote activity frame was rejected"),
        );
      }
      return;
    }
    const error = message.reason === "error"
      ? new Error(message.message ?? "Remote activity stream failed")
      : null;
    clearTimeout(stream.timer);
    this.#streams.delete(message.id);
    if (!stream.opened) {
      stream.rejectOpen(error ?? new Error("Remote activity stream closed before opening"));
    } else {
      stream.onClose(error);
    }
  }

  #onStreamOpened(message: NodeBridgeStreamOpened, stream: PendingStream): void {
    clearTimeout(stream.timer);
    if (message.status < 200 || message.status >= 300) {
      this.#streams.delete(message.id);
      stream.rejectOpen(responseError({
        type: "response",
        id: message.id,
        status: message.status,
        body: message.body,
      }));
      return;
    }
    stream.opened = true;
    stream.resolveOpen();
  }

  #failStream(id: string, error: Error): void {
    const stream = this.#streams.get(id);
    if (!stream) return;
    clearTimeout(stream.timer);
    this.#streams.delete(id);
    if (!stream.opened) stream.rejectOpen(error);
    else stream.onClose(error);
    const child = this.#child;
    if (child && !child.killed && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ type: "stream.close", id })}\n`);
    }
  }

  #reset(error: Error): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#lines?.close();
    this.#lines = null;
    this.#rejectReady?.(error);
    this.#resolveReady = null;
    this.#rejectReady = null;
    this.#ready = null;
    this.#hello = null;
    this.#child = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const stream of this.#streams.values()) {
      clearTimeout(stream.timer);
      if (!stream.opened) stream.rejectOpen(error);
      else stream.onClose(error);
    }
    this.#streams.clear();
  }
}
