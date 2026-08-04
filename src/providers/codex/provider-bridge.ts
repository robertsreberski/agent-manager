import type {
  AttentionDetails,
  AttentionQuestion,
  SessionView,
} from "../../core/types.ts";
import type { ActivityMutation } from "../../activity/index.ts";
import type {
  ActionDispatchResult,
  AttachInstruction,
  CreateSessionInput,
  ProviderControlAdapter,
  RequestContext,
  SessionAction,
} from "../../server/contracts.ts";
import {
  CodexManagedCreationError,
  type CodexManagedAdapter,
  type CodexManagedCreationIssue,
} from "./adapter.ts";
import { jsonRpcIdKey } from "./rpc.ts";
import type {
  CodexPendingRequest,
  CodexThreadState,
  JsonObject,
  JsonRpcId,
} from "./types.ts";
import {
  normalizeCodexQuestions,
  type NormalizedCodexQuestion,
} from "./question-normalizer.ts";

interface ManagedMetadata {
  name: string | null;
  permissionPreset: "standard" | "full-host";
  createdAt: string;
  creationIssue: CodexManagedCreationIssue | null;
}

export interface CodexProviderBridgeOptions {
  adapter: CodexManagedAdapter;
  resolveWorkspace(
    workspaceId: string,
    context: RequestContext,
  ): Promise<string | null> | string | null;
  now?: () => Date;
  onSessionChanged?: (session: SessionView) => void;
  onActivity?: (managerSessionId: string, mutation: ActivityMutation) => void;
}

const MAX_BUFFERED_ACTIVITY_MUTATIONS = 4_096;

function pendingKind(request: CodexPendingRequest): SessionView["attention"][number]["kind"] {
  switch (request.kind) {
    case "user-input": return "question";
    case "permission-approval": return "permission";
    case "elicitation": return "elicitation";
    case "command-approval":
    case "file-change-approval":
    case "legacy-command-approval":
    case "legacy-file-change-approval":
      return "approval";
    case "unsupported":
      return "blocked";
  }
}

function requestSummary(request: CodexPendingRequest): string | null {
  const reason = request.params.reason;
  if (typeof reason === "string" && reason.trim()) return reason.slice(0, 500);
  const command = request.params.command;
  if (typeof command === "string" && command.trim()) return command.slice(0, 500);
  if (request.kind === "user-input") return "Codex is waiting for an answer";
  if (request.kind === "elicitation") return "An MCP server is requesting input";
  return null;
}

function boundedText(value: string, maxCodePoints = 1_000): string {
  const points = Array.from(value);
  return points.length <= maxCodePoints
    ? value
    : `${points.slice(0, maxCodePoints).join("")}…`;
}

function attentionQuestions(request: CodexPendingRequest): AttentionQuestion[] {
  if (request.kind !== "user-input") return [];
  return normalizeCodexQuestions(request.params.questions).map((question) => ({
    id: question.id,
    ...(question.header ? { header: question.header } : {}),
    text: question.text,
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description === null ? {} : { description: option.description }),
    })),
    multiSelect: question.multiSelect,
    allowFreeText: question.allowFreeText,
    ...(question.isSecret ? { isSecret: true } : {}),
  }));
}

function approvalInputSummary(request: CodexPendingRequest): string | null {
  const command = request.params.command;
  if (typeof command === "string") return boundedText(command);
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return boundedText(command.join(" "));
  }
  const reason = request.params.reason;
  if (typeof reason === "string" && reason.trim()) return boundedText(reason);
  const fileChanges = request.params.fileChanges;
  if (typeof fileChanges === "object" && fileChanges !== null &&
      !Array.isArray(fileChanges)) {
    const count = Object.keys(fileChanges).length;
    return `${count} file ${count === 1 ? "change" : "changes"}`;
  }
  if (request.kind === "elicitation" && typeof request.params.serverName === "string") {
    return boundedText(`MCP server: ${request.params.serverName}`);
  }
  return null;
}

