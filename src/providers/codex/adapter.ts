import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ActivityMutation } from "../../activity/index.ts";
import {
  codexAccountFacts,
  parseCodexAccountRateLimits,
  parseCodexAccountUsage,
} from "./account-facts.ts";
import {
  codexActivityOffset,
  projectCodexDiagnostic,
  projectCodexNotification,
  projectCodexQueue,
  projectCodexRequestResolved,
  projectCodexServerRequest,
  recordCodexActivityOffsets,
  recordCodexTodoProjectionState,
  type CodexActivityProjection,
  type CodexTodoProjectionState,
} from "./activity-projector.ts";
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
  CodexExecutionProfile,
  CodexModelOption,
  CodexPendingRequest,
  CodexPendingRequestKind,
  CodexPendingSettings,
  CodexQueuedMessage,
  CodexReasoningEffort,
  CodexSettingsDelivery,
  CodexThreadIdentity,
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
const MAX_MODEL_OPTIONS = 64;
const MAX_MODEL_LIST_PAGES = 8;
const MAX_PENDING_ADOPTION_EVENTS = 512;
const MAX_DETACHED_THREADS = 128;
const MAX_THREAD_NAME_CODE_POINTS = 80;
const ALL_CONTROLS: readonly CodexControlCapability[] = [
  "thread.start",
  "thread.resume",
  "thread.read",
  "thread.unsubscribe",
  "thread.rename",
  "thread.archive",
  "thread.delete",
  "turn.queue",
  "turn.steer",
  "turn.interrupt",
  "request.respond",
  "profile.set",
  "model.set",
  "effort.set",
  "native.attach",
];

interface InternalThreadState {
  threadId: string;
  treeId: string | null;
  parentThreadId: string | null;
  cwd: string | null;
  name: string | null;
  preview: string | null;
  source: string | null;
  model: string | null;
  effort: CodexReasoningEffort | null;
  profile: CodexExecutionProfile | null;
  status: CodexThreadStatus;
  activeTurnId: string | null;
  /**
   * The turn a provider-authoritative `idle` status retired before its
   * `turn/completed` notification arrived. It keeps a late completion from
   * being misread as a superseded-turn anomaly.
   */
  retiredTurnId: string | null;
  lastTurnStatus: CodexTurnStatus | null;
  pendingRequests: Map<string, CodexPendingRequest>;
  queue: CodexQueuedMessage[];
  /** Observational remote exec-server presence, never client ownership. */
  executionEnvironmentIds: Set<string>;
  pendingSettings: CodexPendingSettings | null;
  nextTurnOverrides: JsonObject | null;
  generation: number;
  dispatchPromise: Promise<void> | null;
}

/**
 * Facts that belong to the provider thread rather than to one selected-detail
 * attachment. Detaching is not "end": it must not destroy the operator's queue
 * or forget a provider-confirmed profile that `thread/resume` cannot restate.
 */
interface DetachedThreadFacts {
  queue: CodexQueuedMessage[];
  profile: CodexExecutionProfile | null;
  pendingSettings: CodexPendingSettings | null;
  nextTurnOverrides: JsonObject | null;
}

type PendingAdoptionEvent =
  | { kind: "notification"; value: JsonRpcNotification }
  | { kind: "request"; value: JsonRpcServerRequest };

interface PendingAdoption {
  events: PendingAdoptionEvent[];
  overflowed: boolean;
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

export type CodexManagedCreationFailureStage = "profile" | "initial-message";
export type CodexManagedCreationFailureOutcome = "rejected" | "uncertain";

export interface CodexManagedCreationIssue {
  stage: CodexManagedCreationFailureStage;
  outcome: CodexManagedCreationFailureOutcome;
  message: string;
  /** Whether the initial prompt is known not to have run or may be running. */
  initialMessageDisposition: "not-sent" | "rejected" | "uncertain";
}

/**
 * `thread/start` is the point of no return: the provider thread already
 * exists. Callers must retain this state as a recoverable managed handle
 * instead of treating the whole create operation as if nothing happened.
 */
export class CodexManagedCreationError extends Error {
  readonly threadState: CodexThreadState;
  readonly issue: CodexManagedCreationIssue;

