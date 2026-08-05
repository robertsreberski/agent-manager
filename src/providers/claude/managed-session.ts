import { AsyncInbox } from "./async-inbox.ts";
import {
  CLAUDE_MANAGER_OWNER_ENV,
  CLAUDE_MANAGER_OWNER_VALUE,
} from "../hooks/claude-source.ts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  type ClaudeActivity,
  type ClaudeCanUseToolOptions,
  type ClaudeCliHandoff,
  type ClaudeElicitationRequest,
  type ClaudeElicitationResult,
  type ClaudeEffortLevel,
  type ClaudeInterruptResult,
  type ClaudeManagedResumeConfig,
  type ClaudeManagedDormantConfig,
  type ClaudeManagedSessionConfig,
  type ClaudeManagedSessionSnapshot,
  type ClaudeMessageListener,
  type ClaudePendingRequest,
  type ClaudePermissionMode,
  type ClaudePermissionUpdate,
  type ClaudePermissionResult,
  type ClaudeRequestResponse,
  type ClaudeSdkQuery,
  type ClaudeSdkMessage,
  type ClaudeSdkRuntime,
  type ClaudeSdkUserMessage,
  type ClaudeSessionListener,
  type ClaudeStagedMessage,
} from "./types.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PermissionPending {
  public: ClaudePendingRequest;
  type: "permission";
  input: Record<string, unknown>;
  suggestions: ClaudePermissionUpdate[];
  toolUseId: string;
  promise: Promise<ClaudePermissionResult>;
  settle(result: ClaudePermissionResult): void;
  abort(): void;
}

interface ElicitationPending {
  public: ClaudePendingRequest;
  type: "elicitation";
  promise: Promise<ClaudeElicitationResult>;
  settle(result: ClaudeElicitationResult): void;
  abort(): void;
}