function approvalToolName(request: CodexPendingRequest): string | null {
  switch (request.kind) {
    case "command-approval":
    case "legacy-command-approval":
      return "Command execution";
    case "file-change-approval":
    case "legacy-file-change-approval":
      return "File change";
    case "permission-approval":
      return "Permission request";
    case "elicitation":
      return "MCP elicitation";
    case "user-input":
    case "unsupported":
      return null;
  }
}

function attentionDetails(request: CodexPendingRequest): AttentionDetails | null {
  const questions = attentionQuestions(request);
  if (questions.length > 0) {
    return {
      title: questions.length === 1 ? "Codex needs your answer" : "Codex needs your answers",
      questions,
    };
  }
  const toolName = approvalToolName(request);
  const inputSummary = approvalInputSummary(request);
  if (!toolName && !inputSummary) return null;
  return {
    ...(request.kind === "elicitation" ? { respondable: false } : {}),
    ...(toolName ? { toolName } : {}),
    ...(inputSummary ? { inputSummary } : {}),
  };
}

function sessionStatus(state: CodexThreadState): SessionView["status"] {
  if (state.pendingRequests.length > 0) return "waiting";
  if (state.status === "running") return "running";
  if (state.status === "idle") return "idle";
  if (state.status === "system-error") return "failed";
  return "unknown";
}

function providerMode(mode: CodexThreadState["mode"]): string | null {
  if (mode === "planning") return "plan";
  if (mode === "execution") return "default";
  return null;
}

function emptyChildren(): SessionView["childSummary"] {
  return {
    total: 0,
    running: 0,
    waiting: 0,
    idle: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    unknown: 0,
  };
}

function mappedCapabilities(
  adapter: CodexManagedAdapter,
  state: CodexThreadState,
  creationIssue: CodexManagedCreationIssue | null,
): SessionView["control"]["capabilities"] {
  const controls = new Set(adapter.capabilities.controls);
  const result: SessionView["control"]["capabilities"] = [];
  if (creationIssue) {
    // Do not permit another prompt or mode mutation until a human has inspected
    // the provider thread. Exact pending-request responses and interruption are
    // safe because both are bound to provider-issued IDs.
    if (state.pendingRequests.some((request) =>
      request.respondable && request.kind !== "elicitation"
    ) && controls.has("request.respond")) {
      result.push("respond");
    }
    if (state.activeTurnId && controls.has("turn.interrupt")) result.push("interrupt");
    if (controls.has("native.attach")) result.push("attach", "resume");
    return result;
  }
  if (controls.has("turn.queue")) result.push("queue");
  if (controls.has("turn.steer")) result.push("steer");
  if (controls.has("turn.interrupt")) result.push("interrupt");
  if (controls.has("request.respond")) result.push("respond");
  if (controls.has("mode.set")) result.push("set-mode");
  if (controls.has("native.attach")) result.push("attach", "resume");
  return result;
}

export function encodeCodexRequestId(id: JsonRpcId): string {
  return jsonRpcIdKey(id);
}

export function decodeCodexRequestId(encoded: string): JsonRpcId {
  if (encoded.startsWith("s:")) return encoded.slice(2);
  if (encoded.startsWith("n:")) {
    const value = Number(encoded.slice(2));
    if (Number.isSafeInteger(value)) return value;
  }
  throw new Error("Invalid encoded Codex request ID");
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex response payload must be an object");
  }
  return value as JsonObject;
}

function requestQuestions(request: CodexPendingRequest): NormalizedCodexQuestion[] {
  const questions = normalizeCodexQuestions(request.params.questions);
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) {
      throw new Error(`Duplicate Codex question ID ${question.id}`);
    }
    seen.add(question.id);
  }
  return questions;
}