  constructor(threadState: CodexThreadState, issue: CodexManagedCreationIssue) {
    super(issue.message);
    this.name = "CodexManagedCreationError";
    this.threadState = threadState;
    this.issue = Object.freeze({ ...issue });
  }
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

function providerMode(profile: CodexExecutionProfile): "plan" | "default" {
  return profile === "plan" ? "plan" : "default";
}

function normalizedProfile(value: unknown): CodexExecutionProfile | null {
  if (value === "plan") return "plan";
  return null;
}

function sourceKind(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isObject(value)) return null;
  return stringField(value, "type") ?? stringField(value, "kind");
}

/**
 * A bounded single-line title derived from the operator's own text. It is only
 * ever sent to `thread/name/set`; nothing is displayed until the provider
 * accepts it.
 */
function codexThreadName(source: string | undefined): string | null {
  if (source === undefined) return null;
  const firstLine = source.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;
  const collapsed = firstLine.replaceAll(/\s+/gu, " ");
  const points = Array.from(collapsed);
  return points.length <= MAX_THREAD_NAME_CODE_POINTS
    ? collapsed
    : `${points.slice(0, MAX_THREAD_NAME_CODE_POINTS - 1).join("").trimEnd()}…`;
}

function profileSettings(
  profile: CodexExecutionProfile,
  cwd: string | null,
  model: string,
  effort: CodexReasoningEffort | null,
): JsonObject {
  const collaborationMode = {
    mode: providerMode(profile),
    // Codex 0.146 models this as a complete `Settings` object, not a patch.
    // Preserve the provider-selected defaults when the manager did not
    // explicitly request a model or effort instead of inventing either one.
    settings: {
      model,
      reasoning_effort: effort,
      developer_instructions: null,
    },
  } satisfies JsonObject;
  if (profile === "full-access") {
    return {
      collaborationMode,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  return {
    collaborationMode,
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: cwd ? [cwd] : [],
      networkAccess: false,
    },
  };
}

function settingsMatchProfile(
  settings: Record<string, unknown>,
  profile: CodexExecutionProfile,
): boolean {
  const collaboration = isObject(settings.collaborationMode)
    ? settings.collaborationMode.mode
    : null;
  const sandbox = isObject(settings.sandboxPolicy)
    ? settings.sandboxPolicy.type
    : null;
  if (profile === "full-access") {
    return collaboration === "default" &&
      settings.approvalPolicy === "never" && sandbox === "dangerFullAccess";
  }
  return collaboration === providerMode(profile) &&
    settings.approvalPolicy === "on-request" && sandbox === "workspaceWrite";
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
  return stringField(params, "threadId");
}

function notificationThreadId(notification: JsonRpcNotification): string | null {
  const direct = extractThreadId(notification.params);
  if (direct) return direct;
  if (notification.method === "thread/started" && isObject(notification.params.thread)) {
    return stringField(notification.params.thread, "id");
  }
  return null;
}

function assertText(text: string): void {
  if (text.trim().length === 0) throw new Error("Codex message must not be empty");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error);
}

function failureOutcome(error: unknown): CodexManagedCreationFailureOutcome {
  // A JSON-RPC error is an explicit provider rejection. Timeouts, transport
  // failures, and malformed success payloads cannot prove that the request did
  // not take effect, so they remain uncertain and must never be replayed.
  return error instanceof CodexRpcError ? "rejected" : "uncertain";
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
      return isSimpleDecision(response.decision, ["accept", "acceptForSession", "decline", "cancel"]);
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
  #settingsDelivery: CodexSettingsDelivery = "unavailable";
  #enabledControls = new Set<CodexControlCapability>();
  #threads = new Map<string, InternalThreadState>();
  #detachedThreads = new Map<string, DetachedThreadFacts>();
  #adoptedThreadIds = new Set<string>();
  #pendingAdoptions = new Map<string, PendingAdoption>();
  #listeners = new Set<CodexAdapterEventListener>();
  #removeRpcListeners: Array<() => void> = [];
  #activityOffsets = new Map<string, number>();
  #activityTodos = new Map<string, CodexTodoProjectionState>();

  constructor(options: CodexManagedAdapterOptions) {
    if (!isAbsolute(options.socketPath)) {
      throw new Error("Codex App Server socket path must be absolute");
    }
    this.socketPath = options.socketPath;
    this.codexExecutable = options.codexExecutable ?? "codex";
    this.#clientName = options.clientName ?? "agent-manager";
    this.#clientVersion = options.clientVersion ?? "0.2.1";
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
      settingsDelivery: this.#settingsDelivery,
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
      this.#settingsDelivery = "experimental-rpc";
      this.#compatibilityReason = null;
    } else {
      this.#enabledControls.clear();
      this.#settingsDelivery = "unavailable";
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
    // Validate all caller-controlled input before `thread/start`, after which a
    // provider resource exists and every failure needs a recovery handle.
    if (options.initialMessage !== undefined) assertText(options.initialMessage);
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
    this.#adoptedThreadIds.add(state.threadId);
    const thread = this.#requireThread(state.threadId);

    if (options.profile || options.effort) {
      const effectiveModel = options.model ?? thread.model;
      const effectiveEffort = options.effort ?? thread.effort;
      let requestedProfileSettings: JsonObject = {};
      if (options.profile) {
        if (!effectiveModel) {
          throw this.#managedCreationError(thread, {
            stage: "profile",
            outcome: "rejected",
            message: `Codex thread ${state.threadId} was created, but thread/start did not return the model required to stage its collaboration mode`,
            initialMessageDisposition: "not-sent",
          });
        }
        requestedProfileSettings = profileSettings(
          options.profile,
          state.cwd,
          effectiveModel,
          effectiveEffort,
        );
      }
      try {
        await this.#updateSettings(state.threadId, withoutUndefined({
          ...requestedProfileSettings,
          model: options.model,
          effort: options.effort,
        }), {
          ...(options.profile ? { profile: options.profile } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
        });
      } catch (error) {
        throw this.#managedCreationError(thread, {
          stage: "profile",
          outcome: failureOutcome(error),
          message: `Codex thread ${state.threadId} was created, but its requested settings could not be staged: ${errorMessage(error)}`,
          initialMessageDisposition: "not-sent",
        });
      }
    }
    await this.#nameManagedThread(thread, options);
    if (options.initialMessage !== undefined) {
      // New App Server versions may omit or extend the creation status. Only
      // the managed thread's initial input may bypass that unknown-status gate.
      let queued: CodexQueuedMessage;
      let dispatchMayHaveStarted = false;
      try {
        this.#assertControl("turn.queue");
        dispatchMayHaveStarted = true;
        queued = await this.#enqueueMessage(thread, options.initialMessage, true);
      } catch (error) {
        const outcome = dispatchMayHaveStarted ? failureOutcome(error) : "rejected";
        const disposition = dispatchMayHaveStarted ? outcome : "not-sent";
        this.#discardUnacknowledgedInitialMessage(thread);
        if (outcome === "uncertain" && !thread.activeTurnId) {
          thread.status = "unknown";
        }
        throw this.#managedCreationError(thread, {
          stage: "initial-message",
          outcome,
          message: outcome === "uncertain"
            ? `Codex thread ${state.threadId} was created, but the initial message acknowledgement is uncertain: ${errorMessage(error)}`
            : disposition === "not-sent"
            ? `Codex thread ${state.threadId} was created, but the initial message was not sent: ${errorMessage(error)}`
            : `Codex thread ${state.threadId} was created, but Codex rejected the initial message: ${errorMessage(error)}`,
          initialMessageDisposition: disposition,
        });
      }
      if (queued.status !== "dispatched" || !queued.turnId) {
        this.#discardUnacknowledgedInitialMessage(thread);
        throw this.#managedCreationError(thread, {
          stage: "initial-message",
          outcome: "rejected",
          message: `Codex thread ${state.threadId} was created, but the initial message was not dispatched`,
          initialMessageDisposition: "not-sent",
        });
      }
    }
    return this.#snapshot(thread);
  }

  /**
   * A raw UUID is not a usable card or drawer title, but the thread-name RPC is
   * version/capability gated: it is attempted only while advertised, a
   * rejection withdraws the control, and the name stays honestly unset rather
   * than being faked locally. It never blocks the initial message.
   */
  async #nameManagedThread(
    state: InternalThreadState,
    options: StartCodexThreadOptions,
  ): Promise<void> {
    if (state.name) return;
    const name = codexThreadName(options.name ?? options.initialMessage);
    if (!name || !this.#enabledControls.has("thread.rename")) return;
    try {
      await this.renameThread(state.threadId, name);
    } catch (error) {
      this.#emit({
        type: "diagnostic",
        level: "warning",
        code: "codex.thread.name_unavailable",
        message: `Codex thread ${state.threadId} could not be named: ${errorMessage(error)}`,
        threadId: state.threadId,
      });
    }
  }

  async resumeThread(
    threadId: string,
    options: ResumeCodexThreadOptions = {},
  ): Promise<CodexThreadState> {
    await this.#resumeThread(threadId, options, null);
    return this.#reattachThread(threadId);
  }

  async #resumeThread(
    threadId: string,
    options: ResumeCodexThreadOptions,
    expectedIdentity: CodexThreadIdentity | null,
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
        // The experimental 0.146 runtime honors this schema-omitted flag for
        // both legacy and paginated histories. Selection needs identity and
        // live events, not an unbounded replay of historical turns.
        excludeTurns: true,
      }),
    ), "thread/resume result");
    const returnedThread = asJsonObject(result.thread, "thread");
    const returnedThreadId = stringField(returnedThread, "id");
    if (returnedThreadId !== threadId) {
      throw new Error(
        `Codex thread/resume returned ${returnedThreadId ?? "no thread ID"} for requested thread ${threadId}`,
      );
    }
    if (expectedIdentity) {
      const returnedTreeId = stringField(returnedThread, "sessionId");
      const returnedParentThreadId = stringField(returnedThread, "parentThreadId");
      const returnedCwd = stringField(result, "cwd") ?? stringField(returnedThread, "cwd");
      if (returnedTreeId !== expectedIdentity.treeId ||
          returnedParentThreadId !== expectedIdentity.parentThreadId ||
          returnedCwd !== expectedIdentity.cwd) {
        throw new Error("Codex thread/resume changed the validated managed identity");
      }
    }
    const state = this.#mergeThreadResponse(result);
    this.#adoptedThreadIds.add(threadId);
    return state;
  }

  async readThread(threadId: string): Promise<CodexThreadState> {
    this.#assertControl("thread.read");
    const result = asJsonObject(await this.#call(
      "thread.read",
      "thread/read",
      // Agent Manager creates paginated-history threads. Codex 0.146 rejects
      // includeTurns=true for those threads, and startup recovery only needs
      // bounded identity/status metadata; selected activity has its own stream.
      { threadId, includeTurns: false },
    ), "thread/read result");
    const returnedThread = asJsonObject(result.thread, "thread");
    const returnedThreadId = stringField(returnedThread, "id");
    if (returnedThreadId !== threadId) {
      throw new Error(
        `Codex thread/read returned ${returnedThreadId ?? "no thread ID"} for requested thread ${threadId}`,
      );
    }
    return this.#mergeThreadResponse(result);
  }

  async readAccountFacts() {
    this.#assertAccountReadable();
    const optionalRead = async <T>(
      method: "account/usage/read" | "account/rateLimits/read",
      parse: (value: unknown) => T,
    ): Promise<T | null> => {
      try {
        return parse(await this.rpc.request(method));
      } catch (error) {
        if (error instanceof CodexRpcError && error.code === -32601) return null;
        throw error;
      }
    };
    const [usage, rateLimits] = await Promise.all([
      optionalRead("account/usage/read", parseCodexAccountUsage),
      optionalRead("account/rateLimits/read", parseCodexAccountRateLimits),
    ]);
    return codexAccountFacts({ usage, rateLimits });
  }

  async listModels(signal?: AbortSignal): Promise<readonly CodexModelOption[]> {
    this.#assertModelCatalogReadable();
    signal?.throwIfAborted();
    const models: CodexModelOption[] = [];
    const values = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      signal?.throwIfAborted();
      const result = asJsonObject(await this.rpc.request("model/list", {
        limit: MAX_MODEL_OPTIONS - models.length,
        includeHidden: false,
        ...(cursor === null ? {} : { cursor }),
      }, signal), "model/list result");
      if (!Array.isArray(result.data)) {
        throw new Error("Invalid Codex response: model/list data");
      }
      for (const raw of result.data) {
        const model = asJsonObject(raw, "model/list model");
        if (typeof model.hidden !== "boolean") {
          throw new Error("Invalid Codex response: model/list model hidden");
        }
        const catalogId = stringField(model, "id");
        if (!catalogId || catalogId !== catalogId.trim() || catalogId.length > 256 ||
            /[\u0000-\u001f\u007f]/u.test(catalogId)) {
          throw new Error("Invalid Codex response: model/list catalog identity");
        }
        if (model.hidden) continue;
        const value = stringField(model, "model");
        const label = stringField(model, "displayName");
        const description = stringField(model, "description");
        const defaultEffort = stringField(model, "defaultReasoningEffort");
        if (!value || value !== value.trim() || value.length > 256 ||
            /[\u0000-\u001f\u007f]/u.test(value)) {
          throw new Error("Invalid Codex response: model/list model identifier");
        }
        if (!label || label !== label.trim() || label.length > 128 ||
            /[\u0000-\u001f\u007f]/u.test(label)) {
          throw new Error("Invalid Codex response: model/list display name");
        }
        if (description === null || description.length > 1_000) {
          throw new Error("Invalid Codex response: model/list description");
        }
        if (typeof model.isDefault !== "boolean" || !defaultEffort ||
            !Array.isArray(model.supportedReasoningEfforts)) {
          throw new Error("Invalid Codex response: model/list effort metadata");
        }
        const efforts: string[] = [];
        const seenEfforts = new Set<string>();
        for (const rawEffort of model.supportedReasoningEfforts) {
          const effort = asJsonObject(rawEffort, "model/list effort");
          const effortValue = stringField(effort, "reasoningEffort");
          const effortDescription = stringField(effort, "description");
          if (!effortValue || effortValue !== effortValue.trim() || effortValue.length > 64 ||
              /[\u0000-\u001f\u007f]/u.test(effortValue) || effortDescription === null ||
              effortDescription.length > 1_000 || seenEfforts.has(effortValue)) {
            throw new Error("Invalid Codex response: model/list effort option");
          }
          seenEfforts.add(effortValue);
          efforts.push(effortValue);
        }
        if (efforts.length > 16 || !seenEfforts.has(defaultEffort)) {
          throw new Error("Invalid Codex response: model/list default effort");
        }
        if (values.has(value)) {
          throw new Error(`Invalid Codex response: duplicate model ${value}`);
        }
        values.add(value);
        models.push(Object.freeze({
          value,
          label,
          description: description.length > 0 ? description : null,
          isDefault: model.isDefault,
          defaultEffort,
          efforts: Object.freeze(efforts),
        }));
        if (models.length > MAX_MODEL_OPTIONS) {
          throw new Error("Codex model catalog exceeds the bounded picker limit");
        }
      }

      const nextCursor = result.nextCursor ?? null;
      if (nextCursor !== null && typeof nextCursor !== "string") {
        throw new Error("Invalid Codex response: model/list next cursor");
      }
      if (nextCursor === null) return Object.freeze(models);
      if (models.length >= MAX_MODEL_OPTIONS) {
        throw new Error("Codex model catalog exceeds the bounded picker limit");
      }
      if (!nextCursor || cursors.has(nextCursor)) {
        throw new Error("Invalid Codex response: repeated model/list cursor");
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("Codex model catalog exceeded the bounded pagination limit");
  }

  async adoptThread(
    threadId: string,
    expectedIdentity: CodexThreadIdentity,
  ): Promise<CodexThreadState> {
    if (expectedIdentity.threadId !== threadId) {
      throw new Error("Codex adoption received a mismatched expected thread ID");
    }
    if (this.#adoptedThreadIds.has(threadId)) {
      const existing = this.#threads.get(threadId);
      if (existing) {
        const snapshot = this.#snapshot(existing);
        this.#assertAdoptedIdentity(snapshot, expectedIdentity);
        return snapshot;
      }
    }
    if (this.#pendingAdoptions.has(threadId)) {
      throw new Error(`Codex thread ${threadId} is already being adopted`);
    }
    const pending: PendingAdoption = { events: [], overflowed: false };
    this.#pendingAdoptions.set(threadId, pending);
    try {
      await this.#resumeThread(threadId, {}, expectedIdentity);
      this.#pendingAdoptions.delete(threadId);
      if (pending.overflowed) {
        await this.releaseThread(threadId).catch(() => undefined);
        throw new Error("Codex adoption event buffer overflowed before identity validation");
      }
      for (const event of pending.events) {
        if (event.kind === "notification") this.#onNotification(event.value);
        else this.#onServerRequest(event.value);
      }
      const adopted = this.getThreadState(threadId);
      if (!adopted) throw new Error("Codex thread disappeared during adoption");
      this.#assertAdoptedIdentity(adopted, expectedIdentity);
      // Retained facts are restored only after the provider identity validates,
      // so a mismatched thread can never inherit another thread's queue.
      return this.#reattachThread(threadId);
    } catch (error) {
      this.#pendingAdoptions.delete(threadId);
      if (this.#adoptedThreadIds.has(threadId)) {
        await this.releaseThread(threadId).catch(() => undefined);
      } else {
        this.#threads.delete(threadId);
      }
      throw error;
    }
  }

  async releaseThread(threadId: string): Promise<void> {
    this.#assertControl("thread.unsubscribe");
    if (!this.#adoptedThreadIds.has(threadId)) {
      this.#threads.delete(threadId);
      this.#activityOffsets.delete(threadId);
      this.#activityTodos.delete(threadId);
      return;
    }
    await this.#call("thread.unsubscribe", "thread/unsubscribe", { threadId });
    this.#adoptedThreadIds.delete(threadId);
    this.#detachThread(threadId);
  }

  /**
   * Releasing the selected-detail plane detaches this client from the thread.
   * It is not "end", so the manager queue and the provider-confirmed settings
   * survive against the exact thread identity instead of being discarded — the
   * queue activity item stays truthful and the message is still delivered when
   * selection re-adopts the thread.
   */
  #detachThread(threadId: string): void {
    const state = this.#threads.get(threadId);
    this.#threads.delete(threadId);
    if (!state) return;
    state.pendingRequests.clear();
    const retained = state.queue.filter((item) => item.status === "queued");
    if (retained.length !== state.queue.length) {
      // A dispatch was in flight. Its provider outcome is unknown, so it is
      // never re-queued: replaying it could start a second turn for one
      // message. The operator sees the removal instead of a silent drop.
      this.#commitQueue(state, (queue) => {
        queue.splice(0, queue.length, ...retained);
      });
      this.#emit({
        type: "diagnostic",
        level: "warning",
        code: "codex.queue.dispatch_unresolved",
        message: `A Codex message was dispatching when thread ${threadId} was released and was not re-queued`,
        threadId,
      });
    }
    if (
      retained.length === 0 && state.profile === null
      && state.pendingSettings === null && state.nextTurnOverrides === null
    ) return;
    this.#detachedThreads.delete(threadId);
    this.#detachedThreads.set(threadId, {
      queue: retained.map(cloneQueueItem),
      profile: state.profile,
      pendingSettings: state.pendingSettings,
      nextTurnOverrides: state.nextTurnOverrides,
    });
    for (const oldest of this.#detachedThreads.keys()) {
      if (this.#detachedThreads.size <= MAX_DETACHED_THREADS) break;
      this.#detachedThreads.delete(oldest);
      this.#emit({
        type: "diagnostic",
        level: "warning",
        code: "codex.queue.detached_evicted",
        message: `Retained detached state for Codex thread ${oldest} was evicted at the bounded limit`,
        threadId: oldest,
      });
    }
  }

  /** Restore the detached facts of a re-adopted thread and release its queue. */
  #reattachThread(threadId: string): CodexThreadState {
    const state = this.#requireThread(threadId);
    const detached = this.#detachedThreads.get(threadId);
    if (detached) {
      this.#detachedThreads.delete(threadId);
      state.profile ??= detached.profile;
      state.pendingSettings ??= detached.pendingSettings;
      if (detached.nextTurnOverrides) {
        state.nextTurnOverrides = {
          ...detached.nextTurnOverrides,
          ...(state.nextTurnOverrides ?? {}),
        };
      }
      if (detached.queue.length > 0) {
        this.#commitQueue(state, (queue) => queue.unshift(...detached.queue));
      } else {
        this.#touch(state);
      }
    }
    void this.#drainQueue(state).catch((error) =>
      this.#diagnostic("codex.queue.dispatch_failed", error, threadId)
    );
    return this.#snapshot(state);
  }

  async queueMessage(
    threadId: string,
    text: string,
  ): Promise<CodexQueuedMessage> {
    this.#assertControl("turn.queue");
    assertText(text);
    const state = this.#requireThread(threadId);
    this.#assertThreadWritable(state);
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
    this.#commitQueue(state, (queue) => queue.push(queued));
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
    this.#assertThreadWritable(state);
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
    this.#assertThreadWritable(state);
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
    this.#assertThreadWritable(state);
    const key = jsonRpcIdKey(requestId);
    const request = state.pendingRequests.get(key);
    if (!request || request.id !== requestId) {
      throw new Error("Codex request is stale, resolved, or belongs to another thread");
    }
    if (!request.respondable || !isValidRequestResponse(request, response)) {
      throw new Error(`Invalid or unsupported response for ${request.method}`);
    }
    // Every client subscribed to the shared App Server thread receives the same
    // request. Sending a response only submits this client's candidate; the
    // provider's `serverRequest/resolved` notification is the authoritative
    // first-response-wins outcome. Mark this local candidate non-respondable so
    // one UI cannot submit twice while another client may still win the race.
    request.respondable = false;
    this.#touch(state);
    try {
      await this.rpc.respond(request.id, response);
    } catch (error) {
      // Restore the action only if the request still exists. A concurrent
      // provider resolution must win over a failed local send.
      if (state.pendingRequests.get(key) === request) {
        request.respondable = request.kind !== "unsupported";
        this.#touch(state);
      }
      throw error;
    }
  }

  async setProfile(
    threadId: string,
    profile: CodexExecutionProfile,
  ): Promise<void> {
    this.#assertControl("profile.set");
    const state = this.#requireThread(threadId);
    if (!state.model) {
      throw new Error(
        `Codex thread ${threadId} has no provider-confirmed model for collaboration mode settings`,
      );
    }
    await this.#updateSettings(
      threadId,
      profileSettings(profile, state.cwd, state.model, state.effort),
      { profile },
    );
  }

  async setModel(threadId: string, model: string): Promise<void> {
    this.#assertControl("model.set");
    const normalized = model.trim();
    if (!normalized) throw new Error("Codex model must not be empty");
    await this.#updateSettings(threadId, { model: normalized }, { model: normalized });
  }

  async setEffort(
    threadId: string,
    effort: CodexReasoningEffort,
  ): Promise<void> {
    this.#assertControl("effort.set");
    const normalized = effort.trim();
    if (!normalized) throw new Error("Codex effort must not be empty");
    await this.#updateSettings(threadId, { effort: normalized }, { effort: normalized });
  }

  async removeQueuedMessage(threadId: string, messageId: string): Promise<void> {
    const state = this.#requireThread(threadId);
    const index = state.queue.findIndex((item) => item.id === messageId);
    if (index < 0) throw new Error(`Unknown queued Codex message: ${messageId}`);
    if (state.queue[index]?.status === "dispatching") {
      throw new Error("A dispatching Codex message cannot be removed");
    }
    this.#commitQueue(state, (queue) => queue.splice(index, 1));
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    this.#assertControl("thread.rename");
    const state = this.#requireThread(threadId);
    this.#assertThreadWritable(state);
    const normalized = name.trim();
    if (!normalized) throw new Error("Codex thread name must not be empty");
    await this.#call("thread.rename", "thread/name/set", { threadId, name: normalized });
    state.name = normalized;
    this.#touch(state);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.#assertControl("thread.archive");
    const state = this.#requireThread(threadId);
    this.#assertThreadWritable(state);
    if (state.activeTurnId || state.status === "running") {
      throw new Error("A running Codex thread cannot be archived");
    }
    await this.#call("thread.archive", "thread/archive", { threadId });
    this.#forgetThread(threadId, "archived");
  }

  async deleteThread(threadId: string): Promise<void> {
    this.#assertControl("thread.delete");
    const state = this.#requireThread(threadId);
    this.#assertThreadWritable(state);
    if (state.activeTurnId || state.status === "running") {
      throw new Error("A running Codex thread cannot be deleted");
    }
    await this.#call("thread.delete", "thread/delete", { threadId });
    this.#forgetThread(threadId, "deleted");
  }

  async endThread(threadId: string): Promise<void> {
    const state = this.#requireThread(threadId);
    this.#assertThreadWritable(state);
    if (state.activeTurnId) await this.interrupt(threadId, state.activeTurnId);
    this.#commitQueue(state, (queue) => {
      queue.length = 0;
    });
    await this.releaseThread(threadId);
    // "End" is the one lifecycle action that really does discard the manager
    // queue, so nothing may be retained for a later re-adoption.
    this.#detachedThreads.delete(threadId);
    this.#activityOffsets.delete(threadId);
    this.#activityTodos.delete(threadId);
    this.#emit({ type: "thread.removed", threadId, reason: "ended" });
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
    this.#settingsDelivery = "unavailable";
    this.#compatibilityReason = `Codex App Server is unavailable: ${this.#runtimeFailure}`;

    for (const state of this.#threads.values()) {
      const pending = [...state.pendingRequests.values()];
      state.pendingRequests.clear();
      if (state.activeTurnId) state.lastTurnStatus = "failed";
      state.activeTurnId = null;
      state.retiredTurnId = null;
      state.status = "system-error";
      this.#commitQueue(state, (queue) => {
        for (const item of queue) {
          if (item.status === "dispatching") item.status = "queued";
        }
      });
      for (const request of pending) {
        this.#emit({
          type: "request.resolved",
          threadId: state.threadId,
          requestId: request.id,
        });
      }
      // Runtime loss does not mean the provider conversation was reset. Keep
      // the bounded combined transcript/API history in the hub and append the
      // exact crash fact; the replacement adapter will reconcile fresh state.
      const mutations: ActivityMutation[] = [
        ...projectCodexDiagnostic(
          state.threadId,
          "codex.connection.closed",
          this.#runtimeFailure,
          this.#now().toISOString(),
        ).mutations,
      ];
      this.#emitActivityProjection({ threadId: state.threadId, mutations });
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
    this.#pendingAdoptions.clear();
    this.#detachedThreads.clear();
    this.#activityOffsets.clear();
    this.#activityTodos.clear();
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

  async #updateSettings(
    threadId: string,
    providerSettings: JsonObject,
    pending: Omit<CodexPendingSettings, "delivery">,
  ): Promise<void> {
    const state = this.#requireThread(threadId);
    this.#assertThreadWritable(state);
    if (state.activeTurnId || state.status === "running") {
      throw new Error("Codex settings can only be changed while the thread is idle");
    }
    if (this.#settingsDelivery === "unavailable") {
      throw new Error("Codex settings are unavailable on this App Server");
    }

    const previousPending = state.pendingSettings;
    const previousOverrides = state.nextTurnOverrides;
    state.pendingSettings = {
      ...pending,
      delivery: this.#settingsDelivery === "experimental-rpc"
        ? "experimental-rpc"
        : "next-turn",
    };
    this.#touch(state);

    if (this.#settingsDelivery === "next-turn") {
      state.nextTurnOverrides = {
        ...(state.nextTurnOverrides ?? {}),
        ...providerSettings,
      };
      this.#touch(state);
      return;
    }

    try {
      await this.rpc.request("thread/settings/update", {
        threadId,
        ...providerSettings,
      });
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32601) {
        this.#settingsDelivery = "next-turn";
        state.pendingSettings = { ...pending, delivery: "next-turn" };
        state.nextTurnOverrides = {
          ...(state.nextTurnOverrides ?? {}),
          ...providerSettings,
        };
        this.#emit({
          type: "diagnostic",
          level: "warning",
          code: "codex.settings.next_turn_only",
          message: "thread/settings/update is unavailable; settings will apply to the next turn",
          threadId,
        });
        this.#touch(state);
        return;
      }
      state.pendingSettings = previousPending;
      state.nextTurnOverrides = previousOverrides;
      this.#touch(state);
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

  #assertAccountReadable(): void {
    if (!this.#initialized) throw new Error("Codex adapter is not initialized");
    if (this.#disposed) throw new Error("Codex adapter is disposed");
    if (!this.#runtimeAlive || !isSupportedCodexVersion(this.#serverVersion)) {
      throw new Error(
        `Codex account facts are unavailable${this.#compatibilityReason ? `: ${this.#compatibilityReason}` : ""}`,
      );
    }
  }

  #assertModelCatalogReadable(): void {
    if (!this.#initialized) throw new Error("Codex adapter is not initialized");
    if (this.#disposed) throw new Error("Codex adapter is disposed");
    if (!this.#runtimeAlive || !isSupportedCodexVersion(this.#serverVersion)) {
      throw new Error(
        `Codex model catalog is unavailable${this.#compatibilityReason ? `: ${this.#compatibilityReason}` : ""}`,
      );
    }
  }

  #assertThreadWritable(state: InternalThreadState): void {
    if (!this.#adoptedThreadIds.has(state.threadId)) {
      throw new Error(`Codex thread ${state.threadId} has not been adopted by this client`);
    }
  }

  #forgetThread(
    threadId: string,
    reason: "archived" | "deleted",
  ): void {
    const known = this.#adoptedThreadIds.has(threadId) || this.#threads.has(threadId);
    this.#adoptedThreadIds.delete(threadId);
    this.#threads.delete(threadId);
    this.#detachedThreads.delete(threadId);
    this.#activityOffsets.delete(threadId);
    this.#activityTodos.delete(threadId);
    if (known) this.#emit({ type: "thread.removed", threadId, reason });
  }

  #ensureThread(threadId: string): InternalThreadState {
    let state = this.#threads.get(threadId);
    if (!state) {
      state = {
        threadId,
        treeId: null,
        parentThreadId: null,
        cwd: null,
        name: null,
        preview: null,
        source: null,
        model: null,
        effort: null,
        profile: null,
        status: "unknown",
        activeTurnId: null,
        retiredTurnId: null,
        lastTurnStatus: null,
        pendingRequests: new Map(),
        queue: [],
        executionEnvironmentIds: new Set(),
        pendingSettings: null,
        nextTurnOverrides: null,
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

  #assertAdoptedIdentity(
    state: CodexThreadState,
    expected: CodexThreadIdentity,
  ): void {
    if (state.threadId !== expected.threadId || state.treeId !== expected.treeId ||
        state.parentThreadId !== expected.parentThreadId || state.cwd !== expected.cwd) {
      throw new Error("Codex adoption changed the validated managed identity");
    }
  }

  #bufferPendingAdoption(
    threadId: string,
    event: PendingAdoptionEvent,
  ): boolean {
    const pending = this.#pendingAdoptions.get(threadId);
    if (!pending) return false;
    if (pending.events.length >= MAX_PENDING_ADOPTION_EVENTS) {
      pending.overflowed = true;
    } else {
      pending.events.push(event);
    }
    return true;
  }

  #discardUnacknowledgedInitialMessage(state: InternalThreadState): void {
    if (state.queue.length === 0) return;
    // A failed or ambiguous initial dispatch must never remain in the ordinary
    // FIFO: adding a later message could otherwise replay the original prompt
    // without an explicit recovery decision.
    this.#commitQueue(state, (queue) => queue.shift());
  }

  #managedCreationError(
    state: InternalThreadState,
    issue: CodexManagedCreationIssue,
  ): CodexManagedCreationError {
    this.#touch(state);
    this.#emit({
      type: "diagnostic",
      level: "error",
      code: "codex.creation.recovery_required",
      message: issue.message,
      threadId: state.threadId,
    });
    this.#emitActivityProjection(projectCodexDiagnostic(
      state.threadId,
      "codex.creation.recovery_required",
      issue.message,
      this.#now().toISOString(),
    ));
    return new CodexManagedCreationError(this.#snapshot(state), issue);
  }

  #mergeThreadResponse(response: JsonObject): CodexThreadState {
    const thread = asJsonObject(response.thread, "thread");
    const threadId = stringField(thread, "id");
    if (!threadId) throw new Error("Codex response did not contain a thread ID");
    const state = this.#ensureThread(threadId);
    state.treeId = stringField(thread, "sessionId") ?? state.treeId;
    state.parentThreadId = stringField(thread, "parentThreadId") ??
      state.parentThreadId;
    state.cwd = stringField(response, "cwd") ?? stringField(thread, "cwd") ?? state.cwd;
    state.name = stringField(thread, "name") ?? state.name;
    state.preview = stringField(thread, "preview") ?? state.preview;
    // `Thread.source` is the environment-derived source kind (`cli`, `vscode`,
    // `appServer`, …) of whatever launched the private App Server, so it
    // misreports a manager-created thread as the editor that started the
    // manager. `Thread.threadSource` is the exact client-supplied
    // classification the provider stores and echoes back, so prefer it when the
    // provider has one.
    state.source = sourceKind(thread.threadSource)
      ?? sourceKind(thread.source)
      ?? state.source;
    state.model = stringField(response, "model") ?? state.model;
    state.effort = stringField(response, "reasoningEffort") ?? state.effort;
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
      treeId: state.treeId,
      parentThreadId: state.parentThreadId,
      cwd: state.cwd,
      name: state.name,
      preview: state.preview,
      source: state.source,
      model: state.model,
      effort: state.effort,
      profile: state.profile,
      status: state.status,
      activeTurnId: state.activeTurnId,
      lastTurnStatus: state.lastTurnStatus,
      pendingRequests: Object.freeze(
        [...state.pendingRequests.values()].map(cloneRequest),
      ),
      queue: Object.freeze(state.queue.map(cloneQueueItem)),
      executionEnvironmentIds: Object.freeze(
        [...state.executionEnvironmentIds].sort(),
      ),
      pendingSettings: state.pendingSettings
        ? Object.freeze({ ...state.pendingSettings })
        : null,
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
      this.#emitActivityProjection(projectCodexQueue(
        state.threadId,
        snapshot.queue,
        this.#now().toISOString(),
      ));
    }
  }

  /**
   * The only place `state.queue` may change. The `queue.changed` event, the
   * projected queue activity item, and the array `remove-queued` is derived
   * from all come from the same snapshot here, so the operator can never see a
   * queued bubble the adapter has already forgotten — or lose one it still
   * holds.
   */
  #commitQueue(
    state: InternalThreadState,
    mutate: (queue: CodexQueuedMessage[]) => void,
  ): void {
    mutate(state.queue);
    this.#touch(state, true);
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
    this.#commitQueue(state, () => {
      queued.status = "dispatching";
    });
    try {
      const result = asJsonObject(await this.#call(
        "turn.queue",
        "turn/start",
        {
          threadId: state.threadId,
          input: [{ type: "text", text: queued.text }],
          clientUserMessageId: queued.id,
          ...(state.nextTurnOverrides ?? {}),
        },
      ), "turn/start result");
      const turn = asJsonObject(result.turn, "turn/start turn");
      const turnId = stringField(turn, "id");
      if (!turnId) throw new Error("Codex turn/start response omitted the turn ID");
      state.activeTurnId = turnId;
      state.status = "running";
      state.lastTurnStatus = "inProgress";
      state.nextTurnOverrides = null;
      this.#commitQueue(state, (queue) => {
        queued.status = "dispatched";
        queued.turnId = turnId;
        queue.shift();
      });
    } catch (error) {
      this.#commitQueue(state, () => {
        queued.status = "queued";
      });
      throw error;
    }
  }

  #onNotification(notification: JsonRpcNotification): void {
    const pendingThreadId = notificationThreadId(notification);
    if (pendingThreadId && this.#bufferPendingAdoption(pendingThreadId, {
      kind: "notification",
      value: notification,
    })) return;

    let resolvedRequest: CodexPendingRequest | undefined;
    if (notification.method === "serverRequest/resolved") {
      const threadId = extractThreadId(notification.params);
      const requestId = notification.params.requestId;
      if (threadId && (typeof requestId === "string" || typeof requestId === "number")) {
        resolvedRequest = this.#threads.get(threadId)?.pendingRequests.get(
          jsonRpcIdKey(requestId),
        );
      }
    }

    this.#applyNotification(notification);

    const threadId = extractThreadId(notification.params);
    const requestId = notification.params.requestId;
    const projection = notification.method === "serverRequest/resolved" && threadId &&
        (typeof requestId === "string" || typeof requestId === "number")
      ? projectCodexRequestResolved(
          threadId,
          requestId,
          notification.emittedAtMs,
          resolvedRequest,
        )
      : projectCodexNotification(
          notification,
          (id, channel) => codexActivityOffset(this.#activityOffsets, id, channel),
          (id) => this.#activityTodos.get(id) ?? null,
        );
    this.#emitActivityProjection(projection);
  }

  #applyNotification(notification: JsonRpcNotification): void {
    const params = notification.params;
    if (notification.method === "thread/started") {
      try {
        if (!isObject(params.thread)) return;
        const threadId = stringField(params.thread, "id");
        if (!threadId || !this.#adoptedThreadIds.has(threadId)) return;
        this.#mergeThreadResponse({ thread: params.thread as JsonValue });
      } catch (error) {
        this.#diagnostic("codex.notification.invalid", error);
      }
      return;
    }

    const threadId = extractThreadId(params);
    if (!threadId) return;
    const state = this.#threads.get(threadId);
    if (!state || !this.#adoptedThreadIds.has(threadId)) return;

    switch (notification.method) {
      case "thread/status/changed": {
        state.status = normalizedThreadStatus(params.status);
        if (state.status === "idle" && state.activeTurnId) {
          // Codex 0.146 emits `idle` immediately before `turn/completed`.
          // `idle` is exact provider state — no turn is running — so retire the
          // active turn here too. A late, reordered, or dropped `turn/completed`
          // can then never strand the manager queue behind a finished turn.
          state.retiredTurnId = state.activeTurnId;
          state.activeTurnId = null;
        }
        this.#touch(state);
        if (state.status === "idle" && !state.activeTurnId) {
          void this.#drainQueue(state).catch((error) =>
            this.#diagnostic("codex.queue.dispatch_failed", error, threadId)
          );
        }
        break;
      }
      case "thread/settings/updated": {
        if (!isObject(params.threadSettings)) return;
        const settings = params.threadSettings;
        state.cwd = stringField(settings, "cwd") ?? state.cwd;
        state.model = stringField(settings, "model") ?? state.model;
        state.effort = stringField(settings, "effort") ?? state.effort;
        const pending = state.pendingSettings;
        if (pending?.profile && settingsMatchProfile(settings, pending.profile)) {
          state.profile = pending.profile;
        } else if (isObject(settings.collaborationMode)) {
          const normalized = normalizedProfile(settings.collaborationMode.mode);
          if (normalized || settings.approvalPolicy === "never") {
            state.profile = settings.approvalPolicy === "never"
              ? "full-access"
              : normalized;
          }
        }
        if (pending) {
          const profileConfirmed = !pending.profile ||
            settingsMatchProfile(settings, pending.profile);
          const modelConfirmed = !pending.model || state.model === pending.model;
          const effortConfirmed = !pending.effort || state.effort === pending.effort;
          if (profileConfirmed && modelConfirmed && effortConfirmed) {
            state.pendingSettings = null;
          }
        }
        this.#touch(state);
        break;
      }
      case "thread/environment/connected":
        if (typeof params.environmentId !== "string") return;
        state.executionEnvironmentIds.add(params.environmentId);
        this.#touch(state);
        break;
      case "thread/environment/disconnected":
        if (typeof params.environmentId !== "string") return;
        state.executionEnvironmentIds.delete(params.environmentId);
        this.#touch(state);
        break;
      case "thread/name/updated":
        state.name = stringField(params, "name");
        this.#touch(state);
        break;
      case "thread/closed":
        state.status = "not-loaded";
        state.activeTurnId = null;
        state.pendingRequests.clear();
        this.#touch(state);
        break;
      case "thread/archived":
        this.#forgetThread(threadId, "archived");
        break;
      case "thread/deleted":
        this.#forgetThread(threadId, "deleted");
        break;
      case "turn/started": {
        if (!isObject(params.turn)) return;
        state.activeTurnId = stringField(params.turn, "id");
        state.status = "running";
        state.lastTurnStatus = "inProgress";
        this.#touch(state);
        break;
      }
      // Codex 0.146 has no `turn/failed` or `turn/interrupted` notification:
      // completed, interrupted, and failed all arrive here as `turn/completed`
      // carrying the exact `Turn.status`, so this one path covers every real
      // turn-completion outcome.
      case "turn/completed": {
        if (!isObject(params.turn)) return;
        const completedTurnId = stringField(params.turn, "id");
        if (completedTurnId && completedTurnId === state.retiredTurnId
            && state.activeTurnId && state.activeTurnId !== completedTurnId) {
          // The idle status already retired this turn and the queue has since
          // started the next one. That completion is expected, not superseded.
          state.retiredTurnId = null;
          return;
        }
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
        state.retiredTurnId = null;
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
    if (this.#bufferPendingAdoption(threadId, { kind: "request", value: request })) return;
    const state = this.#threads.get(threadId);
    if (!state || !this.#adoptedThreadIds.has(threadId)) {
      this.#emit({
        type: "diagnostic",
        level: "warning",
        code: "codex.request.unowned",
        message: `Ignored server request for an unadopted thread: ${threadId}`,
        threadId,
      });
      return;
    }
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
    this.#emitActivityProjection(projectCodexServerRequest(request));
  }

  #diagnostic(code: string, error: unknown, threadId?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#emit({
      type: "diagnostic",
      level: "error",
      code,
      message,
      ...(threadId ? { threadId } : {}),
    });
    if (threadId) {
      this.#emitActivityProjection(projectCodexDiagnostic(
        threadId,
        code,
        message,
        this.#now().toISOString(),
      ));
    }
  }

  #emitActivityProjection(projection: CodexActivityProjection | null): void {
    if (!projection) return;
    for (const mutation of projection.mutations) {
      recordCodexActivityOffsets(this.#activityOffsets, mutation);
      recordCodexTodoProjectionState(this.#activityTodos, mutation);
      this.#emit({
        type: "activity",
        threadId: projection.threadId,
        mutation,
      });
    }
  }

  #emit(event: CodexAdapterEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
