import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type {
  ExecutionProfile,
  Provider,
  SessionRecord,
  SessionTakeover,
  SessionView,
  TakeoverMethod,
} from "../shared/session.ts";
import { codexClientInvocation, parseCodexOpenFiles } from "../discovery/observe.ts";

export interface LocalCliProcessIdentity {
  pid: number;
  uid: number;
  executable: "claude" | "codex";
  startedAt: string;
  providerSessionId: string;
  cwd: string;
}

export type LocalCliInspection =
  | { state: "running"; identity: LocalCliProcessIdentity }
  | { state: "exited" }
  | { state: "mismatch"; reason: string };

export interface LocalCliProcessInspector {
  inspect(session: SessionView): Promise<LocalCliInspection> | LocalCliInspection;
  terminate(identity: LocalCliProcessIdentity): void;
}

interface TakeoverAttempt {
  id: string;
  session: SessionView;
  identity: LocalCliProcessIdentity;
  method: TakeoverMethod;
  state: "waiting-for-exit" | "stopping" | "adopting" | "failed";
  requestedAt: string;
  deadlineAt: string | null;
  fallbackProfile: ExecutionProfile | null;
  error: string | null;
  controller: AbortController;
  signalled: boolean;
}

export interface CliTakeoverCoordinatorOptions {
  inspector?: LocalCliProcessInspector;
  canAdopt(provider: Provider): boolean;
  adopt(
    session: SessionView,
    profile: ExecutionProfile,
    signal: AbortSignal,
  ): Promise<SessionView>;
  persist(
    original: SessionView,
    adopted: SessionView,
    profile: ExecutionProfile,
  ): Promise<void> | void;
  rollback?(session: SessionView): Promise<void> | void;
  onChange(sessionId: string): void;
  onAdopted(session: SessionView): void;
  randomId?: () => string;
  now?: () => number;
  guidedTimeoutMs?: number;
  gracefulExitTimeoutMs?: number;
  adoptionTimeoutMs?: number;
  pollIntervalMs?: number;
}

const TAKEOVER_METHODS = ["guided-exit", "graceful-stop"] as const;

function fallbackProfile(provider: Provider): ExecutionProfile {
  return provider === "claude" ? "ask-first" : "plan";
}

function exactIdentity(left: LocalCliProcessIdentity, right: LocalCliProcessIdentity): boolean {
  return left.pid === right.pid
    && left.uid === right.uid
    && left.executable === right.executable
    && left.startedAt === right.startedAt
    && left.providerSessionId === right.providerSessionId
    && left.cwd === right.cwd;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message.trim() || "Takeover failed").slice(0, 2_000).join("");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Takeover cancelled"));
      return;
    }
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void => {
      finish(signal.reason ?? new Error("Takeover cancelled"));
    };
    const timer = setTimeout(() => finish(), milliseconds);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Exclusive, cancellation-aware ownership transfer for proven local CLIs. */
export class CliTakeoverCoordinator {
  readonly #inspector: LocalCliProcessInspector;
  readonly #options: CliTakeoverCoordinatorOptions;
  readonly #attempts = new Map<string, TakeoverAttempt>();
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #guidedTimeoutMs: number;
  readonly #gracefulExitTimeoutMs: number;
  readonly #adoptionTimeoutMs: number;
  readonly #pollIntervalMs: number;

  constructor(options: CliTakeoverCoordinatorOptions) {
    this.#options = options;
    this.#inspector = options.inspector ?? new SystemLocalCliProcessInspector();
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#guidedTimeoutMs = Math.max(1, options.guidedTimeoutMs ?? 5 * 60_000);
    this.#gracefulExitTimeoutMs = Math.max(1, options.gracefulExitTimeoutMs ?? 15_000);
    this.#adoptionTimeoutMs = Math.max(1, options.adoptionTimeoutMs ?? 30_000);
    this.#pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
  }