function selectedOptionArray(value: unknown, questionId: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Codex answer for ${questionId} is malformed`);
  }
  return value;
}

function questionAnswerValues(
  question: NormalizedCodexQuestion,
  value: string,
  selectedOptions: string[],
): string[] {
  const selected = [...new Set(selectedOptions)];
  const allowedOptions = new Set(question.options.map((option) => option.label));
  const unknownOptions = selected.filter((option) => !allowedOptions.has(option));
  if (unknownOptions.length > 0) {
    throw new Error(
      `Unknown option for Codex question ${question.id}: ${unknownOptions.join(", ")}`,
    );
  }

  const customValue = value.trim() ? value : null;
  if (!question.multiSelect && selected.length > 1) {
    throw new Error(`Codex question ${question.id} accepts only one option`);
  }
  if (customValue !== null && !question.allowFreeText) {
    throw new Error(`Codex question ${question.id} does not allow a custom answer`);
  }
  if (!question.multiSelect && customValue !== null && selected.length > 0) {
    throw new Error(
      `Codex question ${question.id} cannot combine an option with a custom answer`,
    );
  }

  const values = customValue === null ? selected : [...selected, customValue];
  if (values.length === 0) {
    throw new Error(`Codex question ${question.id} requires an answer`);
  }
  return values;
}

function legacyQuestionAnswer(
  question: NormalizedCodexQuestion,
  value: unknown,
): string[] {
  if (typeof value === "string") {
    const namedOption = question.options.some((option) => option.label === value);
    return questionAnswerValues(question, namedOption ? "" : value, namedOption ? [value] : []);
  }
  return questionAnswerValues(
    question,
    "",
    selectedOptionArray(value, question.id),
  );
}

/** Translate the provider-independent cockpit envelope into the exact 0.146 RPC result. */
export function codexRequestResponse(
  request: CodexPendingRequest,
  value: unknown,
): JsonObject {
  const response = asJsonObject(value);
  // Provider-shaped responses remain useful for trusted CLI/tests. Browser
  // callers use the normalized `kind` envelopes below.
  if (response.kind === undefined) return response;

  if (request.kind === "user-input") {
    const questions = requestQuestions(request);
    if (questions.length === 0) throw new Error("Codex question has no stable question IDs");
    const questionsById = new Map(questions.map((question) => [question.id, question]));

    if (response.kind === "answers") {
      if (!Array.isArray(response.answers)) {
        throw new Error("Codex multi-question response requires an answers array");
      }
      const expected = new Set(questionsById.keys());
      const seen = new Set<string>();
      const answers: JsonObject = {};
      for (const entry of response.answers) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
            typeof entry.questionId !== "string") {
          throw new Error("Codex multi-question answer is malformed");
        }
        if (!expected.has(entry.questionId)) {
          throw new Error(`Unknown Codex question ID ${entry.questionId}`);
        }
        if (seen.has(entry.questionId)) {
          throw new Error(`Duplicate Codex answer for ${entry.questionId}`);
        }
        if (typeof entry.value !== "string") {
          throw new Error(`Codex answer for ${entry.questionId} is malformed`);
        }
        const question = questionsById.get(entry.questionId) as NormalizedCodexQuestion;
        const values = questionAnswerValues(
          question,
          entry.value,
          selectedOptionArray(entry.selectedOptions, entry.questionId),
        );
        seen.add(entry.questionId);
        answers[entry.questionId] = { answers: values };
      }
      const missing = questions.map((question) => question.id).filter((id) => !seen.has(id));
      if (missing.length > 0 || seen.size !== expected.size) {
        throw new Error(`Codex response is missing answers for: ${missing.join(", ")}`);
      }
      return { answers };
    }

    if (response.kind !== "answer") {
      throw new Error("Codex question response must use kind=answer or kind=answers");
    }
    const answerValue = response.value;
    const answers: JsonObject = {};

    if (typeof answerValue === "object" && answerValue !== null &&
        !Array.isArray(answerValue)) {
      const unknownIds = Object.keys(answerValue).filter((id) => !questionsById.has(id));
      if (unknownIds.length > 0) {
        throw new Error(`Unknown Codex question ID ${unknownIds.join(", ")}`);
      }
      for (const question of questions) {
        const id = question.id;
        const item = (answerValue as Record<string, unknown>)[id];
        answers[id] = { answers: legacyQuestionAnswer(question, item) };
      }
    } else {
      if (questions.length !== 1) {
        throw new Error("Multiple Codex questions require answers keyed by question ID");
      }
      if (typeof answerValue !== "string") {
        throw new Error(`Codex answer for ${questions[0]!.id} is malformed`);
      }
      answers[questions[0]!.id] = {
        answers: questionAnswerValues(
          questions[0]!,
          answerValue,
          selectedOptionArray(response.selectedOptions, questions[0]!.id),
        ),
      };
    }
    return { answers };
  }

  if (response.kind !== "decision" ||
      (response.decision !== "allow" && response.decision !== "deny")) {
    throw new Error("Codex approval response must use an allow or deny decision");
  }
  const allowed = response.decision === "allow";
  const reason = typeof response.reason === "string" && response.reason.trim()
    ? response.reason
    : "Denied by user";

  switch (request.kind) {
    case "command-approval":
    case "file-change-approval":
      return { decision: allowed ? "accept" : "decline" };
    case "legacy-command-approval":
    case "legacy-file-change-approval":
      return allowed
        ? { decision: "approved" }
        : { decision: { denied: { rejection: reason } } };
    case "permission-approval":
      return {
        permissions: allowed && typeof request.params.permissions === "object" &&
            request.params.permissions !== null && !Array.isArray(request.params.permissions)
          ? request.params.permissions
          : {},
        scope: "turn",
      };
    case "elicitation":
      return {
        action: allowed ? "accept" : "decline",
        content: allowed ? (response.value ?? null) : null,
        _meta: null,
      };
    case "unsupported":
      throw new Error(`Codex request method ${request.method} is not respondable`);
  }
}

export class CodexProviderBridge implements ProviderControlAdapter {
  readonly adapter: CodexManagedAdapter;
  #resolveWorkspace: CodexProviderBridgeOptions["resolveWorkspace"];
  #now: () => Date;
  #onActivity: CodexProviderBridgeOptions["onActivity"];
  #metadata = new Map<string, ManagedMetadata>();
  #bufferedActivity = new Map<string, ActivityMutation[]>();
  #overflowedActivity = new Set<string>();
  #unsubscribe: () => void;

  constructor(options: CodexProviderBridgeOptions) {
    this.adapter = options.adapter;
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#now = options.now ?? (() => new Date());
    this.#onActivity = options.onActivity;
    this.#unsubscribe = this.adapter.subscribe((event) => {
      if (event.type === "activity") {
        this.#forwardOrBufferActivity(event.threadId, event.mutation);
        return;
      }
      if (event.type === "state.changed" && this.#metadata.has(event.threadId)) {
        try {
          options.onSessionChanged?.(this.toSessionView(event.state));
        } catch {
          // State consumers cannot be allowed to tear down the provider pump.
        }
      }
    });
  }

  async createSession(
    input: CreateSessionInput,
    context: RequestContext,
  ): Promise<SessionView> {
    if (input.provider !== "codex") throw new Error("Codex bridge received another provider");
    context.signal.throwIfAborted();
    const cwd = await this.#resolveWorkspace(input.workspaceId, context);
    if (!cwd) throw new Error(`Unknown or unauthorized workspace ${input.workspaceId}`);
    context.signal.throwIfAborted();
    const fullHost = input.permissionPreset === "full-host";
    let state: CodexThreadState;
    let creationIssue: CodexManagedCreationIssue | null = null;
    try {
      state = await this.adapter.startThread({
        cwd,
        mode: input.mode,
        initialMessage: input.initialMessage,
        approvalPolicy: fullHost ? "never" : "on-request",
        sandbox: fullHost ? "danger-full-access" : "workspace-write",
      });
    } catch (error) {
      if (!(error instanceof CodexManagedCreationError)) throw error;
      // `thread/start` succeeded, so returning this handle is the only safe
      // creation outcome: the server can durably bind the idempotency receipt
      // to the real provider thread instead of losing it as an unknown create.
      state = error.threadState;
      creationIssue = error.issue;
    }
    this.#metadata.set(state.threadId, {
      name: input.name ?? null,
      permissionPreset: input.permissionPreset,
      createdAt: this.#now().toISOString(),
      creationIssue,
    });
    this.#flushBufferedActivity(state.threadId);
    return this.toSessionView(state);
  }

  async performAction(
    session: SessionView,
    action: SessionAction,
    context: RequestContext,
  ): Promise<ActionDispatchResult> {
    context.signal.throwIfAborted();
    if (session.provider !== "codex" || session.ownership !== "manager") {
      throw new Error("Codex controls apply only to manager-owned Codex sessions");
    }
    if (action.expectedGeneration !== session.generation) {
      throw new Error("Codex session generation changed before dispatch");
    }
    const state = this.adapter.getThreadState(session.sessionId);
    if (!state) throw new Error("Manager-owned Codex thread is not loaded");
    const creationIssue = this.#metadata.get(session.sessionId)?.creationIssue ?? null;
    if (creationIssue && action.type !== "respond" && action.type !== "interrupt") {
      throw new Error(
        "Codex session creation needs native recovery before messages or mode changes can be dispatched",
      );
    }

    switch (action.type) {
      case "send":
        if (action.delivery === "queue") {
          const queued = await this.adapter.queueMessage(session.sessionId, action.text);
          return {
            status: queued.status === "queued" ? "queued" : "succeeded",
            result: queued,
          };
        }
        if (!action.expectedRunId) {
          throw new Error("Steering requires the expected active Codex turn ID");
        }
        return {
          status: "succeeded",
          result: {
            turnId: await this.adapter.steer(
              session.sessionId,
              action.expectedRunId,
              action.text,
            ),
          },
        };
      case "respond": {
        const request = state.pendingRequests.find(
          (candidate) => encodeCodexRequestId(candidate.id) === action.requestId,
        );
        if (!request) throw new Error("Codex request is stale or already resolved");
        if (request.kind === "elicitation") {
          throw new Error("Codex MCP elicitation forms are not respondable in the cockpit");
        }
        await this.adapter.respondToRequest(
          session.sessionId,
          decodeCodexRequestId(action.requestId),
          codexRequestResponse(request, action.response),
        );
        return { status: "succeeded" };
      }
      case "interrupt":
        if (!action.expectedRunId) {
          throw new Error("Interrupt requires the expected active Codex turn ID");
        }
        await this.adapter.interrupt(session.sessionId, action.expectedRunId);
        return { status: "succeeded" };
      case "set-mode":
        await this.adapter.setMode(session.sessionId, action.mode);
        return { status: "succeeded", result: { mode: action.mode } };
    }
  }

  async getAttachInstruction(
    session: SessionView,
    context: RequestContext,
  ): Promise<AttachInstruction | null> {
    context.signal.throwIfAborted();
    if (session.provider !== "codex" || session.ownership !== "manager") return null;
    const command = this.adapter.buildAttachCommand(session.sessionId);
    return {
      kind: "codex-remote",
      argv: [command.executable, ...command.args],
      cwd: session.cwd,
      warning: "Acquire the native-controller lease before attaching; the first client to answer a Codex request wins.",
    };
  }

  toSessionView(state: CodexThreadState): SessionView {
    const metadata = this.#metadata.get(state.threadId) ?? {
      name: null,
      permissionPreset: "standard" as const,
      createdAt: this.#now().toISOString(),
      creationIssue: null,
    };
    const fullHost = metadata.permissionPreset === "full-host";
    const updatedAt = this.#now().toISOString();
    const recoveryAttention: SessionView["attention"] = metadata.creationIssue
      ? [{
          id: "creation-recovery",
          kind: "blocked",
          summary: metadata.creationIssue.stage === "mode"
            ? "The provider thread exists, but its requested mode was not confirmed. The initial message was not sent."
            : metadata.creationIssue.outcome === "uncertain"
            ? "The provider thread exists, but the initial-message acknowledgement is uncertain. It will not be sent again automatically."
            : "The provider thread exists, but Codex rejected the initial message. It will not be sent again automatically.",
          source: "provider-api",
          confidence: "exact",
          details: {
            title: "Managed Codex session needs recovery",
            toolName: "Native Codex attach",
            inputSummary: boundedText(metadata.creationIssue.message, 500),
            respondable: false,
          },
        }]
      : [];
    const normalizedStatus = metadata.creationIssue && !state.activeTurnId
      ? "waiting"
      : sessionStatus(state);
    const pendingAttention: SessionView["attention"] = state.pendingRequests.map(
      (request) => {
        const details = attentionDetails(request);
        return {
          id: encodeCodexRequestId(request.id),
          kind: pendingKind(request),
          summary: requestSummary(request),
          source: "provider-api",
          confidence: "exact",
          ...(details ? { details } : {}),
        };
      },
    );
    return {
      id: `codex:${state.threadId}`,
      provider: "codex",
      sessionId: state.threadId,
      parentSessionId: null,
      rootSessionId: state.threadId,
      depth: 0,
      name: metadata.name,
      cwd: state.cwd,
      kind: "interactive",
      lifecycle: "live",
      status: normalizedStatus,
      providerStatus: state.status,
      waitingReason: state.pendingRequests.some((request) => request.kind === "user-input")
        ? "user-input"
        : state.pendingRequests.some((request) => request.kind === "unsupported")
        ? "blocked"
        : state.pendingRequests.length > 0
        ? "approval"
        : metadata.creationIssue
        ? "blocked"
        : null,
      pid: null,
      runtimePid: null,
      startedAt: metadata.createdAt,
      updatedAt,
      childSummary: emptyChildren(),
      statusSource: "inferred",
      source: "managed:codex-app-server",
      ownership: "manager",
      runtimeAlive: this.adapter.runtimeAlive,
      mode: {
        value: state.mode,
        providerValue: providerMode(state.mode),
        source: "provider-api",
        confidence: state.mode === "unknown" ? "heuristic" : "exact",
      },
      activity: normalizedStatus,
      attention: [...recoveryAttention, ...pendingAttention],
      effectiveAccess: {
        permissionMode: fullHost ? "never" : "on-request",
        sandboxMode: fullHost ? "danger-full-access" : "workspace-write",
        fullHostAccess: fullHost,
      },
      terminal: null,
      control: {
        plane: "codex-app-server",
        capabilities: mappedCapabilities(this.adapter, state, metadata.creationIssue),
        managerOwned: true,
        writableLease: false,
      },
      generation: state.generation,
      runId: state.activeTurnId,
    };
  }

  getManagedSession(sessionId: string): SessionView | null {
    const state = this.adapter.getThreadState(sessionId);
    return state ? this.toSessionView(state) : null;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#bufferedActivity.clear();
    this.#overflowedActivity.clear();
  }

  #forwardOrBufferActivity(threadId: string, mutation: ActivityMutation): void {
    if (!this.#onActivity) return;
    if (this.#metadata.has(threadId)) {
      this.#publishActivity(threadId, mutation);
      return;
    }

    let buffered = this.#bufferedActivity.get(threadId);
    if (!buffered) {
      buffered = [];
      this.#bufferedActivity.set(threadId, buffered);
    }
    if (buffered.length >= MAX_BUFFERED_ACTIVITY_MUTATIONS) {
      buffered.length = 0;
      buffered.push({ type: "reset", reason: "truncation" });
      this.#overflowedActivity.add(threadId);
    }
    if (this.#overflowedActivity.has(threadId) && mutation.type === "append") return;
    buffered.push(mutation);
  }

  #flushBufferedActivity(threadId: string): void {
    const buffered = this.#bufferedActivity.get(threadId);
    this.#bufferedActivity.delete(threadId);
    this.#overflowedActivity.delete(threadId);
    if (!buffered) return;
    for (const mutation of buffered) this.#publishActivity(threadId, mutation);
  }

  #publishActivity(threadId: string, mutation: ActivityMutation): void {
    try {
      this.#onActivity?.(`codex:${threadId}`, mutation);
    } catch {
      // Activity consumers cannot be allowed to tear down the provider pump.
    }
  }
}

export { CodexProviderBridge as CodexProviderControlAdapter };