type InternalPending = PermissionPending | ElicitationPending;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation was cancelled"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = (): void => finish(() => reject(
      signal.reason ?? new Error("Operation was cancelled"),
    ));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function nonEmptyText(text: string, field: string): string {
  if (text.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return text;
}

function cloneHandoff(handoff: ClaudeCliHandoff | null): ClaudeCliHandoff | null {
  if (!handoff) return null;
  return {
    ...handoff,
    command: {
      ...handoff.command,
      args: [...handoff.command.args],
    },
  };
}

/**
 * Owns exactly one Claude Agent SDK Query. It never discovers, adopts, or
 * resumes an arbitrary live Claude process; callers must supply a manager-owned
 * persisted session id when using `resume()`.
 */
export class ClaudeManagedSession {
  readonly #runtime: ClaudeSdkRuntime;
  readonly #config: ClaudeManagedSessionConfig;
  readonly #localId: string;
  readonly #startedAt: string;
  readonly #listeners = new Set<ClaudeSessionListener>();
  readonly #messageListeners = new Set<ClaudeMessageListener>();
  readonly #unobservedMessages: ClaudeSdkMessage[] = [];
  readonly #pending = new Map<string, InternalPending>();
  readonly #resolvedRequests = new Map<
    string,
    ClaudePermissionResult | ClaudeElicitationResult
  >();
  readonly #outstandingMessageIds = new Set<string>();
  readonly #stillQueuedMessageIds = new Set<string>();
  readonly #backgroundTaskIds = new Set<string>();
  readonly #stagedMessages: ClaudeStagedMessage[] = [];
  readonly #closedQueries = new WeakSet<ClaudeSdkQuery>();

  #query: ClaudeSdkQuery | null = null;
  #inbox: AsyncInbox<ClaudeSdkUserMessage> | null = null;
  #queryAbortController: AbortController | null = null;
  #consumerPromise: Promise<void> | null = null;
  #cleanupQuery: ClaudeSdkQuery | null = null;
  #disposePromise: Promise<void> | null = null;
  #ready = deferred<void>();
  #epoch = 0;
  #initialized = false;
  #generation = 0;
  #sessionId: string | null = null;
  #resumedFrom: string | null = null;
  #owner: "manager" | "native" = "manager";
  #providerActivity: ClaudeActivity = "starting";
  #mode: ClaudePermissionMode;
  #desiredMode: ClaudePermissionMode;
  #model: string | null = null;
  #desiredModel: string | null;
  #effort: ClaudeEffortLevel | null;
  #claudeCodeVersion: string | null = null;
  #capabilities: string[] = [];
  #canSteer = false;
  #queueKnowledge: "known" | "unknown" = "known";
  #handoff: ClaudeCliHandoff | null = null;
  #handoffDisconnect: Promise<void> | null = null;
  #lastError: string | null = null;
  #updatedAt: string;
  #disposed = false;
  #messageObservationStarted = false;

  private constructor(
    runtime: ClaudeSdkRuntime,
    config: ClaudeManagedSessionConfig,
  ) {
    if (runtime.sdkVersion !== CLAUDE_AGENT_SDK_VERSION) {
      throw new Error(
        `Unsupported Claude Agent SDK ${runtime.sdkVersion}; expected ${CLAUDE_AGENT_SDK_VERSION}`,
      );
    }
    if (config.mode === "bypassPermissions" && !config.allowDangerouslySkipPermissions) {
      throw new Error(
        "bypassPermissions requires allowDangerouslySkipPermissions: true",
      );
    }
    if (
      config.claudeCodeExecutable !== undefined
      && config.claudeCodeExecutable.trim().length === 0
    ) {
      throw new Error("claudeCodeExecutable must not be empty");
    }
    this.#runtime = runtime;
    this.#config = { ...config };
    this.#localId = runtime.randomUUID();
    this.#startedAt = runtime.now().toISOString();
    this.#updatedAt = this.#startedAt;
    this.#mode = config.mode;
    this.#desiredMode = config.mode;
    this.#desiredModel = config.model ?? null;
    this.#effort = config.effort ?? null;
  }

  static async start(
    runtime: ClaudeSdkRuntime,
    config: ClaudeManagedSessionConfig,
    signal?: AbortSignal,
  ): Promise<ClaudeManagedSession> {
    const session = new ClaudeManagedSession(runtime, config);
    try {
      await session.#connect(null, config.initialMessage, signal);
      return session;
    } catch (error) {
      try {
        await session.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Claude session initialization and cleanup both failed",
        );
      }
      throw error;
    }
  }

  static async resume(
    runtime: ClaudeSdkRuntime,
    config: ClaudeManagedResumeConfig,
    signal?: AbortSignal,
  ): Promise<ClaudeManagedSession> {
    nonEmptyText(config.sessionId, "sessionId");
    const session = new ClaudeManagedSession(runtime, config);
    session.#resumedFrom = config.sessionId;
    try {
      await session.#connect(config.sessionId, config.initialMessage, signal);
      return session;
    } catch (error) {
      try {
        await session.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Claude session resume and cleanup both failed",
        );
      }
      throw error;
    }
  }

  static dormant(
    runtime: ClaudeSdkRuntime,
    config: ClaudeManagedDormantConfig,
  ): ClaudeManagedSession {
    nonEmptyText(config.sessionId, "sessionId");
    const session = new ClaudeManagedSession(runtime, config);
    session.#sessionId = config.sessionId;
    session.#resumedFrom = config.sessionId;
    session.#model = config.model ?? null;
    session.#providerActivity = "closed";
    return session;
  }

  /**
   * Opens a new, still-unpublished SDK owner for this exact dormant
   * conversation. The dormant object remains unchanged so the adapter can
   * durably commit the ownership transition before swapping its public entry,
   * or dispose the returned owner and keep this object on any failure.
   *
   * Concurrency is intentionally coordinated by the adapter: it reserves the
   * provider session before calling this method and blocks native attach until
   * commit/abort. The checks on both sides of the async SDK initialization make
   * identity or workspace drift fail closed even if this dormant object changes
   * while the provider is starting.
   */
  async resumeDormantExact(
    expected: {
      sessionId: string;
      cwd: string;
      mode: ClaudePermissionMode;
      model?: string;
      effort?: ClaudeEffortLevel;
    },
    signal?: AbortSignal,
  ): Promise<ClaudeManagedSession> {
    const sessionId = nonEmptyText(expected.sessionId, "sessionId");
    const cwd = nonEmptyText(expected.cwd, "cwd");
    signal?.throwIfAborted();
    if (this.#disposed) throw new Error("Claude managed session is disposed");
    if (this.#sessionId !== sessionId || this.#resumedFrom !== sessionId) {
      throw new Error("Claude dormant resume identity does not match");
    }
    if (this.#config.cwd !== cwd) {
      throw new Error("Claude dormant resume workspace does not match");
    }
    if (
      this.#owner !== "manager"
      || this.#providerActivity !== "closed"
      || this.#query !== null
      || this.#inbox !== null
      || this.#queryAbortController !== null
      || this.#handoff !== null
      || this.#pending.size > 0
      || this.#stagedMessages.length > 0
      || this.#outstandingMessageIds.size > 0
      || this.#stillQueuedMessageIds.size > 0
      || this.#queueKnowledge !== "known"
    ) {
      throw new Error("Claude session is not an exact dormant resume target");
    }

    const generation = this.#generation;
    const resumeConfig: ClaudeManagedResumeConfig = {
      sessionId,
      cwd,
      mode: expected.mode,
      ...(this.#config.claudeCodeExecutable
        ? { claudeCodeExecutable: this.#config.claudeCodeExecutable }
        : {}),
      ...(this.#config.persistSession !== undefined
        ? { persistSession: this.#config.persistSession }
        : {}),
      ...(expected.model !== undefined ? { model: expected.model } : {}),
      ...(expected.effort !== undefined ? { effort: expected.effort } : {}),
      ...(this.#config.environment
        ? { environment: { ...this.#config.environment } }
        : {}),
      ...(this.#config.allowDangerouslySkipPermissions !== undefined
        ? {
            allowDangerouslySkipPermissions:
              this.#config.allowDangerouslySkipPermissions,
          }
        : {}),
    };
    const resumed = await ClaudeManagedSession.resume(
      this.#runtime,
      resumeConfig,
      signal,
    );
    try {
      signal?.throwIfAborted();
      if (
        this.#disposed
        || this.#generation !== generation
        || this.#sessionId !== sessionId
        || this.#config.cwd !== cwd
        || this.#owner !== "manager"
        || this.#providerActivity !== "closed"
        || this.#query !== null
        || this.#handoff !== null
      ) {
        throw new Error("Claude dormant ownership changed during resume");
      }
      if (
        resumed.snapshot.sessionId !== sessionId
        || resumed.snapshot.resumedFrom !== sessionId
        || resumed.snapshot.cwd !== cwd
      ) {
        throw new Error("Claude dormant resume returned a different identity or workspace");
      }
      return resumed;
    } catch (error) {
      await resumed.dispose();
      throw error;
    }
  }

  get snapshot(): ClaudeManagedSessionSnapshot {
    const pendingRequests = [...this.#pending.values()]
      .map((item) => structuredClone(item.public))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const activity =
      this.#owner === "native"
        ? "native"
        : pendingRequests.length > 0
          ? "requires_action"
          : this.#providerActivity;

    return {
      localId: this.#localId,
      sessionId: this.#sessionId,
      resumedFrom: this.#resumedFrom,
      cwd: this.#config.cwd,
      owner: this.#owner,
      activity,
      mode: this.#mode,
      desiredMode: this.#desiredMode,
      model: this.#model,
      desiredModel: this.#desiredModel,
      effort: this.#effort,
      sdkVersion: this.#runtime.sdkVersion,
      claudeCodeVersion: this.#claudeCodeVersion,
      capabilities: [...this.#capabilities],
      canSteer: this.#canSteer,
      pendingRequests,
      stagedMessages: this.#stagedMessages.map((message) => ({ ...message })),
      outstandingMessageIds: [...this.#outstandingMessageIds],
      stillQueuedMessageIds: [...this.#stillQueuedMessageIds],
      queueKnowledge: this.#queueKnowledge,
      handoff: cloneHandoff(this.#handoff),
      lastError: this.#lastError,
      generation: this.#generation,
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
    };
  }

  subscribe(listener: ClaudeSessionListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  onMessage(listener: ClaudeMessageListener): () => void {
    this.#messageObservationStarted = true;
    this.#messageListeners.add(listener);
    for (const message of this.#unobservedMessages.splice(0)) {
      try {
        listener(message);
      } catch {
        // Replay observers have the same isolation as live observers.
      }
    }
    return () => this.#messageListeners.delete(listener);
  }

  send(text: string, delivery: "queue" | "steer" = "queue"): string {
    this.#assertManagerControl();
    this.#requireLiveConsumer();
    if (delivery === "steer" && !this.#canSteer) {
      throw new Error(
        `Steer-now is unavailable for Claude Code ${this.#claudeCodeVersion ?? "before initialization"}`,
      );
    }

    const uuid = this.#runtime.randomUUID();
    const normalizedText = nonEmptyText(text, "message");
    if (delivery === "queue" && !this.#canDispatchQueuedMessage()) {
      this.#stagedMessages.push({
        id: uuid,
        text: normalizedText,
        enqueuedAt: this.#runtime.now().toISOString(),
      });
      this.#touch();
      return uuid;
    }

    this.#dispatchMessage(uuid, normalizedText, delivery === "steer" ? "now" : "later");
    if (this.#providerActivity === "idle") this.#providerActivity = "running";
    this.#touch();
    return uuid;
  }

  removeStagedMessage(id: string): boolean {
    this.#assertManagerControl();
    const index = this.#stagedMessages.findIndex((message) => message.id === id);
    if (index < 0) return false;
    this.#stagedMessages.splice(index, 1);
    this.#touch();
    return true;
  }

  async interrupt(): Promise<ClaudeInterruptResult> {
    this.#assertManagerControl();
    const { query } = this.#requireLiveConsumer();
    const receipt = await query.interrupt();
    this.#stillQueuedMessageIds.clear();
    if (!receipt) {
      this.#queueKnowledge = "unknown";
      this.#touch();
      return {
        receiptSupported: false,
        stillQueuedMessageIds: [],
        cancelledMessageIds: [],
      };
    }

    for (const id of receipt.still_queued) {
      this.#stillQueuedMessageIds.add(id);
    }
    this.#queueKnowledge = "known";
    this.#touch();
    return {
      receiptSupported: true,
      stillQueuedMessageIds: [...receipt.still_queued],
      cancelledMessageIds: [...(receipt.cancelled ?? [])],
    };
  }

  async setMode(mode: ClaudePermissionMode): Promise<void> {
    this.#assertManagerControl();
    if (mode === "bypassPermissions" && !this.#config.allowDangerouslySkipPermissions) {
      throw new Error(
        "bypassPermissions was not selected when this session was created",
      );
    }
    const { query } = this.#requireLiveConsumer();
    await query.setPermissionMode(mode);
    this.#desiredMode = mode;
    this.#mode = mode;
    this.#touch();
  }

  async setModel(model?: string): Promise<void> {
    this.#assertManagerControl();
    const normalized = model === undefined ? undefined : nonEmptyText(model, "model");
    const { query } = this.#requireLiveConsumer();
    await query.setModel(normalized);
    this.#desiredModel = normalized ?? null;
    this.#model = normalized ?? null;
    this.#touch();
  }

  async setEffort(effort: ClaudeEffortLevel | null): Promise<void> {
    this.#assertManagerControl();
    const { query } = this.#requireLiveConsumer();
    await query.applyFlagSettings({ effortLevel: effort });
    this.#effort = effort;
    this.#touch();
  }

  supportedModels() {
    this.#assertManagerControl();
    const { query } = this.#requireLiveConsumer();
    return query.supportedModels();
  }

  /**
   * Stops only the manager-owned SDK query. The resumable conversation object
   * deliberately remains alive so ending web control cannot erase the native
   * resume path or turn a durable transcript into an unreachable orphan.
   */
  async end(): Promise<void> {
    this.#assertManagerControl();
    const settled = this.#disconnectQuery(new Error("Claude managed control was ended"));
    this.#abortAllPending();
    this.#stagedMessages.splice(0);
    this.#outstandingMessageIds.clear();
    this.#stillQueuedMessageIds.clear();
    this.#backgroundTaskIds.clear();
    this.#queueKnowledge = "known";
    this.#providerActivity = "closed";
    this.#touch();
    await settled;
  }

  respondToRequest(id: string, response: ClaudeRequestResponse): void {
    const request = this.#pending.get(id);
    if (!request) throw new Error(`Claude request ${id} is no longer pending`);

    if (request.type === "elicitation") {
      if (response.decision === "accept") {
        request.settle(
          response.content
            ? { action: "accept", content: { ...response.content } }
            : { action: "accept" },
        );
      } else if (
        response.decision === "decline" ||
        response.decision === "cancel"
      ) {
        request.settle({ action: response.decision });
      } else {
        throw new Error(`Response ${response.decision} cannot answer an elicitation`);
      }
      return;
    }

    if (response.decision === "answer") {
      if (request.public.kind !== "question") {
        throw new Error("Only AskUserQuestion requests accept answers");
      }
      request.settle({
        behavior: "allow",
        updatedInput: {
          ...request.input,
          answers: { ...response.answers },
        },
        toolUseID: request.toolUseId,
        decisionClassification: "user_temporary",
      });
      return;
    }

    if (response.decision === "allow") {
      if (response.persist === true && request.suggestions.length === 0) {
        throw new Error("Claude did not expose a persistent permission choice");
      }
      request.settle({
        behavior: "allow",
        updatedInput: response.updatedInput
          ? { ...response.updatedInput }
          : { ...request.input },
        ...(response.persist === true
          ? { updatedPermissions: structuredClone(request.suggestions) }
          : {}),
        toolUseID: request.toolUseId,
        decisionClassification: response.persist === true
          ? "user_permanent"
          : "user_temporary",
      });
      return;
    }

    if (response.decision === "deny") {
      request.settle({
        behavior: "deny",
        message: nonEmptyText(response.reason, "denial reason"),
        interrupt: response.interrupt ?? false,
        toolUseID: request.toolUseId,
        decisionClassification: "user_reject",
      });
      return;
    }

    throw new Error(`Response ${response.decision} cannot answer a permission`);
  }

  async prepareCliHandoff(
    handoffId = this.#runtime.randomUUID(),
    signal?: AbortSignal,
  ): Promise<ClaudeCliHandoff> {
    this.#assertManagerControl();
    signal?.throwIfAborted();
    if (!this.#sessionId) throw new Error("Claude session has not initialized");
    const terminalConsumer =
      (this.#providerActivity === "closed" || this.#providerActivity === "failed")
      && this.#query === null
      && this.#inbox === null;
    if (this.snapshot.activity !== "idle" && !terminalConsumer) {
      throw new Error("Claude CLI handoff requires an idle session");
    }
    if (this.#pending.size > 0) {
      throw new Error("Claude CLI handoff cannot abandon pending requests");
    }
    if (
      this.#outstandingMessageIds.size > 0 ||
      this.#stillQueuedMessageIds.size > 0 ||
      (this.#inbox?.bufferedCount ?? 0) !== 0 ||
      this.#stagedMessages.length > 0 ||
      this.#queueKnowledge !== "known"
    ) {
      throw new Error("Claude CLI handoff requires a known-empty input queue");
    }

    const now = this.#runtime.now().toISOString();
    this.#handoff = {
      id: handoffId,
      state: "prepared",
      sessionId: this.#sessionId,
      cwd: this.#config.cwd,
      command: {
        executable: this.#config.claudeCodeExecutable
          ?? this.#runtime.claudeCodeExecutable
          ?? "claude",
        args: ["--resume", this.#sessionId],
        cwd: this.#config.cwd,
      },
      preparedAt: now,
      attachedAt: null,
      exitedAt: null,
      wrapperPid: null,
      exitCode: null,
      error: null,
    };
    this.#owner = "native";
    const disconnect = this.#disconnectQuery(new Error("Claude ownership transferred to the native CLI"));
    this.#handoffDisconnect = disconnect;
    // Publish foreign authority before waiting for provider cleanup. A timeout
    // can now only initiate reclaim; it can never restore a stale writable
    // manager projection while this disconnect completes in the background.
    this.#touch();
    await waitWithSignal(disconnect, signal);
    signal?.throwIfAborted();
    if (this.#handoffDisconnect === disconnect) this.#handoffDisconnect = null;
    return cloneHandoff(this.#handoff) as ClaudeCliHandoff;
  }

  markCliAttached(handoffId: string, wrapperPid: number): void {
    const handoff = this.#requireHandoff(handoffId, "prepared");
    if (!Number.isInteger(wrapperPid) || wrapperPid <= 0) {
      throw new Error("wrapperPid must be a positive integer");
    }
    handoff.state = "attached";
    handoff.wrapperPid = wrapperPid;
    handoff.attachedAt = this.#runtime.now().toISOString();
    this.#touch();
  }

  markCliExited(handoffId: string, exitCode: number | null): void {
    const handoff = this.#handoff;
    if (!handoff || handoff.id !== handoffId) {
      throw new Error(`Unknown Claude CLI handoff ${handoffId}`);
    }
    if (handoff.state !== "attached") {
      throw new Error("Only an attached Claude CLI handoff can exit");
    }
    handoff.state = "exited";
    handoff.exitCode = exitCode;
    handoff.exitedAt = this.#runtime.now().toISOString();
    this.#touch();
  }

  markCliAttachFailed(handoffId: string, error: string): void {
    const handoff = this.#requireHandoff(handoffId, "prepared");
    handoff.state = "exited";
    handoff.error = nonEmptyText(error, "handoff error");
    handoff.exitedAt = this.#runtime.now().toISOString();
    this.#touch();
  }

  async reclaimFromCli(handoffId: string, signal?: AbortSignal): Promise<void> {
    const handoff = this.#requireHandoff(handoffId, "exited");
    const sessionId = handoff.sessionId;
    // Keep native/foreign authority published until the resumed SDK stream has
    // proven the exact provider identity and version through init.
    this.#providerActivity = "starting";
    this.#lastError = null;
    this.#touch();
    try {
      const disconnect = this.#handoffDisconnect;
      if (disconnect) {
        await waitWithSignal(disconnect, signal);
        if (this.#handoffDisconnect === disconnect) this.#handoffDisconnect = null;
      }
      signal?.throwIfAborted();
      await this.#connect(sessionId, undefined, signal);
      this.#handoff = null;
      this.#owner = "manager";
      this.#touch();
    } catch (error) {
      this.#owner = "native";
      this.#handoff = handoff;
      this.#providerActivity = "failed";
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#touch();
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    const operation = (async (): Promise<void> => {
      const settled = this.#disconnectQuery(
        new Error("Claude managed session was disposed"),
      );
      this.#abortAllPending();
      this.#stagedMessages.splice(0);
      this.#outstandingMessageIds.clear();
      this.#stillQueuedMessageIds.clear();
      this.#backgroundTaskIds.clear();
      this.#queueKnowledge = "known";
      this.#providerActivity = "closed";
      this.#touch();
      await settled;
    })();
    this.#disposePromise = operation;
    void operation.catch(() => {
      // A close that positively rejects may be retried. A hanging close keeps
      // this promise installed so all concurrent callers share the same
      // indeterminate cleanup instead of issuing another close.
      if (this.#disposePromise === operation) this.#disposePromise = null;
    });
    return operation;
  }

  async #connect(
    resumeSessionId: string | null,
    initialMessage?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#disposed) throw new Error("Claude managed session is disposed");
    signal?.throwIfAborted();
    const epoch = ++this.#epoch;
    const inbox = new AsyncInbox<ClaudeSdkUserMessage>();
    const abortController = new AbortController();
    this.#inbox = inbox;
    this.#queryAbortController = abortController;
    this.#ready = deferred<void>();
    // createQuery() can fail before #connect reaches the readiness await. Keep
    // that synchronous construction failure from surfacing as an unhandled
    // rejection while preserving the original promise for the normal await.
    void this.#ready.promise.catch(() => undefined);
    this.#initialized = false;
    this.#providerActivity = "starting";
    this.#sessionId = resumeSessionId;
    this.#resumedFrom = resumeSessionId;
    this.#backgroundTaskIds.clear();

    if (initialMessage !== undefined) {
      const id = this.#runtime.randomUUID();
      this.#outstandingMessageIds.add(id);
      inbox.push(
        this.#createUserMessage(
          nonEmptyText(initialMessage, "initialMessage"),
          "later",
          id,
        ),
      );
    }

    const environment = {
      ...process.env,
      ...this.#config.environment,
      CLAUDE_AGENT_SDK_CLIENT_APP: "agent-manager",
      [CLAUDE_MANAGER_OWNER_ENV]: CLAUDE_MANAGER_OWNER_VALUE,
    };
    let consumer: Promise<void> | null = null;
    const abortFromSignal = (): void => {
      const error = signal?.reason ?? new Error("Claude session initialization was cancelled");
      if (!abortController.signal.aborted) abortController.abort(error);
      if (epoch !== this.#epoch) return;
      this.#ready.reject(error);
      void this.#disconnectQuery(error);
    };
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    try {
      const query = this.#runtime.createQuery({
        prompt: inbox,
        options: {
          abortController,
          cwd: this.#config.cwd,
          persistSession: this.#config.persistSession ?? true,
          includePartialMessages: true,
          includeHookEvents: true,
          forwardSubagentText: true,
          permissionMode: this.#desiredMode,
          allowDangerouslySkipPermissions:
            this.#config.allowDangerouslySkipPermissions ?? false,
          ...(this.#config.effort ? { effort: this.#config.effort } : {}),
          env: environment,
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          ...(this.#config.model ? { model: this.#config.model } : {}),
          ...((this.#config.claudeCodeExecutable ?? this.#runtime.claudeCodeExecutable)
            ? {
                pathToClaudeCodeExecutable:
                  this.#config.claudeCodeExecutable ?? this.#runtime.claudeCodeExecutable,
              }
            : {}),
          canUseTool: (toolName, input, options) =>
            this.#handlePermission(epoch, toolName, input, options),
          onElicitation: (request, options) =>
            this.#handleElicitation(epoch, request, options.signal),
        },
      });
      // An ownership conflict can abort synchronously from inside the runtime's
      // process/bootstrap callback, before createQuery() returns and before the
      // query is assigned to this object. Close that just-created handle
      // explicitly; the earlier abort could not see it through #query yet.
      if (signal?.aborted || epoch !== this.#epoch) {
        this.#closeQuery(query);
        throw signal?.reason ?? new Error(
          "Claude SDK ownership changed during query construction",
        );
      }
      this.#query = query;
      consumer = this.#consume(query, epoch);
      this.#consumerPromise = consumer;
      if (resumeSessionId && initialMessage === undefined) {
        // Streaming-input query() waits for the first user message before it
        // publishes system/init. A resume intentionally has no synthetic turn,
        // so use the SDK's control handshake to validate the persisted identity
        // without mutating the conversation, then retain the same live Query for
        // future input. The selected binary was independently version-probed.
        await Promise.race([
          waitWithSignal(query.initializationResult(), signal),
          this.#ready.promise,
        ]);
        if (epoch === this.#epoch && !this.#initialized) {
          this.#acceptInitializedResume(resumeSessionId);
        }
      }
      await this.#ready.promise;
      signal?.throwIfAborted();
      if (epoch !== this.#epoch || this.#query !== query || !this.#initialized) {
        throw new Error("Claude SDK ownership changed during initialization");
      }
    } catch (error) {
      this.#ready.reject(error);
      if (epoch === this.#epoch) {
        await this.#disconnectQuery(error);
        this.#providerActivity = "failed";
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#touch();
      } else if (consumer) {
        await consumer;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortFromSignal);
    }
  }

  #acceptInitializedResume(sessionId: string): void {
    const selectedExecutable =
      this.#config.claudeCodeExecutable ?? this.#runtime.claudeCodeExecutable;
    if (
      !selectedExecutable
      || this.#runtime.claudeCodeVersion === null
    ) {
      throw new Error(
        "Claude resume requires the selected Claude Code executable to be version-verified",
      );
    }
    if (this.#runtime.claudeCodeVersion !== CLAUDE_CODE_VERSION) {
      throw new Error(
        `Unsupported Claude Code ${this.#runtime.claudeCodeVersion}; expected ${CLAUDE_CODE_VERSION}`,
      );
    }
    this.#initialized = true;
    this.#sessionId = sessionId;
    this.#claudeCodeVersion = this.#runtime.claudeCodeVersion;
    this.#model = this.#config.model ?? null;
    this.#capabilities = [];
    this.#canSteer = this.#runtime.sdkVersion === CLAUDE_AGENT_SDK_VERSION;
    this.#mode = this.#desiredMode;
    this.#providerActivity = this.#outstandingMessageIds.size > 0 ? "running" : "idle";
    this.#lastError = null;
    this.#touch();
    this.#ready.resolve();
  }

  async #consume(query: ClaudeSdkQuery, epoch: number): Promise<void> {
    try {
      for await (const message of query) {
        if (epoch !== this.#epoch) return;
        await this.#handleMessage(message, query, epoch);
        if (!this.#messageObservationStarted) {
          // start() returns after init, so a fast provider can emit content
          // before the adapter has learned the manager session id. Retain that
          // short in-memory prefix and replay it to the first observer.
          this.#unobservedMessages.push(message);
          continue;
        }
        for (const listener of this.#messageListeners) {
          try {
            listener(message);
          } catch {
            // Observers cannot be allowed to terminate the provider stream.
          }
        }
      }
      if (epoch !== this.#epoch) return;
      if (!this.#initialized) {
        const error = new Error("Claude SDK ended before initialization");
        this.#ready.reject(error);
        throw error;
      }
      if (this.#owner === "manager" && !this.#disposed) {
        this.#deactivateConsumer(query, epoch);
        this.#providerActivity = "closed";
        this.#abortAllPending();
        this.#touch();
      }
    } catch (error) {
      if (epoch !== this.#epoch) return;
      this.#ready.reject(error);
      if (this.#owner === "manager" && !this.#disposed) {
        this.#deactivateConsumer(query, epoch);
        this.#providerActivity = "failed";
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#abortAllPending();
        this.#touch();
      }
    }
  }

  async #handleMessage(
    message: ClaudeSdkMessage,
    query: ClaudeSdkQuery,
    epoch: number,
  ): Promise<void> {
    if (message.type === "system" && message.subtype === "init") {
      const sessionId = message.session_id;
      const codeVersion = message.claude_code_version;
      if (codeVersion !== CLAUDE_CODE_VERSION) {
        throw new Error(
          `Unsupported Claude Code ${codeVersion}; expected ${CLAUDE_CODE_VERSION}`,
        );
      }
      if (this.#resumedFrom && sessionId !== this.#resumedFrom) {
        throw new Error(
          `Claude resumed unexpected session ${sessionId}; expected ${this.#resumedFrom}`,
        );
      }
      this.#initialized = true;
      this.#sessionId = sessionId;
      this.#claudeCodeVersion = codeVersion;
      this.#model = message.model;
      this.#capabilities = [...(message.capabilities ?? [])];
      this.#canSteer =
        this.#runtime.sdkVersion === CLAUDE_AGENT_SDK_VERSION &&
        codeVersion === CLAUDE_CODE_VERSION;
      this.#mode = message.permissionMode;
      this.#providerActivity = this.#outstandingMessageIds.size > 0 ? "running" : "idle";
      this.#lastError = null;
      this.#touch();
      this.#ready.resolve();

      if (this.#mode !== this.#desiredMode) {
        void this.#reapplyDesiredMode(query, epoch);
      }
      return;
    }

    if (message.type === "system" && message.subtype === "session_state_changed") {
      if (message.state === "idle" && this.#outstandingMessageIds.size === 0) {
        this.#queueKnowledge = "known";
        this.#stillQueuedMessageIds.clear();
      }
      this.#providerActivity = message.state === "idle"
        ? (this.#isProviderTurnDrained() ? "idle" : "running")
        : message.state;
      this.#touch();
      if (message.state === "idle") this.#dispatchNextStagedMessage();
      return;
    }

    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      this.#backgroundTaskIds.clear();
      for (const task of message.tasks) this.#backgroundTaskIds.add(task.task_id);
      this.#providerActivity = this.#isProviderTurnDrained() ? "idle" : "running";
      this.#touch();
      if (this.#providerActivity === "idle") this.#dispatchNextStagedMessage();
      return;
    }

    if (message.type === "system" && message.subtype === "status") {
      if (message.permissionMode) {
        this.#mode = message.permissionMode;
        this.#touch();
      }
      return;
    }

    if (message.type === "result") {
      let completedMessage = message.subtype === "success"
        ? message.user_message_uuid
        : undefined;
      // The SDK declares user_message_uuid optional and 0.3.220 omits it for
      // some successful streaming turns. A single tracked message is still
      // unambiguous; without this fallback the session remains permanently
      // running after an otherwise terminal result.
      if (
        message.subtype === "success"
        && !completedMessage
        && this.#outstandingMessageIds.size === 1
      ) {
        completedMessage = this.#outstandingMessageIds.values().next().value;
      }
      if (completedMessage) {
        this.#outstandingMessageIds.delete(completedMessage);
        this.#stillQueuedMessageIds.delete(completedMessage);
      }
      if (message.subtype !== "success") {
        const providerError = message.errors.join("; ") || message.subtype;
        this.#lastError = providerError;
        if (!this.#initialized) {
          const error = new Error(`Claude resume initialization failed: ${providerError}`);
          this.#ready.reject(error);
          throw error;
        }
        this.#deactivateConsumer(query, epoch);
        this.#providerActivity = "failed";
        this.#abortAllPending();
      } else if (this.#pending.size === 0) {
        // Long-lived streaming queries in SDK 0.3.220 do not consistently emit
        // session_state_changed(idle) after a terminal result. Treat the result
        // as an idle fallback only when every manager-tracked queue and
        // background-work signal drained.
        this.#providerActivity = this.#isProviderTurnDrained() ? "idle" : "running";
      }
      this.#touch();
      if (message.subtype === "success") this.#dispatchNextStagedMessage();
    }
  }

  async #reapplyDesiredMode(query: ClaudeSdkQuery, epoch: number): Promise<void> {
    try {
      await query.setPermissionMode(this.#desiredMode);
      if (epoch !== this.#epoch) return;
      this.#mode = this.#desiredMode;
      this.#touch();
    } catch (error) {
      if (epoch !== this.#epoch) return;
      this.#lastError = `Could not restore Claude permission mode: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.#touch();
    }
  }

  #handlePermission(
    epoch: number,
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudeCanUseToolOptions,
  ): Promise<ClaudePermissionResult> {
    if (epoch !== this.#epoch || this.#owner !== "manager") {
      return Promise.resolve({
        behavior: "deny",
        message: "Agent Manager no longer owns this Claude session",
        interrupt: false,
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      });
    }
    const existing = this.#pending.get(options.requestId);
    if (existing?.type === "permission") return existing.promise;
    const resolved = this.#resolvedRequests.get(
      `permission:${options.requestId}`,
    );
    if (resolved && "behavior" in resolved) return Promise.resolve(resolved);
    if (options.signal.aborted) {
      return Promise.resolve({
        behavior: "deny",
        message: "Claude cancelled the permission request",
        interrupt: false,
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      });
    }

    const requestKind =
      toolName === "AskUserQuestion"
        ? "question"
        : toolName === "ExitPlanMode"
          ? "plan-approval"
          : "permission";
    const suggestions = options.suggestions
      ? structuredClone(options.suggestions)
      : [];
    const request: ClaudePendingRequest = {
      id: options.requestId,
      kind: requestKind,
      title:
        options.title ??
        (requestKind === "question"
          ? "Claude needs your answer"
          : requestKind === "plan-approval"
            ? "Claude wants to leave plan mode"
            : `Claude requests ${options.displayName ?? toolName}`),
      toolName,
      toolUseId: options.toolUseID,
      payload: {
        input: { ...input },
        ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
        ...(options.decisionReason
          ? { decisionReason: options.decisionReason }
          : {}),
        ...(options.description ? { description: options.description } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {}),
        ...(options.agentID ? { agentId: options.agentID } : {}),
        ...(suggestions.length > 0
          ? { suggestions: structuredClone(suggestions) }
          : {}),
        ...(options.matchedAskRule
          ? { matchedAskRule: structuredClone(options.matchedAskRule) }
          : {}),
      },
      createdAt: this.#runtime.now().toISOString(),
    };
    const result = deferred<ClaudePermissionResult>();
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      this.#pending.delete(options.requestId);
      result.resolve({
        behavior: "deny",
        message: "Claude cancelled the permission request",
        interrupt: false,
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      });
      this.#cacheResolved(`permission:${options.requestId}`, {
        behavior: "deny",
        message: "Claude cancelled the permission request",
        interrupt: false,
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      });
      this.#touch();
    };
    const pending: PermissionPending = {
      public: request,
      type: "permission",
      input: { ...input },
      suggestions,
      toolUseId: options.toolUseID,
      promise: result.promise,
      settle: (value) => {
        if (settled) throw new Error(`Claude request ${options.requestId} already settled`);
        settled = true;
        options.signal.removeEventListener("abort", abort);
        this.#pending.delete(options.requestId);
        this.#cacheResolved(`permission:${options.requestId}`, value);
        result.resolve(value);
        this.#touch();
      },
      abort,
    };
    this.#pending.set(options.requestId, pending);
    options.signal.addEventListener("abort", abort, { once: true });
    this.#providerActivity = "requires_action";
    this.#touch();
    return result.promise;
  }

  #handleElicitation(
    epoch: number,
    request: ClaudeElicitationRequest,
    signal: AbortSignal,
  ): Promise<ClaudeElicitationResult> {
    if (epoch !== this.#epoch || this.#owner !== "manager" || signal.aborted) {
      return Promise.resolve({ action: "decline" });
    }
    const id = `elicitation:${request.elicitationId ?? this.#runtime.randomUUID()}`;
    const existing = this.#pending.get(id);
    if (existing?.type === "elicitation") return existing.promise;
    const resolved = this.#resolvedRequests.get(id);
    if (resolved && "action" in resolved) return Promise.resolve(resolved);

    const result = deferred<ClaudeElicitationResult>();
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      this.#pending.delete(id);
      const cancelled = { action: "cancel" } as const;
      this.#cacheResolved(id, cancelled);
      result.resolve(cancelled);
      this.#touch();
    };
    const pending: ElicitationPending = {
      public: {
        id,
        kind: "elicitation",
        title: request.title ?? request.message,
        toolName: null,
        toolUseId: null,
        payload: {
          serverName: request.serverName,
          message: request.message,
          ...(request.displayName ? { displayName: request.displayName } : {}),
          ...(request.description ? { description: request.description } : {}),
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.url ? { url: request.url } : {}),
          ...(request.elicitationId
            ? { elicitationId: request.elicitationId }
            : {}),
          ...(request.requestedSchema
            ? { requestedSchema: { ...request.requestedSchema } }
            : {}),
        },
        createdAt: this.#runtime.now().toISOString(),
      },
      type: "elicitation",
      promise: result.promise,
      settle: (value) => {
        if (settled) throw new Error(`Claude request ${id} already settled`);
        settled = true;
        signal.removeEventListener("abort", abort);
        this.#pending.delete(id);
        this.#cacheResolved(id, value);
        result.resolve(value);
        this.#touch();
      },
      abort,
    };
    this.#pending.set(id, pending);
    signal.addEventListener("abort", abort, { once: true });
    this.#providerActivity = "requires_action";
    this.#touch();
    return result.promise;
  }

  #createUserMessage(
    text: string,
    priority: "now" | "later",
    uuid: string,
  ): ClaudeSdkUserMessage {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      priority,
      origin: { kind: "human" },
      uuid,
    };
  }

  #dispatchMessage(
    id: string,
    text: string,
    priority: "now" | "later",
  ): void {
    const { inbox } = this.#requireLiveConsumer();
    this.#outstandingMessageIds.add(id);
    try {
      inbox.push(this.#createUserMessage(text, priority, id));
    } catch (error) {
      this.#outstandingMessageIds.delete(id);
      throw error;
    }
  }

  #canDispatchQueuedMessage(): boolean {
    return this.#providerActivity === "idle" && this.#isProviderTurnDrained();
  }

  #dispatchNextStagedMessage(): void {
    if (!this.#canDispatchQueuedMessage()) return;
    const next = this.#stagedMessages.shift();
    if (!next) return;
    try {
      this.#dispatchMessage(next.id, next.text, "later");
      this.#providerActivity = "running";
      this.#touch();
    } catch (error) {
      this.#stagedMessages.unshift(next);
      this.#lastError = `Could not dispatch queued Claude message: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.#touch();
    }
  }

  #assertManagerControl(): void {
    if (this.#disposed) throw new Error("Claude managed session is disposed");
    if (this.#owner !== "manager") {
      throw new Error("Claude session is controlled by the native CLI");
    }
  }

  #requireLiveConsumer(): {
    query: ClaudeSdkQuery;
    inbox: AsyncInbox<ClaudeSdkUserMessage>;
  } {
    if (
      this.#providerActivity === "closed"
      || this.#providerActivity === "failed"
      || !this.#query
      || !this.#inbox
    ) {
      throw new Error("Claude session has no live Agent SDK consumer");
    }
    return { query: this.#query, inbox: this.#inbox };
  }

  #isManagerQueueDrained(): boolean {
    return this.#isProviderTurnDrained()
      && this.#stagedMessages.length === 0;
  }

  #isProviderTurnDrained(): boolean {
    return this.#pending.size === 0
      && this.#outstandingMessageIds.size === 0
      && this.#stillQueuedMessageIds.size === 0
      && (this.#inbox?.bufferedCount ?? 0) === 0
      && this.#queueKnowledge === "known"
      && this.#backgroundTaskIds.size === 0;
  }

  #requireHandoff(
    id: string,
    state: ClaudeCliHandoff["state"],
  ): ClaudeCliHandoff {
    const handoff = this.#handoff;
    if (!handoff || handoff.id !== id) {
      throw new Error(`Unknown Claude CLI handoff ${id}`);
    }
    if (handoff.state !== state) {
      throw new Error(
        `Claude CLI handoff ${id} is ${handoff.state}, expected ${state}`,
      );
    }
    return handoff;
  }

  #disconnectQuery(reason: unknown): Promise<void> {
    const consumer = this.#consumerPromise;
    const query = this.#query ?? this.#cleanupQuery;
    this.#epoch += 1;
    this.#initialized = false;
    if (this.#queryAbortController && !this.#queryAbortController.signal.aborted) {
      this.#queryAbortController.abort(reason);
    }
    this.#queryAbortController = null;
    this.#inbox?.close();
    this.#inbox = null;
    const closeError = query ? this.#closeQuery(query) : null;
    this.#query = null;
    return (consumer ?? Promise.resolve()).then(() => {
      if (closeError !== null) throw closeError;
    });
  }

  #deactivateConsumer(query: ClaudeSdkQuery, epoch: number): void {
    if (epoch !== this.#epoch || this.#query !== query) return;
    this.#epoch += 1;
    this.#initialized = false;
    if (this.#queryAbortController && !this.#queryAbortController.signal.aborted) {
      this.#queryAbortController.abort(new Error("Claude SDK query ended"));
    }
    this.#queryAbortController = null;
    this.#inbox?.close();
    this.#inbox = null;
    this.#query = null;
    this.#closeQuery(query);
    if (
      this.#outstandingMessageIds.size > 0
      || this.#stillQueuedMessageIds.size > 0
    ) {
      this.#queueKnowledge = "unknown";
    }
  }

  #closeQuery(query: ClaudeSdkQuery): unknown | null {
    if (this.#closedQueries.has(query)) {
      if (this.#cleanupQuery === query) this.#cleanupQuery = null;
      return null;
    }
    try {
      query.close();
      this.#closedQueries.add(query);
      if (this.#cleanupQuery === query) this.#cleanupQuery = null;
      return null;
    } catch (error) {
      // Local authority is already withdrawn, but the exact query handle stays
      // quarantined so a later explicit cleanup retry can positively close it.
      this.#cleanupQuery = query;
      return error;
    }
  }

  #abortAllPending(): void {
    for (const request of [...this.#pending.values()]) request.abort();
  }

  #cacheResolved(
    id: string,
    result: ClaudePermissionResult | ClaudeElicitationResult,
  ): void {
    this.#resolvedRequests.set(id, result);
    if (this.#resolvedRequests.size <= 256) return;
    const oldest = this.#resolvedRequests.keys().next().value;
    if (typeof oldest === "string") this.#resolvedRequests.delete(oldest);
  }

  #touch(): void {
    this.#generation += 1;
    this.#updatedAt = this.#runtime.now().toISOString();
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
