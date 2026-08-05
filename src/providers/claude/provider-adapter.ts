import {
  emptyChildSummary,
  providerEffort,
  sessionRecordId,
  type AttentionDetails,
  type AttentionQuestion,
  type ExecutionProfile,
  type ReasoningEffort,
  type SessionStatus,
  type SessionView,
} from "../../core/types.ts";
import type { ActivityMutation } from "../../activity/index.ts";
import {
  WorkspaceIdentityResolver,
  type WorkspaceIdentity,
} from "../../core/worktree.ts";
import type {
  ActionDispatchResult,
  AttachInstruction,
  CreateSessionInput,
  ProviderControlAdapter,
  RequestContext,
  SessionAction,
  SessionModelOption,
  SessionSettingsOptions,
} from "../../server/contracts.ts";
import { sessionSettingsOptionsSchema } from "../../server/contracts.ts";
import { AsyncInbox } from "./async-inbox.ts";
import { ClaudeManagedSession } from "./managed-session.ts";
import { ClaudeActivityProjector } from "./activity-projector.ts";
import { loadClaudeSdkRuntime } from "./runtime.ts";
import type { ClaudeHookSourceArbiter } from "../hooks/claude-source.ts";
import {
  CLAUDE_MANAGER_OWNER_ENV,
  CLAUDE_MANAGER_OWNER_VALUE,
} from "../hooks/claude-source.ts";
import { CLAUDE_REASONING_EFFORTS } from "../../shared/session.ts";
import {
  CLAUDE_CODE_VERSION,
  type ClaudeEffortLevel,
  type ClaudeManagedSessionSnapshot,
  type ClaudeModelInfo,
  type ClaudePendingRequest,
  type ClaudePermissionMode,
  type ClaudeRequestResponse,
  type ClaudeSdkRuntime,
  type ClaudeSdkUserMessage,
} from "./types.ts";

interface ManagedEntry {
  session: ClaudeManagedSession;
  name: string | null;
  projector: ClaudeActivityProjector;
  publishActivity(mutations: readonly ActivityMutation[]): void;
  unsubscribe: () => void;
}

const CLAUDE_SETTINGS_LOOKUP_TIMEOUT_MS = 2_000;
const WORKSPACE_IDENTITY_BUDGET_MS = 2_500;

export interface ClaudeProviderAdapterOptions {
  resolveWorkspace?(
    workspaceId: string,
    context: RequestContext,
  ): string | null | Promise<string | null>;
  runtime?: ClaudeSdkRuntime | (() => Promise<ClaudeSdkRuntime>);
  /**
   * Manager-owned sessions never pass through the discovery scan, so they
   * resolve their repository facts through the same bounded resolver discovery
   * uses. Without it a managed session opens a second board column for a
   * repository the board already shows.
   */
  workspaceIdentityResolver?: Pick<WorkspaceIdentityResolver, "resolveMany">;
  /** Bounds the git work one create may spend; exhaustion yields a null identity. */
  workspaceIdentityBudgetMs?: number;
  onSessionChanged?: (session: SessionView) => void;
  onActivity?: (managerSessionId: string, mutation: ActivityMutation) => void;
  hookSourceArbiter?: ClaudeHookSourceArbiter;
}

function profileMode(profile: ExecutionProfile): ClaudePermissionMode {
  switch (profile) {
    case "ask-first": return "default";
    case "plan": return "plan";
    case "execute": return "acceptEdits";
    case "full-access": return "bypassPermissions";
  }
}

function modeProfile(mode: ClaudePermissionMode): ExecutionProfile {
  switch (mode) {
    case "plan": return "plan";
    case "acceptEdits": return "execute";
    case "bypassPermissions": return "full-access";
    case "default":
    case "dontAsk":
    case "auto":
      return "ask-first";
  }
}

