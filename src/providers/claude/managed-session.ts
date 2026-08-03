import { AsyncInbox } from "./async-inbox.ts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  type ClaudeActivity,
  type ClaudeCanUseToolOptions,
  type ClaudeCliHandoff,
  type ClaudeElicitationRequest,
  type ClaudeElicitationResult,
  type ClaudeInterruptResult,
  type ClaudeManagedResumeConfig,
  type ClaudeManagedSessionConfig,
  type ClaudeManagedSessionSnapshot,
  type ClaudeMessageListener,
  type ClaudePendingRequest,
  type ClaudePermissionMode,
  type ClaudePermissionResult,
  type ClaudeRequestResponse,
  type ClaudeSdkQuery,
  type ClaudeSdkMessage,
  type ClaudeSdkRuntime,
  type ClaudeSdkUserMessage,
  type ClaudeSessionListener,
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

  #query: ClaudeSdkQuery | null = null;
  #inbox: AsyncInbox<ClaudeSdkUserMessage> | null = null;
  #ready = deferred<void>();
  #epoch = 0;
  #generation = 0;
  #sessionId: string | null = null;
  #resumedFrom: string | null = null;
  #owner: "manager" | "native" = "manager";
  #providerActivity: ClaudeActivity = "starting";
  #mode: ClaudePermissionMode;
  #desiredMode: ClaudePermissionMode;
  #claudeCodeVersion: string | null = null;
  #capabilities: string[] = [];
  #canSteer = false;
  #queueKnowledge: "known" | "unknown" = "known";
  #handoff: ClaudeCliHandoff | null = null;
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
    this.#runtime = runtime;
    this.#config = { ...config };
    this.#localId = runtime.randomUUID();
    this.#startedAt = runtime.now().toISOString();
    this.#updatedAt = this.#startedAt;
    this.#mode = config.mode;
    this.#desiredMode = config.mode;
  }

  static async start(
    runtime: ClaudeSdkRuntime,
    config: ClaudeManagedSessionConfig,
  ): Promise<ClaudeManagedSession> {
    const session = new ClaudeManagedSession(runtime, config);
    await session.#connect(null, config.initialMessage);
    return session;
  }

  static async resume(
    runtime: ClaudeSdkRuntime,
    config: ClaudeManagedResumeConfig,
  ): Promise<ClaudeManagedSession> {
    nonEmptyText(config.sessionId, "sessionId");
    const session = new ClaudeManagedSession(runtime, config);
    session.#resumedFrom = config.sessionId;
    await session.#connect(config.sessionId, config.initialMessage);
    return session;
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
      sdkVersion: this.#runtime.sdkVersion,
      claudeCodeVersion: this.#claudeCodeVersion,
      capabilities: [...this.#capabilities],
      canSteer: this.#canSteer,
      pendingRequests,
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
    const { inbox } = this.#requireLiveConsumer();
    if (delivery === "steer" && !this.#canSteer) {
      throw new Error(
        `Steer-now is unavailable for Claude Code ${this.#claudeCodeVersion ?? "before initialization"}`,
      );
    }

    const uuid = this.#runtime.randomUUID();
    const message = this.#createUserMessage(
      nonEmptyText(text, "message"),
      delivery === "steer" ? "now" : "later",
      uuid,
    );
    this.#outstandingMessageIds.add(uuid);
    try {
      inbox.push(message);
    } catch (error) {
      this.#outstandingMessageIds.delete(uuid);
      throw error;
    }
    if (this.#providerActivity === "idle") this.#providerActivity = "running";
    this.#touch();
    return uuid;
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
        "bypassPermissions was not armed when this session was created",
      );
    }
    const { query } = this.#requireLiveConsumer();
    await query.setPermissionMode(mode);
    this.#desiredMode = mode;
    this.#mode = mode;
    this.#touch();
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
      request.settle({
        behavior: "allow",
        updatedInput: response.updatedInput
          ? { ...response.updatedInput }
          : { ...request.input },
        toolUseID: request.toolUseId,
        decisionClassification: "user_temporary",
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

  prepareCliHandoff(): ClaudeCliHandoff {
    this.#assertManagerControl();
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
      this.#queueKnowledge !== "known"
    ) {
      throw new Error("Claude CLI handoff requires a known-empty input queue");
    }

    const now = this.#runtime.now().toISOString();
    const handoffId = this.#runtime.randomUUID();
    this.#handoff = {
      id: handoffId,
      state: "prepared",
      sessionId: this.#sessionId,
      cwd: this.#config.cwd,
      command: {
        executable: "claude",
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
    this.#disconnectQuery();
    this.#touch();
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

  async reclaimFromCli(handoffId: string): Promise<void> {
    const handoff = this.#requireHandoff(handoffId, "exited");
    const sessionId = handoff.sessionId;
    this.#handoff = null;
    this.#owner = "manager";
    this.#providerActivity = "starting";
    this.#lastError = null;
    this.#touch();
    try {
      await this.#connect(sessionId);
    } catch (error) {
      this.#owner = "native";
      this.#handoff = handoff;
      this.#providerActivity = "failed";
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#touch();
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disconnectQuery();
    this.#abortAllPending();
    this.#providerActivity = "closed";
    this.#touch();
  }

  async #connect(
    resumeSessionId: string | null,
    initialMessage?: string,
  ): Promise<void> {
    if (this.#disposed) throw new Error("Claude managed session is disposed");
    const epoch = ++this.#epoch;
    const inbox = new AsyncInbox<ClaudeSdkUserMessage>();
    this.#inbox = inbox;
    this.#ready = deferred<void>();
    this.#providerActivity = "starting";
    this.#sessionId = resumeSessionId;
    this.#resumedFrom = resumeSessionId;

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
      CLAUDE_AGENT_SDK_CLIENT_APP: "agent-manager/0.1.0",
    };
    try {
      const query = this.#runtime.createQuery({
        prompt: inbox,
        options: {
          cwd: this.#config.cwd,
          persistSession: true,
          includePartialMessages: true,
          includeHookEvents: true,
          forwardSubagentText: true,
          permissionMode: this.#desiredMode,
          allowDangerouslySkipPermissions:
            this.#config.allowDangerouslySkipPermissions ?? false,
          env: environment,
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          ...(this.#config.model ? { model: this.#config.model } : {}),
          canUseTool: (toolName, input, options) =>
            this.#handlePermission(epoch, toolName, input, options),
          onElicitation: (request, options) =>
            this.#handleElicitation(epoch, request, options.signal),
        },
      });
      this.#query = query;
      void this.#consume(query, epoch);
      await this.#ready.promise;
    } catch (error) {
      inbox.close();
      if (epoch === this.#epoch) {
        this.#query?.close();
        this.#query = null;
        this.#inbox = null;
      }
      this.#providerActivity = "failed";
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#ready.reject(error);
      this.#touch();
      throw error;
    }
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
      if (!this.#sessionId) {
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
      if (this.#resumedFrom && sessionId !== this.#resumedFrom) {
        throw new Error(
          `Claude resumed unexpected session ${sessionId}; expected ${this.#resumedFrom}`,
        );
      }
      this.#sessionId = sessionId;
      this.#claudeCodeVersion = codeVersion;
      this.#capabilities = [...(message.capabilities ?? [])];
      this.#canSteer =
        this.#runtime.sdkVersion === CLAUDE_AGENT_SDK_VERSION &&
        codeVersion === CLAUDE_CODE_VERSION;
      this.#mode = message.permissionMode;
      this.#lastError = null;
      this.#touch();
      this.#ready.resolve();

      if (this.#mode !== this.#desiredMode) {
        void this.#reapplyDesiredMode(query, epoch);
      }
      return;
    }

    if (message.type === "system" && message.subtype === "session_state_changed") {
      this.#providerActivity = message.state;
      if (message.state === "idle" && this.#outstandingMessageIds.size === 0) {
        this.#queueKnowledge = "known";
        this.#stillQueuedMessageIds.clear();
      }
      this.#touch();
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
      const completedMessage = message.subtype === "success"
        ? message.user_message_uuid
        : undefined;
      if (completedMessage) {
        this.#outstandingMessageIds.delete(completedMessage);
        this.#stillQueuedMessageIds.delete(completedMessage);
      }
      if (message.subtype !== "success") {
        this.#lastError = message.errors.join("; ") || message.subtype;
        this.#deactivateConsumer(query, epoch);
        this.#providerActivity = "failed";
        this.#abortAllPending();
      } else if (this.#pending.size === 0) {
        this.#providerActivity = "idle";
      }
      this.#touch();
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
        ...(options.suggestions
          ? { suggestions: structuredClone(options.suggestions) }
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

  #disconnectQuery(): void {
    this.#epoch += 1;
    this.#inbox?.close();
    this.#inbox = null;
    this.#query?.close();
    this.#query = null;
  }

  #deactivateConsumer(query: ClaudeSdkQuery, epoch: number): void {
    if (epoch !== this.#epoch || this.#query !== query) return;
    this.#epoch += 1;
    this.#inbox?.close();
    this.#inbox = null;
    this.#query = null;
    try {
      query.close();
    } catch {
      // The consumer is already detached locally. A terminal provider close
      // cannot be allowed to restore a stale writable path by interrupting
      // cleanup.
    }
    if (
      this.#outstandingMessageIds.size > 0
      || this.#stillQueuedMessageIds.size > 0
    ) {
      this.#queueKnowledge = "unknown";
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
