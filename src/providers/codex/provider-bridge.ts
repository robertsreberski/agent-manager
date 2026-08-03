import type {
  AttentionDetails,
  AttentionQuestion,
  SessionView,
} from "../../core/types.ts";
import type {
  ActionDispatchResult,
  AttachInstruction,
  CreateSessionInput,
  ProviderControlAdapter,
  RequestContext,
  SessionAction,
} from "../../server/contracts.ts";
import type { CodexManagedAdapter } from "./adapter.ts";
import { jsonRpcIdKey } from "./rpc.ts";
import type {
  CodexPendingRequest,
  CodexThreadState,
  JsonObject,
  JsonRpcId,
} from "./types.ts";

interface ManagedMetadata {
  name: string | null;
  permissionPreset: "standard" | "full-host";
  createdAt: string;
}

export interface CodexProviderBridgeOptions {
  adapter: CodexManagedAdapter;
  resolveWorkspace(
    workspaceId: string,
    context: RequestContext,
  ): Promise<string | null> | string | null;
  now?: () => Date;
  onSessionChanged?: (session: SessionView) => void;
}

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
  if (request.kind !== "user-input" || !Array.isArray(request.params.questions)) {
    return [];
  }
  return request.params.questions.flatMap((rawQuestion) => {
    if (typeof rawQuestion !== "object" || rawQuestion === null ||
        Array.isArray(rawQuestion) || typeof rawQuestion.id !== "string" ||
        typeof rawQuestion.question !== "string") {
      return [];
    }
    const header = typeof rawQuestion.header === "string"
      ? rawQuestion.header.trim()
      : "";
    const options = Array.isArray(rawQuestion.options)
      ? rawQuestion.options.flatMap((rawOption) => {
          if (typeof rawOption !== "object" || rawOption === null ||
              Array.isArray(rawOption) || typeof rawOption.label !== "string") {
            return [];
          }
          return [{
            label: boundedText(rawOption.label, 300),
            ...(typeof rawOption.description === "string"
              ? { description: boundedText(rawOption.description, 500) }
              : {}),
          }];
        })
      : [];
    return [{
      id: rawQuestion.id,
      text: boundedText(
        header ? `${header}: ${rawQuestion.question}` : rawQuestion.question,
        1_000,
      ),
      options,
      multiSelect: rawQuestion.multiSelect === true,
      // Codex request_user_input permits the client-provided free-form Other
      // answer even when it is not repeated in the provider options array.
      allowFreeText: true,
    }];
  });
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

function mappedCapabilities(adapter: CodexManagedAdapter): SessionView["control"]["capabilities"] {
  const controls = new Set(adapter.capabilities.controls);
  const result: SessionView["control"]["capabilities"] = [];
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return [];
  }
  return value;
}

function questionIds(request: CodexPendingRequest): string[] {
  if (!Array.isArray(request.params.questions)) return [];
  return request.params.questions.flatMap((question) => {
    if (typeof question !== "object" || question === null || Array.isArray(question)) {
      return [];
    }
    return typeof question.id === "string" ? [question.id] : [];
  });
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
    const ids = questionIds(request);
    if (ids.length === 0) throw new Error("Codex question has no stable question IDs");

    if (response.kind === "answers") {
      if (!Array.isArray(response.answers)) {
        throw new Error("Codex multi-question response requires an answers array");
      }
      const expected = new Set(ids);
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
        if (typeof entry.value !== "string" || !Array.isArray(entry.selectedOptions) ||
            !entry.selectedOptions.every((option) => typeof option === "string")) {
          throw new Error(`Codex answer for ${entry.questionId} is malformed`);
        }
        const values = [...entry.selectedOptions];
        if (entry.value.trim()) values.push(entry.value);
        const unique = [...new Set(values)];
        if (unique.length === 0) {
          throw new Error(`Codex question ${entry.questionId} requires an answer`);
        }
        seen.add(entry.questionId);
        answers[entry.questionId] = { answers: unique };
      }
      const missing = ids.filter((id) => !seen.has(id));
      if (missing.length > 0 || seen.size !== expected.size) {
        throw new Error(`Codex response is missing answers for: ${missing.join(", ")}`);
      }
      return { answers };
    }

    if (response.kind !== "answer") {
      throw new Error("Codex question response must use kind=answer or kind=answers");
    }
    const selected = stringArray(response.selectedOptions);
    const answerValue = response.value;
    const answers: JsonObject = {};

    if (typeof answerValue === "object" && answerValue !== null &&
        !Array.isArray(answerValue)) {
      for (const id of ids) {
        const item = (answerValue as Record<string, unknown>)[id];
        const values = typeof item === "string" ? [item] : stringArray(item);
        if (values.length === 0) {
          throw new Error(`Codex question ${id} requires an answer`);
        }
        answers[id] = { answers: values };
      }
    } else {
      if (ids.length !== 1) {
        throw new Error("Multiple Codex questions require answers keyed by question ID");
      }
      const values = [...selected];
      if (typeof answerValue === "string" && answerValue.trim()) {
        values.push(answerValue);
      }
      const unique = [...new Set(values)];
      if (unique.length === 0) throw new Error("Codex question requires an answer");
      answers[ids[0] as string] = { answers: unique };
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
  #metadata = new Map<string, ManagedMetadata>();
  #unsubscribe: () => void;

  constructor(options: CodexProviderBridgeOptions) {
    this.adapter = options.adapter;
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#now = options.now ?? (() => new Date());
    this.#unsubscribe = this.adapter.subscribe((event) => {
      if (event.type !== "state.changed" || !this.#metadata.has(event.threadId)) return;
      try {
        options.onSessionChanged?.(this.toSessionView(event.state));
      } catch {
        // State consumers cannot be allowed to tear down the provider pump.
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
    const state = await this.adapter.startThread({
      cwd,
      mode: input.mode,
      initialMessage: input.initialMessage,
      approvalPolicy: fullHost ? "never" : "on-request",
      sandbox: fullHost ? "danger-full-access" : "workspace-write",
    });
    this.#metadata.set(state.threadId, {
      name: input.name ?? null,
      permissionPreset: input.permissionPreset,
      createdAt: this.#now().toISOString(),
    });
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
    const status = sessionStatus(state);
    const metadata = this.#metadata.get(state.threadId) ?? {
      name: null,
      permissionPreset: "standard" as const,
      createdAt: this.#now().toISOString(),
    };
    const fullHost = metadata.permissionPreset === "full-host";
    const updatedAt = this.#now().toISOString();
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
      status,
      providerStatus: state.status,
      waitingReason: state.pendingRequests.some((request) => request.kind === "user-input")
        ? "user-input"
        : state.pendingRequests.some((request) => request.kind === "unsupported")
        ? "blocked"
        : state.pendingRequests.length > 0
        ? "approval"
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
      activity: status,
      attention: state.pendingRequests.map((request) => {
        const details = attentionDetails(request);
        return {
          id: encodeCodexRequestId(request.id),
          kind: pendingKind(request),
          summary: requestSummary(request),
          source: "provider-api",
          confidence: "exact",
          ...(details ? { details } : {}),
        };
      }),
      effectiveAccess: {
        permissionMode: fullHost ? "never" : "on-request",
        sandboxMode: fullHost ? "danger-full-access" : "workspace-write",
        fullHostAccess: fullHost,
      },
      terminal: null,
      control: {
        plane: "codex-app-server",
        capabilities: mappedCapabilities(this.adapter),
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
  }
}

export { CodexProviderBridge as CodexProviderControlAdapter };
