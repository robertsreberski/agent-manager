import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { CodexManagedAdapter } from "./adapter.ts";
import type { MessageTransport } from "./rpc.ts";
import { isSupportedCodexVersion } from "./adapter.ts";
import { UnixWebSocketTransport } from "./unix-websocket.ts";

const execFileAsync = promisify(execFile);

export interface ManagedChildProcess {
  pid?: number | undefined;
  stderr?: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null | undefined;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(
    event: "error",
    listener: (error: Error) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexAppServerSupervisorOptions {
  runtimeDir: string;
  socketName?: string;
  codexExecutable?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  strictVersion?: boolean;
  env?: NodeJS.ProcessEnv;
  launch?: (
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ManagedChildProcess;
  connect?: (socketPath: string) => Promise<MessageTransport>;
  probeVersion?: (executable: string) => Promise<string | null>;
  now?: () => Date;
  onUnexpectedExit?: (event: CodexUnexpectedExit) => void;
}

export interface CodexUnexpectedExit {
  occurredAt: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  message: string;
  stderrTail: string;
  wasRunning: boolean;
}

export interface CodexSupervisorState {
  status: "stopped" | "starting" | "running" | "failed";
  pid: number | null;
  socketPath: string;
  stderrTail: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  lastUnexpectedExit: CodexUnexpectedExit | null;
}

function parseVersion(value: string): string | null {
  return value.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u)?.[1] ?? null;
}

export async function probeCodexVersion(executable: string): Promise<string | null> {
  const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  return parseVersion(`${stdout}\n${stderr}`);
}

function isInside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

function defaultLaunch(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ManagedChildProcess {
  return spawn(executable, [...args], {
    env,
    detached: false,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export class CodexAppServerSupervisor {
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly codexExecutable: string;

  #options: CodexAppServerSupervisorOptions;
  #child: ManagedChildProcess | null = null;
  #adapter: CodexManagedAdapter | null = null;
  #status: CodexSupervisorState["status"] = "stopped";
  #stderrTail = "";
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #lastUnexpectedExit: CodexUnexpectedExit | null = null;
  #stopping = false;
  #ownsSocket = false;
  #unexpectedExitListeners = new Set<(event: CodexUnexpectedExit) => void>();
  #reportedUnexpectedChildren = new WeakSet<object>();

  constructor(options: CodexAppServerSupervisorOptions) {
    if (!isAbsolute(options.runtimeDir)) {
      throw new Error("Codex runtime directory must be absolute");
    }
    const socketName = options.socketName ?? "codex-app-server.sock";
    if (socketName.includes("/") || socketName === "." || socketName === "..") {
      throw new Error("Codex socketName must be a plain filename");
    }
    this.runtimeDir = resolve(options.runtimeDir);
    this.socketPath = resolve(join(this.runtimeDir, socketName));
    if (!isInside(this.runtimeDir, this.socketPath)) {
      throw new Error("Codex socket must be inside its private runtime directory");
    }
    if (Buffer.byteLength(this.socketPath) > 100) {
      throw new Error("Codex Unix socket path is too long");
    }
    this.codexExecutable = options.codexExecutable ?? "codex";
    this.#options = options;
    if (options.onUnexpectedExit) {
      this.#unexpectedExitListeners.add(options.onUnexpectedExit);
    }
  }

  get adapter(): CodexManagedAdapter | null {
    return this.#adapter;
  }

  get state(): CodexSupervisorState {
    return {
      status: this.#status,
      pid: this.#child?.pid ?? null,
      socketPath: this.socketPath,
      stderrTail: this.#stderrTail,
      exitCode: this.#exitCode,
      exitSignal: this.#exitSignal,
      lastUnexpectedExit: this.#lastUnexpectedExit
        ? { ...this.#lastUnexpectedExit }
        : null,
    };
  }

  onUnexpectedExit(listener: (event: CodexUnexpectedExit) => void): () => void {
    this.#unexpectedExitListeners.add(listener);
    return () => this.#unexpectedExitListeners.delete(listener);
  }

  async start(): Promise<CodexManagedAdapter> {
    if (this.#adapter || this.#child) {
      throw new Error("Codex App Server supervisor has already started");
    }
    this.#status = "starting";
    this.#stopping = false;
    this.#lastUnexpectedExit = null;
    await this.#prepareRuntimeDirectory();
    if (await pathExists(this.socketPath)) {
      this.#status = "failed";
      throw new Error(
        `Refusing to connect to or replace an existing Codex socket: ${this.socketPath}`,
      );
    }

    const probe = this.#options.probeVersion ?? probeCodexVersion;
    const probedVersion = await probe(this.codexExecutable);
    if ((this.#options.strictVersion ?? true) && !isSupportedCodexVersion(probedVersion)) {
      this.#status = "failed";
      throw new Error(
        `Codex ${probedVersion ?? "unknown"} is unsupported; expected 0.146.x`,
      );
    }

    const launch = this.#options.launch ?? defaultLaunch;
    let child: ManagedChildProcess;
    try {
      child = launch(
        this.codexExecutable,
        ["app-server", "--listen", `unix://${this.socketPath}`],
        { ...process.env, ...this.#options.env },
      );
    } catch (error) {
      this.#status = "failed";
      throw error;
    }
    this.#ownsSocket = true;
    this.#child = child;
    child.stderr?.on("data", (chunk) => {
      this.#stderrTail = `${this.#stderrTail}${String(chunk)}`.slice(-16 * 1024);
    });
    child.once("error", (error) => {
      this.#stderrTail = `${this.#stderrTail}\n${error.message}`.slice(-16 * 1024);
      if (!this.#stopping) {
        this.#handleUnexpectedExit(child, null, null, error);
      }
    });
    child.on("exit", (code, signal) => {
      this.#exitCode = code;
      this.#exitSignal = signal;
      if (this.#child === child) this.#child = null;
      if (!this.#stopping) {
        this.#handleUnexpectedExit(child, code, signal);
      }
    });

    try {
      const transport = await this.#connectUntilReady();
      const adapter = new CodexManagedAdapter({
        transport,
        socketPath: this.socketPath,
        codexExecutable: this.codexExecutable,
      });
      const capabilities = await adapter.initialize();
      if ((this.#options.strictVersion ?? true) && !capabilities.compatible) {
        await adapter.dispose();
        throw new Error(capabilities.reason ?? "Codex App Server is incompatible");
      }
      if (!this.#child || this.#hasFailed()) {
        await adapter.dispose();
        throw new Error(
          this.#startupFailureMessage() ??
            "Codex App Server exited while the adapter was initializing",
        );
      }
      this.#adapter = adapter;
      this.#status = "running";
      return adapter;
    } catch (error) {
      this.#status = "failed";
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const adapter = this.#adapter;
    this.#adapter = null;
    if (adapter) await adapter.dispose().catch(() => undefined);

    const child = this.#child;
    if (child) {
      const exited = new Promise<void>((resolveExit) => {
        child.on("exit", () => resolveExit());
      });
      child.kill("SIGTERM");
      const timeoutMs = this.#options.stopTimeoutMs ?? 3_000;
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(timeoutMs).then(() => false),
      ]);
      if (!stopped && this.#child === child) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(1_000)]);
      }
    }

    if (this.#ownsSocket) {
      try {
        const socket = await lstat(this.socketPath);
        if (socket.isSocket()) await unlink(this.socketPath);
      } catch (error) {
        if (!isObject(error) || error.code !== "ENOENT") throw error;
      }
    }
    this.#ownsSocket = false;
    this.#child = null;
    this.#status = "stopped";
    this.#stopping = false;
  }

  async #prepareRuntimeDirectory(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.runtimeDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Codex runtime path is not a private directory");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Codex runtime directory is not owned by the current user");
    }
    await chmod(this.runtimeDir, 0o700);
  }

  #handleUnexpectedExit(
    child: ManagedChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    cause?: Error,
  ): void {
    if (this.#reportedUnexpectedChildren.has(child)) {
      if (this.#lastUnexpectedExit && (code !== null || signal !== null)) {
        this.#lastUnexpectedExit = {
          ...this.#lastUnexpectedExit,
          code,
          signal,
        };
      }
      return;
    }
    this.#reportedUnexpectedChildren.add(child);
    const wasRunning = this.#status === "running";
    // A spawned process may emit an operational error before its eventual
    // exit. Keep that child reachable so stop() can still terminate it. A
    // launch error has no PID and there is nothing left to kill.
    if (!cause || child.pid === undefined) {
      if (this.#child === child) this.#child = null;
    }
    this.#status = "failed";
    const exitDescription = signal
      ? `signal ${signal}`
      : code === null
      ? "an unknown exit status"
      : `exit code ${code}`;
    const detail = cause?.message ?? `Codex App Server exited with ${exitDescription}`;
    const stderr = this.#stderrTail.trim();
    const message = stderr && !detail.includes(stderr)
      ? `${detail}: ${stderr}`
      : detail;
    const event: CodexUnexpectedExit = {
      occurredAt: (this.#options.now ?? (() => new Date()))().toISOString(),
      code,
      signal,
      message,
      stderrTail: this.#stderrTail,
      wasRunning,
    };
    this.#lastUnexpectedExit = event;

    const adapter = this.#adapter;
    this.#adapter = null;
    if (adapter) {
      adapter.markRuntimeUnavailable(new Error(message));
      // Closing the RPC client rejects every in-flight action immediately.
      void adapter.dispose().catch(() => undefined);
    }

    for (const listener of this.#unexpectedExitListeners) {
      try {
        listener({ ...event });
      } catch {
        // A diagnostic consumer cannot compromise the supervisor boundary.
      }
    }
  }

  #hasFailed(): boolean {
    return this.#status === "failed";
  }

  #startupFailureMessage(): string | null {
    return this.#lastUnexpectedExit?.message ?? null;
  }

  async #connectUntilReady(): Promise<MessageTransport> {
    const connect = this.#options.connect ?? ((socketPath: string) =>
      UnixWebSocketTransport.connect({ socketPath })
    );
    const deadline = Date.now() + (this.#options.startTimeoutMs ?? 10_000);
    let latestError: unknown = null;
    while (Date.now() < deadline) {
      if (!this.#child || this.#hasFailed()) {
        throw new Error(
          this.#startupFailureMessage() ??
            `Codex App Server exited before accepting connections${this.#stderrTail ? `: ${this.#stderrTail.trim()}` : ""}`,
        );
      }
      try {
        return await connect(this.socketPath);
      } catch (error) {
        latestError = error;
        await delay(50);
      }
    }
    throw new Error(
      `Timed out starting Codex App Server: ${latestError instanceof Error ? latestError.message : String(latestError)}`,
    );
  }
}
