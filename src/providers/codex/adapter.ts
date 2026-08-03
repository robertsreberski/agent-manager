import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  CodexRpcClient,
  CodexRpcError,
  jsonRpcIdKey,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
  type MessageTransport,
} from "./rpc.ts";
import type {
  CodexAdapterCapabilities,
  CodexAdapterEvent,
  CodexAdapterEventListener,
  CodexAttachCommand,
  CodexControlCapability,
  CodexMode,
  CodexPendingRequest,
  CodexPendingRequestKind,
  CodexQueuedMessage,
  CodexThreadState,
  CodexThreadStatus,
  CodexTurnStatus,
  JsonObject,
  JsonRpcId,
  JsonValue,
  ManagedCodexAdapter,
  ResumeCodexThreadOptions,
  StartCodexThreadOptions,
} from "./types.ts";

const SUPPORTED_VERSION = "0.146.x" as const;
const ALL_CONTROLS: readonly CodexControlCapability[] = [
  "thread.start",
  "thread.resume",
  "thread.read",
  "turn.queue",
  "turn.steer",
  "turn.interrupt",
  "request.respond",
  "mode.set",
  "native.attach",
];

interface InternalThreadState {
  threadId: string;
  cwd: string | null;
  model: string | null;
  mode: CodexMode | "unknown";
  status: CodexThreadStatus;
  activeTurnId: string | null;
  lastTurnStatus: CodexTurnStatus | null;
  pendingRequests: Map<string, CodexPendingRequest>;
  queue: CodexQueuedMessage[];
  generation: number;
  dispatchPromise: Promise<void> | null;
}

export interface CodexManagedAdapterOptions {
  transport: MessageTransport;
  socketPath: string;
  codexExecutable?: string;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  now?: () => Date;
  createId?: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`Invalid Codex response: ${label}`);
  return value as JsonObject;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | null {
  return typeof value[field] === "string" ? value[field] : null;
}

function versionFromUserAgent(userAgent: string): string | null {
  return userAgent.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u)?.[1] ?? null;
}

export function isSupportedCodexVersion(version: string | null): boolean {
  if (!version) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version);
  return match?.[1] === "0" && match[2] === "146";
}

function providerMode(mode: CodexMode): "plan" | "default" {
  return mode === "planning" ? "plan" : "default";
}

function normalizedMode(value: unknown): CodexMode | "unknown" {
  if (value === "plan") return "planning";
  if (value === "default") return "execution";
  return "unknown";
}

function normalizedThreadStatus(value: unknown): CodexThreadStatus {
  if (!isObject(value)) return "unknown";
  switch (value.type) {
    case "notLoaded": return "not-loaded";
    case "idle": return "idle";
    case "active": return "running";
    case "systemError": return "system-error";
    default: return "unknown";
  }
}

function normalizedTurnStatus(value: unknown): CodexTurnStatus | null {
  return value === "completed" || value === "interrupted" ||
      value === "failed" || value === "inProgress"
    ? value
    : null;
}

