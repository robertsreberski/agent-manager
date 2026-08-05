import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { CodexManagedAdapter } from "./adapter.ts";
import type { MessageTransport } from "./rpc.ts";
import { isSupportedCodexVersion } from "./adapter.ts";
import { UnixWebSocketTransport } from "./unix-websocket.ts";
import { probeCodexVersion } from "./version.ts";

export { probeCodexVersion } from "./version.ts";

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
  inspectLiveListener?: (socketPath: string) => Promise<CodexLiveListener | null>;
  probeVersion?: (executable: string) => Promise<string | null>;
  now?: () => Date;
  /** Maximum automatic restart attempts after a previously-running child exits. */
  restartMaxAttempts?: number;
  /** Delay before the first restart; later attempts use bounded exponential backoff. */
  restartInitialDelayMs?: number;
  restartMaxDelayMs?: number;
  onUnexpectedExit?: (event: CodexUnexpectedExit) => void;
  onRecovered?: (
    adapter: CodexManagedAdapter,
    attempt: number,
  ) => CodexRecoveryPublication | void | Promise<CodexRecoveryPublication | void>;
  onRecoveryFailed?: (event: CodexRecoveryFailure) => void;
}

export interface CodexLiveListener {
  pid: number;
  command: string;
}

export interface CodexUnexpectedExit {
  occurredAt: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  message: string;
  stderrTail: string;
  wasRunning: boolean;
}

export interface CodexRecoveryFailure {
  occurredAt: string;
  attempts: number;
  message: string;
  lastError: string;
}

/** A bridge or other consumer prepared for atomic recovered-adapter publication. */
export interface CodexRecoveryPublication {
  /** Synchronous and non-blocking: the supervisor adapter is already live. */
  commit(): void;
  /** Synchronous best-effort cleanup when preparation or commit is rejected. */
  rollback(): void;
}

export interface CodexSupervisorState {
  status: "stopped" | "starting" | "running" | "recovering" | "failed";
  pid: number | null;
  socketPath: string;
  stderrTail: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  lastUnexpectedExit: CodexUnexpectedExit | null;
  restartAttempt: number;
  nextRestartAt: string | null;
  terminalFailure: CodexRecoveryFailure | null;
}

function isInside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): string | null {
  return isObject(error) && typeof error.code === "string" ? error.code : null;
}

function abortError(): Error {
  return new DOMException("Codex App Server operation was cancelled", "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectDelay(signal?.reason ?? abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void promise.then((value) => onLateValue?.(value), () => undefined);
    return Promise.reject(signal.reason ?? abortError());
  }
  return new Promise<T>((resolveValue, rejectValue) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      rejectValue(signal.reason ?? abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      if (settled) {
        onLateValue?.(value);
        return;
      }
      settled = true;
      resolveValue(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      rejectValue(error);
    });
  });
}

type UnixSocketProbe = "live" | "dead" | "missing";

const execFileAsync = promisify(execFile);

async function inspectCodexListener(socketPath: string): Promise<CodexLiveListener | null> {
  let lsofOutput: string;
  try {
    ({ stdout: lsofOutput } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-U", "-Fpcn", "--", socketPath],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    ));
  } catch {
    return null;
  }
  const lines = lsofOutput.split(/\r?\n/u);
  const pid = Number(lines.find((line) => /^p\d+$/u.test(line))?.slice(1));
  const commandName = lines.find((line) => line.startsWith("c"))?.slice(1) ?? "";
  if (!Number.isSafeInteger(pid) || pid <= 0 || commandName !== "codex") return null;

  let processOutput: string;
  try {
    ({ stdout: processOutput } = await execFileAsync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "uid=", "-o", "command="],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    ));
  } catch {
    return null;
  }
  const match = processOutput.trim().match(/^(\d+)\s+([\s\S]+)$/u);
  if (!match) return null;
  const uid = Number(match[1]);
  const command = match[2]!.trim();
  if (typeof process.getuid === "function" && uid !== process.getuid()) return null;
  const escapedSocket = `unix://${socketPath}`;
  const executable = command.split(/\s+/u, 1)[0] ?? "";
  if (
    !(executable === "codex" || executable.endsWith("/codex"))
    || !command.includes(" app-server ")
    || !command.includes(` --listen ${escapedSocket}`)
  ) return null;
  return { pid, command };
}

