import type { ActivityItemDraft, ActivityMutation } from "../../activity/index.ts";
import {
  authorizeHookBearer,
  type HookAuthorizationRecord,
} from "./auth.ts";
import {
  ClaudePermissionBroker,
  type ClaudeHookHttpResponse,
  type ClaudeHookPendingPermission,
  type ClaudeHookPermissionDecision,
} from "./claude-broker.ts";
import { ClaudeHookActivityProjector } from "./claude-projector.ts";
import {
  CLAUDE_MANAGER_OWNER_VALUE,
  ClaudeHookSourceArbiter,
} from "./claude-source.ts";
import { parseClaudeHookInput, type ClaudeHookInput } from "./claude-types.ts";

export interface ClaudeHookBridgeRequest {
  authorization?: string;
  /** Value of X-Agent-Manager-Owner after Claude expands allowedEnvVars. */
  ownerMarker?: string;
  body: unknown;
  signal?: AbortSignal;
}

export interface ClaudeHookBridgeResponse {
  statusCode: 200 | 400 | 401;
  body: Record<string, unknown> | null;
}

export interface ClaudeHookSeenEvent {
  providerSessionId: string;
  hookEventName: ClaudeHookInput["hook_event_name"];
  installId: string;
  receivedAt: string;
}

export type ClaudeHookOperatorResponse =
  | {
      kind: "decision";
      decision: "allow" | "deny";
      reason?: string;
      persist?: boolean;
    }
  | {
      kind: "answer";
      value: string;
      selectedOptions: string[];
    }
  | {
      kind: "answers";
      answers: Array<{
        questionId: string;
        value: string;
        selectedOptions: string[];
      }>;
    };

export interface ClaudeHookBridgeOptions {
  authorizationRecords?: readonly HookAuthorizationRecord[];
  broker?: ClaudePermissionBroker;
  projector?: ClaudeHookActivityProjector;
  sourceArbiter?: ClaudeHookSourceArbiter;
  now?: () => Date;
  /** Map the provider session id to shared identity at the server boundary. */
  onActivity?: (providerSessionId: string, mutation: ActivityMutation) => void;
  onHookSeen?: (event: ClaudeHookSeenEvent) => void;
  onPermissionChanged?: (
    event: { type: "opened"; request: ClaudeHookPendingPermission }
      | { type: "closed"; request: ClaudeHookPendingPermission; reason: string },
  ) => void;
  onError?: (message: string) => void;
}

interface PendingProjection {
  authorizationRecordId: string;
  release(): void;
  resolved: ActivityMutation;
  plan: ActivityMutation | null;
}

const EMPTY_SUCCESS: ClaudeHookBridgeResponse = { statusCode: 200, body: null };

function resolvedAttention(mutation: ActivityMutation): ActivityMutation | null {
  if (mutation.type !== "upsert" || mutation.item.kind !== "attention") return null;
  const item: ActivityItemDraft = {
    ...mutation.item,
    state: "complete",
    respondable: false,
    resolved: true,
  };
  return { type: "upsert", item };
}