function claudeEffort(effort: ReasoningEffort): ClaudeEffortLevel {
  if (effort === "minimal" || effort === "ultra") {
    throw new Error(`Claude does not expose the ${effort} effort level`);
  }
  return effort;
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

function nativeHandoffReadiness(
  snapshot: ClaudeManagedSessionSnapshot,
): { ready: boolean; reason: string } {
  if (snapshot.owner !== "manager") {
    return {
      ready: false,
      reason: "The native Claude CLI already owns this session; another resume would race it",
    };
  }
  if (
    snapshot.activity !== "idle"
    && snapshot.activity !== "closed"
    && snapshot.activity !== "failed"
  ) {
    return {
      ready: false,
      reason: "Native handoff requires an idle or ended Claude session",
    };
  }
  if (snapshot.pendingRequests.length > 0) {
    return {
      ready: false,
      reason: "Native handoff cannot abandon a pending Claude request",
    };
  }
  if (
    snapshot.stagedMessages.length > 0
    || snapshot.outstandingMessageIds.length > 0
    || snapshot.stillQueuedMessageIds.length > 0
    || snapshot.queueKnowledge !== "known"
  ) {
    return {
      ready: false,
      reason: "Native handoff requires a provider-confirmed empty Claude input queue",
    };
  }
  return { ready: true, reason: "Native handoff is ready" };
}

function actionFailure(code: string, message: string): ActionDispatchResult {
  return {
    status: "failed",
    error: { code, message },
  };
}

function boundedSettingsLookup<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Claude settings lookup timed out")),
      CLAUDE_SETTINGS_LOOKUP_TIMEOUT_MS,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Only fields the pinned `ModelInfo` actually declares are advertised.
 * `ModelInfo` carries no default-model marker, so `isDefault` is never claimed,
 * and effort sets are narrowed to the public Claude vocabulary.
 */
function claudeModelOption(model: ClaudeModelInfo): SessionModelOption {
  const declared = model.supportsEffort === true && Array.isArray(model.supportedEffortLevels)
    ? model.supportedEffortLevels
    : [];
  const efforts = [...new Set(declared)].filter(
    (effort): effort is (typeof CLAUDE_REASONING_EFFORTS)[number] =>
      (CLAUDE_REASONING_EFFORTS as readonly string[]).includes(effort),
  );
  return {
    value: model.value,
    label: model.displayName,
    description: model.description,
    ...(efforts.length > 0 ? { efforts } : {}),
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
          if (typeof rawOption === "string") {
            return [{ label: rawOption, description: null }];
          }
          const option = objectValue(rawOption);
          if (!option || typeof option.label !== "string") return [];
          return [
            {
              label: option.label,
              description: typeof option.description === "string"
                ? option.description
                : null,
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
        header: typeof question.header === "string" ? question.header : null,
        text: question.question,
        options,
        multiSelect: question.multiSelect === true,
        // Claude's AskUserQuestion normally supplies an automatic "Other"
        // answer, but an explicit provider false remains authoritative.
        allowFreeText: question.allowFreeText !== false,
        isSecret: question.isSecret === true,
      },
    ];
  });
}

