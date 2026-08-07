import type {
  AttentionDetails,
  AttentionQuestion,
  SessionView,
} from "../../core/types.ts";
import type { ActivityMutation } from "../../activity/index.ts";
import {
  WorkspaceIdentityResolver,
  type WorkspaceIdentity,
} from "../../core/worktree.ts";
import { managedSessionInvariants } from "../shared/session-view.ts";
import {
  allCapabilities,
  deferredToLaterLayers,
  resolveControlCapabilities,
  type CapabilityRuling,
  type CapabilityRulings,
} from "../shared/capabilities.ts";
import {
  DEFAULT_SANDBOX_POLICY,
  normalizeProviderReasoningEffort,
  providerControlCoordination,
  providerEffort,
  sandboxEquals,
  sessionRecordId,
  type SandboxPolicy,
} from "../../shared/session.ts";
import { sessionSettingsOptionsSchema } from "../../server/contracts.ts";
import type {
  ActionDispatchResult,
  AttachInstruction,
  CreateSessionInput,
  ManagedSessionRecoveryRecord,
  ManagedSessionRecoveryReport,
  ProviderControlAdapter,
  ProviderSessionObservation,
  RequestContext,
  SessionAction,
  SessionSettingsOptions,
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
  ResumeCodexThreadOptions,
} from "./types.ts";
import {
  normalizeCodexQuestions,
  type NormalizedCodexQuestion,
} from "./question-normalizer.ts";

interface ManagedMetadata {
  name: string | null;
  requestedProfile: CreateSessionInput["profile"];
  requestedSandbox: SandboxPolicy;
  requestedModel: string | null;
  requestedEffort: CodexThreadState["effort"];
  createdAt: string;
  creationIssue: CodexManagedCreationIssue | null;
  workspaceId: string;
  workspacePath: string;
}

interface ManagedThreadSubscription {
  phase: "acquiring" | "active";
  settled: Promise<void>;
}

interface QuarantinedResume {
  transaction: symbol;
  phase: "releasing" | "needs-attention";
  attempt: number;
  startedAt: string;
  error: string | null;
  releasePromise: Promise<void> | null;
}

interface CodexAdoptionExpectation {
  threadId: string;
  treeId: string | null;
  parentThreadId: string | null;
  cwd: string;
  profile: CreateSessionInput["profile"];
  sandbox: SandboxPolicy;
  model: string | null;
  effort: CodexThreadState["effort"];
}

export interface CodexProviderBridgeOptions {
  adapter: CodexManagedAdapter;
  resolveWorkspace(
    workspaceId: string,
    context: RequestContext,
  ): Promise<string | null> | string | null;
  /**
   * Bridge-published sessions never pass through the discovery scan, so they
   * resolve their repository facts through the same bounded resolver discovery
   * uses. Injectable for tests; production shares its cache semantics.
   */
  workspaceIdentityResolver?: Pick<WorkspaceIdentityResolver, "resolveMany">;
  /** Bounds the git work one publish may spend; exhaustion yields a null identity. */
  workspaceIdentityBudgetMs?: number;
  /** Bounds the wait for thread/settings/updated after update RPC acceptance. */
  adoptionConfirmationTimeoutMs?: number;
  now?: () => Date;
  onSessionChanged?: (session: SessionView) => void;
  onSessionRemoved?: (
    managerSessionId: string,
    reason: "ended" | "archived" | "deleted",
  ) => void;
  onActivity?: (managerSessionId: string, mutation: ActivityMutation) => void;
}

const MAX_BUFFERED_ACTIVITY_MUTATIONS = 4_096;
const MAX_RECOVERY_RECORDS = 100;
const RECOVERY_CONCURRENCY = 4;
const WORKSPACE_IDENTITY_BUDGET_MS = 2_500;
const ADOPTION_CONFIRMATION_TIMEOUT_MS = 5_000;
const QUARANTINE_REASON =
  "Codex rollback is not confirmed; all controls remain quarantined";
const STALE_REQUEST_FAILURE: ActionDispatchResult = {
  status: "failed",
  error: {
    code: "REQUEST_STALE",
    message: "the Codex request is no longer active; another provider peer may have responded first",
  },
};

function recoveryError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return boundedText(error.message, 1_000);
  return boundedText(String(error), 1_000);
}