  canOffer(session: SessionView): boolean {
    return session.hostId === "local"
      && !session.archived
      && session.control.authority !== "manager"
      && session.parentId === null
      && (session.runtimePid ?? session.pid) !== null
      && typeof session.cwd === "string"
      && session.cwd.length > 0
      && this.#options.canAdopt(session.provider);
  }

  decorate(session: SessionRecord): SessionRecord {
    const capabilities: SessionRecord["control"]["capabilities"] = session.control.capabilities.filter(
      (capability) => capability !== "take-control" && capability !== "cancel-take-control",
    );
    const attempt = this.#attempts.get(session.id);
    let takeover: SessionTakeover | null = null;
    if (attempt) {
      takeover = {
        id: attempt.id,
        state: attempt.state,
        methods: [...TAKEOVER_METHODS],
        method: attempt.method,
        requestedAt: attempt.requestedAt,
        deadlineAt: attempt.deadlineAt,
        fallbackProfile: attempt.fallbackProfile,
        error: attempt.error,
      };
      if (attempt.state === "waiting-for-exit") capabilities.push("cancel-take-control");
      if (attempt.state === "failed") capabilities.push("take-control");
    } else if (this.canOffer(session)) {
      takeover = {
        id: null,
        state: "available",
        methods: [...TAKEOVER_METHODS],
        method: null,
        requestedAt: null,
        deadlineAt: null,
        fallbackProfile: session.profile.value === null
          ? fallbackProfile(session.provider)
          : null,
        error: null,
      };
      capabilities.push("take-control");
    }
    return {
      ...session,
      control: { ...session.control, capabilities, takeover },
    };
  }

  retainedSession(sessionId: string): SessionView | null {
    const attempt = this.#attempts.get(sessionId);
    return attempt ? this.decorate(attempt.session) : null;
  }