function attentionDetails(request: ClaudePendingRequest): AttentionDetails {
  const input = objectValue(request.payload.input);
  const questions = attentionQuestions(request);
  return {
    title: request.title,
    questions: questions.length > 0 ? questions : null,
    toolName: request.toolName,
    inputSummary: request.kind !== "question" && input
      ? boundedInputSummary(input)
      : null,
    respondable: request.kind !== "elicitation",
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
  if (response.persist !== undefined && typeof response.persist !== "boolean") {
    throw new Error("Claude approval persistence must be boolean");
  }
  if (response.persist === true && response.decision !== "allow") {
    throw new Error("Claude persistence can only accompany an allow decision");
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
      const persist = response.persist === true;
      return {
        decision: "allow",
        ...(updatedInput ? { updatedInput } : {}),
        ...(persist ? { persist: true } : {}),
      };
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
  readonly #settingsLookups = new Map<ManagedEntry, Promise<SessionSettingsOptions>>();
  readonly #workspaceIdentities = new Map<string, WorkspaceIdentity | null>();
  readonly #workspaceIdentityResolver: Pick<WorkspaceIdentityResolver, "resolveMany">;
  readonly #workspaceIdentityBudgetMs: number;
  #draftSettingsLookup: Promise<SessionSettingsOptions> | null = null;
  #runtime: Promise<ClaudeSdkRuntime> | null = null;

  constructor(options: ClaudeProviderAdapterOptions) {
    this.#options = options;
    this.#workspaceIdentityBudgetMs = Math.max(
      1,
      options.workspaceIdentityBudgetMs ?? WORKSPACE_IDENTITY_BUDGET_MS,
    );
    this.#workspaceIdentityResolver = options.workspaceIdentityResolver
      ?? new WorkspaceIdentityResolver({ totalBudgetMs: this.#workspaceIdentityBudgetMs });
  }

  /**
   * Repository facts are decoration, never a creation precondition: an error or
   * an exhausted budget records a null identity rather than guessing a
   * repository the git probe never confirmed.
   */
  async #resolveWorkspaceIdentity(cwd: string): Promise<void> {
    try {
      const identities = await this.#workspaceIdentityResolver.resolveMany([cwd], {
        budgetMs: this.#workspaceIdentityBudgetMs,
      });
      this.#workspaceIdentities.set(cwd, identities.get(cwd) ?? null);
    } catch {
      if (!this.#workspaceIdentities.has(cwd)) this.#workspaceIdentities.set(cwd, null);
    }
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
    // Resolved before the SDK query so the first published view already groups
    // under its repository instead of opening a second board column.
    await this.#resolveWorkspaceIdentity(cwd);
    if (context.signal.aborted) throw new Error("Claude session creation was cancelled");

    const runtime = await this.#getRuntime();
    const effort = input.effort ? claudeEffort(input.effort) : undefined;
    const session = await ClaudeManagedSession.start(runtime, {
      cwd,
      mode: profileMode(input.profile),
      initialMessage: input.initialMessage,
      ...(input.model ? { model: input.model } : {}),
      ...(effort ? { effort } : {}),
      // This enables a later explicit full-access profile selection. The
      // active permission mode still controls access and starts narrow.
      allowDangerouslySkipPermissions: true,
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

    const managerSessionId = sessionRecordId("local", "claude", id);
    const projector = new ClaudeActivityProjector();
    const publishActivity = (mutations: readonly ActivityMutation[]): void => {
      for (const mutation of mutations) {
        try {
          this.#options.onActivity?.(managerSessionId, mutation);
        } catch {
          // Activity consumers are observers and cannot stop the SDK pump.
        }
      }
    };
    const entry: ManagedEntry = {
      session,
      name: input.name ?? null,
      projector,
      publishActivity,
      unsubscribe: () => undefined,
    };
    this.#entries.set(id, entry);
    this.#options.hookSourceArbiter?.markManagerOwned(id);
    const unsubscribeMessages = session.onMessage((message) => {
      publishActivity(projector.projectMessage(message));
    });
    const unsubscribeSession = session.subscribe((snapshot) => {
      this.#options.hookSourceArbiter?.markManagerOwned(
        id,
        snapshot.owner === "manager"
          && snapshot.activity !== "closed"
          && snapshot.activity !== "failed",
      );
      publishActivity(projector.projectSnapshot(snapshot));
      try {
        this.#options.onSessionChanged?.(this.#toSessionView(entry, snapshot));
      } catch {
        // A state consumer cannot be allowed to tear down the provider pump.
      }
    });
    entry.unsubscribe = () => {
      unsubscribeMessages();
      unsubscribeSession();
    };
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
    if (view.provider !== "claude" || view.control.authority !== "manager") {
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
    const entry = this.#entries.get(view.providerThreadId);
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
          const response = parseRequestResponse(action.response, pending);
          entry.session.respondToRequest(
            action.requestId,
            response,
          );
          if (pending?.kind === "plan-approval" && response.decision === "allow") {
            entry.publishActivity(entry.projector.projectPlanApproval(
              pending,
              entry.session.snapshot.updatedAt,
            ));
          }
          return { status: "succeeded", result: { requestId: action.requestId } };
        }
        case "interrupt":
          return { status: "succeeded", result: await entry.session.interrupt() };
        case "set-profile":
          await entry.session.setMode(profileMode(action.profile));
          return { status: "succeeded", result: { profile: action.profile } };
        case "set-model":
          await entry.session.setModel(action.model);
          return { status: "succeeded", result: { model: action.model } };
        case "set-effort":
          await entry.session.setEffort(claudeEffort(action.effort));
          return { status: "succeeded", result: { effort: action.effort } };
        case "remove-queued":
          if (!entry.session.removeStagedMessage(action.messageId)) {
            throw new Error("Claude queued message is already dispatching or no longer exists");
          }
          return { status: "succeeded", result: { messageId: action.messageId } };
        case "end":
          entry.session.end();
          return { status: "succeeded" };
        case "archive":
        case "delete":
          throw new Error(`Claude does not support ${action.type}`);
        case "open-editor":
          throw new Error("Claude provider does not own editor launch operations");
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
    const entry = this.#entries.get(view.providerThreadId);
    if (!entry) return null;
    const snapshot = entry.session.snapshot;
    if (!nativeHandoffReadiness(snapshot).ready) return null;
    const handoff = entry.session.prepareCliHandoff();
    return {
      kind: "claude-resume",
      argv: [handoff.command.executable, ...handoff.command.args],
      cwd: handoff.command.cwd,
      handoffId: handoff.id,
      warning: "Starting this command transfers exclusive write ownership to Claude CLI until it exits.",
    };
  }

  /**
   * Draft catalog discovery. It must answer before any manager-owned thread
   * exists and must not borrow an unrelated session as a catalog proxy, so it
   * opens its own non-persisted Query, reads the pinned SDK's `supportedModels`,
   * and closes it again. Concurrent callers share one probe; a provider or
   * transport failure propagates so the route withdraws the catalog instead of
   * publishing a fabricated one.
   */
  async getCreateSettingsOptions(
    context: RequestContext,
  ): Promise<SessionSettingsOptions> {
    if (context.signal.aborted) {
      throw new Error("Claude draft settings lookup was cancelled");
    }
    let lookup = this.#draftSettingsLookup;
    if (!lookup) {
      lookup = boundedSettingsLookup(
        this.#loadDraftSettingsOptions(context.workspace?.path ?? process.cwd()),
      );
      this.#draftSettingsLookup = lookup;
      const activeLookup = lookup;
      const clearLookup = (): void => {
        if (this.#draftSettingsLookup === activeLookup) this.#draftSettingsLookup = null;
      };
      void lookup.then(clearLookup, clearLookup);
    }
    const options = await lookup;
    if (context.signal.aborted) {
      throw new Error("Claude draft settings lookup was cancelled");
    }
    return options;
  }

  async getSettingsOptions(
    view: SessionView,
    context: RequestContext,
  ): Promise<SessionSettingsOptions> {
    if (context.signal.aborted) {
      throw new Error("Claude settings lookup was cancelled");
    }
    if (
      view.provider !== "claude"
      || view.hostId !== "local"
      || view.control.authority !== "manager"
    ) {
      throw new Error("Claude settings require a local manager-owned SDK query");
    }
    const entry = this.#entries.get(view.providerThreadId);
    if (!entry) {
      throw new Error("This manager process does not own the Claude SDK query");
    }
    this.#assertLiveSettingsEntry(view.providerThreadId, entry);
    let lookup = this.#settingsLookups.get(entry);
    if (!lookup) {
      lookup = boundedSettingsLookup(
        this.#loadSettingsOptions(view.providerThreadId, entry),
      );
      this.#settingsLookups.set(entry, lookup);
      const activeLookup = lookup;
      const clearLookup = (): void => {
        if (this.#settingsLookups.get(entry) === activeLookup) {
          this.#settingsLookups.delete(entry);
        }
      };
      void lookup.then(clearLookup, clearLookup);
    }
    const options = await lookup;
    if (context.signal.aborted) {
      throw new Error("Claude settings lookup was cancelled");
    }
    this.#assertLiveSettingsEntry(view.providerThreadId, entry);
    return options;
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
    this.#options.hookSourceArbiter?.markManagerOwned(sessionId);
    return this.#toSessionView(entry, entry.session.snapshot);
  }

  getManagedSession(sessionId: string): SessionView | null {
    const entry = this.#entries.get(sessionId);
    return entry ? this.#toSessionView(entry, entry.session.snapshot) : null;
  }

  dispose(): void {
    for (const [sessionId, entry] of this.#entries) {
      entry.unsubscribe();
      entry.session.dispose();
      this.#options.hookSourceArbiter?.forget(sessionId);
    }
    this.#entries.clear();
    this.#settingsLookups.clear();
    this.#workspaceIdentities.clear();
    this.#draftSettingsLookup = null;
  }

  /**
   * A Query is the SDK's only `supportedModels` edge, so the probe opens one
   * directly rather than through `ClaudeManagedSession`: a managed session only
   * becomes ready once a turn has started, and a draft has no prompt to send.
   * The probe never sends input, never persists, and is always closed.
   */
  async #loadDraftSettingsOptions(cwd: string): Promise<SessionSettingsOptions> {
    const runtime = await this.#getRuntime();
    const prompt = new AsyncInbox<ClaudeSdkUserMessage>();
    const query = runtime.createQuery({
      prompt,
      options: {
        cwd,
        persistSession: false,
        includePartialMessages: true,
        includeHookEvents: true,
        forwardSubagentText: true,
        permissionMode: "default",
        allowDangerouslySkipPermissions: false,
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: "agent-manager",
          [CLAUDE_MANAGER_OWNER_ENV]: CLAUDE_MANAGER_OWNER_VALUE,
        },
        // A catalog read runs no turn. If the provider ever asked anyway, the
        // only safe answer from a surface with no operator is refusal.
        canUseTool: () => Promise.reject(
          new Error("A Claude draft catalog probe cannot answer tool permissions"),
        ),
        onElicitation: () => Promise.resolve({ action: "cancel" as const }),
      },
    });
    try {
      return sessionSettingsOptionsSchema.parse({
        source: "provider-api",
        models: (await query.supportedModels()).map(claudeModelOption),
      });
    } finally {
      prompt.close();
      query.close();
    }
  }

  async #loadSettingsOptions(
    providerSessionId: string,
    entry: ManagedEntry,
  ): Promise<SessionSettingsOptions> {
    const generation = entry.session.snapshot.generation;
    const models = await entry.session.supportedModels();
    this.#assertLiveSettingsEntry(providerSessionId, entry, generation);
    return sessionSettingsOptionsSchema.parse({
      source: "provider-api",
      models: models.map(claudeModelOption),
    });
  }

  #assertLiveSettingsEntry(
    providerSessionId: string,
    entry: ManagedEntry,
    expectedGeneration?: number,
  ): void {
    if (this.#entries.get(providerSessionId) !== entry) {
      throw new Error("The managed Claude session changed during settings lookup");
    }
    const snapshot = entry.session.snapshot;
    if (
      snapshot.owner !== "manager"
      || snapshot.activity === "closed"
      || snapshot.activity === "failed"
      || snapshot.activity === "native"
    ) {
      throw new Error("Claude settings require a live manager-owned SDK query");
    }
    if (
      expectedGeneration !== undefined
      && snapshot.generation !== expectedGeneration
    ) {
      throw new Error("The managed Claude session changed during settings lookup");
    }
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
    const id = sessionRecordId("local", "claude", providerSessionId);
    const status = activityStatus(snapshot);
    const managerControls = snapshot.owner === "manager";
    const writableManagerControls = managerControls
      && snapshot.activity !== "closed"
      && snapshot.activity !== "failed";
    const handoffReadiness = nativeHandoffReadiness(snapshot);
    const canAttach = handoffReadiness.ready;
    const canResume = !writableManagerControls && handoffReadiness.ready;
    const capabilities: SessionView["control"]["capabilities"] = [];
    if (writableManagerControls) {
      capabilities.push(
        "queue",
        "interrupt",
        "set-profile",
        "set-model",
        "set-effort",
        "end",
      );
      if (snapshot.canSteer) capabilities.push("steer");
      if (snapshot.pendingRequests.some((request) => request.kind !== "elicitation")) {
        capabilities.push("respond");
      }
      if (snapshot.stagedMessages.length > 0) capabilities.push("remove-queued");
    }
    if (canResume) capabilities.push("resume");
    if (canAttach) capabilities.push("attach");

    const withheld: SessionView["control"]["withheld"] = [];
    if (!writableManagerControls) {
      const reason = snapshot.owner === "native"
        ? "The native Claude CLI currently owns this session"
        : "The Claude SDK query has ended; resume it before changing the session";
      for (const capability of [
        "queue",
        "steer",
        "interrupt",
        "respond",
        "set-profile",
        "set-model",
        "set-effort",
        "remove-queued",
        "end",
      ] as const) {
        withheld.push({ capability, reason });
      }
    } else {
      if (!snapshot.canSteer) {
        withheld.push({
          capability: "steer",
          reason: `Steering requires Claude Code ${CLAUDE_CODE_VERSION}`,
        });
      }
      if (!snapshot.pendingRequests.some((request) => request.kind !== "elicitation")) {
        withheld.push({ capability: "respond", reason: "Claude is not waiting for a respondable request" });
      }
      if (snapshot.stagedMessages.length === 0) {
        withheld.push({ capability: "remove-queued", reason: "There are no staged messages" });
      }
    }
    if (!canAttach) withheld.push({ capability: "attach", reason: handoffReadiness.reason });
    if (!canResume) {
      withheld.push({
        capability: "resume",
        reason: writableManagerControls
          ? "Resume is available only after the managed Claude query ends"
          : handoffReadiness.reason,
      });
    }
    withheld.push(
      { capability: "archive", reason: "Claude does not expose session archive" },
      { capability: "delete", reason: "Claude does not expose session deletion" },
    );

    return {
      id,
      provider: "claude",
      providerThreadId: providerSessionId,
      providerTreeId: providerSessionId,
      parentId: null,
      providerTurnId: null,
      depth: 0,
      hostId: "local",
      hostLabel: "This Mac",
      name: entry.name,
      cwd: snapshot.cwd,
      kind: "interactive",
      presence: status === "completed" ? "recent" : "live",
      status,
      providerStatus: snapshot.activity,
      pid: null,
      runtimePid: snapshot.handoff?.wrapperPid ?? null,
      startedAt: snapshot.startedAt,
      updatedAt: snapshot.updatedAt,
      childSummary: emptyChildSummary(),
      statusSource: "provider-api",
      source: "claude-sdk",
      profile: {
        value: modeProfile(snapshot.mode),
        providerValue: snapshot.mode,
        source: "provider-api",
        confidence: "exact",
      },
      model: {
        value: snapshot.model,
        providerValue: snapshot.model,
        source: "provider-api",
        confidence: snapshot.model === null ? "heuristic" : "exact",
      },
      effort: providerEffort("claude", snapshot.effort, "provider-api"),
      todoProgress: null,
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
      terminal: null,
      control: {
        plane: writableManagerControls ? "claude-sdk" : "resume-only",
        authority: managerControls ? "manager" : "foreign",
        capabilities,
        withheld,
      },
      workspaceIdentity: structuredClone(
        this.#workspaceIdentities.get(snapshot.cwd) ?? null,
      ),
      generation: snapshot.generation,
    };
  }
}