function pendingKind(request: CodexPendingRequest): SessionView["attention"][number]["kind"] {
  switch (request.kind) {
    case "user-input": return "question";
    case "permission-approval": return "permission";
    case "elicitation": return "elicitation";
    case "command-approval":
    case "file-change-approval":
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

function adoptionIdentityMatches(
  state: CodexThreadState,
  expected: CodexAdoptionExpectation,
): boolean {
  return state.threadId === expected.threadId
    && state.treeId === expected.treeId
    && state.parentThreadId === expected.parentThreadId
    && state.cwd === expected.cwd;
}

function adoptionSettingsMismatches(
  state: CodexThreadState | null,
  expected: CodexAdoptionExpectation,
): string[] {
  if (!state) return ["provider state disappeared"];
  const mismatches: string[] = [];
  const accepted = state.pendingSettings;
  const profile = accepted?.profile ?? state.profile;
  const sandbox = accepted?.sandbox ?? state.sandbox;
  const model = accepted?.model ?? state.model;
  const effort = accepted?.effort ?? state.effort;
  if (!adoptionIdentityMatches(state, expected)) {
    mismatches.push("provider identity or workspace changed");
  }
  if (profile !== expected.profile) {
    mismatches.push(`profile expected ${expected.profile}, saw ${profile ?? "unknown"}`);
  }
  if (!sandboxEquals(sandbox, expected.sandbox)) {
    mismatches.push("sandbox did not match the confirmed selection");
  }
  if (expected.model !== null && model !== expected.model) {
    mismatches.push(`model expected ${expected.model}, saw ${model ?? "unknown"}`);
  }
  if (expected.effort !== null && effort !== expected.effort) {
    mismatches.push(`effort expected ${expected.effort}, saw ${effort ?? "unknown"}`);
  }
  return mismatches;
}

function attentionQuestions(request: CodexPendingRequest): AttentionQuestion[] {
  if (request.kind !== "user-input") return [];
  return normalizeCodexQuestions(request.params.questions).map((question) => ({
    id: question.id,
    header: question.header,
    text: question.text,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    multiSelect: question.multiSelect,
    allowFreeText: question.allowFreeText,
    isSecret: question.isSecret,
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
      return "Command execution";
    case "file-change-approval":
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
      toolName: null,
      inputSummary: null,
      respondable: true,
    };
  }
  const toolName = approvalToolName(request);
  const inputSummary = approvalInputSummary(request);
  if (!toolName && !inputSummary) return null;
  return {
    title: null,
    questions: null,
    toolName,
    inputSummary,
    respondable: request.respondable && request.kind !== "elicitation",
  };
}

function sessionStatus(state: CodexThreadState): SessionView["status"] {
  if (state.pendingRequests.length > 0) return "waiting";
  if (state.status === "running") return "running";
  if (state.status === "idle") return "idle";
  if (state.status === "system-error") return "failed";
  return "unknown";
}

function observationBusy(observation: ProviderSessionObservation | null): boolean {
  return observation?.status === "running" || observation?.status === "waiting";
}

function observationClock(observation: ProviderSessionObservation): number | null {
  if (!observation.observedAt) return null;
  const value = Date.parse(observation.observedAt);
  return Number.isFinite(value) ? value : null;
}

function resolveManagedSettings(
  options: SessionSettingsOptions,
  requestedModel: string | null,
  requestedEffort: string | null,
): { model: string; effort: NonNullable<CreateSessionInput["effort"]> } {
  const selected = requestedModel === null
    ? options.models.find((model) => model.isDefault) ?? options.models[0]
    : options.models.find((model) =>
        model.value === requestedModel || model.resolvedModel === requestedModel
      );
  if (!selected) {
    throw new Error(
      requestedModel === null
        ? "Codex did not advertise a default model"
        : `Codex did not advertise model ${requestedModel}`,
    );
  }
  const normalizedEffort = normalizeProviderReasoningEffort("codex", requestedEffort);
  if (requestedEffort !== null && normalizedEffort === null) {
    throw new Error(`Codex reported unsupported reasoning effort ${requestedEffort}`);
  }
  const effort = normalizedEffort ?? selected.defaultEffort;
  if (!effort) {
    throw new Error(`Codex did not advertise a default effort for ${selected.value}`);
  }
  if (selected.efforts && !selected.efforts.includes(effort)) {
    throw new Error(`Codex model ${selected.value} does not support effort ${effort}`);
  }
  return {
    model: requestedModel ?? selected.resolvedModel ?? selected.value,
    effort,
  };
}


/**
 * The App Server did not advertise this control at all, which is a different
 * fact from a control that exists but is momentarily unavailable.
 */
const UNADVERTISED = "This Codex App Server does not advertise this control";

/**
 * One ruling per control for a managed Codex thread. The published capability
 * and withheld lists are both derived from this, so they cannot contradict
 * each other and no control can fall out of both unnoticed.
 */
function codexCapabilityRulings(
  adapter: CodexManagedAdapter,
  state: CodexThreadState,
  creationIssue: CodexManagedCreationIssue | null,
  observedBusy = false,
): CapabilityRulings {
  const controls = new Set(adapter.capabilities.controls);
  const advertised = (
    control: Parameters<typeof controls.has>[0],
    granted: boolean,
    reason: string,
  ): CapabilityRuling => (controls.has(control) ? (granted ? true : reason) : UNADVERTISED);
  const attach: CapabilityRuling = controls.has("native.attach") ? true : UNADVERTISED;

  if (creationIssue) {
    /*
      Do not permit another prompt or mode mutation until a human has inspected
      the provider thread. Exact pending-request responses and interruption stay
      available because both are bound to provider-issued IDs.
    */
    const quarantined = "This Codex thread needs a human to inspect it first";
    return {
      ...allCapabilities(quarantined),
      ...deferredToLaterLayers(),
      respond: advertised(
        "request.respond",
        state.pendingRequests.some((request) =>
          request.respondable && request.kind !== "elicitation"
        ),
        quarantined,
      ),
      interrupt: advertised("turn.interrupt", Boolean(state.activeTurnId), quarantined),
      attach,
      resume: attach,
    } as CapabilityRulings;
  }

  const idle = !state.activeTurnId && state.status !== "running" && !observedBusy;
  const busy = "Available when the Codex turn is idle";
  /*
    Profile and sandbox stay idle-only: they govern the approval policy and
    containment the running turn is already executing tool calls under, and must
    not shift beneath it. Archive and delete stay idle-only because both are
    destructive against live work.

    Model and effort are different. They select what handles the *next*
    inference, so a change during a turn is stashed as that turn's successor's
    override rather than refused. Hiding the control taught the cockpit that a
    session streaming its first turn had no model choice at all.
  */
  return {
    ...deferredToLaterLayers(),
    queue: !adapter.capabilities.compatible && adapter.capabilities.reason
      ? adapter.capabilities.reason
      : advertised("turn.queue", true, busy),
    steer: advertised(
      "turn.steer",
      !observedBusy || Boolean(state.activeTurnId),
      observedBusy
        ? "Exact Codex turn control is unavailable for a turn observed from another client"
        : busy,
    ),
    interrupt: advertised("turn.interrupt", Boolean(state.activeTurnId), "Available while a Codex turn is running"),
    respond: advertised(
      "request.respond",
      state.pendingRequests.some((request) => request.respondable),
      "Available while Codex is waiting on an answer",
    ),
    "set-profile": advertised("profile.set", idle, busy),
    "set-sandbox": advertised("sandbox.set", idle, busy),
    "set-model": advertised("model.set", true, busy),
    "set-effort": advertised("effort.set", true, busy),
    "remove-queued": state.queue.some((item) => item.status === "queued")
      ? true
      : "Available while a message is queued",
    attach,
    resume: attach,
    end: advertised("thread.unsubscribe", true, busy),
    archive: advertised("thread.archive", idle, busy),
    delete: advertised("thread.delete", idle, busy),
  } as CapabilityRulings;
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

/** Translate the provider-independent cockpit envelope into the exact 0.146 RPC result. */
export function codexRequestResponse(
  request: CodexPendingRequest,
  value: unknown,
): JsonObject {
  const response = asJsonObject(value);
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

    if (questions.length !== 1) {
      throw new Error("Multiple Codex questions require an atomic answers envelope");
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
    return { answers };
  }

  if (response.kind !== "decision" ||
      (response.decision !== "allow" && response.decision !== "deny")) {
    throw new Error("Codex approval response must use an allow or deny decision");
  }
  if (response.persist !== undefined && typeof response.persist !== "boolean") {
    throw new Error("Codex approval persistence must be boolean");
  }
  const allowed = response.decision === "allow";
  const persist = response.persist === true;
  if (persist && !allowed) {
    throw new Error("Codex cannot persist a denied approval");
  }

  switch (request.kind) {
    case "command-approval":
    case "file-change-approval":
      return { decision: allowed ? persist ? "acceptForSession" : "accept" : "decline" };
    case "permission-approval":
      if (persist) {
        throw new Error("Codex permission-profile approvals are scoped to this turn");
      }
      return {
        permissions: allowed && typeof request.params.permissions === "object" &&
            request.params.permissions !== null && !Array.isArray(request.params.permissions)
          ? request.params.permissions
          : {},
        scope: "turn",
      };
    case "elicitation":
      if (persist) throw new Error("Codex MCP elicitations do not expose persistence");
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
  #workspaceIdentityResolver: Pick<WorkspaceIdentityResolver, "resolveMany">;
  #workspaceIdentityBudgetMs: number;
  #adoptionConfirmationTimeoutMs: number;
  #workspaceIdentities = new Map<string, WorkspaceIdentity | null>();
  #now: () => Date;
  #onActivity: CodexProviderBridgeOptions["onActivity"];
  #onSessionChanged: CodexProviderBridgeOptions["onSessionChanged"];
  #onSessionRemoved: CodexProviderBridgeOptions["onSessionRemoved"];
  #metadata = new Map<string, ManagedMetadata>();
  #knownStates = new Map<string, CodexThreadState>();
  #observations = new Map<string, ProviderSessionObservation>();
  #recovering = new Map<string, symbol>();
  /** One durable App Server subscription per managed provider thread. */
  #managedThreads = new Map<string, ManagedThreadSubscription>();
  /**
   * Provider-side resume is a transaction, not a second manager connection.
   * Reserve the exact thread before the first asynchronous read so concurrent
   * web actions or startup recovery cannot both attach this bridge client to
   * the same shared App Server thread and then tear each other down.
   */
  #resumeTransactions = new Map<string, symbol>();
  #provisionalAdoptions = new Set<string>();
  #quarantinedResumes = new Map<string, QuarantinedResume>();
  #bufferedActivity = new Map<string, ActivityMutation[]>();
  #unsubscribe: () => void;

  constructor(options: CodexProviderBridgeOptions) {
    this.adapter = options.adapter;
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#workspaceIdentityBudgetMs = Math.max(
      1,
      options.workspaceIdentityBudgetMs ?? WORKSPACE_IDENTITY_BUDGET_MS,
    );
    this.#adoptionConfirmationTimeoutMs = Math.max(
      1,
      options.adoptionConfirmationTimeoutMs ?? ADOPTION_CONFIRMATION_TIMEOUT_MS,
    );
    this.#workspaceIdentityResolver = options.workspaceIdentityResolver
      ?? new WorkspaceIdentityResolver({ totalBudgetMs: this.#workspaceIdentityBudgetMs });
    this.#now = options.now ?? (() => new Date());
    this.#onActivity = options.onActivity;
    this.#onSessionChanged = options.onSessionChanged;
    this.#onSessionRemoved = options.onSessionRemoved;
    this.#unsubscribe = this.adapter.subscribe((event) => {
      if (event.type === "activity") {
        this.#forwardOrBufferActivity(event.threadId, event.mutation);
        return;
      }
      if (event.type === "thread.removed") {
        this.#removeManagedThread(event.threadId, event.reason);
        return;
      }
      if (event.type === "state.changed" && this.#metadata.has(event.threadId) &&
          !this.#recovering.has(event.threadId)) {
        // Keep the provider snapshot current while a takeover is waiting for
        // its durable ownership commit, but never project that manager-owned
        // state into the cockpit early. The commit returns this latest state.
        this.#knownStates.set(event.threadId, event.state);
        if (this.#acceptsLiveEvents(event.threadId)) this.#publishSession(event.state);
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
    // Resolved before `thread/start` so the very first published view already
    // groups under its repository instead of opening a second board column.
    // The resolver's own budget bounds this; it cannot stall creation.
    await this.#resolveWorkspaceIdentity(cwd);
    context.signal.throwIfAborted();
    const resolvedRequest = input.model === null || input.effort === null
      ? resolveManagedSettings(
          await this.getCreateSettingsOptions(context),
          input.model,
          input.effort,
        )
      : { model: input.model, effort: input.effort };
    context.signal.throwIfAborted();
    let state: CodexThreadState;
    let creationIssue: CodexManagedCreationIssue | null = null;
    // The profile decides only whether Codex asks before acting. What it may
    // reach is the operator's separate choice, and defaults to containment.
    const sandbox = input.sandbox ?? DEFAULT_SANDBOX_POLICY;
    try {
      state = await this.adapter.startThread({
        cwd,
        profile: input.profile,
        ...(input.name ? { name: input.name } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        initialMessage: input.initialMessage,
        approvalPolicy: input.profile === "full-access" ? "never" : "on-request",
        sandbox,
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
      requestedProfile: input.profile,
      requestedSandbox: sandbox,
      requestedModel: state.pendingSettings?.model ?? state.model ?? resolvedRequest.model,
      requestedEffort: state.pendingSettings?.effort ?? state.effort ?? resolvedRequest.effort,
      createdAt: this.#now().toISOString(),
      creationIssue,
      workspaceId: input.workspaceId,
      workspacePath: cwd,
    });
    this.#knownStates.set(state.threadId, state);
    // `thread/start` subscribes this App Server connection to the new thread.
    // That subscription belongs to the managed session, not to whichever
    // browser drawer happens to be open.
    this.#managedThreads.set(state.threadId, {
      phase: "active",
      settled: Promise.resolve(),
    });
    this.#flushBufferedActivity(state.threadId);
    this.#assertResolvedSettings(state, this.#metadata.get(state.threadId)!);
    return this.toSessionView(state);
  }

  /**
   * Semantically resume one exact dormant Codex conversation in the web app.
   *
   * This uses the bridge's existing App Server connection: `thread/read` pins
   * the provider identity without claiming it, `thread/resume` subscribes this
   * client to that exact identity, and all resulting state/activity remains
   * private until `commitExternalAdoption` confirms the durable manager record.
   * Callers must invoke `abortExternalAdoption` if persistence fails.
   */
  async resumeSession(
    session: SessionView,
    profile: CreateSessionInput["profile"],
    context: RequestContext,
  ): Promise<SessionView> {
    context.signal.throwIfAborted();
    const threadId = session.providerThreadId;
    if (
      session.provider !== "codex"
      || session.hostId !== "local"
      || session.id !== sessionRecordId("local", "codex", threadId)
      || !session.cwd
      || session.parentId !== null
    ) throw new Error("Codex adoption requires one exact local root-thread identity");
    if (!context.workspace || context.workspace.path !== session.cwd) {
      throw new Error("Codex adoption workspace does not match the discovered thread");
    }
    if (this.#metadata.has(threadId) || this.#recovering.has(threadId) ||
        this.#resumeTransactions.has(threadId)) {
      throw new Error("Codex thread is already managed by this bridge");
    }

    const transaction = Symbol(threadId);
    this.#resumeTransactions.set(threadId, transaction);

    try {
      const read = await this.adapter.readThread(threadId);
      context.signal.throwIfAborted();
      if (
        read.threadId !== threadId
        || read.cwd !== session.cwd
        || (session.providerTreeId !== null && read.treeId !== session.providerTreeId)
        || read.parentThreadId !== null
      ) {
        throw new Error("Codex thread/read changed the validated thread, tree, or workspace identity");
      }
      // `thread/read` populates only this adapter's local identity cache. Drop
      // that cache before `thread/resume`; there is still exactly one provider
      // subscription owner for this bridge client, acquired below.
      await this.adapter.releaseThread(threadId);
      context.signal.throwIfAborted();

      // An unproven sandbox is contained, never assumed to be what it was.
      const sandbox = session.sandbox.value ?? DEFAULT_SANDBOX_POLICY;
      const resolvedRequest = session.model.value === null || session.effort.value === null
        ? resolveManagedSettings(
            await this.getCreateSettingsOptions(context),
            session.model.value,
            session.effort.value,
          )
        : { model: session.model.value, effort: session.effort.value };
      context.signal.throwIfAborted();
      const metadata: ManagedMetadata = {
        name: session.name,
        requestedProfile: profile,
        requestedSandbox: sandbox,
        requestedModel: resolvedRequest.model,
        requestedEffort: resolvedRequest.effort,
        createdAt: session.startedAt ?? this.#now().toISOString(),
        creationIssue: null,
        workspaceId: context.workspace.id,
        workspacePath: context.workspace.path,
      };
      this.#metadata.set(threadId, metadata);
      this.#knownStates.set(threadId, read);
      const subscription: ManagedThreadSubscription = {
        phase: "acquiring",
        settled: Promise.resolve(),
      };
      this.#managedThreads.set(threadId, subscription);
      const resumeOptions: ResumeCodexThreadOptions = {
        cwd: metadata.workspacePath,
        sandbox,
        approvalPolicy: profile === "full-access" ? "never" : "on-request",
        model: resolvedRequest.model,
        effort: resolvedRequest.effort,
      };
      const adopted = await this.adapter.adoptThread(threadId, {
        threadId: read.threadId,
        treeId: read.treeId,
        parentThreadId: read.parentThreadId,
        cwd: read.cwd,
      }, resumeOptions);
      this.#assertSelectedIdentity(adopted, read, metadata);
      context.signal.throwIfAborted();

      if (adopted.profile !== profile) await this.adapter.setProfile(threadId, profile);
      if (!sandboxEquals(adopted.sandbox, sandbox)) await this.adapter.setSandbox(threadId, sandbox);
      if (adopted.model !== resolvedRequest.model) {
        await this.adapter.setModel(threadId, resolvedRequest.model);
      }
      if (adopted.effort !== resolvedRequest.effort) {
        await this.adapter.setEffort(threadId, resolvedRequest.effort);
      }
      context.signal.throwIfAborted();
      // thread/settings/update acknowledges request acceptance with `{}` and
      // confirms effective changes separately through thread/settings/updated.
      // That notification may arrive after the response and is deliberately
      // omitted for a no-op. An exact accepted pending value therefore counts
      // as preserved; the later full notification converges and clears it.
      const confirmed = await this.#waitForAdoptionConfirmation({
        threadId,
        treeId: read.treeId,
        parentThreadId: read.parentThreadId,
        cwd: metadata.workspacePath,
        profile,
        sandbox,
        model: resolvedRequest.model,
        effort: resolvedRequest.effort,
      }, context.signal);
      this.#assertResolvedSettings(confirmed, metadata);

      await this.#resolveWorkspaceIdentity(confirmed.cwd);
      context.signal.throwIfAborted();
      this.#provisionalAdoptions.add(threadId);
      this.#knownStates.set(threadId, confirmed);
      subscription.phase = "active";
      return this.toSessionView(confirmed);
    } catch (error) {
      if (this.#resumeTransactions.get(threadId) === transaction) {
        try {
          await this.#releaseResumeTransaction(
            threadId,
            transaction,
            `Codex resume failed before commit: ${recoveryError(error)}`,
          );
        } catch (releaseError) {
          throw new Error(
            `${recoveryError(error)}; Codex rollback remains quarantined: ${recoveryError(releaseError)}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  #waitForAdoptionConfirmation(
    expected: CodexAdoptionExpectation,
    signal: AbortSignal,
  ): Promise<CodexThreadState> {
    signal.throwIfAborted();
    const immediate = this.adapter.getThreadState(expected.threadId);
    if (immediate && adoptionSettingsMismatches(immediate, expected).length === 0) {
      return Promise.resolve(immediate);
    }

    return new Promise<CodexThreadState>((resolve, reject) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        unsubscribe();
        complete();
      };
      const abort = (): void => finish(() => reject(
        signal.reason ?? new Error("Codex adoption settings confirmation was cancelled"),
      ));
      const check = (state: CodexThreadState | null): void => {
        if (!state) return;
        if (!adoptionIdentityMatches(state, expected)) {
          finish(() => reject(new Error(
            "Codex adoption identity or workspace changed while settings were being confirmed",
          )));
          return;
        }
        if (adoptionSettingsMismatches(state, expected).length === 0) {
          finish(() => resolve(state));
        }
      };
      const timeout = setTimeout(() => {
        const current = this.adapter.getThreadState(expected.threadId);
        const detail = adoptionSettingsMismatches(current, expected).join("; ");
        finish(() => reject(new Error(
          `Codex adoption settings confirmation timed out: ${detail || "unknown mismatch"}`,
        )));
      }, this.#adoptionConfirmationTimeoutMs);

      signal.addEventListener("abort", abort, { once: true });
      unsubscribe = this.adapter.subscribe((event) => {
        if (event.type === "state.changed" && event.threadId === expected.threadId) {
          check(event.state);
        }
      });
      if (signal.aborted) {
        abort();
        return;
      }
      // Recheck after subscribing so a notification cannot land between the
      // optimistic read above and listener registration.
      check(this.adapter.getThreadState(expected.threadId));
    });
  }

  /**
   * CLI takeover and web-native resume share the same provider transaction.
   * Claude needs exclusive ownership transfer; Codex does not, so the server
   * may call `resumeSession` directly without waiting for a native client to
   * exit. Keep this name as the takeover-compatible entrypoint.
   */
  async adoptExternalSession(
    session: SessionView,
    profile: CreateSessionInput["profile"],
    context: RequestContext,
  ): Promise<SessionView> {
    return this.resumeSession(session, profile, context);
  }

  async restoreManagedSessions(
    records: readonly ManagedSessionRecoveryRecord[],
    signal: AbortSignal,
  ): Promise<ManagedSessionRecoveryReport> {
    const selected = records.slice(0, MAX_RECOVERY_RECORDS);
    const failures: Array<string | null> = selected.map(() => null);
    const restored = selected.map(() => false);
    const truncatedByRecordLimit = records.length > selected.length;
    if (selected.length === 0) {
      return { restoredSessionIds: [], failures: [], truncated: truncatedByRecordLimit };
    }

    let recoverySettingsOptions: Promise<SessionSettingsOptions> | null = null;
    const settingsOptions = (): Promise<SessionSettingsOptions> => {
      recoverySettingsOptions ??= this.adapter.listModels(signal).then((models) =>
        sessionSettingsOptionsSchema.parse({ source: "provider-api", models })
      );
      return recoverySettingsOptions;
    };

    const seenThreadIds = new Set<string>();
    const candidates: Array<{
      index: number;
      record: ManagedSessionRecoveryRecord;
    }> = [];
    for (const [index, record] of selected.entries()) {
      if (record.provider !== "codex") {
        failures[index] = "Codex recovery received another provider's durable identity";
        continue;
      }
      const expectedManagerId = sessionRecordId("local", "codex", record.providerThreadId);
      if (record.managerSessionId !== expectedManagerId) {
        failures[index] = "Persisted manager and provider thread identities do not match";
        continue;
      }
      if (seenThreadIds.has(record.providerThreadId)) {
        failures[index] = "Persisted provider thread identity is duplicated";
        continue;
      }
      seenThreadIds.add(record.providerThreadId);
      if (this.#metadata.has(record.providerThreadId) ||
          this.#recovering.has(record.providerThreadId) ||
          this.#resumeTransactions.has(record.providerThreadId)) {
        failures[index] = "Codex thread is already managed by this bridge";
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
        const token = Symbol(record.providerThreadId);
        this.#recovering.set(record.providerThreadId, token);
        this.#metadata.set(record.providerThreadId, {
          name: record.name,
          requestedProfile: record.profile,
          requestedSandbox: record.sandbox ?? DEFAULT_SANDBOX_POLICY,
          requestedModel: record.model ?? null,
          requestedEffort: record.effort ?? null,
          createdAt: record.createdAt,
          creationIssue: null,
          workspaceId: record.workspaceId,
          workspacePath: record.workspacePath,
        });
        const assertActive = (): void => {
          signal.throwIfAborted();
          if (this.#recovering.get(record.providerThreadId) !== token) {
            throw new Error("Codex recovery was superseded or the thread was removed");
          }
        };
        try {
          assertActive();
          const read = await this.adapter.readThread(record.providerThreadId);
          assertActive();
          this.#assertRecoveredIdentity(read, record);
          const subscription: ManagedThreadSubscription = {
            phase: "acquiring",
            settled: Promise.resolve(),
          };
          this.#managedThreads.set(record.providerThreadId, subscription);
          const adopted = await this.adapter.adoptThread(record.providerThreadId, {
            threadId: read.threadId,
            treeId: read.treeId,
            parentThreadId: read.parentThreadId,
            cwd: read.cwd,
          });
          assertActive();
          const metadata = this.#metadata.get(record.providerThreadId);
          if (!metadata) throw new Error("Managed Codex recovery metadata disappeared");
          this.#assertSelectedIdentity(adopted, read, metadata);
          const providerModel = adopted.pendingSettings?.model ?? adopted.model
            ?? metadata.requestedModel;
          const providerEffortValue = adopted.pendingSettings?.effort ?? adopted.effort
            ?? metadata.requestedEffort;
          if (providerModel === null || providerEffortValue === null) {
            const resolved = resolveManagedSettings(
              await settingsOptions(),
              providerModel,
              providerEffortValue,
            );
            metadata.requestedModel = resolved.model;
            metadata.requestedEffort = resolved.effort;
          }
          this.#assertResolvedSettings(adopted, metadata);
          await this.#resolveWorkspaceIdentity(read.cwd ?? record.workspacePath);
          assertActive();
          this.#knownStates.set(record.providerThreadId, adopted);
          subscription.phase = "active";
          this.#recovering.delete(record.providerThreadId);
          restored[index] = true;
          this.#publishSession(adopted);
          this.#flushBufferedActivity(record.providerThreadId);
        } catch (error) {
          failures[index] = recoveryError(error);
          if (this.#recovering.get(record.providerThreadId) === token) {
            this.#recovering.delete(record.providerThreadId);
            this.#metadata.delete(record.providerThreadId);
            this.#knownStates.delete(record.providerThreadId);
            this.#observations.delete(record.providerThreadId);
            this.#managedThreads.delete(record.providerThreadId);
            this.#dropBufferedActivity(record.providerThreadId);
          }
          if (this.adapter.getThreadState(record.providerThreadId)) {
            await this.adapter.releaseThread(record.providerThreadId).catch(() => undefined);
          }
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(RECOVERY_CONCURRENCY, candidates.length) },
      () => worker(),
    ));

    return {
      restoredSessionIds: selected.flatMap((record, index) => (
        restored[index] ? [record.managerSessionId] : []
      )),
      /*
        Absence, not falsiness, decides whether a record failed. `recoveryError`
        can produce an empty reason — a non-`Error` whose `String()` is "" — and
        a truthiness test dropped those records from both lists, so the server
        reported "provider did not confirm the exact managed session identity"
        instead of the cause it had been handed.
      */
      failures: selected.flatMap((record, index) => {
        const reason = failures[index];
        return reason === null || reason === undefined ? [] : [{
          managerSessionId: record.managerSessionId,
          providerThreadId: record.providerThreadId,
          reason,
        }];
      }),
      truncated: truncatedByRecordLimit,
    };
  }

  commitExternalAdoption(threadId: string): SessionView {
    if (this.#quarantinedResumes.has(threadId)) {
      throw new Error("Codex adoption rollback is quarantined and cannot be committed");
    }
    if (!this.#provisionalAdoptions.has(threadId)) {
      throw new Error("Codex adoption is not awaiting durable commit");
    }
    const state = this.adapter.getThreadState(threadId) ?? this.#knownStates.get(threadId);
    if (!state || !this.#metadata.has(threadId) ||
        this.#managedThreads.get(threadId)?.phase !== "active") {
      throw new Error("Codex adoption disappeared before commit");
    }
    this.#knownStates.set(threadId, state);
    this.#provisionalAdoptions.delete(threadId);
    this.#resumeTransactions.delete(threadId);
    const session = this.toSessionView(state);
    // Activity emitted by thread/resume or provider setting reconciliation is
    // private to the provisional client until durable ownership has committed.
    this.#flushBufferedActivity(threadId);
    return session;
  }

  async abortExternalAdoption(threadId: string): Promise<void> {
    const quarantine = this.#quarantinedResumes.get(threadId);
    if (!this.#provisionalAdoptions.has(threadId) && !quarantine) return;
    const transaction = quarantine?.transaction ?? this.#resumeTransactions.get(threadId);
    if (!transaction) {
      throw new Error("Codex rollback lost its exact resume transaction identity");
    }
    await this.#releaseResumeTransaction(threadId, transaction, null);
  }

  async acquireSelectedSession(
    session: SessionView,
    context: RequestContext,
  ): Promise<() => void | Promise<void>> {
    context.signal.throwIfAborted();
    if (
      session.provider !== "codex"
      || session.hostId !== "local"
      || session.control.plane !== "codex-private"
      || session.control.authority !== "manager"
    ) {
      throw new Error("Codex detail acquisition requires a local manager-owned session");
    }
    const threadId = session.providerThreadId;
    if (this.#quarantinedResumes.has(threadId)) {
      throw new Error(QUARANTINE_REASON);
    }
    if (session.id !== sessionRecordId("local", "codex", threadId) ||
        !this.#metadata.has(threadId) || !this.#knownStates.has(threadId)) {
      throw new Error("Codex detail acquisition received an unknown managed identity");
    }

    let subscription = this.#managedThreads.get(threadId);
    if (!subscription) {
      subscription = {
        phase: "acquiring",
        settled: Promise.resolve(),
      };
      this.#managedThreads.set(threadId, subscription);
      const acquiring = subscription;
      acquiring.settled = (async () => {
        const expected = this.#knownStates.get(threadId);
        const metadata = this.#metadata.get(threadId);
        if (!expected || !metadata) throw new Error("Managed Codex identity disappeared");
        const adopted = await this.adapter.adoptThread(threadId, {
          threadId: expected.threadId,
          treeId: expected.treeId,
          parentThreadId: expected.parentThreadId,
          cwd: expected.cwd,
        });
        this.#assertSelectedIdentity(adopted, expected, metadata);
        await this.#resolveWorkspaceIdentity(adopted.cwd ?? metadata.workspacePath);
        if (this.#managedThreads.get(threadId) !== acquiring) {
          throw new Error("Codex managed subscription was superseded");
        }
        this.#knownStates.set(threadId, adopted);
        acquiring.phase = "active";
        this.#publishSession(adopted);
        this.#flushBufferedActivity(threadId);
      })();
    }

    try {
      await subscription.settled;
      context.signal.throwIfAborted();
    } catch (error) {
      if (this.#managedThreads.get(threadId) === subscription &&
          subscription.phase !== "active") {
        this.#managedThreads.delete(threadId);
        if (this.adapter.getThreadState(threadId)) {
          await this.adapter.releaseThread(threadId).catch(() => undefined);
        }
      }
      const known = this.#knownStates.get(threadId);
      if (known && this.#metadata.has(threadId)) this.#publishSession(known);
      throw error;
    }

    // Drawer/SSE lifetime is deliberately independent from the provider
    // subscription. Closing this browser consumer must not turn a managed
    // Codex thread read-only or disconnect its shared native clients.
    return () => undefined;
  }

  observeSession(observation: ProviderSessionObservation): void {
    const threadId = observation.providerThreadId;
    if (
      observation.provider !== "codex"
      || observation.managerSessionId !== sessionRecordId("local", "codex", threadId)
      || !this.#metadata.has(threadId)
    ) return;

    const previous = this.#observations.get(threadId) ?? null;
    const previousClock = previous ? observationClock(previous) : null;
    const nextClock = observationClock(observation);
    if (previousClock !== null && nextClock !== null && nextClock < previousClock) return;
    // A named terminal row must match the active observed turn. Discovery
    // deliberately omits that identity from SessionView, but reaches this path
    // only after the shared rollout reducer has rejected stale completions.
    if (
      previous && observationBusy(previous) && !observationBusy(observation)
      && previous.observedTurnId
      && observation.observedTurnId
      && previous.observedTurnId !== observation.observedTurnId
    ) return;

    const statusUnknown = observation.status === "unknown";
    const next: ProviderSessionObservation = structuredClone({
      ...observation,
      status: statusUnknown && previous ? previous.status : observation.status,
      providerStatus: statusUnknown && previous
        ? previous.providerStatus
        : observation.providerStatus,
      statusSource: statusUnknown && previous
        ? previous.statusSource
        : observation.statusSource,
      observedTurnId: observation.observedTurnId
        ?? (observationBusy(observation) ? previous?.observedTurnId ?? null : null),
      profile: observation.profile !== null && observation.profile.value !== null
        ? observation.profile
        : previous?.profile ?? null,
      sandbox: observation.sandbox !== null && observation.sandbox.value !== null
        ? observation.sandbox
        : previous?.sandbox ?? null,
      model: observation.model !== null && observation.model.value !== null
        ? observation.model
        : previous?.model ?? null,
      effort: observation.effort !== null && observation.effort.value !== null
        ? observation.effort
        : previous?.effort ?? null,
    });
    const unchanged = previous !== null && JSON.stringify(previous) === JSON.stringify(next);
    if (unchanged) return;
    this.#observations.set(threadId, next);

    const metadata = this.#metadata.get(threadId);
    if (metadata) {
      if (next.profile?.value) metadata.requestedProfile = next.profile.value;
      if (next.sandbox?.value) metadata.requestedSandbox = next.sandbox.value;
      if (next.model?.value) metadata.requestedModel = next.model.value;
      if (next.effort?.value) metadata.requestedEffort = next.effort.value;
    }

    const previousBusy = observationBusy(previous);
    const nextBusy = observationBusy(next);
    const adapterState = this.adapter.getThreadState(threadId);
    this.adapter.setExternalTurnActive(threadId, nextBusy);
    if (previousBusy === nextBusy || adapterState === null) {
      const state = this.adapter.getThreadState(threadId) ?? this.#knownStates.get(threadId);
      if (state && this.#acceptsLiveEvents(threadId)) this.#publishSession(state);
    }
  }

  async performAction(
    session: SessionView,
    action: SessionAction,
    context: RequestContext,
  ): Promise<ActionDispatchResult> {
    context.signal.throwIfAborted();
    if (session.provider !== "codex" || session.control.authority !== "manager") {
      throw new Error("Codex controls apply only to manager-owned Codex sessions");
    }
    if (action.type !== "respond" && action.expectedGeneration !== session.generation) {
      throw new Error("Codex session generation changed before dispatch");
    }
    if (this.#quarantinedResumes.has(session.providerThreadId)) {
      throw new Error(QUARANTINE_REASON);
    }
    const subscription = this.#managedThreads.get(session.providerThreadId);
    if (!subscription || subscription.phase !== "active") {
      throw new Error("Manager-owned Codex thread is not subscribed or loaded");
    }
    if (this.#provisionalAdoptions.has(session.providerThreadId)) {
      throw new Error("Manager-owned Codex thread is awaiting durable adoption commit");
    }
    const state = this.adapter.getThreadState(session.providerThreadId);
    if (!state) throw new Error("Manager-owned Codex thread is not loaded");
    const creationIssue = this.#metadata.get(session.providerThreadId)?.creationIssue ?? null;
    if (creationIssue && action.type !== "respond" && action.type !== "interrupt") {
      throw new Error(
        "Codex session creation needs native recovery before messages or mode changes can be dispatched",
      );
    }

    switch (action.type) {
      case "send":
        if (action.delivery === "queue") {
          const queued = await this.adapter.queueMessage(session.providerThreadId, action.text);
          return {
            status: queued.status === "queued" ? "queued" : "succeeded",
            result: queued,
          };
        }
        if (!action.expectedProviderTurnId) {
          throw new Error("Steering requires the expected active Codex turn ID");
        }
        return {
          status: "succeeded",
          result: {
            turnId: await this.adapter.steer(
              session.providerThreadId,
              action.expectedProviderTurnId,
              action.text,
            ),
          },
        };
      case "respond": {
        const request = state.pendingRequests.find(
          (candidate) => encodeCodexRequestId(candidate.id) === action.requestId,
        );
        if (!request) return STALE_REQUEST_FAILURE;
        const expectedTurnId = action.expectedProviderTurnId ?? null;
        if (expectedTurnId !== request.turnId) {
          return STALE_REQUEST_FAILURE;
        }
        if (request.kind === "elicitation") {
          throw new Error("Codex MCP elicitation forms are not respondable in the cockpit");
        }
        if (request.kind === "unsupported") {
          throw new Error(`Codex request method ${request.method} is not respondable`);
        }
        if (!request.respondable) return STALE_REQUEST_FAILURE;
        try {
          await this.adapter.respondToRequest(
            session.providerThreadId,
            decodeCodexRequestId(action.requestId),
            codexRequestResponse(request, action.response),
          );
        } catch (error) {
          const current = this.adapter.getThreadState(session.providerThreadId);
          const currentRequest = current?.pendingRequests.find(
            (candidate) => encodeCodexRequestId(candidate.id) === action.requestId,
          );
          if (!currentRequest?.respondable) return STALE_REQUEST_FAILURE;
          throw error;
        }
        return {
          status: "succeeded",
          result: {
            coordination: "first-response-wins",
            resolution: "submitted",
          },
        };
      }
      case "interrupt":
        if (!action.expectedProviderTurnId) {
          throw new Error("Interrupt requires the expected active Codex turn ID");
        }
        await this.adapter.interrupt(
          session.providerThreadId,
          action.expectedProviderTurnId,
        );
        return { status: "succeeded" };
      case "set-profile":
        await this.adapter.setProfile(session.providerThreadId, action.profile);
        return { status: "succeeded", result: { profile: action.profile } };
      case "set-sandbox":
        await this.adapter.setSandbox(session.providerThreadId, action.sandbox);
        return { status: "succeeded", result: { sandbox: action.sandbox } };
      case "set-model":
        await this.adapter.setModel(session.providerThreadId, action.model);
        return { status: "succeeded", result: { model: action.model } };
      case "set-effort":
        await this.adapter.setEffort(session.providerThreadId, action.effort);
        return { status: "succeeded", result: { effort: action.effort } };
      case "remove-queued":
        await this.adapter.removeQueuedMessage(
          session.providerThreadId,
          action.messageId,
        );
        return { status: "succeeded" };
      case "end":
        await this.adapter.endThread(session.providerThreadId);
        return { status: "succeeded" };
      case "archive":
        await this.adapter.archiveThread(session.providerThreadId);
        return { status: "succeeded" };
      case "delete":
        await this.adapter.deleteThread(session.providerThreadId);
        return { status: "succeeded" };
      case "open-editor":
        throw new Error("Codex provider does not own editor launch operations");
      case "resume":
      case "take-control":
      case "cancel-take-control":
      case "retry-control":
        throw new Error("Codex resume and takeover are orchestrated by Agent Manager");
    }
  }

  async getAttachInstruction(
    session: SessionView,
    context: RequestContext,
  ): Promise<AttachInstruction | null> {
    context.signal.throwIfAborted();
    if (session.provider !== "codex" || session.control.authority !== "manager") return null;
    if (this.#quarantinedResumes.has(session.providerThreadId)) {
      throw new Error(QUARANTINE_REASON);
    }
    if (this.#provisionalAdoptions.has(session.providerThreadId)) {
      throw new Error("Manager-owned Codex thread is awaiting durable adoption commit");
    }
    const subscription = this.#managedThreads.get(session.providerThreadId);
    if (!subscription || subscription.phase !== "active" ||
        !this.adapter.getThreadState(session.providerThreadId)) {
      throw new Error("Manager-owned Codex thread is not subscribed or loaded");
    }
    const command = this.adapter.buildAttachCommand(session.providerThreadId);
    return {
      kind: "codex-remote",
      argv: [command.executable, ...command.args],
      cwd: session.cwd,
      warning: "Joins the shared Codex App Server thread. CLI and web stay active together; the first client to answer a Codex request wins.",
    };
  }

  async getAccountFacts(
    session: SessionView,
    context: RequestContext,
  ) {
    context.signal.throwIfAborted();
    if (
      session.provider !== "codex"
      || session.hostId !== "local"
      || session.control.authority !== "manager"
    ) throw new Error("Codex account facts require a local manager-owned session");
    return this.adapter.readAccountFacts();
  }

  async getCreateSettingsOptions(
    context: RequestContext,
  ): Promise<SessionSettingsOptions> {
    context.signal.throwIfAborted();
    const models = await this.adapter.listModels(context.signal);
    context.signal.throwIfAborted();
    return sessionSettingsOptionsSchema.parse({ source: "provider-api", models });
  }

  async getSettingsOptions(
    session: SessionView,
    context: RequestContext,
  ): Promise<SessionSettingsOptions> {
    context.signal.throwIfAborted();
    if (
      session.provider !== "codex"
      || session.hostId !== "local"
      || session.control.authority !== "manager"
    ) {
      throw new Error("Codex settings require a local manager-owned thread");
    }
    /*
      No idle, generation, or `set-model` guard. This is `model/list` on the
      private App Server — a provider-wide read that says nothing about this
      thread, so nothing about this thread can invalidate it. Those guards were
      here because reading the catalog used to imply intent to write it; that
      cost the operator any sight of the catalog for the whole of every turn,
      which is exactly when they most want to know what else is on offer.
      Whether the answer may be *applied* is `set-model`'s business, and the
      browser renders the list disabled with that reason.
    */
    return await this.getCreateSettingsOptions(context);
  }

  toSessionView(state: CodexThreadState): SessionView {
    const subscription = this.#managedThreads.get(state.threadId);
    const quarantine = this.#quarantinedResumes.get(state.threadId) ?? null;
    const controlsLoaded = subscription?.phase === "active" &&
      this.adapter.getThreadState(state.threadId) !== null && quarantine === null &&
      !this.#provisionalAdoptions.has(state.threadId);
    const liveDetail = controlsLoaded;
    const observation = this.#observations.get(state.threadId) ?? null;
    const observedBusy = observationBusy(observation);
    const metadata = this.#metadata.get(state.threadId) ?? {
      name: null,
      requestedProfile: "plan" as const,
      requestedSandbox: DEFAULT_SANDBOX_POLICY,
      requestedModel: state.model,
      requestedEffort: state.effort,
      createdAt: this.#now().toISOString(),
      creationIssue: null,
      workspaceId: "",
      workspacePath: state.cwd ?? "",
    };
    const cwd = state.cwd ?? metadata.workspacePath;
    const providerProfile = state.pendingSettings?.profile ?? state.profile;
    const providerSandbox = state.pendingSettings?.sandbox ?? state.sandbox;
    const providerModel = state.pendingSettings?.model ?? state.model;
    const providerEffortValue = state.pendingSettings?.effort ?? state.effort;
    const effectiveProfile = providerProfile
      ?? observation?.profile?.value
      ?? metadata.requestedProfile;
    const effectiveSandbox = providerSandbox
      ?? observation?.sandbox?.value
      ?? metadata.requestedSandbox;
    const effectiveModel = providerModel
      ?? observation?.model?.value
      ?? metadata.requestedModel;
    const effectiveEffort = providerEffortValue
      ?? observation?.effort?.value
      ?? metadata.requestedEffort;
    const updatedAt = this.#now().toISOString();
    const recoveryAttention: SessionView["attention"] = metadata.creationIssue
      ? [{
          id: "creation-recovery",
          kind: "blocked",
          summary: metadata.creationIssue.stage === "profile"
            ? "The provider thread exists, but its requested settings were not confirmed. The initial message was not sent."
            : metadata.creationIssue.outcome === "uncertain"
            ? "The provider thread exists, but the initial-message acknowledgement is uncertain. It will not be sent again automatically."
            : "The provider thread exists, but Codex rejected the initial message. It will not be sent again automatically.",
          source: "provider-api",
          confidence: "exact",
          details: {
            title: "Managed Codex session needs recovery",
            questions: null,
            toolName: "Native Codex attach",
            inputSummary: boundedText(metadata.creationIssue.message, 500),
            respondable: false,
          },
        }]
      : [];
    const exactStatus = metadata.creationIssue && !state.activeTurnId
      ? "waiting"
      : sessionStatus(state);
    const observedStatus = observation?.status === "completed"
      ? "idle"
      : observation?.status ?? "unknown";
    const usesObservedStatus = metadata.creationIssue === null
      && (exactStatus === "idle" || exactStatus === "unknown")
      && observedStatus !== "unknown";
    const normalizedStatus = usesObservedStatus ? observedStatus : exactStatus;
    const pendingAttention: SessionView["attention"] = state.pendingRequests.map(
      (request) => {
        const details = attentionDetails(request);
        return {
          id: encodeCodexRequestId(request.id),
          kind: pendingKind(request),
          summary: requestSummary(request),
          source: "provider-api",
          confidence: "exact",
          details,
        };
      },
    );
    return {
      id: sessionRecordId("local", "codex", state.threadId),
      provider: "codex",
      providerThreadId: state.threadId,
      providerTreeId: state.treeId,
      parentId: state.parentThreadId
        ? sessionRecordId("local", "codex", state.parentThreadId)
        : null,
      providerTurnId: state.activeTurnId,
      ...managedSessionInvariants(),
      name: metadata.name ?? state.name,
      cwd,
      presence: liveDetail ? "live" : "recent",
      status: normalizedStatus,
      providerStatus: usesObservedStatus
        ? observation?.providerStatus ?? state.status
        : state.status,
      pid: null,
      runtimePid: null,
      startedAt: metadata.createdAt,
      updatedAt,
      source: state.source ?? "appServer",
      statusSource: usesObservedStatus ? observation?.statusSource ?? "rollout-events" : "provider-api",
      profile: providerProfile === null && observation?.profile?.value
        ? observation.profile
        : {
            value: effectiveProfile,
            providerValue: effectiveProfile,
            source: "provider-api",
            confidence: effectiveProfile === null ? "heuristic" : "exact",
          },
      sandbox: providerSandbox === null && observation?.sandbox?.value
        ? observation.sandbox
        : {
            value: effectiveSandbox,
            providerValue: effectiveSandbox
              ? `${effectiveSandbox.mode};network=${String(effectiveSandbox.networkAccess)}`
              : null,
            source: "provider-api",
            confidence: effectiveSandbox === null ? "heuristic" : "exact",
          },
      model: providerModel === null && observation?.model?.value
        ? observation.model
        : {
            value: effectiveModel,
            providerValue: effectiveModel,
            source: "provider-api",
            confidence: effectiveModel === null ? "heuristic" : "exact",
          },
      effort: providerEffortValue === null && observation?.effort?.value
        ? observation.effort
        : providerEffort("codex", effectiveEffort, "provider-api"),
      attention: [...recoveryAttention, ...pendingAttention],
      control: {
        plane: "codex-private",
        authority: "manager",
        coordination: providerControlCoordination("codex"),
        recovery: quarantine
          ? {
              state: quarantine.phase === "releasing" ? "reconnecting" : "needs-attention",
              attempt: quarantine.attempt,
              startedAt: quarantine.startedAt,
              deadlineAt: null,
              nextRetryAt: null,
              error: quarantine.error,
            }
          : null,
        ...resolveControlCapabilities(
          quarantine
            ? {
                ...allCapabilities(QUARANTINE_REASON),
                ...deferredToLaterLayers(),
                /*
                  The one capability quarantine takes back from the layer that
                  normally owns it. An unconfirmed rollback must not offer a
                  retry that could re-enter the same uncertain release.
                */
                "retry-control": QUARANTINE_REASON,
              } as CapabilityRulings
            : controlsLoaded
            ? codexCapabilityRulings(
                this.adapter,
                state,
                metadata.creationIssue,
                observedBusy,
              )
            : {
                /*
                  A state, not an instruction. Every reader of `withheld` is
                  already inside the drawer, which is what acquires the thread
                  lease in the first place — telling them to "select this
                  session" named an internal lease phase as if it were something
                  left undone.
                */
                ...allCapabilities("Loading exact Codex controls…"),
                ...deferredToLaterLayers(),
              } as CapabilityRulings,
        ),
        /*
          Codex peers are execution environments on the shared app-server, not
          local processes this bridge can name a pid for. Execution-environment
          notifications remain observational peer presence and never reach the
          published peer list, which is about proven local writers.
        */
        peers: [],
        takeover: null,
      },
      workspaceIdentity: structuredClone(this.#workspaceIdentities.get(cwd) ?? null),
      generation: state.generation,
    };
  }

  getManagedSession(sessionId: string): SessionView | null {
    const state = this.adapter.getThreadState(sessionId) ?? this.#knownStates.get(sessionId);
    return state ? this.toSessionView(state) : null;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#metadata.clear();
    this.#knownStates.clear();
    this.#observations.clear();
    this.#recovering.clear();
    this.#managedThreads.clear();
    this.#resumeTransactions.clear();
    this.#provisionalAdoptions.clear();
    this.#quarantinedResumes.clear();
    this.#bufferedActivity.clear();
    this.#workspaceIdentities.clear();
  }

  /**
   * Fail-closed rollback for a provisional provider subscription. The exact
   * transaction and all ownership maps remain reserved until the adapter has
   * positively removed its thread state. A rejected unsubscribe is uncertain,
   * so it becomes an explicit quarantine and may be retried idempotently; an
   * in-flight unsubscribe is shared by every concurrent rollback caller.
   */
  async #releaseResumeTransaction(
    threadId: string,
    transaction: symbol,
    contextError: string | null,
  ): Promise<void> {
    if (this.#resumeTransactions.get(threadId) !== transaction) {
      throw new Error("Codex rollback no longer owns the exact resume transaction");
    }

    let quarantine = this.#quarantinedResumes.get(threadId);
    if (quarantine && quarantine.transaction !== transaction) {
      throw new Error("Codex rollback quarantine belongs to another resume transaction");
    }
    if (quarantine?.releasePromise) {
      await quarantine.releasePromise;
      return;
    }
    if (!quarantine) {
      quarantine = {
        transaction,
        phase: "releasing",
        attempt: 0,
        startedAt: this.#now().toISOString(),
        error: contextError,
        releasePromise: null,
      };
      this.#quarantinedResumes.set(threadId, quarantine);
    }

    quarantine.phase = "releasing";
    quarantine.attempt += 1;
    if (contextError) quarantine.error = contextError;
    // Keeping the provisional marker is what withholds state and activity from
    // consumers while cleanup is uncertain or merely slow.
    this.#provisionalAdoptions.add(threadId);
    const activeQuarantine = quarantine;
    const releasePromise = (async (): Promise<void> => {
      try {
        if (this.adapter.getThreadState(threadId)) {
          await this.adapter.releaseThread(threadId);
        }
        if (this.adapter.getThreadState(threadId)) {
          throw new Error("Codex App Server still reports the provider client as subscribed");
        }

        // A provider removal event may have completed cleanup while the RPC was
        // in flight. That is also exact confirmation and needs no second pass.
        const current = this.#resumeTransactions.get(threadId);
        if (current !== undefined && current !== transaction) {
          throw new Error("Codex rollback transaction changed during provider release");
        }
        this.#provisionalAdoptions.delete(threadId);
        this.#metadata.delete(threadId);
        this.#knownStates.delete(threadId);
        this.#observations.delete(threadId);
        this.#managedThreads.delete(threadId);
        this.#dropBufferedActivity(threadId);
        this.#quarantinedResumes.delete(threadId);
        if (current === transaction) this.#resumeTransactions.delete(threadId);
      } catch (error) {
        // Exact provider removal wins over an RPC error racing its notification.
        if (!this.#resumeTransactions.has(threadId) &&
            !this.#quarantinedResumes.has(threadId) &&
            !this.adapter.getThreadState(threadId)) {
          return;
        }
        if (this.#quarantinedResumes.get(threadId) === activeQuarantine) {
          activeQuarantine.phase = "needs-attention";
          activeQuarantine.error = boundedText(
            [contextError, `Provider release was not confirmed: ${recoveryError(error)}`]
              .filter((part): part is string => Boolean(part))
              .join("; "),
            1_000,
          );
          activeQuarantine.releasePromise = null;
        }
        throw error;
      }
    })();
    activeQuarantine.releasePromise = releasePromise;
    await releasePromise;
  }

  /**
   * Repository facts are decoration, never a creation precondition: an error or
   * an exhausted budget records a null identity rather than guessing a
   * repository the git probe never confirmed.
   */
  async #resolveWorkspaceIdentity(cwd: string | null): Promise<void> {
    if (!cwd) return;
    try {
      const identities = await this.#workspaceIdentityResolver.resolveMany([cwd], {
        budgetMs: this.#workspaceIdentityBudgetMs,
      });
      this.#workspaceIdentities.set(cwd, identities.get(cwd) ?? null);
    } catch {
      if (!this.#workspaceIdentities.has(cwd)) this.#workspaceIdentities.set(cwd, null);
    }
  }

  #acceptsLiveEvents(threadId: string): boolean {
    return this.#managedThreads.get(threadId)?.phase === "active" &&
      !this.#provisionalAdoptions.has(threadId);
  }

  #forwardOrBufferActivity(threadId: string, mutation: ActivityMutation): void {
    if (!this.#onActivity) return;
    if (this.#metadata.has(threadId)) {
      if (!this.#recovering.has(threadId) && this.#acceptsLiveEvents(threadId)) {
        this.#publishActivity(threadId, mutation);
      } else {
        // Adoption/recovery can emit before identity validation completes.
        // Retain that activity until the durable managed subscription is live.
        this.#bufferActivity(threadId, mutation);
      }
      return;
    }

    this.#bufferActivity(threadId, mutation);
  }

  #bufferActivity(threadId: string, mutation: ActivityMutation): void {
    let buffered = this.#bufferedActivity.get(threadId);
    if (!buffered) {
      buffered = [];
      this.#bufferedActivity.set(threadId, buffered);
    }
    buffered.push(mutation);
    if (buffered.length <= MAX_BUFFERED_ACTIVITY_MUTATIONS) return;

    // This buffer sits in front of an ActivityHub that may already contain
    // transcript or hook history for the same manager session. A provider
    // reset would erase that independently sourced history when adoption
    // commits. Keep an amortized bounded tail and publish an internal boundary
    // that marks the retained window incomplete without replacing its items.
    const retained = buffered.slice(-(MAX_BUFFERED_ACTIVITY_MUTATIONS / 2));
    buffered.length = 0;
    buffered.push({ type: "retention-boundary" }, ...retained);
  }

  #flushBufferedActivity(threadId: string): void {
    const buffered = this.#bufferedActivity.get(threadId);
    this.#bufferedActivity.delete(threadId);
    if (!buffered) return;
    for (const mutation of buffered) this.#publishActivity(threadId, mutation);
  }

  #dropBufferedActivity(threadId: string): void {
    this.#bufferedActivity.delete(threadId);
  }

  #assertRecoveredIdentity(
    state: CodexThreadState,
    record: ManagedSessionRecoveryRecord,
  ): void {
    if (
      record.providerTreeId === undefined
      || record.providerParentThreadId === undefined
    ) {
      throw new Error(
        "Persisted Codex tree and parent identity baseline is missing or invalid; " +
        "history is preserved, but automatic control recovery is fail-closed. " +
        "Use Resume here to re-adopt this exact provider conversation.",
      );
    }
    if (state.threadId !== record.providerThreadId) {
      throw new Error("Native Codex recovery returned a different thread identity");
    }
    if (state.cwd !== record.workspacePath) {
      throw new Error("Native Codex recovery returned a different workspace");
    }
    if (
      state.treeId !== record.providerTreeId
      || state.parentThreadId !== record.providerParentThreadId
    ) {
      throw new Error(
        "Native Codex recovery changed the persisted thread tree or parent identity",
      );
    }
  }

  #assertSelectedIdentity(
    state: CodexThreadState,
    expected: CodexThreadState,
    metadata: ManagedMetadata,
  ): void {
    if (state.threadId !== expected.threadId) {
      throw new Error("Native Codex selection returned a different thread identity");
    }
    if (state.cwd !== metadata.workspacePath) {
      throw new Error("Native Codex selection returned a different workspace");
    }
    if (state.treeId !== expected.treeId || state.parentThreadId !== expected.parentThreadId) {
      throw new Error("Native Codex selection changed the validated thread tree identity");
    }
  }

  #assertResolvedSettings(state: CodexThreadState, metadata: ManagedMetadata): void {
    const missing: string[] = [];
    const profile = state.pendingSettings?.profile ?? state.profile ?? metadata.requestedProfile;
    const sandbox = state.pendingSettings?.sandbox ?? state.sandbox ?? metadata.requestedSandbox;
    const model = state.pendingSettings?.model ?? state.model ?? metadata.requestedModel;
    const effort = state.pendingSettings?.effort ?? state.effort ?? metadata.requestedEffort;
    if (!profile) missing.push("profile");
    if (!sandbox) missing.push("sandbox");
    if (!model) missing.push("model");
    if (!normalizeProviderReasoningEffort("codex", effort)) missing.push("effort");
    if (missing.length > 0) {
      throw new Error(
        `Managed Codex settings could not be resolved: ${missing.join(", ")}`,
      );
    }
  }

  #publishSession(state: CodexThreadState): void {
    try {
      this.#onSessionChanged?.(this.toSessionView(state));
    } catch {
      // State consumers cannot be allowed to tear down the provider pump.
    }
  }

  #removeManagedThread(
    threadId: string,
    reason: "ended" | "archived" | "deleted",
  ): void {
    if (!this.#metadata.has(threadId)) return;
    const provisional = this.#provisionalAdoptions.delete(threadId);
    const resuming = this.#resumeTransactions.delete(threadId);
    const quarantined = this.#quarantinedResumes.delete(threadId);
    this.#metadata.delete(threadId);
    this.#knownStates.delete(threadId);
    this.#observations.delete(threadId);
    this.#recovering.delete(threadId);
    this.#managedThreads.delete(threadId);
    this.#dropBufferedActivity(threadId);
    if (!provisional && !resuming && !quarantined) {
      this.#publishRemoval(sessionRecordId("local", "codex", threadId), reason);
    }
  }

  #publishRemoval(
    managerSessionId: string,
    reason: "ended" | "archived" | "deleted",
  ): void {
    try {
      this.#onSessionRemoved?.(managerSessionId, reason);
    } catch {
      // Durable cleanup is best-effort at this event boundary; callers surface
      // their own diagnostic without poisoning unrelated provider sessions.
    }
  }

  #publishActivity(threadId: string, mutation: ActivityMutation): void {
    try {
      this.#onActivity?.(sessionRecordId("local", "codex", threadId), mutation);
    } catch {
      // Activity consumers cannot be allowed to tear down the provider pump.
    }
  }
}

export { CodexProviderBridge as CodexProviderControlAdapter };
