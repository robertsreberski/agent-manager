import {
  emptyChildSummary,
  providerControlCoordination,
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
  ManagedSessionRecoveryRecord,
  ManagedSessionRecoveryReport,
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
import { CLAUDE_REASONING_EFFORTS, noSandbox } from "../../shared/session.ts";
import {
  deferredToLaterLayers,
  resolveControlCapabilities,
  type CapabilityRuling,
  type CapabilityRulings,
} from "../shared/capabilities.ts";
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
import { profileForClaudePermissionMode } from "./profile.ts";

interface ManagedEntry {
  session: ClaudeManagedSession;
  name: string | null;
  published: boolean;
  ended: boolean;
  endTask: Promise<void> | null;
  projector: ClaudeActivityProjector;
  publishActivity(mutations: readonly ActivityMutation[]): void;
  unsubscribe: () => void;
}

interface DormantResumeProvisional {
  dormant: ManagedEntry;
  session: ClaudeManagedSession;
  name: string | null;
  committable: boolean;
  cleanup: Promise<void> | null;
  releaseReservation: () => void;
}

interface ExternalAdoptionProvisional {
  session: ClaudeManagedSession;
  name: string | null;
  committable: boolean;
  cleanup: Promise<void> | null;
  releaseReservation: () => void;
}

interface ProvisionalInFlight {
  controller: AbortController;
  releaseReservation: () => void;
}

export type ClaudeManagedSessionLossReason =
  | "unexpected-close"
  | "unexpected-failure"
  | "ownership-conflict";

/*
  A backstop against a settings lookup that never settles, not the deadline a
  caller waits on. The HTTP routes bound their own request
  (`SETTINGS_OPTIONS_TIMEOUT_MS`, 3s) and return `provider-unavailable` when it
  expires, so this must sit well above that: a draft catalog read spawns a
  `claude` subprocess and measures 750-1150ms on a warm machine, and at 2s it
  was the binding constraint rather than the backstop — a probe merely slowed by
  a busy manager failed here before the request bound ever applied, leaving the
  composer with an empty catalog.

  It cannot be the request signal instead. The lookup is shared by every
  concurrent draft (`#draftSettingsLookup`), so one caller navigating away must
  not abort a probe the others are still awaiting.
*/
const CLAUDE_SETTINGS_LOOKUP_TIMEOUT_MS = 10_000;
const WORKSPACE_IDENTITY_BUDGET_MS = 2_500;
const MAX_RECOVERY_RECORDS = 100;
const RECOVERY_CONCURRENCY = 4;

export interface ClaudeProviderAdapterOptions {
  resolveWorkspace?(
    workspaceId: string,
    context: RequestContext,
  ): string | null | Promise<string | null>;
  runtime?: ClaudeSdkRuntime | (() => Promise<ClaudeSdkRuntime>);
  /** Canonical executable resolved by the service bootstrap. */
  claudeExecutable?: string;
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
  onManagerControlStopped?: (managerSessionId: string) => void | Promise<void>;
  onActivity?: (managerSessionId: string, mutation: ActivityMutation) => void;
  /**
   * The SDK writer was withdrawn without an explicit End. Durable identity and
   * activity remain server-owned so the caller can start managed recovery.
   */
  onSessionLost?: (
    managerSessionId: string,
    reason: ClaudeManagedSessionLossReason,
  ) => void | Promise<void>;
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

function boundedSettingsLookup<T>(
  promise: Promise<T>,
  onTimeout?: (error: Error) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(
      signal?.reason ?? new Error("Claude settings lookup was cancelled"),
    ));
    const timer = setTimeout(() => {
      const error = new Error("Claude settings lookup timed out");
      onTimeout?.(error);
      finish(() => reject(error));
    }, CLAUDE_SETTINGS_LOOKUP_TIMEOUT_MS);
    timer.unref();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function recoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message.trim() || "Claude recovery failed").slice(0, 2_000).join("");
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => {
    if (!target.signal.aborted) target.abort(source.reason);
  };
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
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
    ...(typeof model.resolvedModel === "string" && model.resolvedModel.length > 0
      ? { resolvedModel: model.resolvedModel }
      : {}),
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
  /*
    A plan's own input is its markdown, which the activity stream already
    carries as a plan item and renders as written. Serializing it here would
    put a thousand characters of JSON-escaped document into a one-line summary,
    so the summary states what the request is instead.
  */
  const planText = [input?.plan, input?.planFilePath]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const hasPlan = request.kind === "plan-approval" && planText !== undefined;
  return {
    title: request.title,
    questions: questions.length > 0 ? questions : null,
    toolName: request.toolName,
    inputSummary: request.kind === "plan-approval"
      ? hasPlan ? "The plan is shown in the activity timeline." : null
      : request.kind !== "question" && input
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
  readonly #lifetime = new AbortController();
  readonly #connecting = new Map<AbortController, Promise<unknown>>();
  readonly #resuming = new Map<string, ProvisionalInFlight>();
  readonly #dormantResumes = new Map<string, DormantResumeProvisional>();
  readonly #adopting = new Map<string, ProvisionalInFlight>();
  readonly #externalAdoptions = new Map<string, ExternalAdoptionProvisional>();
  #unsubscribeOwnershipConflicts: () => void = () => undefined;
  #draftSettingsLookup: Promise<SessionSettingsOptions> | null = null;
  #runtime: Promise<ClaudeSdkRuntime> | null = null;
  #disposed = false;

  constructor(options: ClaudeProviderAdapterOptions) {
    if (
      options.claudeExecutable !== undefined
      && options.claudeExecutable.trim().length === 0
    ) {
      throw new Error("claudeExecutable must not be empty");
    }
    this.#options = options;
    this.#workspaceIdentityBudgetMs = Math.max(
      1,
      options.workspaceIdentityBudgetMs ?? WORKSPACE_IDENTITY_BUDGET_MS,
    );
    this.#workspaceIdentityResolver = options.workspaceIdentityResolver
      ?? new WorkspaceIdentityResolver({ totalBudgetMs: this.#workspaceIdentityBudgetMs });
    this.#unsubscribeOwnershipConflicts = options.hookSourceArbiter?.onOwnershipConflict(
      ({ sessionId }) => this.#handleOwnershipConflict(sessionId),
    ) ?? (() => undefined);
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
    const session = await this.#connectManagedSession(context.signal, (signal) =>
      ClaudeManagedSession.start(runtime, {
        cwd,
        mode: profileMode(input.profile),
        initialMessage: input.initialMessage,
        ...this.#executableConfig(runtime),
        ...(input.model ? { model: input.model } : {}),
        ...(effort ? { effort } : {}),
        // This enables a later explicit full-access profile selection. The
        // active permission mode still controls access and starts narrow.
        allowDangerouslySkipPermissions: true,
      }, signal)
    );
    try {
      if (this.#disposed) throw new Error("Claude provider adapter is disposed");
      if (context.signal.aborted) {
        throw new Error("Claude session creation was cancelled");
      }
      const id = session.snapshot.sessionId;
      if (!id) throw new Error("Claude SDK initialized without a session id");
      return this.#registerSession(session, input.name ?? null, true);
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  async adoptExternalSession(
    view: SessionView,
    profile: ExecutionProfile,
    context: RequestContext,
  ): Promise<SessionView> {
    if (
      view.provider !== "claude"
      || view.hostId !== "local"
      || view.id !== sessionRecordId("local", "claude", view.providerThreadId)
      || !view.cwd
    ) throw new Error("Claude adoption requires one exact local session identity");
    if (this.#entries.has(view.providerThreadId)) {
      throw new Error("Claude session is already managed by this adapter");
    }
    if (
      this.#adopting.has(view.providerThreadId)
      || this.#externalAdoptions.has(view.providerThreadId)
    ) {
      throw new Error("Claude session adoption is already in progress");
    }
    if (!context.workspace || context.workspace.path !== view.cwd) {
      throw new Error("Claude adoption workspace does not match the discovered session");
    }
    const cwd = view.cwd;
    const providerSessionId = view.providerThreadId;
    const controller = new AbortController();
    const releaseRequest = forwardAbort(context.signal, controller);
    let releaseReservation = (): void => undefined;
    const inFlight: ProvisionalInFlight = {
      controller,
      releaseReservation: () => releaseReservation(),
    };
    this.#adopting.set(providerSessionId, inFlight);
    releaseReservation = this.#options.hookSourceArbiter?.reserveManagerAdoption(
      providerSessionId,
      () => {
        const error = new Error("A native Claude owner appeared during web adoption");
        if (!controller.signal.aborted) controller.abort(error);
        const provisional = this.#externalAdoptions.get(providerSessionId);
        if (provisional) {
          provisional.committable = false;
          void this.#cleanupProvisional(
            this.#externalAdoptions,
            providerSessionId,
            provisional,
          ).catch(() => undefined);
        }
      },
    ) ?? (() => undefined);

    let retainedReservation = false;
    try {
      controller.signal.throwIfAborted();
      await this.#resolveWorkspaceIdentity(cwd);
      controller.signal.throwIfAborted();
      const runtime = await this.#getRuntime();
      const desiredMode = profileMode(profile);
      const desiredEffort = view.effort.value
        ? claudeEffort(view.effort.value)
        : undefined;
      const session = await this.#runConnectingOperation(
        controller.signal,
        async (signal) => {
          let resumed: ClaudeManagedSession | null = null;
          try {
            resumed = await ClaudeManagedSession.resume(runtime, {
              sessionId: providerSessionId,
              cwd,
              mode: desiredMode,
              ...this.#executableConfig(runtime),
              ...(view.model.value ? { model: view.model.value } : {}),
              ...(desiredEffort ? { effort: desiredEffort } : {}),
              allowDangerouslySkipPermissions: true,
            }, signal);
            const abortSession = (): void => {
              void resumed?.dispose();
            };
            signal.addEventListener("abort", abortSession, { once: true });
            try {
              signal.throwIfAborted();
              if (
                resumed.snapshot.sessionId !== providerSessionId
                || resumed.snapshot.cwd !== cwd
              ) {
                throw new Error("Claude resume changed the validated provider identity");
              }
              if (resumed.snapshot.mode !== desiredMode) {
                await resumed.setMode(desiredMode);
              }
              signal.throwIfAborted();
              if (view.model.value && resumed.snapshot.model !== view.model.value) {
                await resumed.setModel(view.model.value);
              }
              signal.throwIfAborted();
              if (desiredEffort && resumed.snapshot.effort !== desiredEffort) {
                await resumed.setEffort(desiredEffort);
              }
              signal.throwIfAborted();
              return resumed;
            } finally {
              signal.removeEventListener("abort", abortSession);
            }
          } catch (error) {
            if (resumed) await resumed.dispose();
            throw error;
          }
        },
      );
      try {
        controller.signal.throwIfAborted();
        if (
          this.#disposed
          || this.#adopting.get(providerSessionId) !== inFlight
          || this.#entries.has(providerSessionId)
          || this.#externalAdoptions.has(providerSessionId)
        ) {
          throw new Error("Claude adoption ownership changed during initialization");
        }
        this.#externalAdoptions.set(providerSessionId, {
          session,
          name: view.name,
          committable: true,
          cleanup: null,
          releaseReservation,
        });
        retainedReservation = true;
        return this.#toSessionView({
          session,
          name: view.name,
          published: false,
          ended: false,
          endTask: null,
          projector: new ClaudeActivityProjector(),
          publishActivity: () => undefined,
          unsubscribe: () => undefined,
        }, session.snapshot);
      } catch (error) {
        await session.dispose();
        throw error;
      }
    } finally {
      releaseRequest();
      if (!retainedReservation) releaseReservation();
      if (this.#adopting.get(providerSessionId) === inFlight) {
        this.#adopting.delete(providerSessionId);
      }
    }
  }

  /**
   * Prepares an exact in-web resume without changing the public dormant entry.
   * The caller must durably persist managerControl=active and then call
   * commitExternalAdoption(), or call abortExternalAdoption() on every failure.
   */
  async resumeSession(
    view: SessionView,
    profile: ExecutionProfile,
    context: RequestContext,
  ): Promise<SessionView> {
    if (
      view.provider !== "claude"
      || view.hostId !== "local"
      || view.id !== sessionRecordId("local", "claude", view.providerThreadId)
      || !view.cwd
    ) {
      throw new Error("Claude resume requires one exact local session identity");
    }
    const entry = this.#entries.get(view.providerThreadId);
    if (!entry) return this.adoptExternalSession(view, profile, context);
    if (this.#resuming.has(view.providerThreadId)) {
      throw new Error("Claude session resume is already in progress");
    }
    if (this.#dormantResumes.has(view.providerThreadId)) {
      throw new Error("Claude session resume is awaiting durable commit");
    }
    if (!context.workspace || context.workspace.path !== view.cwd) {
      throw new Error("Claude resume workspace does not match the managed session");
    }

    const snapshot = entry.session.snapshot;
    const current = this.#toSessionView(entry, snapshot);
    if (
      !entry.published
      || !entry.ended
      || snapshot.owner !== "manager"
      || snapshot.activity !== "closed"
      || snapshot.sessionId !== view.providerThreadId
      || snapshot.cwd !== view.cwd
      || current.generation !== view.generation
      || current.profile.value !== view.profile.value
      || current.model.value !== view.model.value
      || current.effort.value !== view.effort.value
    ) {
      throw new Error("Claude session is not the exact current dormant manager record");
    }
    if (profile !== current.profile.value) {
      throw new Error("Claude resume must preserve the dormant execution profile");
    }

    const controller = new AbortController();
    const releaseRequest = forwardAbort(context.signal, controller);
    let releaseReservation = (): void => undefined;
    const inFlight: ProvisionalInFlight = {
      controller,
      releaseReservation: () => releaseReservation(),
    };
    this.#resuming.set(view.providerThreadId, inFlight);
    releaseReservation = this.#options.hookSourceArbiter?.reserveManagerAdoption(
      view.providerThreadId,
      () => {
        const error = new Error("A native Claude owner appeared during web resume");
        if (!controller.signal.aborted) controller.abort(error);
        const provisional = this.#dormantResumes.get(view.providerThreadId);
        if (provisional) {
          provisional.committable = false;
          void this.#cleanupProvisional(
            this.#dormantResumes,
            view.providerThreadId,
            provisional,
          ).catch(() => undefined);
        }
      },
    ) ?? (() => undefined);
    let retainedReservation = false;
    try {
      const desiredMode = profileMode(profile);
      const desiredEffort = view.effort.value
        ? claudeEffort(view.effort.value)
        : undefined;
      const session = await this.#runConnectingOperation(
        controller.signal,
        async (signal) => {
          let resumed: ClaudeManagedSession | null = null;
          try {
            resumed = await entry.session.resumeDormantExact({
              sessionId: view.providerThreadId,
              cwd: view.cwd as string,
              mode: desiredMode,
              ...(view.model.value ? { model: view.model.value } : {}),
              ...(desiredEffort ? { effort: desiredEffort } : {}),
            }, signal);
            const abortSession = (): void => {
              void resumed?.dispose();
            };
            signal.addEventListener("abort", abortSession, { once: true });
            try {
              signal.throwIfAborted();
              if (resumed.snapshot.mode !== desiredMode) {
                await resumed.setMode(desiredMode);
              }
              signal.throwIfAborted();
              if (view.model.value && resumed.snapshot.model !== view.model.value) {
                await resumed.setModel(view.model.value);
              }
              signal.throwIfAborted();
              if (desiredEffort && resumed.snapshot.effort !== desiredEffort) {
                await resumed.setEffort(desiredEffort);
              }
              signal.throwIfAborted();
              return resumed;
            } finally {
              signal.removeEventListener("abort", abortSession);
            }
          } catch (error) {
            if (resumed) await resumed.dispose();
            throw error;
          }
        },
      );

      try {
        controller.signal.throwIfAborted();
        if (
          this.#disposed
          || this.#entries.get(view.providerThreadId) !== entry
          || entry.session.snapshot.generation !== snapshot.generation
          || this.#dormantResumes.has(view.providerThreadId)
        ) {
          throw new Error("Claude dormant manager record changed during resume");
        }
        this.#dormantResumes.set(view.providerThreadId, {
          dormant: entry,
          session,
          name: entry.name,
          committable: true,
          cleanup: null,
          releaseReservation,
        });
        retainedReservation = true;
        return this.#toSessionView({
          ...entry,
          session,
          published: false,
          ended: false,
          endTask: null,
        }, session.snapshot);
      } catch (error) {
        await session.dispose();
        throw error;
      }
    } finally {
      releaseRequest();
      if (!retainedReservation) releaseReservation();
      if (this.#resuming.get(view.providerThreadId) === inFlight) {
        this.#resuming.delete(view.providerThreadId);
      }
    }
  }

  async restoreManagedSessions(
    records: readonly ManagedSessionRecoveryRecord[],
    signal: AbortSignal,
  ): Promise<ManagedSessionRecoveryReport> {
    const selected = records.slice(0, MAX_RECOVERY_RECORDS);
    const failures: Array<string | null> = selected.map(() => null);
    const restored = selected.map(() => false);
    const seenSessionIds = new Set<string>();
    const candidates: Array<{ index: number; record: ManagedSessionRecoveryRecord }> = [];
    for (const [index, record] of selected.entries()) {
      if (
        record.provider !== "claude"
        || record.managerSessionId !== sessionRecordId("local", "claude", record.providerThreadId)
      ) {
        failures[index] = "Persisted manager and Claude session identities do not match";
        continue;
      }
      if (seenSessionIds.has(record.providerThreadId)) {
        failures[index] = "Persisted Claude session identity is duplicated";
        continue;
      }
      seenSessionIds.add(record.providerThreadId);
      if (this.#entries.has(record.providerThreadId)) {
        failures[index] = "Claude session is already managed by this adapter";
        continue;
      }
      candidates.push({ index, record });
    }

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        if (!candidate) return;
        const { index, record } = candidate;
        let session: ClaudeManagedSession | null = null;
        try {
          signal.throwIfAborted();
          await this.#resolveWorkspaceIdentity(record.workspacePath);
          signal.throwIfAborted();
          const runtime = await this.#getRuntime();
          const effort = record.effort ? claudeEffort(record.effort) : undefined;
          const resumeConfig = {
              sessionId: record.providerThreadId,
              cwd: record.workspacePath,
              mode: profileMode(record.profile),
              ...this.#executableConfig(runtime),
              ...(record.model ? { model: record.model } : {}),
              ...(effort ? { effort } : {}),
              allowDangerouslySkipPermissions: true,
          };
          session = record.managerControl === "stopped"
            ? ClaudeManagedSession.dormant(runtime, resumeConfig)
            : await this.#connectManagedSession(signal, (attemptSignal) =>
                ClaudeManagedSession.resume(runtime, resumeConfig, attemptSignal)
              );
          signal.throwIfAborted();
          if (this.#disposed) throw new Error("Claude provider adapter is disposed");
          if (
            session.snapshot.sessionId !== record.providerThreadId
            || session.snapshot.cwd !== record.workspacePath
          ) throw new Error("Claude recovery returned a different session identity or workspace");
          this.#registerSession(session, record.name, true);
          session = null;
          restored[index] = true;
        } catch (error) {
          if (session) await session.dispose();
          failures[index] = recoveryError(error);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(RECOVERY_CONCURRENCY, candidates.length) },
        () => worker(),
      ),
    );
    return {
      restoredSessionIds: selected.flatMap((record, index) =>
        restored[index] ? [record.managerSessionId] : []
      ),
      failures: selected.flatMap((record, index) => {
        const reason = failures[index];
        return reason === null || reason === undefined ? [] : [{
          managerSessionId: record.managerSessionId,
          providerThreadId: record.providerThreadId,
          reason,
        }];
      }),
      truncated: records.length > selected.length,
    };
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
        case "set-sandbox":
          // Never reachable through the capability list; refused rather than
          // silently accepted so a mistake stays visible.
          return actionFailure("UNSUPPORTED_ACTION", "Claude has no sandbox setting");
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
          // Mark intent before the synchronous snapshot notification so an
          // unexpected-loss observer cannot mistake this deliberate close for
          // a provider failure and retire the durable identity.
          if (!entry.endTask) {
            entry.ended = true;
            let intentPersisted = false;
            const endTask = Promise.resolve().then(async () => {
              try {
                // This write-ahead intent is the safety boundary: if it cannot
                // be committed, leave the SDK consumer live so a failed End can
                // never turn into an automatic restart resume.
                await this.#options.onManagerControlStopped?.(view.id);
                intentPersisted = true;
                await entry.session.end();
              } catch (error) {
                if (!intentPersisted) {
                  entry.ended = false;
                  entry.endTask = null;
                }
                throw error;
              }
            });
            entry.endTask = endTask;
          }
          await entry.endTask;
          return { status: "succeeded" };
        case "archive":
        case "delete":
        case "resume":
        case "take-control":
        case "cancel-take-control":
        case "retry-control":
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
    if (
      this.#resuming.has(view.providerThreadId)
      || this.#dormantResumes.has(view.providerThreadId)
    ) {
      // A provisional SDK owner already exists. Native resume must stay
      // unavailable until that owner is either committed or rolled back.
      return null;
    }
    const entry = this.#entries.get(view.providerThreadId);
    if (!entry) return null;
    const snapshot = entry.session.snapshot;
    if (!nativeHandoffReadiness(snapshot).ready) return null;
    const handoff = await entry.session.prepareCliHandoff(context.requestId, context.signal);
    if (context.signal.aborted) {
      entry.session.markCliAttachFailed(handoff.id, "Native handoff preparation was cancelled");
      // Do not start an unbounded replacement SDK writer after the caller's
      // deadline. Leave the exact handoff fail-closed for managed recovery.
      await entry.session.reclaimFromCli(handoff.id, context.signal).catch(() => undefined);
      context.signal.throwIfAborted();
    }
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
      lookup = this.#loadDraftSettingsOptions(context.workspace?.path ?? process.cwd());
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
    await this.#runConnectingOperation(undefined, (signal) =>
      entry.session.reclaimFromCli(handoffId, signal)
    );
    if (this.#disposed) throw new Error("Claude provider adapter is disposed");
    this.#options.hookSourceArbiter?.markManagerOwned(sessionId);
    return this.#toSessionView(entry, entry.session.snapshot);
  }

  getManagedSession(sessionId: string): SessionView | null {
    const entry = this.#entries.get(sessionId);
    return entry ? this.#toSessionView(entry, entry.session.snapshot) : null;
  }

  commitExternalAdoption(sessionId: string): SessionView {
    const external = this.#externalAdoptions.get(sessionId);
    if (external) {
      if (this.#disposed) throw new Error("Claude provider adapter is disposed");
      if (!external.committable || external.cleanup) {
        throw new Error("Claude provisional adoption is quarantined during cleanup");
      }
      const snapshot = external.session.snapshot;
      if (
        this.#entries.has(sessionId)
        || snapshot.sessionId !== sessionId
        || snapshot.resumedFrom !== sessionId
        || snapshot.owner !== "manager"
        || snapshot.activity === "closed"
        || snapshot.activity === "failed"
      ) {
        throw new Error("Claude provisional adoption is no longer a live exact owner");
      }
      this.#externalAdoptions.delete(sessionId);
      external.releaseReservation();
      try {
        this.#registerSession(external.session, external.name, false);
        const active = this.#requireEntry(sessionId);
        active.published = true;
        return this.#toSessionView(active, active.session.snapshot);
      } catch (error) {
        void external.session.dispose().catch(() => undefined);
        throw error;
      }
    }
    const provisional = this.#dormantResumes.get(sessionId);
    if (provisional) {
      if (this.#disposed) throw new Error("Claude provider adapter is disposed");
      if (!provisional.committable || provisional.cleanup) {
        throw new Error("Claude provisional resume is quarantined during cleanup");
      }
      if (this.#entries.get(sessionId) !== provisional.dormant) {
        throw new Error("Claude dormant manager record changed before commit");
      }
      const snapshot = provisional.session.snapshot;
      if (
        snapshot.sessionId !== sessionId
        || snapshot.resumedFrom !== sessionId
        || snapshot.cwd !== provisional.dormant.session.snapshot.cwd
        || snapshot.owner !== "manager"
        || snapshot.activity === "closed"
        || snapshot.activity === "failed"
      ) {
        throw new Error("Claude provisional resume is no longer a live exact owner");
      }

      // From here to #registerSession is synchronous: no other action can see a
      // missing entry or interleave a second writer between the durable commit
      // and the provider ownership swap.
      this.#dormantResumes.delete(sessionId);
      provisional.releaseReservation();
      this.#entries.delete(sessionId);
      this.#settingsLookups.delete(provisional.dormant);
      provisional.dormant.unsubscribe();
      this.#registerSession(
        provisional.session,
        provisional.name,
        false,
      );
      const active = this.#requireEntry(sessionId);
      active.published = true;
      void provisional.dormant.session.dispose().catch(() => undefined);
      return this.#toSessionView(active, active.session.snapshot);
    }
    const entry = this.#requireEntry(sessionId);
    if (entry.published) {
      throw new Error("Claude session has no provisional adoption to commit");
    }
    entry.published = true;
    return this.#toSessionView(entry, entry.session.snapshot);
  }

  async abortExternalAdoption(sessionId: string): Promise<void> {
    const adopting = this.#adopting.get(sessionId);
    if (adopting) {
      if (!adopting.controller.signal.aborted) {
        adopting.controller.abort(new Error("Claude provisional adoption was cancelled"));
      }
      adopting.releaseReservation();
    }
    const external = this.#externalAdoptions.get(sessionId);
    if (external) {
      external.committable = false;
      await this.#cleanupProvisional(
        this.#externalAdoptions,
        sessionId,
        external,
      );
      return;
    }
    const provisional = this.#dormantResumes.get(sessionId);
    if (provisional) {
      provisional.committable = false;
      await this.#cleanupProvisional(
        this.#dormantResumes,
        sessionId,
        provisional,
      );
      return;
    }
    // First-time and dormant provisionals live only in the quarantined maps
    // above. #entries may be briefly unpublished only inside the synchronous
    // commit swap, where no abort call can interleave.
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      await Promise.allSettled(this.#connecting.values());
      return;
    }
    this.#disposed = true;
    this.#unsubscribeOwnershipConflicts();
    this.#unsubscribeOwnershipConflicts = () => undefined;
    this.#lifetime.abort(new Error("Claude provider adapter was disposed"));
    for (const controller of this.#connecting.keys()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Claude provider adapter was disposed"));
      }
    }
    const settlements: Promise<unknown>[] = [...this.#connecting.values()];
    for (const resuming of this.#resuming.values()) {
      if (!resuming.controller.signal.aborted) {
        resuming.controller.abort(new Error("Claude provider adapter was disposed"));
      }
      resuming.releaseReservation();
    }
    this.#resuming.clear();
    for (const adopting of this.#adopting.values()) {
      if (!adopting.controller.signal.aborted) {
        adopting.controller.abort(new Error("Claude provider adapter was disposed"));
      }
      adopting.releaseReservation();
    }
    this.#adopting.clear();
    for (const [sessionId, external] of this.#externalAdoptions) {
      external.committable = false;
      settlements.push(this.#cleanupProvisional(
        this.#externalAdoptions,
        sessionId,
        external,
      ));
    }
    for (const [sessionId, provisional] of this.#dormantResumes) {
      provisional.committable = false;
      settlements.push(this.#cleanupProvisional(
        this.#dormantResumes,
        sessionId,
        provisional,
      ));
    }
    for (const [sessionId, entry] of this.#entries) {
      entry.unsubscribe();
      settlements.push(entry.session.dispose());
      this.#options.hookSourceArbiter?.forget(sessionId);
    }
    this.#entries.clear();
    this.#settingsLookups.clear();
    this.#workspaceIdentities.clear();
    this.#draftSettingsLookup = null;
    await Promise.allSettled(settlements);
  }

  /**
   * A Query is the SDK's only `supportedModels` edge, so the probe opens one
   * directly rather than through `ClaudeManagedSession`: a managed session only
   * becomes ready once a turn has started, and a draft has no prompt to send.
   * The probe never sends input, never persists, and is always closed.
   */
  async #loadDraftSettingsOptions(cwd: string): Promise<SessionSettingsOptions> {
    const runtime = await this.#getRuntime();
    if (this.#disposed) throw new Error("Claude provider adapter is disposed");
    const prompt = new AsyncInbox<ClaudeSdkUserMessage>();
    const abortController = new AbortController();
    const releaseLifetime = forwardAbort(this.#lifetime.signal, abortController);
    let query: ReturnType<ClaudeSdkRuntime["createQuery"]> | null = null;
    let closed = false;
    const close = (reason?: unknown): void => {
      if (closed) return;
      closed = true;
      if (reason !== undefined && !abortController.signal.aborted) {
        abortController.abort(reason);
      }
      prompt.close();
      try {
        query?.close();
      } catch {
        // The owned abort signal and prompt have already withdrawn this probe.
      }
    };
    try {
      query = runtime.createQuery({
        prompt,
        options: {
          abortController,
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
          ...((this.#options.claudeExecutable ?? runtime.claudeCodeExecutable)
            ? {
                pathToClaudeCodeExecutable:
                  this.#options.claudeExecutable ?? runtime.claudeCodeExecutable,
              }
            : {}),
          // A catalog read runs no turn. If the provider ever asked anyway, the
          // only safe answer from a surface with no operator is refusal.
          canUseTool: () => Promise.reject(
            new Error("A Claude draft catalog probe cannot answer tool permissions"),
          ),
          onElicitation: () => Promise.resolve({ action: "cancel" as const }),
        },
      });
    } catch (error) {
      close(error);
      releaseLifetime();
      throw error;
    }
    abortController.signal.addEventListener("abort", () => close(), { once: true });
    try {
      return sessionSettingsOptionsSchema.parse({
        source: "provider-api",
        models: (await boundedSettingsLookup(
          query.supportedModels(),
          (error) => close(error),
          abortController.signal,
        )).map(claudeModelOption),
      });
    } finally {
      releaseLifetime();
      close();
    }
  }

  async #loadSettingsOptions(
    providerSessionId: string,
    entry: ManagedEntry,
  ): Promise<SessionSettingsOptions> {
    const models = await entry.session.supportedModels();
    this.#assertLiveSettingsEntry(providerSessionId, entry);
    return sessionSettingsOptionsSchema.parse({
      source: "provider-api",
      models: models.map(claudeModelOption),
    });
  }

  /*
    Identity and liveness only — deliberately not generation. Streamed
    messages bump the snapshot generation continuously, and a fresh session
    is always streaming, so a generation comparison would reject exactly the
    reads a fresh session issues. The catalog does not depend on any state a
    turn can change; entry replacement and ownership loss are what invalidate
    it, and both are checked here.
  */
  #assertLiveSettingsEntry(
    providerSessionId: string,
    entry: ManagedEntry,
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
        : loadClaudeSdkRuntime({
            ...(this.#options.claudeExecutable
              ? { claudeCodeExecutable: this.#options.claudeExecutable }
              : {}),
          });
    }
    return this.#runtime;
  }

  #executableConfig(runtime: ClaudeSdkRuntime): { claudeCodeExecutable?: string } {
    const executable = this.#options.claudeExecutable ?? runtime.claudeCodeExecutable;
    return executable ? { claudeCodeExecutable: executable } : {};
  }

  #connectManagedSession(
    parentSignal: AbortSignal,
    connect: (signal: AbortSignal) => Promise<ClaudeManagedSession>,
  ): Promise<ClaudeManagedSession> {
    return this.#runConnectingOperation(parentSignal, connect);
  }

  async #runConnectingOperation<T>(
    parentSignal: AbortSignal | undefined,
    connect: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#disposed) throw new Error("Claude provider adapter is disposed");
    const controller = new AbortController();
    const releaseParent = parentSignal
      ? forwardAbort(parentSignal, controller)
      : () => undefined;
    const releaseLifetime = forwardAbort(this.#lifetime.signal, controller);
    const promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return connect(controller.signal);
    });
    this.#connecting.set(controller, promise);
    try {
      return await promise;
    } finally {
      this.#connecting.delete(controller);
      releaseParent();
      releaseLifetime();
    }
  }

  #cleanupProvisional<
    T extends {
      session: ClaudeManagedSession;
      committable: boolean;
      cleanup: Promise<void> | null;
      releaseReservation: () => void;
    },
  >(
    provisionals: Map<string, T>,
    sessionId: string,
    provisional: T,
  ): Promise<void> {
    provisional.committable = false;
    provisional.releaseReservation();
    if (provisional.cleanup) return provisional.cleanup;

    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(() => provisional.session.dispose())
      .then(
        () => {
          if (provisional.cleanup === tracked) provisional.cleanup = null;
          if (provisionals.get(sessionId) === provisional) {
            provisionals.delete(sessionId);
          }
        },
        (error: unknown) => {
          // A positively rejected close can be retried, but the exact record
          // remains quarantined between attempts. A hanging close never reaches
          // this branch, so every concurrent abort keeps sharing `tracked`.
          if (provisional.cleanup === tracked) provisional.cleanup = null;
          throw error;
        },
      );
    provisional.cleanup = tracked;
    return tracked;
  }

  #registerSession(
    session: ClaudeManagedSession,
    name: string | null,
    published: boolean,
  ): SessionView {
    if (this.#disposed) throw new Error("Claude provider adapter is disposed");
    const id = session.snapshot.sessionId;
    if (!id || this.#entries.has(id)) {
      throw new Error(id ? "Claude session is already managed" : "Claude session has no provider identity");
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
      name,
      published,
      // A dormant session is the durable representation of an explicit prior
      // End. It must not immediately trigger the unexpected-loss path merely
      // because its intentionally query-free snapshot is closed.
      ended: session.snapshot.activity === "closed",
      endTask: null,
      projector,
      publishActivity,
      unsubscribe: () => undefined,
    };
    this.#entries.set(id, entry);
    const initialSnapshot = session.snapshot;
    this.#options.hookSourceArbiter?.markManagerOwned(
      id,
      initialSnapshot.owner === "manager"
        && initialSnapshot.activity !== "closed"
        && initialSnapshot.activity !== "failed",
    );
    const unsubscribeMessages = session.onMessage((message) => {
      publishActivity(projector.projectMessage(message));
    });
    const unsubscribeSession = session.subscribe((snapshot) => {
      publishActivity(projector.projectSnapshot(snapshot));
      if (
        !this.#disposed
        && !entry.ended
        && snapshot.owner === "manager"
        && (snapshot.activity === "closed" || snapshot.activity === "failed")
      ) {
        this.#retireLostEntry(
          id,
          entry,
          snapshot.activity === "closed" ? "unexpected-close" : "unexpected-failure",
        );
        return;
      }
      this.#options.hookSourceArbiter?.markManagerOwned(
        id,
        snapshot.owner === "manager"
          && snapshot.activity !== "closed"
          && snapshot.activity !== "failed",
      );
      if (!entry.published) return;
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

  #handleOwnershipConflict(providerSessionId: string): void {
    if (this.#disposed) return;
    const resuming = this.#resuming.get(providerSessionId);
    if (resuming && !resuming.controller.signal.aborted) {
      resuming.controller.abort(new Error("A native Claude owner appeared during web resume"));
    }
    const provisional = this.#dormantResumes.get(providerSessionId);
    if (provisional) {
      provisional.committable = false;
      void this.#cleanupProvisional(
        this.#dormantResumes,
        providerSessionId,
        provisional,
      ).catch(() => undefined);
    }
    const entry = this.#entries.get(providerSessionId);
    if (!entry || entry.ended) return;
    this.#retireLostEntry(providerSessionId, entry, "ownership-conflict");
  }

  #retireLostEntry(
    providerSessionId: string,
    entry: ManagedEntry,
    reason: ClaudeManagedSessionLossReason,
  ): void {
    if (
      this.#disposed
      || entry.ended
      || this.#entries.get(providerSessionId) !== entry
    ) return;

    // This is the local ownership commit point: no later action lookup can
    // reach the writer, and observers are detached before dispose publishes its
    // deliberate terminal snapshot. The durable record is intentionally left
    // to the server's recovery coordinator.
    entry.ended = true;
    this.#entries.delete(providerSessionId);
    this.#settingsLookups.delete(entry);
    entry.unsubscribe();
    this.#options.hookSourceArbiter?.forget(providerSessionId);
    const disposal = entry.session.dispose();

    try {
      const notification = this.#options.onSessionLost?.(
        sessionRecordId("local", "claude", providerSessionId),
        reason,
      );
      void Promise.resolve(notification).catch(() => undefined);
    } catch {
      // Recovery notification is an observer edge. Local writer withdrawal is
      // already committed and must not be rolled back if the server is closing.
    }
    void disposal.catch(() => undefined);
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
    /*
      One ruling per control, so the published capability and withheld lists are
      derived from the same answer instead of being maintained beside each other.
    */
    const noWrites = snapshot.owner === "native"
      ? "The native Claude CLI currently owns this session"
      : "The Claude SDK query has ended; resume it before changing the session";
    const writable = (granted: boolean, reason: string): CapabilityRuling =>
      writableManagerControls ? (granted ? true : reason) : noWrites;
    const rulings = {
      ...deferredToLaterLayers(),
      queue: writable(true, noWrites),
      steer: writable(snapshot.canSteer, `Steering requires Claude Code ${CLAUDE_CODE_VERSION}`),
      interrupt: writable(true, noWrites),
      respond: writable(
        snapshot.pendingRequests.some((request) => request.kind !== "elicitation"),
        "Claude is not waiting for a respondable request",
      ),
      "set-profile": writable(true, noWrites),
      "set-model": writable(true, noWrites),
      "set-effort": writable(true, noWrites),
      "remove-queued": writable(snapshot.stagedMessages.length > 0, "There are no staged messages"),
      end: writable(true, noWrites),
      attach: canAttach ? true : handoffReadiness.reason,
      resume: canResume
        ? true
        : writableManagerControls
        ? "Resume is available only after the managed Claude query ends"
        : handoffReadiness.reason,
      // Exact facts about the harness, not conditions that could later clear.
      "set-sandbox": "Claude has no sandbox setting",
      archive: "Claude does not expose session archive",
      delete: "Claude does not expose session deletion",
    } as CapabilityRulings;

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
      archived: false,
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
        value: profileForClaudePermissionMode(snapshot.mode),
        providerValue: snapshot.mode,
        source: "provider-api",
        confidence: "exact",
      },
      // Claude having no sandbox is a fact this adapter knows exactly, not a
      // gap in what it could observe.
      sandbox: noSandbox(),
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
        coordination: providerControlCoordination("claude"),
        recovery: null,
        ...resolveControlCapabilities(rulings),
        takeover: null,
      },
      workspaceIdentity: structuredClone(
        this.#workspaceIdentities.get(snapshot.cwd) ?? null,
      ),
      generation: snapshot.generation,
    };
  }
}