  async begin(
    session: SessionView,
    method: TakeoverMethod,
  ): Promise<{ takeoverId: string }> {
    if (!this.canOffer(session)) throw new Error("Safe local CLI takeover is unavailable");
    const existing = this.#attempts.get(session.id);
    if (existing && existing.state !== "failed") throw new Error("A takeover is already active");
    if (existing) this.#attempts.delete(session.id);

    const inspected = await this.#inspector.inspect(session);
    if (inspected.state === "exited") throw new Error("The provider CLI has already exited; use native resume");
    if (inspected.state === "mismatch") throw new Error(inspected.reason);
    const now = this.#now();
    const timeout = method === "guided-exit" ? this.#guidedTimeoutMs : this.#gracefulExitTimeoutMs;
    const attempt: TakeoverAttempt = {
      id: this.#randomId(),
      session: structuredClone(session),
      identity: inspected.identity,
      method,
      state: method === "guided-exit" ? "waiting-for-exit" : "stopping",
      requestedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + timeout).toISOString(),
      fallbackProfile: session.profile.value === null ? fallbackProfile(session.provider) : null,
      error: null,
      controller: new AbortController(),
      signalled: false,
    };
    this.#attempts.set(session.id, attempt);
    this.#options.onChange(session.id);
    void this.#run(attempt);
    return { takeoverId: attempt.id };
  }

  cancel(sessionId: string, takeoverId: string): void {
    const attempt = this.#attempts.get(sessionId);
    if (!attempt || attempt.id !== takeoverId) throw new Error("The takeover attempt is stale");
    if (attempt.state !== "waiting-for-exit") {
      throw new Error("Only a guided takeover waiting for CLI exit can be cancelled");
    }
    this.#attempts.delete(sessionId);
    attempt.controller.abort(new Error("Takeover cancelled"));
    this.#options.onChange(sessionId);
  }

  dispose(): void {
    for (const attempt of this.#attempts.values()) {
      attempt.controller.abort(new Error("Takeover coordinator stopped"));
    }
    this.#attempts.clear();
  }

  async #run(attempt: TakeoverAttempt): Promise<void> {
    try {
      if (attempt.method === "graceful-stop") {
        const inspection = await this.#inspector.inspect(attempt.session);
        if (inspection.state !== "running" || !exactIdentity(inspection.identity, attempt.identity)) {
          throw new Error(inspection.state === "mismatch"
            ? inspection.reason
            : "The provider process identity changed before graceful stop");
        }
        if (attempt.signalled) throw new Error("The provider process was already signalled");
        attempt.signalled = true;
        this.#inspector.terminate(attempt.identity);
      }

      await this.#waitForExit(attempt);
      this.#assertActive(attempt);
      attempt.state = "adopting";
      attempt.deadlineAt = new Date(this.#now() + this.#adoptionTimeoutMs).toISOString();
      this.#options.onChange(attempt.session.id);

      const profile = attempt.session.profile.value ?? fallbackProfile(attempt.session.provider);
      const adopted = await this.#withTimeout(
        this.#options.adopt(attempt.session, profile, attempt.controller.signal),
        this.#adoptionTimeoutMs,
        attempt.controller,
      );
      this.#assertActive(attempt);
      if (
        adopted.id !== attempt.session.id
        || adopted.provider !== attempt.session.provider
        || adopted.providerThreadId !== attempt.session.providerThreadId
        || adopted.cwd !== attempt.session.cwd
        || adopted.control.authority !== "manager"
      ) throw new Error("Provider adoption returned a different session identity");
      await this.#options.persist(attempt.session, adopted, profile);
      this.#assertActive(attempt);
      this.#attempts.delete(attempt.session.id);
      this.#options.onAdopted(adopted);
    } catch (error) {
      if (this.#attempts.get(attempt.session.id)?.id !== attempt.id) return;
      await Promise.resolve(this.#options.rollback?.(attempt.session)).catch(() => undefined);
      attempt.state = "failed";
      attempt.deadlineAt = null;
      attempt.error = boundedError(error);
      this.#options.onChange(attempt.session.id);
    }
  }

  async #waitForExit(attempt: TakeoverAttempt): Promise<void> {
    const timeout = attempt.method === "guided-exit"
      ? this.#guidedTimeoutMs
      : this.#gracefulExitTimeoutMs;
    const deadline = this.#now() + timeout;
    while (this.#now() <= deadline) {
      this.#assertActive(attempt);
      const inspected = await this.#inspector.inspect(attempt.session);
      if (inspected.state === "exited") return;
      if (inspected.state === "mismatch" || !exactIdentity(inspected.identity, attempt.identity)) {
        throw new Error(inspected.state === "mismatch"
          ? inspected.reason
          : "The provider process identity changed while waiting for exit");
      }
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - this.#now())), attempt.controller.signal);
    }
    throw new Error(attempt.method === "guided-exit"
      ? "Timed out waiting for the operator to exit the provider CLI"
      : "The provider CLI did not exit after SIGTERM; use native resume or retry");
  }

  #assertActive(attempt: TakeoverAttempt): void {
    attempt.controller.signal.throwIfAborted();
    if (this.#attempts.get(attempt.session.id)?.id !== attempt.id) {
      throw new Error("Takeover was superseded");
    }
  }

  #withTimeout<T>(
    operation: Promise<T>,
    milliseconds: number,
    controller: AbortController,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Provider adoption timed out");
        controller.abort(error);
        reject(error);
      }, milliseconds);
      timer.unref();
      operation.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }
}

function commandWords(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [])
    .map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2"));
}