/**
 * Probe the exact Unix-domain socket directly. A successful connection is
 * authoritative evidence of a live listener. Only ECONNREFUSED proves that a
 * still-present socket inode is stale; every other error is deliberately
 * treated as inconclusive so cleanup fails closed.
 */
function probeUnixSocket(
  socketPath: string,
  signal?: AbortSignal,
): Promise<UnixSocketProbe> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ path: socketPath });
    socket.unref();
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() => rejectProbe(
        new Error(`Could not prove the Codex socket is inactive: ${socketPath}`),
      ));
    }, 500);
    timeout.unref?.();

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.destroy();
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = (): void => {
      finish(() => rejectProbe(signal?.reason ?? abortError()));
    };
    const onConnect = (): void => {
      finish(() => resolveProbe("live"));
    };
    const onError = (error: Error): void => {
      const code = errorCode(error);
      if (code === "ECONNREFUSED") {
        finish(() => resolveProbe("dead"));
        return;
      }
      if (code === "ENOENT") {
        finish(() => resolveProbe("missing"));
        return;
      }
      finish(() => rejectProbe(
        new Error(
          `Could not safely inspect the Codex socket ${socketPath}: ${error.message}`,
        ),
      ));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", onConnect);
    socket.once("error", onError);
    if (signal?.aborted) onAbort();
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
  #restartAttempt = 0;
  #nextRestartAt: string | null = null;
  #terminalFailure: CodexRecoveryFailure | null = null;
  #stopping = false;
  #ownsSocket = false;
  #adoptedListener = false;
  #adoptedPid: number | null = null;
  #removeAdoptedCloseListener: (() => void) | null = null;
  #attemptAbort: AbortController | null = null;
  #startTask: Promise<CodexManagedAdapter> | null = null;
  #recoveryTask: Promise<void> | null = null;
  #recoveryRequested = false;
  #stopTask: Promise<void> | null = null;
  #initializingAdapter: CodexManagedAdapter | null = null;
  #unexpectedExitListeners = new Set<(event: CodexUnexpectedExit) => void>();
  #recoveredListeners = new Set<(
    adapter: CodexManagedAdapter,
    attempt: number,
  ) => CodexRecoveryPublication | void | Promise<CodexRecoveryPublication | void>>();
  #recoveryFailedListeners = new Set<(event: CodexRecoveryFailure) => void>();
  #reportedUnexpectedChildren = new WeakSet<object>();
  #expectedExitChildren = new WeakSet<object>();

  constructor(options: CodexAppServerSupervisorOptions) {
    if (!isAbsolute(options.runtimeDir)) {
      throw new Error("Codex runtime directory must be absolute");
    }
    const socketName = options.socketName ?? "codex-private.sock";
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
    const restartMaxAttempts = options.restartMaxAttempts ?? 5;
    const restartInitialDelayMs = options.restartInitialDelayMs ?? 250;
    const restartMaxDelayMs = options.restartMaxDelayMs ?? 10_000;
    if (!Number.isInteger(restartMaxAttempts) || restartMaxAttempts < 1 ||
        restartMaxAttempts > 20) {
      throw new Error("Codex restartMaxAttempts must be an integer from 1 to 20");
    }
    if (!Number.isInteger(restartInitialDelayMs) || restartInitialDelayMs < 0 ||
        restartInitialDelayMs > 60_000) {
      throw new Error("Codex restartInitialDelayMs must be an integer from 0 to 60000");
    }
    if (!Number.isInteger(restartMaxDelayMs) || restartMaxDelayMs < restartInitialDelayMs ||
        restartMaxDelayMs > 300_000) {
      throw new Error(
        "Codex restartMaxDelayMs must be an integer no smaller than the initial delay and at most 300000",
      );
    }
    this.codexExecutable = options.codexExecutable ?? "codex";
    this.#options = options;
    if (options.onUnexpectedExit) {
      this.#unexpectedExitListeners.add(options.onUnexpectedExit);
    }
    if (options.onRecovered) this.#recoveredListeners.add(options.onRecovered);
    if (options.onRecoveryFailed) {
      this.#recoveryFailedListeners.add(options.onRecoveryFailed);
    }
  }

  get adapter(): CodexManagedAdapter | null {
    return this.#adapter;
  }

  get state(): CodexSupervisorState {
    return {
      status: this.#status,
      pid: this.#child?.pid ?? this.#adoptedPid,
      socketPath: this.socketPath,
      stderrTail: this.#stderrTail,
      exitCode: this.#exitCode,
      exitSignal: this.#exitSignal,
      lastUnexpectedExit: this.#lastUnexpectedExit
        ? { ...this.#lastUnexpectedExit }
        : null,
      restartAttempt: this.#restartAttempt,
      nextRestartAt: this.#nextRestartAt,
      terminalFailure: this.#terminalFailure ? { ...this.#terminalFailure } : null,
    };
  }

  onUnexpectedExit(listener: (event: CodexUnexpectedExit) => void): () => void {
    this.#unexpectedExitListeners.add(listener);
    return () => this.#unexpectedExitListeners.delete(listener);
  }

  onRecovered(
    listener: (
      adapter: CodexManagedAdapter,
      attempt: number,
    ) => CodexRecoveryPublication | void | Promise<CodexRecoveryPublication | void>,
  ): () => void {
    this.#recoveredListeners.add(listener);
    return () => this.#recoveredListeners.delete(listener);
  }

  onRecoveryFailed(listener: (event: CodexRecoveryFailure) => void): () => void {
    this.#recoveryFailedListeners.add(listener);
    return () => this.#recoveryFailedListeners.delete(listener);
  }

  async start(): Promise<CodexManagedAdapter> {
    if (this.#adapter || this.#child || this.#startTask || this.#recoveryTask ||
        this.#status === "starting") {
      throw new Error("Codex App Server supervisor has already started");
    }
    const task = this.#start();
    this.#startTask = task;
    try {
      return await task;
    } finally {
      if (this.#startTask === task) this.#startTask = null;
    }
  }

  /**
   * Return the live adapter, wait for the one recovery already in flight, or
   * start a fresh bounded series after terminal startup/recovery failure.
   * Manual session recovery uses this so it cannot race a second App Server
   * into the supervisor's private socket.
   */
  async ensureRunning(): Promise<CodexManagedAdapter> {
    if (this.#adapter) return this.#adapter;
    if (this.#startTask) return await this.#startTask;
    const recoveryTask = this.#recoveryTask;
    if (recoveryTask) {
      await recoveryTask;
      if (this.#adapter) return this.#adapter;
      if (this.#startTask) return await this.#startTask;
    }
    return await this.start();
  }

  async #start(): Promise<CodexManagedAdapter> {
    this.#status = "starting";
    this.#stopping = false;
    this.#lastUnexpectedExit = null;
    this.#restartAttempt = 0;
    this.#recoveryRequested = false;
    this.#nextRestartAt = null;
    this.#terminalFailure = null;
    this.#stderrTail = "";
    this.#exitCode = null;
    this.#exitSignal = null;
    const controller = new AbortController();
    this.#attemptAbort = controller;
    let coldRecoveryTask: Promise<void> | null = null;
    try {
      try {
        const adapter = await this.#launchInitialized(controller.signal);
        controller.signal.throwIfAborted();
        if (this.#initializingAdapter !== adapter || (!this.#child && !this.#adoptedListener)) {
          throw new Error("Codex App Server exited before startup publication");
        }
        this.#initializingAdapter = null;
        this.#adapter = adapter;
        this.#status = "running";
        return adapter;
      } catch (initialError) {
        await this.#cleanupFailedAttempt().catch(() => undefined);
        controller.signal.throwIfAborted();
        if (this.#stopping) throw abortError();

        this.#status = "recovering";
        let recovered: CodexManagedAdapter | null = null;
        const recovery = this.#recover(
          controller.signal,
          false,
          errorMessage(initialError),
        ).then((adapter) => {
          recovered = adapter;
        });
        coldRecoveryTask = recovery;
        this.#recoveryTask = recovery;
        await recovery;
        if (recovered) return recovered;
        controller.signal.throwIfAborted();
        const terminalFailure = this.state.terminalFailure;
        throw new Error(
          terminalFailure?.message ??
            `Codex App Server startup failed: ${errorMessage(initialError)}`,
          { cause: initialError },
        );
      }
    } finally {
      if (coldRecoveryTask && this.#recoveryTask === coldRecoveryTask) {
        this.#recoveryTask = null;
      }
      if (this.#attemptAbort === controller) this.#attemptAbort = null;
      if (this.#recoveryRequested && !this.#stopping && this.#status === "recovering") {
        this.#recoveryRequested = false;
        this.#scheduleRecovery();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#stopTask) return this.#stopTask;
    const task = this.#stop();
    this.#stopTask = task;
    try {
      await task;
    } finally {
      if (this.#stopTask === task) this.#stopTask = null;
    }
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    this.#recoveryRequested = false;
    this.#nextRestartAt = null;
    this.#attemptAbort?.abort(abortError());
    let stopFailure: unknown = null;
    try {
      const startTask = this.#startTask;
      if (startTask) await startTask.catch(() => undefined);
      const recoveryTask = this.#recoveryTask;
      const initializingAdapter = this.#initializingAdapter;
      this.#initializingAdapter = null;
      if (initializingAdapter) {
        await initializingAdapter.dispose().catch(() => undefined);
      }
      if (recoveryTask) await recoveryTask.catch(() => undefined);

      const adapter = this.#adapter;
      this.#adapter = null;
      this.#removeAdoptedCloseListener?.();
      this.#removeAdoptedCloseListener = null;
      this.#adoptedListener = false;
      this.#adoptedPid = null;
      if (adapter) await adapter.dispose().catch(() => undefined);
      await this.#terminateChild(this.#child);
      await this.#removeOwnedSocket();
    } catch (error) {
      stopFailure = error;
    } finally {
      this.#status = stopFailure === null ? "stopped" : "failed";
      this.#restartAttempt = 0;
      this.#nextRestartAt = null;
      this.#stopping = false;
    }
    if (stopFailure !== null) throw stopFailure;
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

  async #launchInitialized(signal: AbortSignal): Promise<CodexManagedAdapter> {
    await this.#prepareRuntimeDirectory();
    signal.throwIfAborted();
    const liveSocket = await this.#liveSocketInfo(signal);
    if (!liveSocket) await this.#reclaimStaleSocket(signal);
    signal.throwIfAborted();

    const probe = this.#options.probeVersion ?? probeCodexVersion;
    const probedVersion = await withAbort(probe(this.codexExecutable), signal);
    if ((this.#options.strictVersion ?? true) && !isSupportedCodexVersion(probedVersion)) {
      throw new Error(
        `Codex ${probedVersion ?? "unknown"} is unsupported; expected 0.146.x`,
      );
    }
    signal.throwIfAborted();

    if (liveSocket) {
      this.#ownsSocket = false;
      const inspect = this.#options.inspectLiveListener ?? inspectCodexListener;
      const listener = await withAbort(inspect(this.socketPath), signal);
      if (!listener) {
        throw new Error(
          `Refusing to connect to or replace an existing Codex socket with a live listener: ${this.socketPath}; the listener process is not the expected same-user Codex App Server`,
        );
      }
      const connect = this.#options.connect ?? ((socketPath: string) =>
        UnixWebSocketTransport.connect({ socketPath })
      );
      let transport: MessageTransport;
      try {
        transport = await withAbort(
          connect(this.socketPath),
          signal,
          (lateTransport) => void lateTransport.close().catch(() => undefined),
        );
      } catch (error) {
        throw new Error(
          `Refusing to connect to or replace an existing Codex socket with a live listener: ${this.socketPath}; the listener did not accept the Codex App Server transport: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      const adapter = await this.#initializeTransport(transport, signal);
      this.#adoptedListener = true;
      this.#adoptedPid = listener.pid;
      this.#observeAdoptedAdapter(adapter);
      return adapter;
    }

    this.#stderrTail = "";
    this.#exitCode = null;
    this.#exitSignal = null;
    const launch = this.#options.launch ?? defaultLaunch;
    const child = launch(
      this.codexExecutable,
      ["app-server", "--listen", `unix://${this.socketPath}`],
      { ...process.env, ...this.#options.env },
    );
    this.#ownsSocket = true;
    this.#child = child;
    this.#observeChild(child);

    const transport = await this.#connectUntilReady(child, signal);
    signal.throwIfAborted();
    const adapter = await this.#initializeTransport(transport, signal);
    if (this.#child !== child || this.#reportedUnexpectedChildren.has(child)) {
      throw new Error(
        this.#startupFailureMessage() ??
          "Codex App Server exited while the adapter was initializing",
      );
    }
    return adapter;
  }

  async #initializeTransport(
    transport: MessageTransport,
    signal: AbortSignal,
  ): Promise<CodexManagedAdapter> {
    const adapter = new CodexManagedAdapter({
      transport,
      socketPath: this.socketPath,
      codexExecutable: this.codexExecutable,
    });
    this.#initializingAdapter = adapter;
    const capabilities = await adapter.initialize();
    signal.throwIfAborted();
    if ((this.#options.strictVersion ?? true) && !capabilities.compatible) {
      throw new Error(capabilities.reason ?? "Codex App Server is incompatible");
    }
    return adapter;
  }

  #observeAdoptedAdapter(adapter: CodexManagedAdapter): void {
    this.#removeAdoptedCloseListener?.();
    this.#removeAdoptedCloseListener = adapter.rpc.onClose((error) => {
      if (this.#stopping || (!this.#adoptedListener && this.#adapter !== adapter)) return;
      this.#adoptedListener = false;
      this.#adoptedPid = null;
      this.#removeAdoptedCloseListener?.();
      this.#removeAdoptedCloseListener = null;
      const message = error?.message || "Codex App Server connection closed";
      const wasRunning = this.#status === "running";
      if (this.#adapter === adapter) this.#adapter = null;
      if (this.#initializingAdapter === adapter) this.#initializingAdapter = null;
      this.#status = wasRunning || this.#recoveryTask ? "recovering" : "failed";
      const event: CodexUnexpectedExit = {
        occurredAt: this.#now().toISOString(),
        code: null,
        signal: null,
        message,
        stderrTail: this.#stderrTail,
        wasRunning,
      };
      this.#lastUnexpectedExit = event;
      for (const listener of this.#unexpectedExitListeners) {
        try {
          listener({ ...event });
        } catch {
          // A diagnostic consumer cannot compromise listener recovery.
        }
      }
      adapter.markRuntimeUnavailable(new Error(message));
      void adapter.dispose().catch(() => undefined);
      if (wasRunning) this.#scheduleRecovery();
    });
  }

  #observeChild(child: ManagedChildProcess): void {
    child.stderr?.on("data", (chunk) => {
      this.#stderrTail = `${this.#stderrTail}${String(chunk)}`.slice(-16 * 1024);
    });
    child.once("error", (error) => {
      this.#stderrTail = `${this.#stderrTail}\n${error.message}`.slice(-16 * 1024);
      if (!this.#stopping && !this.#expectedExitChildren.has(child)) {
        this.#handleUnexpectedExit(child, null, null, error);
      }
    });
    child.on("exit", (code, signal) => {
      this.#exitCode = code;
      this.#exitSignal = signal;
      if (this.#child === child) this.#child = null;
      if (!this.#stopping && !this.#expectedExitChildren.has(child)) {
        this.#handleUnexpectedExit(child, code, signal);
      }
    });
  }

  #validateSocketForCleanup(
    socket: Awaited<ReturnType<typeof lstat>>,
  ): void {
    if (!socket.isSocket() || socket.isSymbolicLink()) {
      throw new Error(
        `Refusing to remove a non-socket Codex runtime path: ${this.socketPath}`,
      );
    }
    if (typeof process.getuid === "function" && socket.uid !== process.getuid()) {
      throw new Error("Refusing to remove a Codex socket owned by another user");
    }
  }

  async #socketInfo(): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    try {
      return await lstat(this.socketPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async #liveSocketInfo(signal?: AbortSignal): Promise<boolean> {
    const original = await this.#socketInfo();
    if (!original) return false;
    this.#validateSocketForCleanup(original);
    if (await probeUnixSocket(this.socketPath, signal) !== "live") return false;

    // Do not adopt a listener that swapped the pathname while it was probed.
    const current = await this.#socketInfo();
    if (!current) return false;
    this.#validateSocketForCleanup(current);
    if (current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error(
        `Refusing to connect to a Codex socket that changed during validation: ${this.socketPath}`,
      );
    }
    return true;
  }

  async #reclaimStaleSocket(signal?: AbortSignal): Promise<void> {
    const original = await this.#socketInfo();
    if (!original) {
      this.#ownsSocket = false;
      return;
    }
    this.#validateSocketForCleanup(original);

    const firstProbe = await probeUnixSocket(this.socketPath, signal);
    if (firstProbe === "live") {
      throw new Error(
        `Refusing to connect to or replace an existing Codex socket with a live listener: ${this.socketPath}`,
      );
    }
    if (firstProbe === "missing") {
      this.#ownsSocket = false;
      return;
    }

    // Revalidate the inode after probing so a same-UID replacement cannot be
    // mistaken for the stale socket that was inspected.
    const current = await this.#socketInfo();
    if (!current) {
      this.#ownsSocket = false;
      return;
    }
    this.#validateSocketForCleanup(current);
    if (current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error(
        `Refusing to replace a Codex socket that changed during validation: ${this.socketPath}`,
      );
    }

    // A second direct probe closes the practical bind/listen race. A process
    // cannot bind a replacement at this path while this exact inode exists.
    const confirmed = await probeUnixSocket(this.socketPath, signal);
    if (confirmed === "live") {
      throw new Error(
        `Refusing to connect to or replace an existing Codex socket with a live listener: ${this.socketPath}`,
      );
    }
    if (confirmed === "missing") {
      this.#ownsSocket = false;
      return;
    }
    const finalInfo = await this.#socketInfo();
    if (!finalInfo) {
      this.#ownsSocket = false;
      return;
    }
    this.#validateSocketForCleanup(finalInfo);
    if (finalInfo.dev !== original.dev || finalInfo.ino !== original.ino) {
      throw new Error(
        `Refusing to replace a Codex socket that changed during validation: ${this.socketPath}`,
      );
    }
    await unlink(this.socketPath);
    this.#ownsSocket = false;
  }

  async #terminateChild(child: ManagedChildProcess | null): Promise<void> {
    if (!child) return;
    this.#expectedExitChildren.add(child);
    let didExit = false;
    const exited = new Promise<void>((resolveExit) => {
      child.on("exit", () => {
        didExit = true;
        resolveExit();
      });
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
    if (didExit && this.#child === child) this.#child = null;
    if (!didExit && this.#child === child) {
      throw new Error("Codex App Server did not stop after SIGTERM and SIGKILL");
    }
  }

  async #removeOwnedSocket(): Promise<void> {
    if (!this.#ownsSocket) return;
    await this.#reclaimStaleSocket();
  }

  async #cleanupFailedAttempt(): Promise<void> {
    this.#removeAdoptedCloseListener?.();
    this.#removeAdoptedCloseListener = null;
    this.#adoptedListener = false;
    this.#adoptedPid = null;
    const adapter = this.#initializingAdapter;
    this.#initializingAdapter = null;
    if (adapter) await adapter.dispose().catch(() => undefined);
    await this.#terminateChild(this.#child);
    await this.#removeOwnedSocket();
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
    this.#status = wasRunning || this.#recoveryTask ? "recovering" : "failed";
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
      occurredAt: this.#now().toISOString(),
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
    const initializingAdapter = this.#initializingAdapter;
    this.#initializingAdapter = null;
    if (initializingAdapter) {
      initializingAdapter.markRuntimeUnavailable(new Error(message));
      void initializingAdapter.dispose().catch(() => undefined);
    }

    for (const listener of this.#unexpectedExitListeners) {
      try {
        listener({ ...event });
      } catch {
        // A diagnostic consumer cannot compromise the supervisor boundary.
      }
    }
    if (wasRunning) this.#scheduleRecovery();
  }

  #scheduleRecovery(): void {
    if (this.#stopping) return;
    if (this.#recoveryTask) {
      this.#recoveryRequested = true;
      return;
    }
    this.#recoveryRequested = false;
    this.#status = "recovering";
    this.#restartAttempt = 0;
    this.#nextRestartAt = null;
    this.#terminalFailure = null;
    const controller = new AbortController();
    this.#attemptAbort = controller;
    const task = this.#recover(controller.signal, true).then(() => undefined).finally(() => {
      if (this.#recoveryTask === task) this.#recoveryTask = null;
      if (this.#attemptAbort === controller) this.#attemptAbort = null;
      if (this.#recoveryRequested && !this.#stopping && this.#status === "recovering") {
        this.#recoveryRequested = false;
        this.#scheduleRecovery();
      }
    });
    this.#recoveryTask = task;
    void task.catch(() => undefined);
  }

  #startupFailureMessage(): string | null {
    return this.#lastUnexpectedExit?.message ?? null;
  }

  async #recover(
    signal: AbortSignal,
    notifyRecovered: boolean,
    initialError?: string,
  ): Promise<CodexManagedAdapter | null> {
    const maxAttempts = this.#options.restartMaxAttempts ?? 5;
    let lastError = initialError ?? this.#lastUnexpectedExit?.message ??
      "Codex App Server exited";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const publications: CodexRecoveryPublication[] = [];
      this.#restartAttempt = attempt;
      const waitMs = this.#restartDelay(attempt);
      this.#nextRestartAt = new Date(this.#now().getTime() + waitMs).toISOString();
      try {
        await delay(waitMs, signal);
        this.#nextRestartAt = null;
        signal.throwIfAborted();
        await this.#cleanupFailedAttempt();
        signal.throwIfAborted();
        const adapter = await this.#launchInitialized(signal);
        if (notifyRecovered) {
          for (const listener of this.#recoveredListeners) {
            const publication = await listener(adapter, attempt);
            if (publication) publications.push(publication);
            signal.throwIfAborted();
          }
        }
        if (this.#initializingAdapter !== adapter || (!this.#child && !this.#adoptedListener)) {
          throw new Error("Codex recovery was superseded before publication");
        }
        this.#initializingAdapter = null;
        this.#adapter = adapter;
        this.#status = "running";
        this.#nextRestartAt = null;
        this.#terminalFailure = null;
        try {
          for (const publication of publications) publication.commit();
        } catch (error) {
          this.#adapter = null;
          this.#initializingAdapter = adapter;
          this.#status = "recovering";
          throw error;
        }
        return adapter;
      } catch (error) {
        for (const publication of publications.reverse()) {
          try {
            publication.rollback();
          } catch {
            // A consumer rollback cannot compromise owned child cleanup.
          }
        }
        this.#nextRestartAt = null;
        if (isAbort(error, signal) || this.#stopping) {
          await this.#cleanupFailedAttempt().catch(() => undefined);
          return null;
        }
        lastError = errorMessage(error);
        try {
          await this.#cleanupFailedAttempt();
        } catch (cleanupError) {
          lastError = `${lastError}; cleanup failed: ${errorMessage(cleanupError)}`;
        }
      }
    }

    if (signal.aborted || this.#stopping) return null;
    const terminalFailure: CodexRecoveryFailure = {
      occurredAt: this.#now().toISOString(),
      attempts: maxAttempts,
      message: `Codex App Server recovery failed after ${maxAttempts} attempts: ${lastError}`,
      lastError,
    };
    this.#terminalFailure = terminalFailure;
    this.#status = "failed";
    for (const listener of this.#recoveryFailedListeners) {
      try {
        listener({ ...terminalFailure });
      } catch {
        // Terminal diagnostics cannot compromise cleanup or state publication.
      }
    }
    return null;
  }

  #restartDelay(attempt: number): number {
    const initial = this.#options.restartInitialDelayMs ?? 250;
    const maximum = this.#options.restartMaxDelayMs ?? 10_000;
    return Math.min(maximum, initial * (2 ** Math.max(0, attempt - 1)));
  }

  #now(): Date {
    return (this.#options.now ?? (() => new Date()))();
  }

  async #connectUntilReady(
    child: ManagedChildProcess,
    signal: AbortSignal,
  ): Promise<MessageTransport> {
    const connect = this.#options.connect ?? ((socketPath: string) =>
      UnixWebSocketTransport.connect({ socketPath })
    );
    const deadline = Date.now() + (this.#options.startTimeoutMs ?? 10_000);
    let latestError: unknown = null;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (this.#child !== child || this.#reportedUnexpectedChildren.has(child)) {
        throw new Error(
          this.#startupFailureMessage() ??
            `Codex App Server exited before accepting connections${this.#stderrTail ? `: ${this.#stderrTail.trim()}` : ""}`,
        );
      }
      try {
        return await withAbort(
          connect(this.socketPath),
          signal,
          (transport) => void transport.close().catch(() => undefined),
        );
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        latestError = error;
        await delay(50, signal);
      }
    }
    throw new Error(
      `Timed out starting Codex App Server: ${latestError instanceof Error ? latestError.message : String(latestError)}`,
    );
  }
}