function approvedPlan(
  mutation: ActivityMutation | null,
  approvedAt: string,
): ActivityMutation | null {
  if (mutation?.type !== "upsert" || mutation.item.kind !== "plan") return null;
  return {
    type: "upsert",
    item: {
      ...mutation.item,
      approvedAt,
      state: "complete",
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function answerText(value: string, selectedOptions: readonly string[]): string {
  return [...selectedOptions, value.trim()].filter((part) => part.length > 0).join(", ");
}

function questionRecords(toolInput: unknown): Array<{
  id: string;
  text: string;
  options: Set<string>;
  multiSelect: boolean;
}> {
  const input = objectValue(toolInput);
  if (!Array.isArray(input?.questions)) return [];
  return input.questions.map((rawQuestion, index) => {
    const question = objectValue(rawQuestion);
    if (!question || typeof question.question !== "string" || question.question.length === 0) {
      throw new Error("Claude AskUserQuestion supplied an invalid question");
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          if (typeof rawOption === "string") return [rawOption];
          const option = objectValue(rawOption);
          return typeof option?.label === "string" ? [option.label] : [];
        })
      : [];
    return {
      id: typeof question.header === "string" && question.header.length > 0
        ? question.header
        : `question-${index + 1}`,
      text: question.question,
      options: new Set(options),
      multiSelect: question.multiSelect === true,
    };
  });
}

function validateSelectedOptions(
  selectedOptions: readonly string[],
  question: ReturnType<typeof questionRecords>[number],
): void {
  if (new Set(selectedOptions).size !== selectedOptions.length) {
    throw new Error("Claude question option was selected more than once");
  }
  if (!question.multiSelect && selectedOptions.length > 1) {
    throw new Error("Claude question accepts only one selected option");
  }
  for (const selected of selectedOptions) {
    if (!question.options.has(selected)) {
      throw new Error(`Claude question does not offer option ${selected}`);
    }
  }
}

/**
 * Provider-specific HTTP orchestration. The surrounding server owns socket,
 * Host, content-type, no-store, and body-time limits; this class owns Claude
 * auth, parsing, arbitration, projection, and held PermissionRequest lifetime.
 */
export class ClaudeHookBridge {
  readonly #broker: ClaudePermissionBroker;
  readonly #projector: ClaudeHookActivityProjector;
  readonly #sourceArbiter: ClaudeHookSourceArbiter;
  readonly #now: () => Date;
  readonly #onActivity: ClaudeHookBridgeOptions["onActivity"];
  readonly #onHookSeen: ClaudeHookBridgeOptions["onHookSeen"];
  readonly #onPermissionChanged: ClaudeHookBridgeOptions["onPermissionChanged"];
  readonly #onError: ClaudeHookBridgeOptions["onError"];
  readonly #pending = new Map<string, PendingProjection>();
  readonly #unsubscribeBroker: () => void;
  #authorizationRecords: HookAuthorizationRecord[];
  #closed = false;

  constructor(options: ClaudeHookBridgeOptions = {}) {
    this.#authorizationRecords = (options.authorizationRecords ?? []).map((record) => structuredClone(record));
    this.#broker = options.broker ?? new ClaudePermissionBroker();
    this.#projector = options.projector ?? new ClaudeHookActivityProjector();
    this.#sourceArbiter = options.sourceArbiter ?? new ClaudeHookSourceArbiter();
    this.#now = options.now ?? (() => new Date());
    this.#onActivity = options.onActivity;
    this.#onHookSeen = options.onHookSeen;
    this.#onPermissionChanged = options.onPermissionChanged;
    this.#onError = options.onError;
    this.#unsubscribeBroker = this.#broker.subscribe((event) => {
      if (event.type !== "closed") return;
      this.#notifyPermission(event);
      const pending = this.#pending.get(event.request.id);
      if (!pending) return;
      this.#pending.delete(event.request.id);
      this.#publish(event.request.sessionId, pending.resolved);
    });
  }

  get sourceArbiter(): ClaudeHookSourceArbiter {
    return this.#sourceArbiter;
  }

  pending(): ClaudeHookPendingPermission[] {
    return this.#broker.pending();
  }

  respond(requestId: string, decision: ClaudeHookPermissionDecision): boolean {
    const request = this.#broker.pending().find((candidate) => candidate.id === requestId);
    const pending = this.#pending.get(requestId);
    const accepted = this.#broker.respond(requestId, decision);
    if (accepted && request && decision.behavior === "allow") {
      const mutation = approvedPlan(pending?.plan ?? null, this.#now().toISOString());
      if (mutation) this.#publish(request.sessionId, mutation);
    }
    return accepted;
  }

  /** Release an exact held request without claiming an operator decision. */
  failOpen(requestId: string, reason = "browser-lost"): boolean {
    return this.#broker.failOpen(requestId, reason);
  }

  /** Maps the shared cockpit response envelope to Claude's exact held output. */
  respondWithEnvelope(requestId: string, response: ClaudeHookOperatorResponse): boolean {
    const request = this.#broker.pending().find((candidate) => candidate.id === requestId);
    if (!request) return false;
    if (response.kind === "decision") {
      if (response.persist === true && response.decision !== "allow") {
        throw new Error("Claude cannot persist a denied approval");
      }
      if (response.decision === "allow") {
        if (response.persist === true && request.permissionSuggestions.length === 0) {
          throw new Error("Claude did not expose a persistent permission choice");
        }
        return this.respond(requestId, {
          behavior: "allow",
          ...(response.persist === true
            ? { updatedPermissions: structuredClone(request.permissionSuggestions) }
            : {}),
        });
      }
      return this.respond(requestId, {
        behavior: "deny",
        ...(response.reason ? { message: response.reason } : {}),
      });
    }
    if (request.toolName !== "AskUserQuestion") {
      throw new Error("Only Claude AskUserQuestion accepts an answer envelope");
    }
    const questions = questionRecords(request.toolInput);
    if (questions.length === 0) {
      throw new Error("Claude AskUserQuestion did not expose any answerable questions");
    }
    if (new Set(questions.map((question) => question.id)).size !== questions.length) {
      throw new Error("Claude AskUserQuestion supplied duplicate question ids");
    }
    if (new Set(questions.map((question) => question.text)).size !== questions.length) {
      throw new Error("Claude AskUserQuestion supplied duplicate question text");
    }
    const answers: Record<string, string> = {};
    if (response.kind === "answer") {
      if (questions.length !== 1) {
        throw new Error("The compact answer envelope requires exactly one Claude question");
      }
      const question = questions[0]!;
      validateSelectedOptions(response.selectedOptions, question);
      const answer = answerText(response.value, response.selectedOptions);
      if (!answer) throw new Error("Claude question response must not be empty");
      answers[question.text] = answer;
    } else {
      if (response.answers.length !== questions.length) {
        throw new Error("Every Claude question must be answered exactly once");
      }
      const byId = new Map(questions.map((question) => [question.id, question]));
      for (const item of response.answers) {
        const question = byId.get(item.questionId);
        if (!question) throw new Error(`Unknown Claude question ${item.questionId}`);
        if (question.text in answers) throw new Error(`Claude question ${item.questionId} was answered twice`);
        validateSelectedOptions(item.selectedOptions, question);
        const answer = answerText(item.value, item.selectedOptions);
        if (!answer) throw new Error(`Claude question ${item.questionId} response must not be empty`);
        answers[question.text] = answer;
        byId.delete(item.questionId);
      }
      if (byId.size > 0) throw new Error("Every Claude question must be answered exactly once");
    }
    const input = objectValue(request.toolInput);
    if (!input) throw new Error("Claude AskUserQuestion input is invalid");
    return this.respond(requestId, {
      behavior: "allow",
      updatedInput: { ...structuredClone(input), answers },
    });
  }

  /** Rotating/removing an install immediately releases holds authenticated by it. */
  replaceAuthorizationRecords(records: readonly HookAuthorizationRecord[]): void {
    const next = records.map((record) => structuredClone(record));
    const liveIds = new Set(next.map((record) => `${record.id}\0${record.tokenDigest}`));
    const previous = new Map(this.#authorizationRecords.map((record) => [record.id, record.tokenDigest]));
    for (const pending of this.#pending.values()) {
      const digest = previous.get(pending.authorizationRecordId);
      if (!digest || !liveIds.has(`${pending.authorizationRecordId}\0${digest}`)) pending.release();
    }
    this.#authorizationRecords = next;
  }

  async handle(request: ClaudeHookBridgeRequest): Promise<ClaudeHookBridgeResponse> {
    if (this.#closed || request.signal?.aborted) return EMPTY_SUCCESS;
    const authorizationRecord = authorizeHookBearer(
      request.authorization,
      this.#authorizationRecords,
    );
    if (!authorizationRecord) return { statusCode: 401, body: null };

    let input: ClaudeHookInput;
    try {
      input = parseClaudeHookInput(request.body);
    } catch {
      return { statusCode: 400, body: null };
    }

    const source = this.#sourceArbiter.accept(input, {
      ...(request.ownerMarker === undefined ? {} : { ownerMarker: request.ownerMarker }),
      now: this.#now().getTime(),
    });
    if (!source.accepted) return EMPTY_SUCCESS;

    this.#notifySeen({
      providerSessionId: input.session_id,
      hookEventName: input.hook_event_name,
      installId: authorizationRecord.id,
      receivedAt: this.#now().toISOString(),
    });

    if (input.hook_event_name === "PermissionRequest") {
      const held = this.#broker.hold(input);
      try {
        const projection = this.#projector.project(input, {
          permissionRequestId: held.request.id,
        });
        const resolved = projection.mutations
          .map(resolvedAttention)
          .find((mutation): mutation is ActivityMutation => mutation !== null);
        if (!resolved) {
          held.release();
          return EMPTY_SUCCESS;
        }
        this.#pending.set(held.request.id, {
          authorizationRecordId: authorizationRecord.id,
          release: held.release,
          resolved,
          plan: projection.mutations.find((mutation) =>
            mutation.type === "upsert" && mutation.item.kind === "plan"
          ) ?? null,
        });
        for (const mutation of projection.mutations) this.#publish(input.session_id, mutation);
        this.#notifyPermission({ type: "opened", request: held.request });
        const abort = () => held.release();
        request.signal?.addEventListener("abort", abort, { once: true });
        try {
          const response: ClaudeHookHttpResponse = await held.response;
          return response;
        } finally {
          request.signal?.removeEventListener("abort", abort);
        }
      } catch (error) {
        held.release();
        this.#report(error);
        return EMPTY_SUCCESS;
      }
    }

    try {
      const projection = this.#projector.project(input);
      for (const mutation of projection.mutations) this.#publish(input.session_id, mutation);
      if (input.hook_event_name === "SessionEnd") {
        this.#broker.releaseSession(input.session_id);
        this.#projector.forgetSession(input.session_id);
        this.#sourceArbiter.forget(input.session_id);
      }
    } catch (error) {
      // Once authenticated and parsed, provider exceptions fail open. Claude
      // must retain its native behavior even if cockpit projection is broken.
      this.#report(error);
    }
    return EMPTY_SUCCESS;
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#broker.shutdown();
    this.#unsubscribeBroker();
    this.#pending.clear();
  }

  #publish(providerSessionId: string, mutation: ActivityMutation): void {
    try {
      this.#onActivity?.(providerSessionId, mutation);
    } catch (error) {
      this.#report(error);
    }
  }

  #notifySeen(event: ClaudeHookSeenEvent): void {
    try {
      this.#onHookSeen?.(event);
    } catch (error) {
      this.#report(error);
    }
  }

  #notifyPermission(event:
    { type: "opened"; request: ClaudeHookPendingPermission }
    | { type: "closed"; request: ClaudeHookPendingPermission; reason: string }
  ): void {
    try {
      this.#onPermissionChanged?.(event);
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    const message = error instanceof Error ? error.message : "Claude hook bridge failed";
    try {
      this.#onError?.(message);
    } catch {
      // Error reporting cannot affect Claude's hook response.
    }
  }
}
