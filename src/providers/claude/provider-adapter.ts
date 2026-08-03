import {
  emptyChildSummary,
  type AttentionDetails,
  type AttentionQuestion,
  type SessionStatus,
  type SessionView,
} from "../../core/types.ts";
import type {
  ActionDispatchResult,
  AttachInstruction,
  CreateSessionInput,
  ProviderControlAdapter,
  RequestContext,
  SessionAction,
} from "../../server/contracts.ts";
import { ClaudeManagedSession } from "./managed-session.ts";
import { loadClaudeSdkRuntime } from "./runtime.ts";
import type {
  ClaudeManagedSessionSnapshot,
  ClaudePendingRequest,
  ClaudePermissionMode,
  ClaudeRequestResponse,
  ClaudeSdkRuntime,
} from "./types.ts";

interface ManagedEntry {
  session: ClaudeManagedSession;
  name: string | null;
  executionMode: Exclude<ClaudePermissionMode, "plan">;
  unsubscribe: () => void;
}

export interface ClaudeProviderAdapterOptions {
  resolveWorkspace?(
    workspaceId: string,
    context: RequestContext,
  ): string | null | Promise<string | null>;
  runtime?: ClaudeSdkRuntime | (() => Promise<ClaudeSdkRuntime>);
  onSessionChanged?: (session: SessionView) => void;
}

function activityStatus(snapshot: ClaudeManagedSessionSnapshot): SessionStatus {
  switch (snapshot.activity) {
    case "starting":
    case "running":
      return "running";
    case "requires_action":
      return "waiting";
    case "idle":
      return "idle";
    case "failed":
      return "failed";
    case "closed":
      return "completed";
    case "native":
      return "unknown";
  }
}

function actionFailure(code: string, message: string): ActionDispatchResult {
  return {
    status: "failed",
    error: { code, message },
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function questionText(request: ClaudePendingRequest): string[] {
  const payloadInput = objectValue(request.payload.input);
  const questions = payloadInput?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    const record = objectValue(question);
    return record && typeof record.question === "string"
      ? [record.question]
      : [];
  });
}

function combinedQuestionAnswer(
  selectedOptions: string[],
  value: unknown,
): string {
  const parts = [...selectedOptions];
  if (typeof value === "string" && value.trim()) parts.push(value.trim());
  return parts.join(", ");
}

function boundedInputSummary(input: Record<string, unknown>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = "[Unserializable provider input]";
  }
  const points = Array.from(serialized);
  return points.length <= 1_000
    ? serialized
    : `${points.slice(0, 1_000).join("")}…`;
}

function attentionQuestions(request: ClaudePendingRequest): AttentionQuestion[] {
  if (request.kind !== "question") return [];
  const input = objectValue(request.payload.input);
  if (!Array.isArray(input?.questions)) return [];

  return input.questions.flatMap((rawQuestion, index) => {
    const question = objectValue(rawQuestion);
    if (!question || typeof question.question !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          if (typeof rawOption === "string") return [{ label: rawOption }];
          const option = objectValue(rawOption);
          if (!option || typeof option.label !== "string") return [];
          return [
            {
              label: option.label,
              ...(typeof option.description === "string"
                ? { description: option.description }
                : {}),
            },
          ];
        })
      : [];
    return [
      {
        id:
          typeof question.header === "string" && question.header.length > 0
            ? question.header
            : `question-${index + 1}`,
        text: question.question,
        options,
        multiSelect: question.multiSelect === true,
        // Claude's AskUserQuestion always supplies an automatic "Other"
        // answer. Preserve an explicit false for forward-compatible providers.
        allowFreeText: question.allowFreeText !== false,
      },
    ];
  });
}

