import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ExecutionProfile,
  Provider,
  SandboxPolicy,
  SessionRecord,
  SessionTakeover,
  SessionView,
  TakeoverMethod,
} from "../shared/session.ts";
import { DEFAULT_SANDBOX_POLICY } from "../shared/session.ts";

export interface LocalCliProcessMemberIdentity {
  pid: number;
  ppid: number;
  processGroupId: number;
  foregroundProcessGroupId: number;
  tty: string;
  startedAt: string;
  startedAtMs: number;
  executablePath: string;
  executableDevice: number;
  executableInode: number;
}

export interface LocalCliProcessIdentity {
  pid: number;
  uid: number;
  executable: "claude" | "codex";
  startedAt: string;
  providerSessionId: string;
  cwd: string;
  /** Canonical provider process path. Optional only for injected legacy inspectors. */
  executablePath?: string | undefined;
  ppid?: number | undefined;
  processGroupId?: number | undefined;
  foregroundProcessGroupId?: number | undefined;
  tty?: string | undefined;
  providerStartedAtMs?: number | null | undefined;
  associationPath?: string | undefined;
  interactive?: boolean | undefined;
  members?: readonly LocalCliProcessMemberIdentity[] | undefined;
}

export type LocalCliInspection =
  | { state: "running"; identity: LocalCliProcessIdentity }
  | {
      state: "pending";
      /**
       * Process identity proven before the provider registry is ready. Every
       * retry must revalidate this exact pin; a bare PID is never sufficient.
       */
      identity: LocalCliProcessIdentity;
      reason: string;
    }
  | { state: "exited" }
  | { state: "mismatch"; reason: string };

export interface LocalCliInspectionOptions {
  /** Disable only while polling for exit after association was already proven. */
  revalidateAssociation?: boolean;
}

export interface LocalCliProcessInspector {
  inspect(
    session: SessionView,
    expected?: LocalCliProcessIdentity,
    options?: LocalCliInspectionOptions,
  ): Promise<LocalCliInspection> | LocalCliInspection;
  /** Read-only recovery fence when a persisted session has no remembered PID. */
  findAssociated?(session: SessionView): Promise<LocalCliInspection> | LocalCliInspection;
  terminate(identity: LocalCliProcessIdentity): void;
}

export interface CliTakeoverSignalIntent {
  fingerprint: string;
  takeoverId: string;
  requestedAt: string;
  identity: LocalCliProcessIdentity;
}

/**
 * An implementation must atomically and durably claim a fingerprint. `true`
 * means this caller owns the one permitted SIGTERM; `false` means an earlier
 * process/attempt already recorded signal intent and no signal may be replayed.
 */
export interface CliTakeoverSignalJournal {
  claimSignalIntent(intent: CliTakeoverSignalIntent): Promise<boolean> | boolean;
}

export type CliTranscriptAssociationVerification =
  | { readonly state: "associated" }
  | { readonly state: "mismatch"; readonly reason: string };

interface TakeoverAttempt {
  id: string;
  session: SessionView;
  identity: LocalCliProcessIdentity;
  method: TakeoverMethod;
  state: "awaiting-confirmation" | "waiting-for-exit" | "stopping" | "adopting" | "failed";
  requestedAt: string;
  deadlineAt: string | null;
  fallbackProfile: ExecutionProfile | null;
  fallbackSandbox: SandboxPolicy | null;
  error: string | null;
  controller: AbortController;
  signalled: boolean;
  adoptionStarted: boolean;
  /** Fences the guided worker while its exact attempt is being replaced. */
  replacementPending: boolean;
  operation: Promise<void> | null;
}

interface RollbackQuarantine {
  session: SessionView;
  phase: "cleanup-in-flight" | "cleanup-failed" | "cleanup-succeeded";
  attempt: number;
  startedAt: string;
  error: string | null;
  controller: AbortController | null;
  operation: Promise<void> | null;
}

export interface CliTakeoverCoordinatorOptions {
  inspector?: LocalCliProcessInspector;
  canAdopt(provider: Provider): boolean;
  adopt(
    session: SessionView,
    profile: ExecutionProfile,
    signal: AbortSignal,
  ): Promise<SessionView>;
  /**
   * Resume an exact conversation without a live standalone owner. A Codex CLI
   * connected to this manager's exact private App Server socket is a peer, not
   * a standalone owner. Providers may keep this provisional until `persist`
   * commits and the server invokes their existing commit hook. When absent,
   * ordinary adoption is used.
   */
  resume?(
    session: SessionView,
    profile: ExecutionProfile,
    signal: AbortSignal,
  ): Promise<SessionView>;
  persist(
    original: SessionView,
    adopted: SessionView,
    profile: ExecutionProfile,
    signal: AbortSignal,
  ): Promise<SessionView | void> | SessionView | void;
  rollback?(session: SessionView, signal: AbortSignal): Promise<void> | void;
  /**
   * Synchronously verify a Claude session against the existing bounded,
   * read-only transcript reader. The coordinator checks only availability on
   * decoration, then executes this verifier at each ownership boundary.
   */
  verifyTranscriptAssociation?(
    session: SessionView,
  ): CliTranscriptAssociationVerification;
  onChange(sessionId: string): void;
  onAdopted(session: SessionView): void;
  randomId?: () => string;
  now?: () => number;
  guidedTimeoutMs?: number;
  gracefulExitTimeoutMs?: number;
  adoptionTimeoutMs?: number;
  inspectionTimeoutMs?: number;
  persistenceTimeoutMs?: number;
  rollbackTimeoutMs?: number;
  pollIntervalMs?: number;
  signalJournal?: CliTakeoverSignalJournal;
}

const TAKEOVER_METHODS = ["guided-exit", "graceful-stop"] as const;
const QUARANTINE_WITHHELD_CAPABILITIES = [
  "queue",
  "steer",
  "interrupt",
  "respond",
  "set-profile",
  "set-model",
  "set-effort",
  "remove-queued",
  "preview",
  "attach",
  "resume",
  "end",
  "archive",
  "delete",
  "take-control",
  "cancel-take-control",
  "open-editor",
] as const satisfies readonly SessionRecord["control"]["capabilities"][number][];

const CLEANUP_PENDING_REASON =
  "Provider ownership cleanup is still being confirmed; history remains available.";
const CLEANUP_FAILED_REASON =
  "Provider ownership cleanup could not be confirmed; retry cleanup before resuming or taking control.";

class MemorySignalJournal implements CliTakeoverSignalJournal {
  readonly #claimed = new Set<string>();

  claimSignalIntent(intent: CliTakeoverSignalIntent): boolean {
    if (this.#claimed.has(intent.fingerprint)) return false;
    this.#claimed.add(intent.fingerprint);
    return true;
  }
}

function fallbackProfile(provider: Provider): ExecutionProfile {
  return provider === "claude" ? "ask-first" : "plan";
}

/** Claude has no sandbox; an unproven Codex one is contained, not trusted. */
function fallbackSandbox(provider: Provider): SandboxPolicy | null {
  return provider === "claude" ? null : DEFAULT_SANDBOX_POLICY;
}

function takeoverMethods(session: SessionView): readonly TakeoverMethod[] {
  return session.kind === "interactive"
    ? TAKEOVER_METHODS
    : ["guided-exit"];
}

function normalizedIdentity(identity: LocalCliProcessIdentity): object {
  return {
    pid: identity.pid,
    uid: identity.uid,
    executable: identity.executable,
    executablePath: identity.executablePath ?? null,
    startedAt: identity.startedAt,
    providerStartedAtMs: identity.providerStartedAtMs ?? null,
    associationPath: identity.associationPath ?? null,
    ppid: identity.ppid ?? null,
    processGroupId: identity.processGroupId ?? null,
    foregroundProcessGroupId: identity.foregroundProcessGroupId ?? null,
    tty: identity.tty ?? null,
    interactive: identity.interactive ?? null,
    providerSessionId: identity.providerSessionId,
    cwd: identity.cwd,
    members: [...(identity.members ?? [])]
      .map((member) => ({ ...member }))
      .sort((left, right) => left.pid - right.pid),
  };
}

function strictLocalCliIdentityFingerprint(identity: LocalCliProcessIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedIdentity(identity)))
    .digest("hex");
}

function exactIdentity(left: LocalCliProcessIdentity, right: LocalCliProcessIdentity): boolean {
  return localCliProcessIdentityMatches(left, right);
}

/** Strict in-memory identity equality, including the complete mutable lineage fence. */
export function localCliProcessIdentityMatches(
  left: LocalCliProcessIdentity,
  right: LocalCliProcessIdentity,
): boolean {
  return strictLocalCliIdentityFingerprint(left) === strictLocalCliIdentityFingerprint(right);
}

/**
 * Durable at-most-once signal key. Unlike strict in-memory revalidation, this
 * intentionally excludes mutable lineage, terminal and process-group facts so
 * a wrapper exit or terminal detach cannot authorize a second SIGTERM for the
 * same exact provider target after restart.
 */