function requestKind(method: string): CodexPendingRequestKind {
  switch (method) {
    case "item/commandExecution/requestApproval": return "command-approval";
    case "item/fileChange/requestApproval": return "file-change-approval";
    case "item/tool/requestUserInput": return "user-input";
    case "item/permissions/requestApproval": return "permission-approval";
    case "mcpServer/elicitation/request": return "elicitation";
    case "execCommandApproval": return "legacy-command-approval";
    case "applyPatchApproval": return "legacy-file-change-approval";
    default: return "unsupported";
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function withoutUndefined(values: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as JsonObject;
}

function extractThreadId(params: Record<string, unknown>): string | null {
  return stringField(params, "threadId") ?? stringField(params, "conversationId");
}

function assertText(text: string): void {
  if (text.trim().length === 0) throw new Error("Codex message must not be empty");
}

function assertStartOptions(
  options: StartCodexThreadOptions | ResumeCodexThreadOptions,
): void {
  if (options.sandbox && options.permissions) {
    throw new Error("Codex sandbox and permissions profile are mutually exclusive");
  }
  if ("cwd" in options && options.cwd !== undefined && !isAbsolute(options.cwd)) {
    throw new Error("Codex working directory must be absolute");
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSimpleDecision(
  value: unknown,
  allowed: readonly string[],
): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

function isValidRequestResponse(
  request: CodexPendingRequest,
  response: JsonObject,
): boolean {
  switch (request.kind) {
    case "command-approval":
    case "file-change-approval":
      return isSimpleDecision(response.decision, ["accept", "decline", "cancel"]);
    case "legacy-command-approval":
    case "legacy-file-change-approval": {
      if (isSimpleDecision(response.decision, ["approved", "abort", "timed_out"])) {
        return true;
      }
      return isObject(response.decision) &&
        isObject(response.decision.denied) &&
        typeof response.decision.denied.rejection === "string";
    }
    case "user-input": {
      if (!isObject(response.answers)) return false;
      return Object.values(response.answers).every((answer) =>
        isObject(answer) && isStringArray(answer.answers)
      );
    }
    case "permission-approval":
      return isObject(response.permissions) &&
        (response.scope === undefined || response.scope === "turn") &&
        (response.strictAutoReview === undefined ||
          response.strictAutoReview === null ||
          typeof response.strictAutoReview === "boolean");
    case "elicitation": {
      if (!isSimpleDecision(response.action, ["accept", "decline", "cancel"]) ||
          !("content" in response) || !("_meta" in response)) {
        return false;
      }
      if (!isJsonValue(response.content) || !isJsonValue(response._meta)) return false;
      // The 0.146 protocol requires both nullable fields. Decline and cancel
      // carry no form data.
      return response.action === "accept" || response.content === null;
    }
    case "unsupported":
      return false;
  }
}

function cloneRequest(request: CodexPendingRequest): CodexPendingRequest {
  return structuredClone(request);
}

function cloneQueueItem(item: CodexQueuedMessage): CodexQueuedMessage {
  return { ...item };
}

export class CodexManagedAdapter implements ManagedCodexAdapter {
  readonly rpc: CodexRpcClient;
  readonly socketPath: string;
  readonly codexExecutable: string;

  #clientName: string;
  #clientVersion: string;
  #now: () => Date;
  #createId: () => string;
  #initialized = false;
  #disposed = false;
  #runtimeAlive = true;
  #runtimeFailure: string | null = null;
  #serverVersion: string | null = null;
  #serverUserAgent: string | null = null;
  #compatibilityReason: string | null = "Adapter has not initialized";
  #enabledControls = new Set<CodexControlCapability>();
  #threads = new Map<string, InternalThreadState>();
  #listeners = new Set<CodexAdapterEventListener>();
  #removeRpcListeners: Array<() => void> = [];

  constructor(options: CodexManagedAdapterOptions) {
    if (!isAbsolute(options.socketPath)) {
      throw new Error("Codex App Server socket path must be absolute");
    }
    this.socketPath = options.socketPath;
    this.codexExecutable = options.codexExecutable ?? "codex";
    this.#clientName = options.clientName ?? "agent-manager";
    this.#clientVersion = options.clientVersion ?? "0.1.0";
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.rpc = new CodexRpcClient(
      options.transport,
      options.requestTimeoutMs ?? 30_000,
    );
    this.#removeRpcListeners.push(
      this.rpc.onNotification((notification) => this.#onNotification(notification)),
      this.rpc.onServerRequest((request) => this.#onServerRequest(request)),
      this.rpc.onClose((error) => {
        this.markRuntimeUnavailable(
          error ?? new Error("Codex App Server connection closed"),
        );
      }),
    );
  }

  get runtimeAlive(): boolean {
    return this.#runtimeAlive;
  }

  get runtimeFailure(): string | null {
    return this.#runtimeFailure;
  }

  get capabilities(): CodexAdapterCapabilities {
    const controls = ALL_CONTROLS.filter((control) =>
      this.#enabledControls.has(control)
    );
    return Object.freeze({
      runtimeAlive: this.#runtimeAlive,
      compatible: this.#runtimeAlive && isSupportedCodexVersion(this.#serverVersion),
      serverVersion: this.#serverVersion,
      serverUserAgent: this.#serverUserAgent,
      supportedVersion: SUPPORTED_VERSION,
      controls: Object.freeze(controls),
      reason: this.#compatibilityReason,
    });
  }

  async initialize(): Promise<CodexAdapterCapabilities> {
    if (this.#disposed) throw new Error("Codex adapter is disposed");
    if (this.#initialized) return this.capabilities;

    const raw = await this.rpc.request("initialize", {
      clientInfo: {
        name: this.#clientName,
        version: this.#clientVersion,
        title: "Agent Manager",
      },
      capabilities: {
        experimentalApi: true,
        // Required by the 0.146 initialize contract. Agent Manager does not
        // accept upstream attestation work on this private control channel.
        requestAttestation: false,
      },
    });
    const response = asJsonObject(raw, "initialize result");
    this.#serverUserAgent = stringField(response, "userAgent");
    this.#serverVersion = this.#serverUserAgent
      ? versionFromUserAgent(this.#serverUserAgent)
      : null;
    const compatible = isSupportedCodexVersion(this.#serverVersion);
    if (compatible) {
      this.#enabledControls = new Set(ALL_CONTROLS);
      this.#compatibilityReason = null;
    } else {
      this.#enabledControls = new Set(["thread.read"]);
      this.#compatibilityReason = this.#serverVersion
        ? `Codex ${this.#serverVersion} is outside supported range ${SUPPORTED_VERSION}`
        : "Codex App Server did not report a parseable version";
    }
    await this.rpc.notify("initialized");
    this.#initialized = true;
    return this.capabilities;
  }

  async startThread(options: StartCodexThreadOptions): Promise<CodexThreadState> {
    this.#assertControl("thread.start");
    assertStartOptions(options);
    const result = asJsonObject(await this.#call(
      "thread.start",
      "thread/start",
      withoutUndefined({
        cwd: options.cwd,
        model: options.model,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        permissions: options.permissions,
        historyMode: "paginated",
        threadSource: "agent-manager",
      }),
    ), "thread/start result");
    const state = this.#mergeThreadResponse(result);

    if (options.mode) await this.setMode(state.threadId, options.mode);
    if (options.initialMessage !== undefined) {
      this.#assertControl("turn.queue");
      assertText(options.initialMessage);
      // New App Server versions may omit or extend the creation status. Only
      // the managed thread's initial input may bypass that unknown-status gate.
      const queued = await this.#enqueueMessage(
        this.#requireThread(state.threadId),
        options.initialMessage,
        true,
      );
      if (queued.status !== "dispatched" || !queued.turnId) {
        throw new Error(
          "Codex did not acknowledge the initial message with a turn ID",
        );
      }
    }
    return this.#snapshot(this.#requireThread(state.threadId));
  }

  async resumeThread(
    threadId: string,
    options: ResumeCodexThreadOptions = {},
  ): Promise<CodexThreadState> {
    this.#assertControl("thread.resume");
    assertStartOptions(options);
    const result = asJsonObject(await this.#call(
      "thread.resume",
      "thread/resume",
      withoutUndefined({
        threadId,
        cwd: options.cwd,
        model: options.model,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        permissions: options.permissions,
        excludeTurns: false,
      }),
    ), "thread/resume result");
    return this.#mergeThreadResponse(result);
  }

  async readThread(threadId: string): Promise<CodexThreadState> {
    this.#assertControl("thread.read");
    const result = asJsonObject(await this.#call(
      "thread.read",
      "thread/read",
      { threadId, includeTurns: true },
    ), "thread/read result");
    return this.#mergeThreadResponse(result);
  }

  async queueMessage(
    threadId: string,
    text: string,
  ): Promise<CodexQueuedMessage> {
    this.#assertControl("turn.queue");
    assertText(text);
    const state = this.#requireThread(threadId);
    return this.#enqueueMessage(state, text);
  }

  async #enqueueMessage(
    state: InternalThreadState,
    text: string,
    dispatchWhenStatusUnknown = false,
  ): Promise<CodexQueuedMessage> {
    const queued: CodexQueuedMessage = {
      id: this.#createId(),
      text,
      status: "queued",
      enqueuedAt: this.#now().toISOString(),
      turnId: null,
    };
    state.queue.push(queued);
    this.#touch(state, true);
    const dispatchAlreadyInProgress = state.dispatchPromise !== null;
    const dispatch = this.#drainQueue(state, dispatchWhenStatusUnknown);
    if (dispatchAlreadyInProgress) return cloneQueueItem(queued);
    await dispatch;
    return cloneQueueItem(queued);
  }

  async steer(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<string> {
    this.#assertControl("turn.steer");
    assertText(text);
    const state = this.#requireThread(threadId);
    if (!state.activeTurnId || state.activeTurnId !== expectedTurnId) {
      throw new Error(
        `Stale Codex turn: expected ${expectedTurnId}, active ${state.activeTurnId ?? "none"}`,
      );
    }
    const result = asJsonObject(await this.#call(
      "turn.steer",
      "turn/steer",
      {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text }],
      },
    ), "turn/steer result");
    const turnId = stringField(result, "turnId");
    if (!turnId || turnId !== expectedTurnId) {
      throw new Error("Codex returned an unexpected turn ID after steering");
    }
    return turnId;
  }

  async interrupt(threadId: string, expectedTurnId: string): Promise<void> {
    this.#assertControl("turn.interrupt");
    const state = this.#requireThread(threadId);
    if (!state.activeTurnId || state.activeTurnId !== expectedTurnId) {
      throw new Error(
        `Stale Codex turn: expected ${expectedTurnId}, active ${state.activeTurnId ?? "none"}`,
      );
    }
    await this.#call("turn.interrupt", "turn/interrupt", {
      threadId,
      turnId: expectedTurnId,
    });
  }

  async respondToRequest(
    threadId: string,
    requestId: JsonRpcId,
    response: JsonObject,
  ): Promise<void> {
    this.#assertControl("request.respond");
    const state = this.#requireThread(threadId);
    const key = jsonRpcIdKey(requestId);
    const request = state.pendingRequests.get(key);
    if (!request || request.id !== requestId) {
      throw new Error("Codex request is stale, resolved, or belongs to another thread");
    }
    if (!request.respondable || !isValidRequestResponse(request, response)) {
      throw new Error(`Invalid or unsupported response for ${request.method}`);
    }
    await this.rpc.respond(request.id, response);
    state.pendingRequests.delete(key);
    this.#touch(state);
    this.#emit({
      type: "request.resolved",
      threadId,
      requestId: request.id,
    });
  }

  async setMode(threadId: string, mode: CodexMode): Promise<void> {
    this.#assertControl("mode.set");
    const state = this.#requireThread(threadId);
    if (!state.model) {
      throw new Error("Cannot change Codex mode before the thread model is known");
    }
    await this.#call("mode.set", "thread/settings/update", {
      threadId,
      collaborationMode: {
        mode: providerMode(mode),
        settings: { model: state.model },
      },
    });
    state.mode = mode;
    this.#touch(state);
  }

  getThreadState(threadId: string): CodexThreadState | null {
    const state = this.#threads.get(threadId);
    return state ? this.#snapshot(state) : null;
  }

  listThreadStates(): readonly CodexThreadState[] {
    return [...this.#threads.values()].map((state) => this.#snapshot(state));
  }

  buildAttachCommand(threadId: string): CodexAttachCommand {
    this.#assertControl("native.attach");
    this.#requireThread(threadId);
    const args = ["resume", threadId, "--remote", `unix://${this.socketPath}`];
    return Object.freeze({
      executable: this.codexExecutable,
      args: Object.freeze(args),
      display: [this.codexExecutable, ...args].map(shellQuote).join(" "),
    });
  }

  subscribe(listener: CodexAdapterEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  markRuntimeUnavailable(error: Error): void {
    if (!this.#runtimeAlive) return;
    this.#runtimeAlive = false;
    this.#runtimeFailure = error.message || "Codex App Server is unavailable";
    this.#enabledControls.clear();
    this.#compatibilityReason = `Codex App Server is unavailable: ${this.#runtimeFailure}`;

    for (const state of this.#threads.values()) {
      const pending = [...state.pendingRequests.values()];
      state.pendingRequests.clear();
      for (const item of state.queue) {
        if (item.status === "dispatching") item.status = "queued";
      }
      if (state.activeTurnId) state.lastTurnStatus = "failed";
      state.activeTurnId = null;
      state.status = "system-error";
      this.#touch(state, state.queue.length > 0);
      for (const request of pending) {
        this.#emit({
          type: "request.resolved",
          threadId: state.threadId,
          requestId: request.id,
        });
      }
    }

    this.#emit({
      type: "diagnostic",
      level: "error",
      code: "codex.connection.closed",
      message: this.#runtimeFailure,
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.markRuntimeUnavailable(new Error("Codex adapter was disposed"));
    this.#disposed = true;
    for (const remove of this.#removeRpcListeners.splice(0)) remove();
    await this.rpc.close();
    this.#listeners.clear();
  }

  async #call(
    control: CodexControlCapability,
    method: string,
    params: JsonObject,
  ): Promise<JsonValue> {
    try {
      return await this.rpc.request(method, params);
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32601) {
        this.#enabledControls.delete(control);
        this.#emit({
          type: "diagnostic",
          level: "warning",
          code: "codex.capability.unavailable",
          message: `${method} is unavailable; ${control} was disabled`,
        });
      }
      throw error;
    }
  }

  #assertControl(control: CodexControlCapability): void {
    if (!this.#initialized) throw new Error("Codex adapter is not initialized");
    if (this.#disposed) throw new Error("Codex adapter is disposed");
    if (!this.#enabledControls.has(control)) {
      throw new Error(
        `Codex control ${control} is unavailable${this.#compatibilityReason ? `: ${this.#compatibilityReason}` : ""}`,
      );
    }
  }

  #ensureThread(threadId: string): InternalThreadState {
    let state = this.#threads.get(threadId);
    if (!state) {
      state = {
        threadId,
        cwd: null,
        model: null,
        mode: "unknown",
        status: "unknown",
        activeTurnId: null,
        lastTurnStatus: null,
        pendingRequests: new Map(),
        queue: [],
        generation: 0,
        dispatchPromise: null,
      };
      this.#threads.set(threadId, state);
    }
    return state;
  }

  #requireThread(threadId: string): InternalThreadState {
    const state = this.#threads.get(threadId);
    if (!state) throw new Error(`Unknown manager-owned Codex thread: ${threadId}`);
    return state;
  }

  #mergeThreadResponse(response: JsonObject): CodexThreadState {
    const thread = asJsonObject(response.thread, "thread");
    const threadId = stringField(thread, "id");
    if (!threadId) throw new Error("Codex response did not contain a thread ID");
    const state = this.#ensureThread(threadId);
    state.cwd = stringField(response, "cwd") ?? stringField(thread, "cwd") ?? state.cwd;
    state.model = stringField(response, "model") ?? state.model;
    state.status = normalizedThreadStatus(thread.status);

    if (Array.isArray(thread.turns)) {
      const turns = thread.turns.filter(
        (turn): turn is JsonObject => isObject(turn),
      );
      const active = [...turns].reverse().find((turn) => turn.status === "inProgress");
      state.activeTurnId = active ? stringField(active, "id") : null;
      const latest = turns.at(-1);
      state.lastTurnStatus = latest ? normalizedTurnStatus(latest.status) : null;
      if (state.activeTurnId) state.status = "running";
    }
    this.#touch(state);
    return this.#snapshot(state);
  }

  #snapshot(state: InternalThreadState): CodexThreadState {
    return Object.freeze({
      threadId: state.threadId,
      cwd: state.cwd,
      model: state.model,
      mode: state.mode,
      status: state.status,
      activeTurnId: state.activeTurnId,
      lastTurnStatus: state.lastTurnStatus,
      pendingRequests: Object.freeze(
        [...state.pendingRequests.values()].map(cloneRequest),
      ),
      queue: Object.freeze(state.queue.map(cloneQueueItem)),
      generation: state.generation,
    });
  }

  #touch(state: InternalThreadState, queueChanged = false): void {
    state.generation += 1;
    const snapshot = this.#snapshot(state);
    this.#emit({ type: "state.changed", threadId: state.threadId, state: snapshot });
    if (queueChanged) {
      this.#emit({
        type: "queue.changed",
        threadId: state.threadId,
        queue: snapshot.queue,
      });
    }
  }

  async #drainQueue(
    state: InternalThreadState,
    dispatchWhenStatusUnknown = false,
  ): Promise<void> {
    if (state.dispatchPromise) return state.dispatchPromise;
    const statusAllowsDispatch = state.status === "idle" ||
      (dispatchWhenStatusUnknown && state.status === "unknown");
    if (state.activeTurnId || !statusAllowsDispatch || state.queue.length === 0) {
      return;
    }

    state.dispatchPromise = this.#dispatchNext(state).finally(() => {
      state.dispatchPromise = null;
    });
    return state.dispatchPromise;
  }

  async #dispatchNext(state: InternalThreadState): Promise<void> {
    const queued = state.queue[0];
    if (!queued) return;
    queued.status = "dispatching";
    this.#touch(state, true);
    try {
      const result = asJsonObject(await this.#call(
        "turn.queue",
        "turn/start",
        {
          threadId: state.threadId,
          input: [{ type: "text", text: queued.text }],
          clientUserMessageId: queued.id,
        },
      ), "turn/start result");
      const turn = asJsonObject(result.turn, "turn/start turn");
      const turnId = stringField(turn, "id");
      if (!turnId) throw new Error("Codex turn/start response omitted the turn ID");
      queued.status = "dispatched";
      queued.turnId = turnId;
      state.activeTurnId = turnId;
      state.status = "running";
      state.lastTurnStatus = "inProgress";
      state.queue.shift();
      this.#touch(state, true);
    } catch (error) {
      queued.status = "queued";
      this.#touch(state, true);
      throw error;
    }
  }

  #onNotification(notification: JsonRpcNotification): void {
    const params = notification.params;
    if (notification.method === "thread/started") {
      try {
        this.#mergeThreadResponse({ thread: params.thread as JsonValue });
      } catch (error) {
        this.#diagnostic("codex.notification.invalid", error);
      }
      return;
    }

    const threadId = extractThreadId(params);
    if (!threadId) return;
    const state = this.#ensureThread(threadId);

    switch (notification.method) {
      case "thread/status/changed":
        state.status = normalizedThreadStatus(params.status);
        this.#touch(state);
        if (state.status === "idle" && !state.activeTurnId) {
          void this.#drainQueue(state).catch((error) =>
            this.#diagnostic("codex.queue.dispatch_failed", error, threadId)
          );
        }
        break;
      case "thread/settings/updated": {
        if (!isObject(params.threadSettings)) return;
        const settings = params.threadSettings;
        state.cwd = stringField(settings, "cwd") ?? state.cwd;
        state.model = stringField(settings, "model") ?? state.model;
        if (isObject(settings.collaborationMode)) {
          state.mode = normalizedMode(settings.collaborationMode.mode);
        }
        this.#touch(state);
        break;
      }
      case "turn/started": {
        if (!isObject(params.turn)) return;
        state.activeTurnId = stringField(params.turn, "id");
        state.status = "running";
        state.lastTurnStatus = "inProgress";
        this.#touch(state);
        break;
      }
      case "turn/completed": {
        if (!isObject(params.turn)) return;
        const completedTurnId = stringField(params.turn, "id");
        if (state.activeTurnId && completedTurnId &&
            state.activeTurnId !== completedTurnId) {
          this.#emit({
            type: "diagnostic",
            level: "warning",
            code: "codex.turn.stale_completion",
            message: `Ignored completion for ${completedTurnId}; active turn is ${state.activeTurnId}`,
            threadId,
          });
          return;
        }
        state.activeTurnId = null;
        state.lastTurnStatus = normalizedTurnStatus(params.turn.status);
        state.status = "idle";
        this.#touch(state);
        void this.#drainQueue(state).catch((error) =>
          this.#diagnostic("codex.queue.dispatch_failed", error, threadId)
        );
        break;
      }
      case "serverRequest/resolved": {
        const requestId = params.requestId;
        if (typeof requestId !== "string" && typeof requestId !== "number") return;
        const key = jsonRpcIdKey(requestId);
        if (state.pendingRequests.delete(key)) {
          this.#touch(state);
          this.#emit({
            type: "request.resolved",
            threadId,
            requestId,
          });
        }
        break;
      }
    }
  }

  #onServerRequest(request: JsonRpcServerRequest): void {
    const threadId = extractThreadId(request.params);
    if (!threadId) {
      this.#emit({
        type: "diagnostic",
        level: "warning",
        code: "codex.request.unowned",
        message: `Ignored server request without a thread ID: ${request.method}`,
      });
      return;
    }
    const state = this.#ensureThread(threadId);
    const kind = requestKind(request.method);
    const pending: CodexPendingRequest = {
      id: request.id,
      method: request.method,
      kind,
      threadId,
      turnId: stringField(request.params, "turnId"),
      params: structuredClone(request.params),
      respondable: kind !== "unsupported",
      receivedAt: this.#now().toISOString(),
    };
    state.pendingRequests.set(jsonRpcIdKey(request.id), pending);
    this.#touch(state);
    this.#emit({
      type: "request.pending",
      threadId,
      request: cloneRequest(pending),
    });
  }

  #diagnostic(code: string, error: unknown, threadId?: string): void {
    this.#emit({
      type: "diagnostic",
      level: "error",
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(threadId ? { threadId } : {}),
    });
  }

  #emit(event: CodexAdapterEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