function attentionDetails(request: ClaudePendingRequest): AttentionDetails {
  const input = objectValue(request.payload.input);
  const questions = attentionQuestions(request);
  return {
    title: request.title,
    ...(request.kind === "elicitation" ? { respondable: false } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(request.toolName ? { toolName: request.toolName } : {}),
    ...(request.kind !== "question" && input
      ? { inputSummary: boundedInputSummary(input) }
      : {}),
  };
}

function parseRequestResponse(
  value: unknown,
  pending?: ClaudePendingRequest,
): ClaudeRequestResponse {
  const response = objectValue(value);
  if (!response) {
    throw new Error("Claude response must contain a decision");
  }
  if (response.kind === "answer") {
    if (pending?.kind !== "question") {
      throw new Error("An answer envelope requires a pending Claude question");
    }
    const questions = questionText(pending);
    if (questions.length !== 1) {
      throw new Error(
        "The compact answer envelope can only answer one Claude question",
      );
    }
    const selectedOptions = Array.isArray(response.selectedOptions)
      ? response.selectedOptions.filter(
          (option): option is string => typeof option === "string",
        )
      : [];
    const answer = combinedQuestionAnswer(selectedOptions, response.value);
    if (answer.trim().length === 0) {
      throw new Error("Claude question response must not be empty");
    }
    const question = questions[0];
    if (!question) throw new Error("Claude question text is missing");
    return { decision: "answer", answers: { [question]: answer } };
  }
  if (response.kind === "answers") {
    if (pending?.kind !== "question") {
      throw new Error("An answers envelope requires a pending Claude question");
    }
    const providerQuestions = attentionQuestions(pending);
    const providerIds = new Map<string, string>();
    const providerTexts = new Set<string>();
    for (const question of providerQuestions) {
      if (providerIds.has(question.id)) {
        throw new Error(`Claude supplied duplicate question id ${question.id}`);
      }
      if (providerTexts.has(question.text)) {
        throw new Error(`Claude supplied duplicate question text ${question.text}`);
      }
      providerIds.set(question.id, question.text);
      providerTexts.add(question.text);
    }
    if (!Array.isArray(response.answers)) {
      throw new Error("Claude multi-question response requires answers");
    }
    if (response.answers.length !== providerQuestions.length) {
      throw new Error("Every Claude question must be answered exactly once");
    }

    const answerById = new Map<string, string>();
    for (const rawAnswer of response.answers) {
      const item = objectValue(rawAnswer);
      if (!item) throw new Error("Claude multi-question answer must be an object");
      const questionId = item.questionId;
      if (typeof questionId !== "string" || !providerIds.has(questionId)) {
        throw new Error(`Unknown Claude question id ${String(questionId ?? "")}`);
      }
      if (answerById.has(questionId)) {
        throw new Error(`Claude question ${questionId} was answered more than once`);
      }
      const selectedOptions = Array.isArray(item.selectedOptions)
        ? item.selectedOptions.filter(
            (option): option is string => typeof option === "string",
          )
        : [];
      const answer = combinedQuestionAnswer(selectedOptions, item.value);
      if (answer.trim().length === 0) {
        throw new Error(`Claude question ${questionId} must not be empty`);
      }
      answerById.set(questionId, answer);
    }

    const answers: Record<string, string> = {};
    for (const question of providerQuestions) {
      const answer = answerById.get(question.id);
      if (!answer) {
        throw new Error("Every Claude question must be answered exactly once");
      }
      answers[question.text] = answer;
    }
    return { decision: "answer", answers };
  }
  if (typeof response.decision !== "string") {
    throw new Error("Claude response must contain a decision");
  }
  switch (response.decision) {
    case "answer": {
      const answers = objectValue(response.answers);
      if (!answers) throw new Error("Claude question response requires answers");
      const normalized: Record<string, string> = {};
      for (const [question, answer] of Object.entries(answers)) {
        if (typeof answer !== "string") {
          throw new Error(`Claude answer for ${question} must be text`);
        }
        normalized[question] = answer;
      }
      return { decision: "answer", answers: normalized };
    }
    case "allow": {
      const updatedInput = objectValue(response.updatedInput);
      return updatedInput
        ? { decision: "allow", updatedInput }
        : { decision: "allow" };
    }
    case "deny":
      return {
        decision: "deny",
        reason: typeof response.reason === "string" && response.reason.trim()
          ? response.reason
          : "Denied by user",
        ...(typeof response.interrupt === "boolean"
          ? { interrupt: response.interrupt }
          : {}),
      };
    case "accept": {
      const content = objectValue(response.content);
      return content ? { decision: "accept", content } : { decision: "accept" };
    }
    case "decline":
    case "cancel":
      return { decision: response.decision };
    default:
      throw new Error(`Unsupported Claude response decision ${response.decision}`);
  }
}

/**
 * Backend contract bridge. The service owns workspace authorization,
 * idempotency and browser leases; this adapter owns only Claude SDK lifecycle
 * and exact provider preconditions.
 */
export class ClaudeProviderControlAdapter implements ProviderControlAdapter {
  readonly #options: ClaudeProviderAdapterOptions;
  readonly #entries = new Map<string, ManagedEntry>();
  #runtime: Promise<ClaudeSdkRuntime> | null = null;

  constructor(options: ClaudeProviderAdapterOptions) {
    this.#options = options;
  }

  async createSession(
    input: CreateSessionInput,
    context: RequestContext,
  ): Promise<SessionView> {
    if (input.provider !== "claude") {
      throw new Error(`Claude adapter cannot create ${input.provider} sessions`);
    }
    if (context.signal.aborted) throw new Error("Claude session creation was cancelled");
    if (context.workspace && context.workspace.id !== input.workspaceId) {
      throw new Error(`Workspace authorization does not match ${input.workspaceId}`);
    }
    const cwd = context.workspace?.path ??
      (await this.#options.resolveWorkspace?.(input.workspaceId, context)) ??
      null;
    if (!cwd) throw new Error(`Unknown or unauthorized workspace ${input.workspaceId}`);
    if (context.signal.aborted) throw new Error("Claude session creation was cancelled");

    const runtime = await this.#getRuntime();
    const executionMode: Exclude<ClaudePermissionMode, "plan"> =
      input.permissionPreset === "full-host" ? "bypassPermissions" : "default";
    const session = await ClaudeManagedSession.start(runtime, {
      cwd,
      mode: input.mode === "planning" ? "plan" : executionMode,
      initialMessage: input.initialMessage,
      allowDangerouslySkipPermissions: input.permissionPreset === "full-host",
    });
    if (context.signal.aborted) {
      session.dispose();
      throw new Error("Claude session creation was cancelled");
    }
    const id = session.snapshot.sessionId;
    if (!id) {
      session.dispose();
      throw new Error("Claude SDK initialized without a session id");
    }

    const entry: ManagedEntry = {
      session,
      name: input.name ?? null,
      executionMode,
      unsubscribe: () => undefined,
    };
    this.#entries.set(id, entry);
    entry.unsubscribe = session.subscribe((snapshot) => {
      try {
        this.#options.onSessionChanged?.(this.#toSessionView(entry, snapshot));
      } catch {
        // A state consumer cannot be allowed to tear down the provider pump.
      }
    });
    return this.#toSessionView(entry, session.snapshot);
  }

  async performAction(
    view: SessionView,
    action: SessionAction,
    context: RequestContext,
  ): Promise<ActionDispatchResult> {
    if (context.signal.aborted) {
      return actionFailure("REQUEST_ABORTED", "Claude action was cancelled");
    }
    if (view.provider !== "claude" || view.ownership !== "manager") {
      return actionFailure(
        "NOT_MANAGER_OWNED",
        "Claude semantic controls require a manager-owned session",
      );
    }
    if (action.expectedGeneration !== view.generation) {
      return actionFailure(
        "STALE_SESSION",
        `Expected generation ${action.expectedGeneration}, current generation is ${view.generation}`,
      );
    }
    const entry = this.#entries.get(view.sessionId) ?? this.#entries.get(view.id);
    if (!entry) {
      return actionFailure(
        "SESSION_NOT_OWNED",
        "This manager process does not own the Claude SDK query",
      );
    }

    try {
      switch (action.type) {
        case "send": {
          const messageId = entry.session.send(action.text, action.delivery);
          return {
            status: action.delivery === "queue" ? "queued" : "succeeded",
            result: { messageId, delivery: action.delivery },
          };
        }
        case "respond": {
          const pending = entry.session.snapshot.pendingRequests.find(
            (request) => request.id === action.requestId,
          );
          entry.session.respondToRequest(
            action.requestId,
            parseRequestResponse(action.response, pending),
          );
          return { status: "succeeded", result: { requestId: action.requestId } };
        }
        case "interrupt":
          return { status: "succeeded", result: await entry.session.interrupt() };
        case "set-mode": {
          const providerMode =
            action.mode === "planning" ? "plan" : entry.executionMode;
          await entry.session.setMode(providerMode);
          return { status: "succeeded", result: { mode: providerMode } };
        }
      }
    } catch (error) {
      return actionFailure(
        "CLAUDE_ACTION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async getAttachInstruction(
    view: SessionView,
    context: RequestContext,
  ): Promise<AttachInstruction | null> {
    if (context.signal.aborted) return null;
    const entry = this.#entries.get(view.sessionId) ?? this.#entries.get(view.id);
    if (!entry) return null;
    let handoff = entry.session.snapshot.handoff;
    if (entry.session.snapshot.owner === "manager") {
      handoff = entry.session.prepareCliHandoff();
    }
    if (!handoff || handoff.state === "exited") return null;
    return {
      kind: "claude-resume",
      argv: [handoff.command.executable, ...handoff.command.args],
      cwd: handoff.command.cwd,
      handoffId: handoff.id,
      warning:
        handoff.state === "attached"
          ? "Claude CLI already owns this session; cockpit writes remain disabled."
          : "Starting this command transfers exclusive write ownership to Claude CLI until it exits.",
    };
  }

  markCliAttached(sessionId: string, handoffId: string, wrapperPid: number): void {
    this.#requireEntry(sessionId).session.markCliAttached(handoffId, wrapperPid);
  }

  markCliExited(
    sessionId: string,
    handoffId: string,
    exitCode: number | null,
  ): void {
    this.#requireEntry(sessionId).session.markCliExited(handoffId, exitCode);
  }

  markCliAttachFailed(sessionId: string, handoffId: string, error: string): void {
    this.#requireEntry(sessionId).session.markCliAttachFailed(handoffId, error);
  }

  async reclaimFromCli(sessionId: string, handoffId: string): Promise<SessionView> {
    const entry = this.#requireEntry(sessionId);
    await entry.session.reclaimFromCli(handoffId);
    return this.#toSessionView(entry, entry.session.snapshot);
  }

  getManagedSession(sessionId: string): SessionView | null {
    const entry = this.#entries.get(sessionId);
    return entry ? this.#toSessionView(entry, entry.session.snapshot) : null;
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      entry.unsubscribe();
      entry.session.dispose();
    }
    this.#entries.clear();
  }

  #requireEntry(sessionId: string): ManagedEntry {
    const entry = this.#entries.get(sessionId);
    if (!entry) throw new Error(`Unknown managed Claude session ${sessionId}`);
    return entry;
  }

  #getRuntime(): Promise<ClaudeSdkRuntime> {
    if (!this.#runtime) {
      const configured = this.#options.runtime;
      this.#runtime = configured
        ? typeof configured === "function"
          ? configured()
          : Promise.resolve(configured)
        : loadClaudeSdkRuntime();
    }
    return this.#runtime;
  }

  #toSessionView(
    entry: ManagedEntry,
    snapshot: ClaudeManagedSessionSnapshot,
  ): SessionView {
    const providerSessionId = snapshot.sessionId ?? snapshot.localId;
    const id = `claude:${providerSessionId}`;
    const status = activityStatus(snapshot);
    const waitingKind = snapshot.pendingRequests[0]?.kind;
    const managerControls = snapshot.owner === "manager";
    const writableManagerControls = managerControls
      && snapshot.activity !== "closed"
      && snapshot.activity !== "failed";
    const capabilities: SessionView["control"]["capabilities"] = writableManagerControls
      ? [
          "queue",
          "interrupt",
          "set-mode",
          "attach",
          ...(snapshot.canSteer ? (["steer"] as const) : []),
          ...(snapshot.pendingRequests.some((request) => request.kind !== "elicitation")
            ? (["respond"] as const)
            : []),
        ]
      : ["resume", "attach"];
    const runtimeAlive =
      snapshot.owner === "manager"
        ? snapshot.activity !== "closed" && snapshot.activity !== "failed"
        : snapshot.handoff?.state === "attached";

    return {
      id,
      provider: "claude",
      sessionId: providerSessionId,
      parentSessionId: null,
      rootSessionId: providerSessionId,
      depth: 0,
      name: entry.name,
      cwd: snapshot.cwd,
      kind: "interactive",
      lifecycle: status === "completed" ? "recent" : "live",
      status,
      providerStatus: snapshot.activity,
      waitingReason:
        waitingKind === "question" || waitingKind === "elicitation"
          ? "user-input"
          : waitingKind
            ? "approval"
            : null,
      pid: null,
      runtimePid: snapshot.handoff?.wrapperPid ?? null,
      startedAt: snapshot.startedAt,
      updatedAt: snapshot.updatedAt,
      childSummary: emptyChildSummary(),
      statusSource: "inferred",
      source: "claude-sdk",
      ownership: "manager",
      runtimeAlive,
      mode: {
        value: snapshot.mode === "plan" ? "planning" : "execution",
        providerValue: snapshot.mode,
        source: "provider-api",
        confidence: "exact",
      },
      activity: status,
      attention: snapshot.pendingRequests.map((request) => ({
        id: request.id,
        kind:
          request.kind === "plan-approval"
            ? "approval"
            : request.kind === "question"
              ? "question"
              : request.kind,
        summary: request.title,
        source: "provider-api",
        confidence: "exact",
        details: attentionDetails(request),
      })),
      effectiveAccess: {
        permissionMode: snapshot.mode,
        sandboxMode: null,
        // The session retains its execution preset while temporarily in plan
        // mode. Keep the high-risk badge/arming requirement visible before a
        // set-mode action can restore bypassPermissions.
        fullHostAccess: entry.executionMode === "bypassPermissions",
      },
      terminal: null,
      control: {
        plane: writableManagerControls ? "claude-sdk" : "resume-only",
        capabilities,
        managerOwned: true,
        writableLease: false,
      },
      generation: snapshot.generation,
    };
  }
}