export function localCliSignalIntentFingerprint(identity: LocalCliProcessIdentity): string {
  const target = identity.members?.find((member) => member.pid === identity.pid);
  return createHash("sha256")
    .update(JSON.stringify({
      pid: identity.pid,
      uid: identity.uid,
      executable: identity.executable,
      executablePath: identity.executablePath ?? target?.executablePath ?? null,
      executableDevice: target?.executableDevice ?? null,
      executableInode: target?.executableInode ?? null,
      startedAt: identity.startedAt,
      providerStartedAtMs: identity.providerStartedAtMs ?? null,
      providerSessionId: identity.providerSessionId,
      cwd: identity.cwd,
      associationPath: identity.associationPath ?? null,
    }))
    .digest("hex");
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

function phaseTimeout<T>(
  start: (signal: AbortSignal) => Promise<T> | T,
  parent: AbortSignal | null,
  milliseconds: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parent?.reason ?? new Error(`${label} cancelled`));
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out`));
  }, milliseconds);
  timer.unref();

  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error: unknown | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
      controller.signal.removeEventListener("abort", abort);
      if (error === null) resolvePromise(value as T);
      else rejectPromise(error);
    };
    const abort = (): void => {
      finish(controller.signal.reason ?? new Error(`${label} cancelled`));
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => start(controller.signal))
      .then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
  });
}

/** Exclusive, cancellation-aware ownership transfer for proven local CLIs. */
export class CliTakeoverCoordinator {
  readonly #inspector: LocalCliProcessInspector;
  readonly #options: CliTakeoverCoordinatorOptions;
  readonly #attempts = new Map<string, TakeoverAttempt>();
  readonly #reservations = new Set<string>();
  readonly #rollbackQuarantines = new Map<string, RollbackQuarantine>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #guidedTimeoutMs: number;
  readonly #gracefulExitTimeoutMs: number;
  readonly #adoptionTimeoutMs: number;
  readonly #inspectionTimeoutMs: number;
  readonly #persistenceTimeoutMs: number;
  readonly #rollbackTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #signalJournal: CliTakeoverSignalJournal;
  readonly #lifecycleController = new AbortController();
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: CliTakeoverCoordinatorOptions) {
    this.#options = options;
    this.#inspector = options.inspector ?? new SystemLocalCliProcessInspector();
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#guidedTimeoutMs = Math.max(1, options.guidedTimeoutMs ?? 5 * 60_000);
    this.#gracefulExitTimeoutMs = Math.max(1, options.gracefulExitTimeoutMs ?? 15_000);
    this.#adoptionTimeoutMs = Math.max(1, options.adoptionTimeoutMs ?? 30_000);
    this.#inspectionTimeoutMs = Math.max(1, options.inspectionTimeoutMs ?? 5_000);
    this.#persistenceTimeoutMs = Math.max(1, options.persistenceTimeoutMs ?? 10_000);
    this.#rollbackTimeoutMs = Math.max(1, options.rollbackTimeoutMs ?? 5_000);
    this.#pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
    this.#signalJournal = options.signalJournal ?? new MemorySignalJournal();
  }

  canOffer(session: SessionView): boolean {
    return !this.#disposed
      && !this.#hasBlockingRollbackQuarantine(session.id)
      && this.#hasTranscriptVerifier(session)
      && session.hostId === "local"
      && !session.archived
      && session.control.authority !== "manager"
      && session.parentId === null
      && (session.runtimePid ?? session.pid) !== null
      && typeof session.cwd === "string"
      && session.cwd.length > 0
      && this.#options.canAdopt(session.provider);
  }

  /** Resume is a manager-side provider adoption, never a terminal command. */
  canResume(session: SessionView): boolean {
    const dormantManager = session.control.authority === "manager"
      && session.control.plane === "resume-only";
    return !this.#disposed
      && !this.#hasBlockingRollbackQuarantine(session.id)
      && this.#hasTranscriptVerifier(session)
      && session.hostId === "local"
      && !session.archived
      && (session.control.authority !== "manager" || dormantManager)
      && session.parentId === null
      && typeof session.cwd === "string"
      && session.cwd.length > 0
      && (session.runtimePid ?? session.pid) === null
      && this.#options.canAdopt(session.provider);
  }

  decorate(session: SessionRecord): SessionRecord {
    // A remote node has already decorated its own provider ownership state.
    // The local coordinator must preserve that typed contract verbatim so the
    // authenticated action can be proxied back to the owning node.
    if (session.hostId !== "local") return session;
    const quarantine = this.#rollbackQuarantines.get(session.id);
    if (quarantine?.phase === "cleanup-succeeded") {
      const projectedRecovery = session.control.recovery;
      const cleanupProjection = projectedRecovery?.startedAt === quarantine.startedAt
        && projectedRecovery.attempt === quarantine.attempt
        && (
          projectedRecovery.error === CLEANUP_PENDING_REASON
          || projectedRecovery.error?.startsWith(
            "Provider ownership cleanup could not be confirmed:",
          ) === true
        );
      // Rollback may positively resolve by confirming a late forward provider
      // promotion. Preserve that healthy manager view; only peel off our own
      // quarantine projection when cleanup restored the original owner state.
      const restored = this.#decorateAvailable(cleanupProjection
        ? {
            ...session,
            control: structuredClone(quarantine.session.control),
          }
        : session);
      this.#rollbackQuarantines.delete(session.id);
      return restored;
    }
    if (quarantine) return this.#decorateRollbackQuarantine(session, quarantine);
    return this.#decorateAvailable(session);
  }

  #decorateAvailable(session: SessionRecord): SessionRecord {
    const capabilities: SessionRecord["control"]["capabilities"] = session.control.capabilities.filter(
      (capability) => capability !== "take-control"
        && capability !== "cancel-take-control"
        && (
          capability !== "resume"
          || this.#hasTranscriptVerifier(session)
        ),
    );
    const resumable = this.canResume(session);
    if (resumable && !capabilities.includes("resume")) capabilities.push("resume");
    const attempt = this.#attempts.get(session.id);
    let takeover: SessionTakeover | null = null;
    if (attempt) {
      const methods = takeoverMethods(attempt.session);
      takeover = {
        id: attempt.id,
        state: attempt.state,
        methods: [...methods],
        method: attempt.method,
        requestedAt: attempt.requestedAt,
        deadlineAt: attempt.deadlineAt,
        fallbackProfile: attempt.fallbackProfile,
        fallbackSandbox: attempt.fallbackSandbox,
        error: attempt.error,
      };
      if (attempt.state === "awaiting-confirmation") {
        capabilities.push("take-control", "cancel-take-control");
      }
      if (attempt.state === "waiting-for-exit") {
        capabilities.push("take-control", "cancel-take-control");
      }
      if (attempt.state === "failed") capabilities.push("take-control");
    } else if (!resumable && this.canOffer(session)) {
      const methods = takeoverMethods(session);
      takeover = {
        id: null,
        state: "available",
        methods: [...methods],
        method: null,
        requestedAt: null,
        deadlineAt: null,
        fallbackProfile: session.profile.value === null
          ? fallbackProfile(session.provider)
          : null,
        fallbackSandbox: session.sandbox.value === null
          ? fallbackSandbox(session.provider)
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
    const quarantine = this.#rollbackQuarantines.get(sessionId);
    if (quarantine) return this.decorate(quarantine.session);
    const attempt = this.#attempts.get(sessionId);
    return attempt ? this.decorate(attempt.session) : null;
  }

  /**
   * Forget only a terminal, non-quarantined takeover attempt. Startup recovery
   * uses this after a failed native-owner transfer before it resumes polling
   * the same persisted identity; active or cleanup-uncertain transitions are
   * never dismissible through this seam.
   */
  dismissFailed(sessionId: string): boolean {
    if (this.#reservations.has(sessionId) || this.#rollbackQuarantines.has(sessionId)) {
      return false;
    }
    const attempt = this.#attempts.get(sessionId);
    if (!attempt || attempt.state !== "failed") return false;
    this.#attempts.delete(sessionId);
    return true;
  }

  /** Retry only a rollback whose previous cleanup rejected or timed out. */
  retryCleanup(sessionId: string): boolean {
    const quarantine = this.#rollbackQuarantines.get(sessionId);
    if (
      this.#disposed
      || !quarantine
      || quarantine.phase !== "cleanup-failed"
    ) return false;
    quarantine.attempt += 1;
    quarantine.startedAt = new Date(this.#now()).toISOString();
    quarantine.error = null;
    const boundary = this.#launchRollbackCleanup(quarantine);
    void this.#track(boundary);
    return true;
  }

  begin(
    session: SessionView,
    method: TakeoverMethod,
    confirmationTakeoverId?: string,
  ): Promise<{ takeoverId: string }> {
    if (confirmationTakeoverId === undefined) {
      return this.#track(this.#begin(session, method));
    }
    const attempt = this.#attempts.get(session.id);
    if (
      method === "graceful-stop"
      && attempt?.id === confirmationTakeoverId
      && attempt.method === "guided-exit"
      && attempt.state === "waiting-for-exit"
    ) {
      return this.#track(this.#replaceGuidedWithGraceful(
        session,
        confirmationTakeoverId,
      ));
    }
    return this.#confirm(session, method, confirmationTakeoverId);
  }

  /**
   * Resume the exact provider conversation into web control. This is a
   * separate path from takeover: it is allowed only after a complete owner-set
   * scan proves there is no standalone CLI to stop or race.
   */
  resume(session: SessionView): Promise<SessionView> {
    return this.#track(this.#resume(session));
  }

  async #resume(session: SessionView): Promise<SessionView> {
    if (this.#disposed) throw new Error("Takeover coordinator is stopped");
    if (
      session.hostId !== "local"
      || session.archived
      || session.parentId !== null
      || !session.cwd
      || !session.control.capabilities.includes("resume")
      || !this.canResume(session)
      || !this.#options.canAdopt(session.provider)
    ) {
      throw new Error("Safe in-web provider resume is unavailable");
    }
    if (this.#reservations.has(session.id)) {
      throw new Error("A provider ownership transition is already active");
    }
    const takeover = this.#attempts.get(session.id);
    if (takeover && takeover.state !== "failed") {
      throw new Error("A takeover is already active");
    }

    const controller = new AbortController();
    const abortFromLifecycle = (): void => {
      controller.abort(this.#lifecycleController.signal.reason);
    };
    this.#lifecycleController.signal.addEventListener("abort", abortFromLifecycle, { once: true });
    this.#reservations.add(session.id);
    let adoptionStarted = false;
    let ownershipCommitted = false;
    try {
      if (!this.#inspector.findAssociated) {
        throw new Error("Provider owner-set discovery is unavailable");
      }
      await this.#assertResumeOwnerPolicy(session, controller.signal);
      this.#assertTranscriptAssociation(session);
      controller.signal.throwIfAborted();
      const profile = session.profile.value ?? fallbackProfile(session.provider);
      adoptionStarted = true;
      const adopted = await phaseTimeout(
        (signal) => (this.#options.resume ?? this.#options.adopt)(session, profile, signal),
        controller.signal,
        this.#adoptionTimeoutMs,
        "Provider resume",
      );
      controller.signal.throwIfAborted();
      if (
        adopted.id !== session.id
        || adopted.provider !== session.provider
        || adopted.providerThreadId !== session.providerThreadId
        || adopted.cwd !== session.cwd
        || adopted.control.authority !== "manager"
      ) {
        throw new Error("Provider resume returned a different session identity");
      }
      const committed = await phaseTimeout(
        (signal) => this.#options.persist(session, adopted, profile, signal),
        controller.signal,
        this.#persistenceTimeoutMs,
        "Provider resume persistence",
      );
      ownershipCommitted = true;
      this.#attempts.delete(session.id);
      const result = committed ?? adopted;
      try {
        this.#options.onAdopted(result);
      } catch {
        // Startup recovery republishes the persisted manager identity.
      }
      return result;
    } catch (error) {
      if (adoptionStarted && !ownershipCommitted) {
        await this.#beginRollbackQuarantine(session);
      }
      throw error;
    } finally {
      if (!this.#hasBlockingRollbackQuarantine(session.id)) {
        this.#reservations.delete(session.id);
      }
      this.#lifecycleController.signal.removeEventListener("abort", abortFromLifecycle);
    }
  }

  async #confirm(
    session: SessionView,
    method: TakeoverMethod,
    takeoverId: string,
  ): Promise<{ takeoverId: string }> {
    if (this.#disposed) throw new Error("Takeover coordinator is stopped");
    if (method !== "graceful-stop") {
      throw new Error("Only graceful stop uses a separate confirmation");
    }
    const attempt = this.#attempts.get(session.id);
    if (!attempt || attempt.id !== takeoverId) {
      throw new Error("The graceful-stop confirmation is stale");
    }
    if (attempt.state !== "awaiting-confirmation" || attempt.method !== method) {
      throw new Error("The graceful-stop confirmation is no longer available");
    }
    if (!this.#options.canAdopt(attempt.session.provider)) {
      throw new Error("Provider adoption became unavailable; no signal was sent");
    }
    if (
      session.provider !== attempt.session.provider
      || session.providerThreadId !== attempt.session.providerThreadId
      || session.cwd !== attempt.session.cwd
    ) {
      throw new Error("The provider conversation changed before graceful-stop confirmation");
    }
    // Refresh observed provider settings at the confirmation boundary while
    // retaining the exact process identity pinned by the first request.
    attempt.session = structuredClone(session);
    attempt.state = "stopping";
    attempt.deadlineAt = null;
    attempt.error = null;
    this.#notifyChange(session.id);
    attempt.operation = this.#track(this.#run(attempt));
    return { takeoverId: attempt.id };
  }

  /**
   * Turn an exact, still-waiting guided attempt into a fresh graceful-stop
   * confirmation. The old poll is aborted before revalidation so it cannot
   * race this request into adoption. This method never signals the process;
   * the returned, newly-issued id must be confirmed in a separate request.
   */
  async #replaceGuidedWithGraceful(
    session: SessionView,
    takeoverId: string,
  ): Promise<{ takeoverId: string }> {
    if (this.#disposed) throw new Error("Takeover coordinator is stopped");
    const attempt = this.#attempts.get(session.id);
    if (!attempt || attempt.id !== takeoverId) {
      throw new Error("The guided takeover attempt is stale");
    }
    if (attempt.method !== "guided-exit" || attempt.state !== "waiting-for-exit") {
      throw new Error("The guided takeover can no longer be stopped from the web app");
    }
    if (attempt.replacementPending || this.#reservations.has(session.id)) {
      throw new Error("A provider ownership transition is already active");
    }
    if (!this.canOffer(session)) {
      throw new Error("Safe local CLI takeover is unavailable");
    }
    if (!this.#options.canAdopt(attempt.session.provider)) {
      throw new Error("Provider adoption became unavailable; no signal was sent");
    }
    if (
      session.provider !== attempt.session.provider
      || session.providerThreadId !== attempt.session.providerThreadId
      || session.cwd !== attempt.session.cwd
    ) {
      throw new Error("The provider conversation changed before safe-stop preparation");
    }
    if (!takeoverMethods(session).includes("graceful-stop")) {
      throw new Error("Graceful stop requires a proven interactive provider CLI");
    }
    const replacementId = this.#freshTakeoverId(attempt.id);

    // These mutations are intentionally synchronous: no guided worker can run
    // between the state check and the abort in JavaScript's event loop.
    this.#reservations.add(session.id);
    attempt.replacementPending = true;
    attempt.controller.abort(new Error("Guided takeover replaced by safe-stop preparation"));
    try {
      if (attempt.operation) await attempt.operation;
      if (this.#disposed) throw new Error("Takeover coordinator is stopped");
      if (
        this.#attempts.get(session.id) !== attempt
        || !attempt.replacementPending
      ) {
        throw new Error("The guided takeover attempt was superseded");
      }

      const inspected = await phaseTimeout(
        () => this.#inspector.inspect(session, attempt.identity),
        this.#lifecycleController.signal,
        this.#inspectionTimeoutMs,
        "Provider process revalidation",
      );
      if (inspected.state !== "running" || !exactIdentity(inspected.identity, attempt.identity)) {
        throw new Error(
          inspected.state === "pending" || inspected.state === "mismatch"
            ? inspected.reason
            : inspected.state === "exited"
              ? "The provider CLI exited while preparing the safe stop; resume it in the web app"
              : "The provider process identity changed before safe-stop preparation",
        );
      }
      await this.#assertStandaloneOwnerSet(
        session,
        inspected.identity,
        "Provider safe-stop owner-set validation",
        this.#lifecycleController.signal,
      );
      this.#assertTranscriptAssociation(session);
      if (inspected.identity.interactive === false) {
        throw new Error("Graceful stop requires a foreground interactive provider CLI");
      }
      if (!this.#options.canAdopt(attempt.session.provider)) {
        throw new Error("Provider adoption became unavailable; no signal was sent");
      }
      this.#lifecycleController.signal.throwIfAborted();
      if (
        this.#attempts.get(session.id) !== attempt
        || !attempt.replacementPending
      ) {
        throw new Error("The guided takeover attempt was superseded");
      }
      const replacement: TakeoverAttempt = {
        id: replacementId,
        session: structuredClone(session),
        identity: inspected.identity,
        method: "graceful-stop",
        state: "awaiting-confirmation",
        requestedAt: new Date(this.#now()).toISOString(),
        deadlineAt: null,
        fallbackProfile: session.profile.value === null ? fallbackProfile(session.provider) : null,
        fallbackSandbox: session.sandbox.value === null ? fallbackSandbox(session.provider) : null,
        error: null,
        controller: new AbortController(),
        signalled: false,
        adoptionStarted: false,
        replacementPending: false,
        operation: null,
      };
      this.#attempts.set(session.id, replacement);
      this.#notifyChange(session.id);
      return { takeoverId: replacement.id };
    } catch (error) {
      if (this.#attempts.get(session.id) === attempt) {
        attempt.replacementPending = false;
        attempt.state = "failed";
        attempt.deadlineAt = null;
        attempt.error = boundedError(error);
        this.#notifyChange(session.id);
      }
      throw error;
    } finally {
      this.#reservations.delete(session.id);
    }
  }

  async #begin(
    session: SessionView,
    method: TakeoverMethod,
  ): Promise<{ takeoverId: string }> {
    if (this.#disposed) throw new Error("Takeover coordinator is stopped");
    if (!this.canOffer(session)) throw new Error("Safe local CLI takeover is unavailable");
    if (!takeoverMethods(session).includes(method)) {
      throw new Error("Graceful stop requires a proven interactive provider CLI");
    }
    if (this.#reservations.has(session.id)) throw new Error("A takeover is already active");
    const existing = this.#attempts.get(session.id);
    if (existing && existing.state !== "failed") throw new Error("A takeover is already active");
    this.#reservations.add(session.id);
    try {
      const inspected = await phaseTimeout(
        () => this.#inspector.inspect(session, existing?.identity),
        this.#lifecycleController.signal,
        this.#inspectionTimeoutMs,
        "Provider process inspection",
      );
      if (this.#disposed) throw new Error("Takeover coordinator is stopped");
      if (inspected.state === "exited" && !existing) {
        throw new Error("The provider CLI has already exited; resume the conversation in the web app");
      }
      if (inspected.state === "pending") throw new Error(inspected.reason);
      if (inspected.state === "mismatch") throw new Error(inspected.reason);
      const inspectedIdentity = inspected.state === "running"
        ? inspected.identity
        : existing?.identity;
      if (!inspectedIdentity) throw new Error("The provider process identity is unavailable");
      if (existing && !exactIdentity(inspectedIdentity, existing.identity)) {
        throw new Error("The provider process identity changed before takeover retry");
      }
      await this.#assertStandaloneOwnerSet(
        session,
        inspected.state === "running" ? inspectedIdentity : null,
        "Provider owner-set validation",
      );
      this.#assertTranscriptAssociation(session);
      if (method === "graceful-stop" && inspectedIdentity.interactive === false) {
        throw new Error("Graceful stop requires a foreground interactive provider CLI");
      }
      if (existing && this.#attempts.get(session.id) === existing) {
        this.#attempts.delete(session.id);
      }
      const now = this.#now();
      const attempt: TakeoverAttempt = {
        id: this.#randomId(),
        session: structuredClone(session),
        identity: inspectedIdentity,
        method,
        state: method === "guided-exit" ? "waiting-for-exit" : "awaiting-confirmation",
        requestedAt: new Date(now).toISOString(),
        deadlineAt: method === "guided-exit"
          ? new Date(now + this.#guidedTimeoutMs).toISOString()
          : null,
        fallbackProfile: session.profile.value === null ? fallbackProfile(session.provider) : null,
        fallbackSandbox: session.sandbox.value === null ? fallbackSandbox(session.provider) : null,
        error: null,
        controller: new AbortController(),
        signalled: false,
        adoptionStarted: false,
        replacementPending: false,
        operation: null,
      };
      this.#attempts.set(session.id, attempt);
      this.#notifyChange(session.id);
      if (method === "guided-exit") {
        attempt.operation = this.#track(this.#run(attempt));
      }
      return { takeoverId: attempt.id };
    } finally {
      this.#reservations.delete(session.id);
    }
  }

  cancel(sessionId: string, takeoverId: string): void {
    const attempt = this.#attempts.get(sessionId);
    if (!attempt || attempt.id !== takeoverId) throw new Error("The takeover attempt is stale");
    if (attempt.replacementPending || this.#reservations.has(sessionId)) {
      throw new Error("A provider ownership transition is already active");
    }
    if (attempt.state !== "waiting-for-exit" && attempt.state !== "awaiting-confirmation") {
      throw new Error("Only a takeover waiting for exit or confirmation can be cancelled");
    }
    this.#attempts.delete(sessionId);
    attempt.controller.abort(new Error("Takeover cancelled"));
    this.#notifyChange(sessionId);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#lifecycleController.abort(new Error("Takeover coordinator stopped"));
    const attempts = [...this.#attempts.values()];
    for (const attempt of attempts) {
      attempt.controller.abort(new Error("Takeover coordinator stopped"));
    }
    for (const quarantine of this.#rollbackQuarantines.values()) {
      quarantine.controller?.abort(new Error("Takeover coordinator stopped"));
    }
    this.#disposePromise = (async () => {
      await Promise.allSettled([
        ...attempts.flatMap((attempt) => attempt.operation ? [attempt.operation] : []),
        ...this.#operations,
      ]);
      for (const attempt of attempts) {
        if (this.#attempts.get(attempt.session.id)?.id === attempt.id) {
          this.#attempts.delete(attempt.session.id);
          this.#notifyChange(attempt.session.id);
        }
      }
    })();
    return this.#disposePromise;
  }

  async #run(attempt: TakeoverAttempt): Promise<void> {
    let ownershipCommitted = false;
    try {
      if (attempt.method === "graceful-stop") {
        const inspection = await phaseTimeout(
          () => this.#inspector.inspect(attempt.session, attempt.identity),
          attempt.controller.signal,
          this.#inspectionTimeoutMs,
          "Provider process revalidation",
        );
        if (inspection.state !== "running" || !exactIdentity(inspection.identity, attempt.identity)) {
          throw new Error(
            inspection.state === "mismatch" || inspection.state === "pending"
              ? inspection.reason
              : "The provider process identity changed before graceful stop",
          );
        }
        if (attempt.signalled) throw new Error("The provider process was already signalled");
        this.#assertTranscriptAssociation(attempt.session);
        const claimed = await phaseTimeout(
          () => this.#signalJournal.claimSignalIntent({
            fingerprint: localCliSignalIntentFingerprint(attempt.identity),
            takeoverId: attempt.id,
            requestedAt: attempt.requestedAt,
            identity: structuredClone(attempt.identity),
          }),
          attempt.controller.signal,
          this.#persistenceTimeoutMs,
          "Graceful-stop signal journal",
        );
        attempt.signalled = true;
        if (claimed) {
          const finalInspection = await phaseTimeout(
            () => this.#inspector.inspect(attempt.session, attempt.identity),
            attempt.controller.signal,
            this.#inspectionTimeoutMs,
            "Provider process final signal validation",
          );
          if (finalInspection.state === "mismatch" || finalInspection.state === "pending" ||
              (finalInspection.state === "running" && !exactIdentity(finalInspection.identity, attempt.identity))) {
            throw new Error(
              finalInspection.state === "mismatch" || finalInspection.state === "pending"
                ? finalInspection.reason
                : "The provider process identity changed immediately before graceful stop",
            );
          }
          if (finalInspection.state === "running") {
            try {
              this.#inspector.terminate(attempt.identity);
            } catch (error) {
              const afterSignalFailure = await phaseTimeout(
                () => this.#inspector.inspect(
                  attempt.session,
                  attempt.identity,
                  { revalidateAssociation: false },
                ),
                attempt.controller.signal,
                this.#inspectionTimeoutMs,
                "Provider exit confirmation",
              );
              if (afterSignalFailure.state !== "exited") throw error;
            }
          }
        }
      }

      await this.#waitForExit(attempt);
      this.#assertActive(attempt);
      // The selected process exiting is not sufficient: another standalone
      // process may have joined the same provider conversation while we waited.
      // Re-scan the complete exact owner set immediately before adoption.
      await this.#assertStandaloneOwnerSet(
        attempt.session,
        null,
        "Provider final owner-set validation",
        attempt.controller.signal,
      );
      this.#assertActive(attempt);
      this.#assertTranscriptAssociation(attempt.session);
      attempt.state = "adopting";
      attempt.deadlineAt = new Date(this.#now() + this.#adoptionTimeoutMs).toISOString();
      this.#notifyChange(attempt.session.id);

      const profile = attempt.session.profile.value ?? fallbackProfile(attempt.session.provider);
      attempt.adoptionStarted = true;
      const adopted = await phaseTimeout(
        (signal) => this.#options.adopt(attempt.session, profile, signal),
        attempt.controller.signal,
        this.#adoptionTimeoutMs,
        "Provider adoption",
      );
      this.#assertActive(attempt);
      if (
        adopted.id !== attempt.session.id
        || adopted.provider !== attempt.session.provider
        || adopted.providerThreadId !== attempt.session.providerThreadId
        || adopted.cwd !== attempt.session.cwd
        || adopted.control.authority !== "manager"
      ) throw new Error("Provider adoption returned a different session identity");
      const committed = await phaseTimeout(
        (signal) => this.#options.persist(attempt.session, adopted, profile, signal),
        attempt.controller.signal,
        this.#persistenceTimeoutMs,
        "Provider adoption persistence",
      );
      ownershipCommitted = true;
      this.#attempts.delete(attempt.session.id);
      // Persistence is the ownership commit point. A projection failure after
      // it must not tear down a durable provider adoption.
      try {
        this.#options.onAdopted(committed ?? adopted);
      } catch {
        // Startup recovery republishes the persisted managed identity.
      }
    } catch (error) {
      if (attempt.replacementPending) return;
      if (attempt.adoptionStarted && !ownershipCommitted) {
        await this.#beginRollbackQuarantine(attempt.session);
      }
      if (this.#attempts.get(attempt.session.id)?.id !== attempt.id) return;
      attempt.state = "failed";
      attempt.deadlineAt = null;
      attempt.error = boundedError(error);
      this.#notifyChange(attempt.session.id);
    }
  }

  async #waitForExit(attempt: TakeoverAttempt): Promise<void> {
    const timeout = attempt.method === "guided-exit"
      ? this.#guidedTimeoutMs
      : this.#gracefulExitTimeoutMs;
    const deadline = this.#now() + timeout;
    attempt.deadlineAt = new Date(deadline).toISOString();
    this.#notifyChange(attempt.session.id);
    while (this.#now() <= deadline) {
      this.#assertActive(attempt);
      const inspected = await phaseTimeout(
        () => this.#inspector.inspect(
          attempt.session,
          attempt.identity,
          { revalidateAssociation: false },
        ),
        attempt.controller.signal,
        this.#inspectionTimeoutMs,
        "Provider process exit inspection",
      );
      if (inspected.state === "exited") return;
      if (
        inspected.state === "mismatch"
        || inspected.state === "pending"
        || !exactIdentity(inspected.identity, attempt.identity)
      ) {
        throw new Error(
          inspected.state === "mismatch" || inspected.state === "pending"
            ? inspected.reason
            : "The provider process identity changed while waiting for exit",
        );
      }
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - this.#now())), attempt.controller.signal);
    }
    throw new Error(attempt.method === "guided-exit"
      ? "Timed out waiting for the operator to exit the provider CLI"
      : "The provider CLI did not exit after SIGTERM; retry or continue using its existing owner");
  }

  async #assertStandaloneOwnerSet(
    session: SessionView,
    expected: LocalCliProcessIdentity | null,
    label: string,
    parentSignal: AbortSignal = this.#lifecycleController.signal,
  ): Promise<void> {
    if (!this.#inspector.findAssociated) return;
    const withoutSelectedPid: SessionView = {
      ...session,
      pid: null,
      runtimePid: null,
    };
    const inspected = await phaseTimeout(
      () => this.#inspector.findAssociated!(withoutSelectedPid),
      parentSignal,
      this.#inspectionTimeoutMs,
      label,
    );
    if (inspected.state === "pending" || inspected.state === "mismatch") {
      throw new Error(inspected.reason);
    }
    if (expected === null) {
      if (inspected.state === "running") {
        throw new Error(
          `Another standalone ${session.provider === "codex" ? "Codex" : "Claude"} process still owns this conversation`,
        );
      }
      return;
    }
    if (inspected.state !== "running" || !exactIdentity(inspected.identity, expected)) {
      throw new Error(
        inspected.state === "exited"
          ? "The selected provider process disappeared during owner-set validation"
          : `Another standalone ${session.provider === "codex" ? "Codex" : "Claude"} process also owns this conversation`,
      );
    }
  }

  async #assertResumeOwnerPolicy(
    session: SessionView,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#assertStandaloneOwnerSet(
      session,
      null,
      "Provider resume owner-set validation",
      signal,
    );
  }

  #hasTranscriptVerifier(session: SessionView): boolean {
    return session.provider !== "claude"
      || this.#options.verifyTranscriptAssociation !== undefined;
  }

  #assertTranscriptAssociation(session: SessionView): void {
    if (session.provider !== "claude") return;
    const verify = this.#options.verifyTranscriptAssociation;
    if (!verify) {
      throw new Error("Claude transcript association verification is unavailable");
    }
    let result: CliTranscriptAssociationVerification;
    try {
      result = verify(session);
    } catch (error) {
      throw new Error(
        `Claude transcript association verification failed: ${boundedError(error)}`,
      );
    }
    if (result?.state !== "associated") {
      const reason = result?.state === "mismatch"
        ? boundedError(result.reason)
        : "the verifier returned an invalid result";
      throw new Error(`Claude transcript association mismatch: ${reason}`);
    }
  }

  #hasBlockingRollbackQuarantine(sessionId: string): boolean {
    const quarantine = this.#rollbackQuarantines.get(sessionId);
    return quarantine !== undefined && quarantine.phase !== "cleanup-succeeded";
  }

  #decorateRollbackQuarantine(
    session: SessionRecord,
    quarantine: RollbackQuarantine,
  ): SessionRecord {
    const failed = quarantine.phase === "cleanup-failed";
    const reason = failed ? CLEANUP_FAILED_REASON : CLEANUP_PENDING_REASON;
    return {
      ...session,
      control: {
        ...session.control,
        recovery: {
          state: failed ? "needs-attention" : "reconnecting",
          attempt: quarantine.attempt,
          startedAt: quarantine.startedAt,
          deadlineAt: null,
          nextRetryAt: null,
          error: failed
            ? `Provider ownership cleanup could not be confirmed: ${quarantine.error ?? "unknown cleanup failure"}`
            : CLEANUP_PENDING_REASON,
        },
        capabilities: failed ? ["retry-control"] : [],
        withheld: QUARANTINE_WITHHELD_CAPABILITIES.map((capability) => ({
          capability,
          reason,
        })),
        takeover: null,
      },
    };
  }

  async #beginRollbackQuarantine(session: SessionView): Promise<void> {
    const existing = this.#rollbackQuarantines.get(session.id);
    if (existing?.phase !== "cleanup-succeeded") {
      if (existing) return;
      const quarantine: RollbackQuarantine = {
        session: structuredClone(session),
        phase: "cleanup-in-flight",
        attempt: 1,
        startedAt: new Date(this.#now()).toISOString(),
        error: null,
        controller: null,
        operation: null,
      };
      this.#rollbackQuarantines.set(session.id, quarantine);
      this.#reservations.add(session.id);
      await this.#launchRollbackCleanup(quarantine);
    }
  }

  #launchRollbackCleanup(quarantine: RollbackQuarantine): Promise<void> {
    quarantine.phase = "cleanup-in-flight";
    quarantine.error = null;
    const controller = new AbortController();
    quarantine.controller = controller;
    const operation = Promise.resolve().then(async () => {
      if (!this.#options.rollback) {
        throw new Error("Provider rollback confirmation is unavailable");
      }
      await this.#options.rollback(quarantine.session, controller.signal);
    });
    quarantine.operation = operation;
    this.#notifyChange(quarantine.session.id);

    void operation.then(
      () => this.#completeRollbackCleanup(quarantine, operation),
      (error: unknown) => this.#failRollbackCleanup(quarantine, operation, error),
    );

    return new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        const error = new Error("Provider ownership cleanup timed out");
        controller.abort(error);
        this.#failRollbackCleanup(quarantine, operation, error);
        finish();
      }, this.#rollbackTimeoutMs);
      timer.unref();
      operation.then(finish, finish);
    });
  }

  #completeRollbackCleanup(
    quarantine: RollbackQuarantine,
    operation: Promise<void>,
  ): void {
    if (
      this.#rollbackQuarantines.get(quarantine.session.id) !== quarantine
      || quarantine.operation !== operation
      || quarantine.phase !== "cleanup-in-flight"
    ) return;
    quarantine.phase = "cleanup-succeeded";
    quarantine.controller = null;
    quarantine.error = null;
    this.#reservations.delete(quarantine.session.id);
    this.#notifyChange(quarantine.session.id);
    if (this.#rollbackQuarantines.get(quarantine.session.id) === quarantine) {
      this.#rollbackQuarantines.delete(quarantine.session.id);
    }
  }

  #failRollbackCleanup(
    quarantine: RollbackQuarantine,
    operation: Promise<void>,
    error: unknown,
  ): void {
    if (
      this.#rollbackQuarantines.get(quarantine.session.id) !== quarantine
      || quarantine.operation !== operation
      || quarantine.phase !== "cleanup-in-flight"
    ) return;
    quarantine.phase = "cleanup-failed";
    quarantine.controller = null;
    quarantine.error = boundedError(error);
    this.#notifyChange(quarantine.session.id);
  }

  #assertActive(attempt: TakeoverAttempt): void {
    attempt.controller.signal.throwIfAborted();
    if (this.#attempts.get(attempt.session.id)?.id !== attempt.id) {
      throw new Error("Takeover was superseded");
    }
  }

  #freshTakeoverId(excludedId: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.#randomId();
      if (candidate.length > 0 && candidate !== excludedId) return candidate;
    }
    throw new Error("Could not issue a fresh safe-stop confirmation");
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  #notifyChange(sessionId: string): void {
    try {
      this.#options.onChange(sessionId);
    } catch {
      // State projection is best effort; provider ownership remains driven by
      // the coordinator transaction, never by a listener exception.
    }
  }
}

function commandWords(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [])
    .map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2"));
}

interface ProviderCommand {
  provider: "claude" | "codex";
  path: string;
  args: string[];
}

interface ProcessRow {
  pid: number;
  ppid: number;
  processGroupId: number;
  foregroundProcessGroupId: number;
  uid: number;
  tty: string;
  startedAt: string;
  startedAtMs: number;
  command: string;
  providerCommand: ProviderCommand | null;
}

interface ProbeResult {
  stdout: string;
  status: number | null;
  error: Error | null;
}

type ProbeRunner = (command: string, args: readonly string[], timeoutMs: number) => ProbeResult;

function providerCommand(command: string): ProviderCommand | null {
  const words = commandWords(command);
  const direct = basename(words[0] ?? "");
  if (direct === "claude" || direct === "codex") {
    return { provider: direct, path: words[0] as string, args: words.slice(1) };
  }
  if (/^(?:node|nodejs)$/u.test(direct)) {
    const wrapped = basename(words[1] ?? "");
    if (wrapped === "claude" || wrapped === "codex") {
      return { provider: wrapped, path: words[1] as string, args: words.slice(2) };
    }
  }
  return null;
}

function executablePath(path: string, env: NodeJS.ProcessEnv): string {
  const candidates = path.includes("/")
    ? [resolve(path)]
    : (env.PATH ?? "").split(":").filter(Boolean).map((directory) => resolve(directory, path));
  for (const candidate of candidates) {
    try {
      return realpathSync.native(candidate);
    } catch {
      // Keep looking through the caller's fixed PATH.
    }
  }
  throw new Error(`Provider executable could not be canonicalized: ${path}`);
}

function executableIdentity(path: string, env: NodeJS.ProcessEnv): {
  path: string;
  device: number;
  inode: number;
} {
  const canonical = executablePath(path, env);
  const stat = statSync(canonical);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`Provider executable is not an executable file: ${canonical}`);
  }
  return { path: canonical, device: stat.dev, inode: stat.ino };
}

function processRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n").slice(0, 4_096)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const processGroupId = Number(match[3]);
    const foregroundProcessGroupId = Number(match[4]);
    const uid = Number(match[5]);
    const startedAt = match[7] ?? "";
    // Claude's live registry records procStart in UTC. Parse the same stable
    // clock regardless of the manager process's local timezone.
    const startedAtMs = Date.parse(`${startedAt} UTC`);
    if (![pid, ppid, processGroupId, foregroundProcessGroupId, uid, startedAtMs].every(Number.isFinite)) continue;
    const command = match[8] ?? "";
    rows.push({
      pid,
      ppid,
      processGroupId,
      foregroundProcessGroupId,
      uid,
      tty: match[6] ?? "?",
      startedAt,
      startedAtMs,
      command,
      providerCommand: providerCommand(command),
    });
  }
  return rows;
}

function memberIdentity(row: ProcessRow, env: NodeJS.ProcessEnv): LocalCliProcessMemberIdentity {
  if (!row.providerCommand) throw new Error("Process is not a provider command");
  const executable = executableIdentity(row.providerCommand.path, env);
  return {
    pid: row.pid,
    ppid: row.ppid,
    processGroupId: row.processGroupId,
    foregroundProcessGroupId: row.foregroundProcessGroupId,
    tty: row.tty,
    startedAt: row.startedAt,
    startedAtMs: row.startedAtMs,
    executablePath: executable.path,
    executableDevice: executable.device,
    executableInode: executable.inode,
  };
}

function sameMember(row: ProcessRow, expected: LocalCliProcessMemberIdentity, env: NodeJS.ProcessEnv): boolean {
  try {
    const current = memberIdentity(row, env);
    return JSON.stringify(current) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function providerLineage(
  anchor: ProcessRow,
  rows: readonly ProcessRow[],
  provider: Provider,
): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const selected = new Map<number, ProcessRow>();
  const add = (row: ProcessRow | undefined): boolean => {
    if (!row || row.uid !== anchor.uid || row.processGroupId !== anchor.processGroupId ||
        row.tty !== anchor.tty || row.providerCommand?.provider !== provider || selected.has(row.pid)) {
      return false;
    }
    selected.set(row.pid, row);
    return true;
  };
  add(anchor);
  let parent = byPid.get(anchor.ppid);
  while (add(parent)) parent = byPid.get(parent!.ppid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.ppid) && add(row)) changed = true;
    }
  }
  return [...selected.values()].sort((left, right) => left.pid - right.pid);
}

function pathInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function lsofNames(output: string): { cwd: string | null; paths: string[] } {
  let descriptor: string | null = null;
  let cwd: string | null = null;
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("f")) {
      descriptor = line.slice(1);
      continue;
    }
    if (!line.startsWith("n") || line.length < 2) continue;
    const path = line.slice(1);
    if (descriptor === "cwd") cwd = path;
    else paths.push(path);
  }
  return { cwd, paths };
}

function lsofByPid(output: string): Map<number, string> {
  const result = new Map<number, string[]>();
  let current: string[] | null = null;
  for (const line of output.split("\n")) {
    const process = /^p(\d+)$/u.exec(line);
    if (process) {
      current = [];
      result.set(Number(process[1]), current);
      continue;
    }
    current?.push(line);
  }
  return new Map([...result].map(([pid, lines]) => [pid, lines.join("\n")]));
}

function trustedRegularFile(path: string, root: string, uid: number): boolean {
  let descriptor: number | null = null;
  try {
    const lexical = lstatSync(path);
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.uid !== uid) return false;
    const canonical = realpathSync.native(path);
    if (!pathInside(canonical, root)) return false;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    return opened.isFile()
      && opened.uid === uid
      && opened.dev === lexical.dev
      && opened.ino === lexical.ino;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

interface CodexThreadAssociation {
  rolloutPath: string;
  cwd: string;
}

function codexThreadAssociation(
  codexHome: string,
  canonicalHome: string,
  uid: number,
  providerSessionId: string,
): CodexThreadAssociation | null {
  const candidates: Array<{ path: string; version: number; modifiedAtMs: number }> = [];
  for (const directory of [join(codexHome, "sqlite"), codexHome]) {
    let names: string[];
    try {
      names = readdirSync(directory)
        .filter((name) => /^state_\d+\.sqlite$/u.test(name))
        .slice(0, 256);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^state_(\d+)\.sqlite$/u.exec(name);
      if (!match) continue;
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (!trustedRegularFile(path, canonicalHome, uid)) continue;
        candidates.push({ path, version: Number(match[1]), modifiedAtMs: stat.mtimeMs });
      } catch {
        // State databases may rotate while takeover is being inspected.
      }
    }
  }
  const selected = candidates.sort((left, right) =>
    right.version - left.version || right.modifiedAtMs - left.modifiedAtMs
  )[0];
  if (!selected) return null;

  const database = new DatabaseSync(selected.path, { readOnly: true });
  try {
    const columns = new Set(
      (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!["id", "rollout_path", "cwd"].every((column) => columns.has(column))) return null;
    const archived = columns.has("archived") ? "AND COALESCE(archived, 0) = 0" : "";
    const row = database.prepare(
      `SELECT rollout_path, cwd FROM threads WHERE id = ? ${archived} LIMIT 1`,
    ).get(providerSessionId) as { rollout_path?: unknown; cwd?: unknown } | undefined;
    if (!row || typeof row.rollout_path !== "string" || typeof row.cwd !== "string") return null;
    return { rolloutPath: row.rollout_path, cwd: row.cwd };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

function boundedJsonDescriptor(path: string, uid: number): Record<string, unknown> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== uid || stat.size <= 0 || stat.size > 64 * 1024) {
      throw new Error("Provider registry record is unsafe or oversized");
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) throw new Error("Provider registry record changed during read");
    const value = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Provider registry record is malformed");
    }
    return value as Record<string, unknown>;
  } finally {
    closeSync(descriptor);
  }
}

/** Production inspector: argv-only probes, exact process lineage, no shell. */
export class SystemLocalCliProcessInspector implements LocalCliProcessInspector {
  readonly #uid: number;
  readonly #home: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #run: ProbeRunner;
  readonly #codexSharedSocketPath: string | null;

  constructor(options: {
    uid?: number;
    home?: string;
    env?: NodeJS.ProcessEnv;
    run?: ProbeRunner;
    /** Exact private App Server socket whose Codex CLI clients are manager peers. */
    codexSharedSocketPath?: string;
  } = {}) {
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
    this.#home = options.home ?? homedir();
    this.#env = options.env ?? process.env;
    if (options.codexSharedSocketPath !== undefined && !isAbsolute(options.codexSharedSocketPath)) {
      throw new Error("Codex shared socket path must be absolute");
    }
    this.#codexSharedSocketPath = options.codexSharedSocketPath === undefined
      ? null
      : resolve(options.codexSharedSocketPath);
    this.#run = options.run ?? ((command, args, timeoutMs) => {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...this.#env, LC_ALL: "C", TZ: "UTC" },
      });
      return {
        stdout: result.stdout ?? "",
        status: result.status,
        error: result.error ?? null,
      };
    });
  }

  inspect(
    session: SessionView,
    expected?: LocalCliProcessIdentity,
    options: LocalCliInspectionOptions = {},
  ): LocalCliInspection {
    const pid = session.runtimePid ?? session.pid;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) {
      return { state: "mismatch", reason: "No exact local provider PID is available" };
    }
    const result = this.#run("ps", [
      "-axo",
      "pid=,ppid=,pgid=,tpgid=,uid=,tty=,lstart=,command=",
    ], 3_000);
    if (result.status !== 0 || result.error) {
      return { state: "mismatch", reason: "The provider process identity could not be revalidated" };
    }
    const rows = processRows(result.stdout);
    if (expected) {
      const identity = this.#reinspectExpected(expected, rows);
      if (identity.state !== "running" || options.revalidateAssociation === false) return identity;
      return this.#reinspectAssociation(session, expected, rows);
    }
    const anchor = rows.find((row) => row.pid === pid);
    if (!anchor) return { state: "exited" };
    if (anchor.uid !== this.#uid) return { state: "mismatch", reason: "The provider process belongs to a different UID" };
    if (anchor.providerCommand?.provider !== session.provider) {
      return { state: "mismatch", reason: "The PID no longer belongs to the selected provider executable" };
    }

    const lineage = providerLineage(anchor, rows, session.provider);
    if (lineage.length === 0) {
      return { state: "mismatch", reason: "The provider process lineage is unavailable" };
    }
    if (lineage.length > 16) {
      return { state: "mismatch", reason: "The provider process lineage is unexpectedly large" };
    }
    const pinned = this.#configuredExecutable(session.provider);
    let members: LocalCliProcessMemberIdentity[];
    try {
      members = lineage.map((row) => memberIdentity(row, this.#env));
    } catch {
      return { state: "mismatch", reason: "The provider executable identity could not be canonicalized" };
    }
    if (pinned && !members.some((member) => member.executablePath === pinned)) {
      return { state: "mismatch", reason: "The provider process does not descend from the pinned executable" };
    }

    const associated = session.provider === "claude"
      ? this.#claudeAssociation(session, anchor)
      : this.#codexAssociation(session, lineage);
    if (associated.state === "mismatch") return associated;
    if (associated.state === "pending") {
      const targetMember = members.find((member) => member.pid === anchor.pid);
      if (!targetMember || !session.cwd) {
        return { state: "mismatch", reason: "The pending provider process could not be pinned safely" };
      }
      if (session.terminal?.tty && session.terminal.tty !== anchor.tty) {
        return { state: "mismatch", reason: "The provider process moved to a different terminal" };
      }
      return {
        state: "pending",
        reason: associated.reason,
        identity: {
          pid: anchor.pid,
          uid: anchor.uid,
          executable: session.provider,
          executablePath: targetMember.executablePath,
          startedAt: anchor.startedAt,
          providerStartedAtMs: null,
          ppid: anchor.ppid,
          processGroupId: anchor.processGroupId,
          foregroundProcessGroupId: anchor.foregroundProcessGroupId,
          tty: anchor.tty,
          interactive: false,
          providerSessionId: session.providerThreadId,
          cwd: session.cwd,
          members,
        },
      };
    }
    const target = associated.target;
    const targetMember = members.find((member) => member.pid === target.pid);
    if (!targetMember) return { state: "mismatch", reason: "The associated provider process left its validated lineage" };
    if (session.terminal?.tty && session.terminal.tty !== target.tty) {
      return { state: "mismatch", reason: "The provider process moved to a different terminal" };
    }
    const foreground = target.tty !== "?" && target.tty !== "??"
      && target.foregroundProcessGroupId > 0
      && target.foregroundProcessGroupId === target.processGroupId;
    const directClaude = session.provider !== "claude"
      || (associated.kind === "interactive" && associated.entrypoint === "cli");
    const batchCommand = session.provider === "codex"
      && target.providerCommand?.args.some((argument) => ["exec", "app-server", "mcp-server", "completion"].includes(argument));
    return {
      state: "running",
      identity: {
        pid: target.pid,
        uid: target.uid,
        executable: session.provider,
        executablePath: targetMember.executablePath,
        startedAt: target.startedAt,
        providerStartedAtMs: associated.providerStartedAtMs,
        associationPath: associated.associationPath,
        ppid: target.ppid,
        processGroupId: target.processGroupId,
        foregroundProcessGroupId: target.foregroundProcessGroupId,
        tty: target.tty,
        interactive: session.kind === "interactive" && foreground && directClaude && !batchCommand,
        providerSessionId: session.providerThreadId,
        cwd: associated.cwd,
        members,
      },
    };
  }

  findAssociated(session: SessionView): LocalCliInspection {
    if (session.runtimePid || session.pid) return this.inspect(session);
    if (session.provider === "codex") return this.#findAssociatedCodex(session);
    const root = join(this.#env.CLAUDE_CONFIG_DIR ?? join(this.#home, ".claude"), "sessions");
    let entries: Array<{ isFile(): boolean; name: string }>;
    try {
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== this.#uid) {
        return { state: "mismatch", reason: "Claude's registry directory is unsafe" };
      }
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "exited" };
      return { state: "mismatch", reason: "Claude's registry directory is unavailable" };
    }
    if (entries.length > 512) {
      return { state: "mismatch", reason: "Claude's live registry is too large to inspect safely" };
    }
    let owner: LocalCliInspection | null = null;
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d+\.json$/u.test(entry.name)) continue;
      const pid = Number(entry.name.slice(0, -5));
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      let value: Record<string, unknown>;
      try {
        value = boundedJsonDescriptor(join(root, entry.name), this.#uid);
      } catch {
        continue;
      }
      if (value.sessionId !== session.providerThreadId) continue;
      if (value.pid !== pid || value.cwd !== session.cwd) {
        return { state: "mismatch", reason: "Claude's registry session identity is inconsistent" };
      }
      const inspected = this.inspect({ ...session, pid, runtimePid: pid });
      if (inspected.state === "exited") continue;
      if (inspected.state === "mismatch") return inspected;
      if (inspected.state === "pending") return inspected;
      if (owner !== null) {
        return { state: "mismatch", reason: "Multiple Claude processes claim the same session" };
      }
      owner = inspected;
    }
    return owner ?? { state: "exited" };
  }

  #findAssociatedCodex(session: SessionView): LocalCliInspection {
    if (!session.cwd) {
      return { state: "mismatch", reason: "The Codex workspace identity is unavailable" };
    }
    const result = this.#run("ps", [
      "-axo",
      "pid=,ppid=,pgid=,tpgid=,uid=,tty=,lstart=,command=",
    ], 3_000);
    if (result.status !== 0 || result.error) {
      return { state: "mismatch", reason: "Codex owner discovery could not revalidate process identities" };
    }
    const candidates = processRows(result.stdout).filter((row) =>
      row.uid === this.#uid && row.providerCommand?.provider === "codex"
    );
    if (candidates.length > 64) {
      return { state: "mismatch", reason: "Too many Codex processes are present to fence safely" };
    }
    if (candidates.length === 0) return { state: "exited" };

    const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
    const lsofResult = this.#run(
      lsof,
      ["-n", "-P", "-a", "-p", candidates.map((candidate) => candidate.pid).join(","), "-Fn"],
      3_000,
    );
    if (lsofResult.status !== 0 || lsofResult.error) {
      return { state: "mismatch", reason: "Codex owner discovery could not inspect open rollout files" };
    }
    const openByPid = lsofByPid(lsofResult.stdout);
    const expectedName = new RegExp(
      `-${session.providerThreadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.jsonl$`,
      "u",
    );
    const groups: ProcessRow[][] = [];
    const groupedPids = new Set<number>();
    for (const candidate of candidates) {
      if (groupedPids.has(candidate.pid)) continue;
      const lineage = providerLineage(candidate, candidates, "codex");
      for (const member of lineage) groupedPids.add(member.pid);
      groups.push(lineage);
    }
    if (groups.length > 32) {
      return { state: "mismatch", reason: "Too many independent Codex process groups are present to fence safely" };
    }

    let owner: LocalCliProcessIdentity | null = null;
    for (const lineage of groups) {
      const claimsThread = lineage.some((row) => {
        const args = row.providerCommand?.args ?? [];
        const resumeIndex = args.lastIndexOf("resume");
        const exactResume = resumeIndex >= 0 && args[resumeIndex + 1] === session.providerThreadId;
        const files = openByPid.get(row.pid);
        const openTranscript = files === undefined
          ? false
          : lsofNames(files).paths.some((path) => expectedName.test(path));
        return exactResume || openTranscript;
      });
      if (!claimsThread) continue;

      // Only a CLI connected to this manager's exact private App Server socket
      // shares its provider runtime. A different or unpinned `--remote` target
      // remains an independent owner and must migrate through normal takeover.
      if (this.#isTrustedCodexManagerPeer(lineage)) continue;

      const associated = this.#codexAssociation(session, lineage, openByPid);
      if (associated.state === "mismatch") return associated;
      let members: LocalCliProcessMemberIdentity[];
      try {
        members = lineage.map((row) => memberIdentity(row, this.#env));
      } catch {
        return { state: "mismatch", reason: "A Codex owner executable could not be canonicalized" };
      }
      const pinned = this.#configuredExecutable("codex");
      if (pinned && !members.some((member) => member.executablePath === pinned)) {
        return { state: "mismatch", reason: "A Codex owner does not descend from the pinned executable" };
      }
      const target = associated.target;
      const targetMember = members.find((member) => member.pid === target.pid);
      if (!targetMember) {
        return { state: "mismatch", reason: "A Codex owner left its validated process lineage" };
      }
      const foreground = target.tty !== "?" && target.tty !== "??"
        && target.foregroundProcessGroupId > 0
        && target.foregroundProcessGroupId === target.processGroupId;
      const identity: LocalCliProcessIdentity = {
        pid: target.pid,
        uid: target.uid,
        executable: "codex",
        executablePath: targetMember.executablePath,
        startedAt: target.startedAt,
        providerStartedAtMs: associated.providerStartedAtMs,
        associationPath: associated.associationPath,
        ppid: target.ppid,
        processGroupId: target.processGroupId,
        foregroundProcessGroupId: target.foregroundProcessGroupId,
        tty: target.tty,
        interactive: session.kind === "interactive" && foreground,
        providerSessionId: session.providerThreadId,
        cwd: associated.cwd,
        members,
      };
      if (owner) {
        return { state: "mismatch", reason: "Multiple standalone Codex processes claim the same rollout" };
      }
      owner = identity;
    }
    return owner ? { state: "running", identity: owner } : { state: "exited" };
  }

  #isTrustedCodexManagerPeer(lineage: readonly ProcessRow[]): boolean {
    if (this.#codexSharedSocketPath === null) return false;
    const endpoints: string[] = [];
    for (const row of lineage) {
      const args = row.providerCommand?.args ?? [];
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] as string;
        if (argument === "--remote") {
          const endpoint = args[index + 1];
          if (endpoint === undefined) return false;
          endpoints.push(endpoint);
          index += 1;
        } else if (argument.startsWith("--remote=")) {
          endpoints.push(argument.slice("--remote=".length));
        }
      }
    }
    if (
      endpoints.length === 0
      || endpoints.some((endpoint) => endpoint !== `unix://${this.#codexSharedSocketPath}`)
    ) return false;

    let members: LocalCliProcessMemberIdentity[];
    try {
      members = lineage.map((row) => memberIdentity(row, this.#env));
    } catch {
      return false;
    }
    const pinned = this.#configuredExecutable("codex");
    return pinned === null
      ? members.length > 0
      : pinned !== "<invalid>" && members.some((member) => member.executablePath === pinned);
  }

  terminate(identity: LocalCliProcessIdentity): void {
    const result = this.#run("ps", [
      "-axo",
      "pid=,ppid=,pgid=,tpgid=,uid=,tty=,lstart=,command=",
    ], 3_000);
    if (result.status !== 0 || result.error) {
      throw new Error("The provider process could not be revalidated at signal time");
    }
    const inspected = this.#reinspectExpected(identity, processRows(result.stdout));
    if (inspected.state !== "running" || !exactIdentity(inspected.identity, identity)) {
      throw new Error(
        inspected.state === "mismatch" || inspected.state === "pending"
          ? inspected.reason
          : "The provider process exited before SIGTERM",
      );
    }
    process.kill(identity.pid, "SIGTERM");
  }

  #reinspectExpected(
    expected: LocalCliProcessIdentity,
    rows: readonly ProcessRow[],
  ): LocalCliInspection {
    const members = expected.members ?? [];
    if (members.length === 0) {
      const row = rows.find((candidate) => candidate.pid === expected.pid);
      if (!row) return { state: "exited" };
      const command = row.providerCommand;
      if (row.uid !== expected.uid || command?.provider !== expected.executable || row.startedAt !== expected.startedAt) {
        return { state: "mismatch", reason: "The provider process identity changed while awaiting exit" };
      }
      return { state: "running", identity: expected };
    }
    const expectedByPid = new Map(members.map((member) => [member.pid, member]));
    let alive = 0;
    for (const member of members) {
      const row = rows.find((candidate) => candidate.pid === member.pid);
      if (!row) continue;
      alive += 1;
      if (row.uid !== expected.uid || row.providerCommand?.provider !== expected.executable ||
          !sameMember(row, member, this.#env)) {
        return { state: "mismatch", reason: "The provider process lineage changed while awaiting exit" };
      }
    }
    if (alive === 0) return { state: "exited" };
    const unexpected = rows.some((row) =>
      row.uid === expected.uid
      && row.processGroupId === expected.processGroupId
      && row.providerCommand?.provider === expected.executable
      && !expectedByPid.has(row.pid)
    );
    if (unexpected) {
      return { state: "mismatch", reason: "The provider process lineage spawned an unvalidated replacement" };
    }
    return { state: "running", identity: expected };
  }

  #reinspectAssociation(
    session: SessionView,
    expected: LocalCliProcessIdentity,
    rows: readonly ProcessRow[],
  ): LocalCliInspection {
    const target = rows.find((row) => row.pid === expected.pid);
    // A signalled native leaf may disappear before its wrapper. Identity-only
    // polling still waits for every recorded member, but there is no remaining
    // writer target whose provider association could be re-read.
    if (!target) return { state: "running", identity: expected };
    const expectedPids = new Set((expected.members ?? []).map((member) => member.pid));
    const lineage = expectedPids.size > 0
      ? rows.filter((row) => expectedPids.has(row.pid))
      : providerLineage(target, rows, session.provider);
    const associated = session.provider === "claude"
      ? this.#claudeAssociation(session, target)
      : this.#codexAssociation(session, lineage);
    if (associated.state === "mismatch") return associated;
    if (associated.state === "pending") {
      return { state: "pending", identity: expected, reason: associated.reason };
    }
    const associationWasPinned = expected.associationPath !== undefined;
    if (associated.target.pid !== expected.pid || associated.cwd !== expected.cwd ||
        (associationWasPinned &&
          associated.providerStartedAtMs !== (expected.providerStartedAtMs ?? null)) ||
        (associationWasPinned && associated.associationPath !== expected.associationPath)) {
      return { state: "mismatch", reason: "The provider session association changed during takeover" };
    }
    const foreground = target.tty !== "?" && target.tty !== "??"
      && target.foregroundProcessGroupId > 0
      && target.foregroundProcessGroupId === target.processGroupId;
    const directClaude = session.provider !== "claude"
      || (associated.kind === "interactive" && associated.entrypoint === "cli");
    const batchCommand = session.provider === "codex"
      && target.providerCommand?.args.some((argument) =>
        ["exec", "app-server", "mcp-server", "completion"].includes(argument)
      );
    if (expected.interactive === true && (!foreground || !directClaude || batchCommand)) {
      return { state: "mismatch", reason: "The provider process is no longer a foreground interactive CLI" };
    }
    return {
      state: "running",
      identity: {
        ...expected,
        providerStartedAtMs: associated.providerStartedAtMs,
        associationPath: associated.associationPath,
        interactive: session.kind === "interactive" && foreground && directClaude && !batchCommand,
      },
    };
  }

  #configuredExecutable(provider: Provider): string | null {
    const configured = provider === "claude"
      ? this.#env.AGENT_MANAGER_CLAUDE_EXECUTABLE
      : this.#env.AGENT_MANAGER_CODEX_EXECUTABLE;
    if (!configured) return null;
    try {
      return executablePath(configured, this.#env);
    } catch {
      return "<invalid>";
    }
  }

  #claudeAssociation(
    session: SessionView,
    processRow: ProcessRow,
  ): {
    state: "ok";
    cwd: string;
    target: ProcessRow;
    providerStartedAtMs: number;
    associationPath: string;
      entrypoint: string | null;
      kind: string | null;
    } |
    { state: "pending"; reason: string } |
    { state: "mismatch"; reason: string } {
    const root = join(this.#env.CLAUDE_CONFIG_DIR ?? join(this.#home, ".claude"), "sessions");
    const registryPath = join(root, `${String(processRow.pid)}.json`);
    try {
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== this.#uid) {
        return { state: "mismatch", reason: "Claude's registry directory is unsafe" };
      }
      let registryStat;
      try {
        registryStat = lstatSync(registryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            state: "pending",
            reason: "Claude's exact live registry record is not ready yet",
          };
        }
        throw error;
      }
      if (
        registryStat.isSymbolicLink()
        || !registryStat.isFile()
        || registryStat.uid !== this.#uid
        || registryStat.size > 64 * 1024
      ) {
        return { state: "mismatch", reason: "Claude's exact live registry record is unsafe" };
      }
      if (registryStat.size === 0) {
        return {
          state: "pending",
          reason: "Claude's exact live registry record is not ready yet",
        };
      }
      const value = boundedJsonDescriptor(registryPath, this.#uid);
      if (value.sessionId !== session.providerThreadId || value.pid !== processRow.pid) {
        return { state: "mismatch", reason: "Claude's registry no longer associates this PID with the session" };
      }
      if (typeof value.procStart !== "string" || value.procStart !== processRow.startedAt) {
        return { state: "mismatch", reason: "Claude's registry process-start identity no longer matches" };
      }
      const providerStartedAtMs = typeof value.startedAt === "number"
        && Number.isSafeInteger(value.startedAt)
        && value.startedAt > 0
        ? value.startedAt
        : null;
      if (providerStartedAtMs === null) {
        return { state: "mismatch", reason: "Claude's high-resolution process identity is unavailable" };
      }
      if (Math.abs(providerStartedAtMs - processRow.startedAtMs) > 10_000) {
        return { state: "mismatch", reason: "Claude's high-resolution process identity no longer matches" };
      }
      const cwd = typeof value.cwd === "string" ? value.cwd : null;
      if (!cwd || cwd !== session.cwd) {
        return { state: "mismatch", reason: "Claude's registry workspace no longer matches the session" };
      }
      return {
        state: "ok",
        cwd,
        target: processRow,
        providerStartedAtMs,
        associationPath: realpathSync.native(registryPath),
        entrypoint: typeof value.entrypoint === "string" ? value.entrypoint : null,
        kind: typeof value.kind === "string" ? value.kind : null,
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT"
        || error instanceof SyntaxError
        || (error instanceof Error && error.message === "Provider registry record changed during read")
      ) {
        return {
          state: "pending",
          reason: "Claude's exact live registry record is not ready yet",
        };
      }
      return { state: "mismatch", reason: "Claude's exact live registry record is unavailable" };
    }
  }

  #codexAssociation(
    session: SessionView,
    lineage: readonly ProcessRow[],
    knownOpenByPid?: ReadonlyMap<number, string>,
  ): {
    state: "ok";
    cwd: string;
    target: ProcessRow;
    providerStartedAtMs: number | null;
    associationPath: string;
    entrypoint: null;
    kind: null;
  } |
    { state: "mismatch"; reason: string } {
    const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
    const codexHome = this.#env.CODEX_HOME ?? join(this.#home, ".codex");
    const root = join(codexHome, "sessions");
    let canonicalHome: string;
    let canonicalRoot: string;
    try {
      const homeStat = lstatSync(codexHome);
      const rootStat = lstatSync(root);
      if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== this.#uid ||
          !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== this.#uid) {
        return { state: "mismatch", reason: "Codex's live transcript root is unsafe" };
      }
      canonicalHome = realpathSync.native(codexHome);
      canonicalRoot = realpathSync.native(root);
      if (!pathInside(canonicalRoot, canonicalHome)) {
        return { state: "mismatch", reason: "Codex's live transcript root is unsafe" };
      }
    } catch {
      return { state: "mismatch", reason: "Codex's live transcript root is unavailable" };
    }
    const expectedName = new RegExp(`-${session.providerThreadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.jsonl$`, "u");
    const databaseAssociation = codexThreadAssociation(
      codexHome,
      canonicalHome,
      this.#uid,
      session.providerThreadId,
    );
    if (databaseAssociation &&
        (!expectedName.test(databaseAssociation.rolloutPath) ||
          !trustedRegularFile(databaseAssociation.rolloutPath, canonicalRoot, this.#uid))) {
      return { state: "mismatch", reason: "Codex's state database points outside the trusted live root" };
    }
    let openByPid: ReadonlyMap<number, string>;
    if (knownOpenByPid) {
      openByPid = knownOpenByPid;
    } else {
      const lsofResult = this.#run(
        lsof,
        ["-n", "-P", "-a", "-p", lineage.map((candidate) => candidate.pid).join(","), "-Fn"],
        3_000,
      );
      if (lsofResult.status !== 0 || lsofResult.error) {
        return { state: "mismatch", reason: "Codex rollout association could not be revalidated" };
      }
      openByPid = lsofByPid(lsofResult.stdout);
    }
    for (const candidate of [...lineage].reverse()) {
      const processFiles = openByPid.get(candidate.pid);
      if (processFiles === undefined) continue;
      const open = lsofNames(processFiles);
      const openTranscript = open.paths.find((path) => expectedName.test(path));
      const args = candidate.providerCommand?.args ?? [];
      const resumeIndex = args.lastIndexOf("resume");
      const exactResume = resumeIndex >= 0 && args[resumeIndex + 1] === session.providerThreadId;
      if (!openTranscript && !exactResume) continue;
      const transcript = openTranscript ?? databaseAssociation?.rolloutPath ?? null;
      if (!transcript || !expectedName.test(transcript) ||
          !trustedRegularFile(transcript, canonicalRoot, this.#uid)) {
        return { state: "mismatch", reason: "Codex's rollout association is outside the trusted live root" };
      }
      if (openTranscript && databaseAssociation &&
          realpathSync.native(openTranscript) !== realpathSync.native(databaseAssociation.rolloutPath)) {
        return { state: "mismatch", reason: "Codex's process and state database disagree on the rollout" };
      }
      const cwd = open.cwd;
      if (!cwd || cwd !== session.cwd ||
          (databaseAssociation && databaseAssociation.cwd !== session.cwd)) {
        return { state: "mismatch", reason: "Codex's process workspace no longer matches the session" };
      }
      return {
        state: "ok",
        cwd,
        target: candidate,
        providerStartedAtMs: null,
        associationPath: realpathSync.native(transcript),
        entrypoint: null,
        kind: null,
      };
    }
    return { state: "mismatch", reason: "Codex could not be associated with the exact trusted rollout" };
  }
}