function providerExecutable(command: string): "claude" | "codex" | null {
  const words = commandWords(command);
  const direct = basename(words[0] ?? "");
  if (direct === "claude" || direct === "codex") return direct;
  if (/^(?:node|nodejs)$/u.test(direct)) {
    const wrapped = basename(words[1] ?? "");
    if (wrapped === "claude" || wrapped === "codex") return wrapped;
  }
  return null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Production inspector: argv-only probes, exact UID/start time, no shell. */
export class SystemLocalCliProcessInspector implements LocalCliProcessInspector {
  readonly #uid: number;
  readonly #home: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: { uid?: number; home?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
    this.#home = options.home ?? homedir();
    this.#env = options.env ?? process.env;
  }

  inspect(session: SessionView): LocalCliInspection {
    const pid = session.runtimePid ?? session.pid;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) {
      return { state: "mismatch", reason: "No exact local provider PID is available" };
    }
    if (!processExists(pid)) return { state: "exited" };
    const result = spawnSync("ps", ["-p", String(pid), "-o", "uid=", "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      timeout: 3_000,
      env: { ...this.#env, LC_ALL: "C" },
    });
    if (result.status !== 0 || result.error) {
      return processExists(pid)
        ? { state: "mismatch", reason: "The provider process identity could not be revalidated" }
        : { state: "exited" };
    }
    const match = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(result.stdout.trim());
    if (!match) return { state: "mismatch", reason: "The provider process start identity was malformed" };
    const uid = Number(match[1]);
    const startedAt = match[2] ?? "";
    const command = match[3] ?? "";
    const executable = providerExecutable(command);
    if (uid !== this.#uid) return { state: "mismatch", reason: "The provider process belongs to a different UID" };
    if (executable !== session.provider) {
      return { state: "mismatch", reason: "The PID no longer belongs to the selected provider executable" };
    }

    const association = session.provider === "claude"
      ? this.#claudeAssociation(session, pid)
      : this.#codexAssociation(session, pid, command);
    if (association.state === "mismatch") return association;
    return {
      state: "running",
      identity: {
        pid,
        uid,
        executable,
        startedAt,
        providerSessionId: session.providerThreadId,
        cwd: association.cwd,
      },
    };
  }

  terminate(identity: LocalCliProcessIdentity): void {
    process.kill(identity.pid, "SIGTERM");
  }

  #claudeAssociation(session: SessionView, pid: number): { state: "ok"; cwd: string } | { state: "mismatch"; reason: string } {
    const root = join(this.#env.CLAUDE_CONFIG_DIR ?? join(this.#home, ".claude"), "sessions");
    let entries: string[];
    try {
      entries = readdirSync(root).filter((name) => name.endsWith(".json")).slice(0, 750);
    } catch {
      return { state: "mismatch", reason: "Claude's live registry is unavailable" };
    }
    for (const entry of entries) {
      try {
        const path = join(root, entry);
        const lexical = lstatSync(path);
        const stat = statSync(path);
        if (lexical.isSymbolicLink() || !stat.isFile() || stat.uid !== this.#uid) continue;
        const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        if (value.sessionId !== session.providerThreadId || value.pid !== pid) continue;
        const cwd = typeof value.cwd === "string" ? value.cwd : session.cwd;
        if (!cwd || (session.cwd && cwd !== session.cwd)) {
          return { state: "mismatch", reason: "Claude's registry workspace no longer matches the session" };
        }
        return { state: "ok", cwd };
      } catch {
        // Ignore unrelated or partially-written registry entries.
      }
    }
    return { state: "mismatch", reason: "Claude's registry no longer associates this PID with the session" };
  }

  #codexAssociation(session: SessionView, pid: number, command: string): { state: "ok"; cwd: string } | { state: "mismatch"; reason: string } {
    const invocation = codexClientInvocation({
      pid,
      ppid: 0,
      startedAtMs: null,
      tty: "?",
      state: "?",
      command,
      executable: "codex",
    });
    const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
    const result = spawnSync(lsof, ["-n", "-P", "-a", "-p", String(pid), "-Fn"], {
      encoding: "utf8",
      timeout: 3_000,
      env: this.#env,
    });
    if (result.status !== 0 || result.error) {
      return { state: "mismatch", reason: "Codex rollout association could not be revalidated" };
    }
    const open = parseCodexOpenFiles(result.stdout);
    const associated = invocation?.resumeThreadId === session.providerThreadId
      || open.threadIds.includes(session.providerThreadId);
    if (!associated) {
      return { state: "mismatch", reason: "Codex no longer has the selected thread open" };
    }
    const cwd = open.cwd ?? session.cwd;
    if (!cwd || (session.cwd && cwd !== session.cwd)) {
      return { state: "mismatch", reason: "Codex's process workspace no longer matches the session" };
    }
    return { state: "ok", cwd };
  }
}
