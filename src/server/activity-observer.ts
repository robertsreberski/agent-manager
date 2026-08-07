import type { ActivityItem, ActivityItemDraft, ActivityResetReason } from "../activity/index.ts";
import { ActivityHub } from "../activity/index.ts";
import type { SessionView } from "../core/types.ts";
import { normalizeCodexQuestions } from "../providers/codex/question-normalizer.ts";
import type {
  SessionTranscriptReader,
  TranscriptItem,
  TranscriptItemStatus,
  TranscriptReadResult,
  TranscriptUnavailableReason,
} from "./transcript.ts";

interface AvailableTranscriptObservation {
  state: "available";
  source: TranscriptReadResult["transcript"]["source"];
  truncated: boolean;
  items: TranscriptItem[];
  /** Two writers answered the same message; these items are one branch. */
  forked: boolean;
}

interface UnavailableTranscriptObservation {
  state: "unavailable";
  reason: TranscriptUnavailableReason;
}

type TranscriptObservation = AvailableTranscriptObservation | UnavailableTranscriptObservation;

interface ActiveObservation {
  refs: number;
  session: SessionView;
  timer: NodeJS.Timeout | null;
  previous: TranscriptObservation | null;
  stopped: boolean;
}

export interface SelectedTranscriptActivityObserverOptions {
  hub: ActivityHub;
  reader?: SessionTranscriptReader;
  resolveSession?: (id: string) => SessionView | null;
  eligible?: (session: SessionView) => boolean;
  runningPollMs?: number;
  idlePollMs?: number;
}

/**
 * Every transcript-derived item is inferred by definition: it was reconstructed
 * from a file the provider owns rather than handed over by a provider API. The
 * provenance triple below is therefore fixed, and must never be widened to
 * `provider-api` / `exact` / `provider-exposed` for any transcript item.
 */
/** This observer's id namespace, and the handle it withdraws its items by. */
export const TRANSCRIPT_ID_PREFIX = "transcript:";

const TRANSCRIPT_PROVENANCE = {
  source: "transcript",
  confidence: "inferred",
  exposure: "transcript-derived",
} as const;

function transcriptState(status: TranscriptItemStatus) {
  return status === "running" ? "running" as const
    : status === "complete" ? "complete" as const
    : "interrupted" as const;
}

function activityDraft(item: TranscriptItem): ActivityItemDraft {
  const complete = item.status === "complete";
  const timing = {
    startedAt: item.createdAt,
    updatedAt: item.createdAt,
    completedAt: complete ? item.createdAt : null,
  };
  if (item.kind === "reasoning") {
    return {
      kind: "reasoning",
      id: `${TRANSCRIPT_ID_PREFIX}${item.id}`,
      correlationId: item.correlationId ?? null,
      turnId: item.turnId,
      reasoningKind: "summary",
      label: item.label,
      text: item.text,
      state: transcriptState(item.status),
      ...timing,
      ...TRANSCRIPT_PROVENANCE,
    };
  }
  if (item.kind === "plan") {
    return {
      kind: "plan",
      id: `${TRANSCRIPT_ID_PREFIX}${item.id}`,
      correlationId: item.correlationId ?? null,
      turnId: item.turnId,
      path: null,
      version: null,
      markdown: item.markdown,
      supersededBy: null,
      approvalRequestId: null,
      approvedAt: null,
      state: transcriptState(item.status),
      ...timing,
      ...TRANSCRIPT_PROVENANCE,
    };
  }
  if (item.kind === "tool") {
    if (item.name === "request_user_input") {
      const argumentRecord = typeof item.arguments === "object"
          && item.arguments !== null
          && !Array.isArray(item.arguments)
        ? item.arguments
        : null;
      const questions = normalizeCodexQuestions(argumentRecord?.questions).map((question) => ({
        id: question.id,
        ...(question.header ? { header: question.header } : {}),
        text: question.text,
        options: question.options,
        multiSelect: question.multiSelect,
        allowFreeText: question.allowFreeText,
        isSecret: question.isSecret,
      }));
      const resolved = item.result !== null || item.status === "complete";
      return {
        kind: "attention",
        id: `${TRANSCRIPT_ID_PREFIX}${item.id}`,
        correlationId: item.correlationId ?? null,
        turnId: item.turnId,
        requestId: item.toolCallId,
        attentionKind: "question",
        title: "request_user_input",
        summary: questions.length > 0 ? null : "Codex is waiting for input",
        questions,
        approvalFacts: null,
        respondable: false,
        resolved,
        isSecret: questions.some((question) => question.isSecret),
        state: item.isError
          ? "failed"
          : resolved
            ? "complete"
            : item.status === "running"
              ? "waiting"
              : "interrupted",
        ...timing,
        ...TRANSCRIPT_PROVENANCE,
      };
    }
    return {
      kind: "tool",
      id: `${TRANSCRIPT_ID_PREFIX}${item.id}`,
      correlationId: item.correlationId ?? null,
      turnId: item.turnId,
      toolCallId: item.toolCallId,
      name: item.name,
      // The transcript names a tool but never states which category the
      // provider assigned it, so the category stays unclassified.
      category: "other",
      arguments: item.arguments,
      result: item.result,
      output: "",
      state: item.isError ? "failed" : transcriptState(item.status),
      ...timing,
      ...TRANSCRIPT_PROVENANCE,
    };
  }
  return {
    kind: "message",
    id: `${TRANSCRIPT_ID_PREFIX}${item.id}`,
    correlationId: item.correlationId ?? null,
    turnId: item.turnId,
    role: item.role,
    // Transcript rows preserve message order but do not expose the provider's
    // commentary/final channel. Treating every complete assistant row as final
    // let the UI move it past later tool calls and erase a real message boundary.
    phase: null,
    text: item.text,
    label: item.label,
    memoryCitation: item.memoryCitation,
    state: transcriptState(item.status),
    ...timing,
    ...TRANSCRIPT_PROVENANCE,
  };
}

function activityDrafts(item: TranscriptItem): ActivityItemDraft[] {
  const primary = activityDraft(item);
  if (item.kind !== "plan" || !item.memoryCitation) return [primary];
  const complete = item.status === "complete";
  return [primary, {
    kind: "message",
    id: `${TRANSCRIPT_ID_PREFIX}${item.id}:memory-citation`,
    correlationId: item.correlationId ? `${item.correlationId}:memory-citation` : null,
    turnId: item.turnId,
    role: "assistant",
    phase: null,
    text: "",
    label: null,
    memoryCitation: item.memoryCitation,
    state: transcriptState(item.status),
    startedAt: item.createdAt,
    updatedAt: item.createdAt,
    completedAt: complete ? item.createdAt : null,
    ...TRANSCRIPT_PROVENANCE,
  }];
}

function sameArguments(previous: TranscriptItem, next: TranscriptItem): boolean {
  if (previous.kind !== "tool" || next.kind !== "tool") return true;
  return JSON.stringify(previous.arguments ?? null) === JSON.stringify(next.arguments ?? null);
}

function changed(previous: TranscriptItem, next: TranscriptItem): boolean {
  if (
    previous.kind !== next.kind
    || previous.id !== next.id
    || previous.turnId !== next.turnId
    || previous.createdAt !== next.createdAt
    || previous.status !== next.status
  ) return true;
  if (previous.kind === "tool" && next.kind === "tool") {
    return previous.toolCallId !== next.toolCallId
      || previous.name !== next.name
      || previous.result !== next.result
      || previous.isError !== next.isError
      || !sameArguments(previous, next);
  }
  if (previous.kind === "message" && next.kind === "message") {
    return previous.role !== next.role
      || previous.text !== next.text
      || previous.label !== next.label
      || JSON.stringify(previous.memoryCitation) !== JSON.stringify(next.memoryCitation);
  }
  if (previous.kind === "plan" && next.kind === "plan") {
    return previous.markdown !== next.markdown
      || JSON.stringify(previous.memoryCitation) !== JSON.stringify(next.memoryCitation);
  }
  if (previous.kind === "reasoning" && next.kind === "reasoning") {
    return previous.text !== next.text || previous.label !== next.label;
  }
  return true;
}

function replacementReason(
  previous: AvailableTranscriptObservation,
  next: AvailableTranscriptObservation,
): ActivityResetReason | null {
  if (previous.source !== next.source) return "transcript-reset";
  if (previous.truncated !== next.truncated) return "truncation";
  if (next.items.length < previous.items.length) return "transcript-reset";
  for (let index = 0; index < previous.items.length; index += 1) {
    const before = previous.items[index];
    const after = next.items[index];
    if (before?.id !== after?.id || before?.kind !== after?.kind) return "branch-change";
  }
  return null;
}

function unavailableActivity(reason: TranscriptUnavailableReason): ActivityItemDraft {
  const facts: Record<TranscriptUnavailableReason, {
    level: "info" | "warning" | "error";
    title: string;
    details: string;
  }> = {
    "not-found": {
      level: "info",
      title: "No transcript found",
      details: "This session has no readable transcript at its provider-owned location.",
    },
    unreadable: {
      level: "error",
      title: "Transcript unreadable",
      details: "The provider transcript exists but cannot be read safely.",
    },
    unsupported: {
      level: "warning",
      title: "Transcript unsupported",
      details: "This provider session does not expose a transcript shape Agent Manager can read faithfully.",
    },
  };
  const fact = facts[reason];
  return {
    kind: "lifecycle",
    id: "transcript:availability",
    event: reason === "unreadable" ? "error" : "status",
    level: fact.level,
    title: fact.title,
    details: fact.details,
    state: reason === "unreadable" ? "failed" : "complete",
    source: "transcript",
    confidence: "inferred",
    exposure: "transcript-derived",
  };
}

/**
 * States that two writers answered the same message, so the chain shown is one
 * branch of several.
 *
 * Without this the fork is silent and looks like a malfunction: the reader walks
 * one root-to-latest path, so the rendered history flips to whichever branch
 * appended last and trips an unexplained `branch-change` reset on every poll.
 * Naming it is the honest minimum — the cockpit still cannot show both branches.
 */
function forkedActivity(): ActivityItemDraft {
  return {
    kind: "lifecycle",
    id: "transcript:fork",
    event: "warning",
    level: "warning",
    title: "This conversation forked",
    details: "Two surfaces answered the same message, so this conversation has more than one branch. Agent Manager is showing the most recently written one.",
    state: "complete",
    source: "transcript",
    confidence: "inferred",
    exposure: "transcript-derived",
  };
}

function sameUnavailableActivity(
  item: ActivityItem,
  draft: ActivityItemDraft,
): boolean {
  return item?.kind === "lifecycle"
    && draft.kind === "lifecycle"
    && item.id === draft.id
    && item.event === draft.event
    && item.level === draft.level
    && item.title === draft.title
    && item.state === draft.state;
}

/**
 * Projects the currently selected provider transcript into the volatile
 * activity hub. Exact managed/hook events remain authoritative through the
 * hub's correlation reconciliation, while polling retains transcript-only
 * history and event kinds the live provider surface does not expose.
 */
export class SelectedTranscriptActivityObserver {
  readonly #hub: ActivityHub;
  readonly #reader: SessionTranscriptReader | undefined;
  readonly #resolveSession: ((id: string) => SessionView | null) | undefined;
  readonly #eligible: ((session: SessionView) => boolean) | undefined;
  readonly #runningPollMs: number;
  readonly #active = new Map<string, ActiveObservation>();

  constructor(options: SelectedTranscriptActivityObserverOptions) {
    this.#hub = options.hub;
    this.#reader = options.reader;
    this.#resolveSession = options.resolveSession;
    this.#eligible = options.eligible;
    this.#runningPollMs = Math.max(100, options.runningPollMs ?? 500);
  }

  seedOnce(session: SessionView): void {
    this.hydrate(session);
  }

  /** @deprecated Use hydrate; retained for embedders during this source cutover. */
  seedIfEmpty(session: SessionView): boolean {
    return this.hydrate(session);
  }

  /** Hydrates history even when hook/API activity already occupies the hub. */
  hydrate(session: SessionView): boolean {
    if (!this.#reader) return false;
    const existing = this.#active.get(session.id);
    if (existing) {
      existing.session = session;
      return this.#refresh(existing, false);
    }
    return this.#refresh({
      refs: 0,
      session,
      timer: null,
      previous: null,
      stopped: false,
    }, false);
  }

  acquire(session: SessionView): () => void {
    if (!this.#reader) return () => undefined;
    let observation = this.#active.get(session.id);
    if (!observation) {
      observation = {
        refs: 0,
        session,
        timer: null,
        previous: null,
        stopped: false,
      };
      this.#active.set(session.id, observation);
      this.#refresh(observation);
      this.#schedule(observation);
    } else {
      observation.session = session;
    }
    observation.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = this.#active.get(session.id);
      if (!active) return;
      active.refs -= 1;
      if (active.refs > 0) return;
      active.stopped = true;
      if (active.timer) clearTimeout(active.timer);
      this.#active.delete(session.id);
    };
  }

  dispose(): void {
    for (const observation of this.#active.values()) {
      observation.stopped = true;
      if (observation.timer) clearTimeout(observation.timer);
    }
    this.#active.clear();
  }

  #refresh(observation: ActiveObservation, respectEligibility = true): boolean {
    if (!this.#reader || observation.stopped) return false;
    const latestSession = this.#resolveSession?.(observation.session.id);
    if (latestSession) observation.session = latestSession;
    if (respectEligibility && this.#eligible && !this.#eligible(observation.session)) {
      // Eligibility can pause polling, but a source handoff never deletes the
      // already-reconciled history. Exact events replace correlated inferred
      // twins inside ActivityHub as they arrive.
      return false;
    }
    let result: TranscriptReadResult;
    try {
      result = this.#reader.read(observation.session);
    } catch {
      result = {
        items: [],
        transcript: {
          state: "unavailable",
          truncated: false,
          source: null,
          itemCount: 0,
          reason: "unreadable",
          forked: false,
        },
      };
    }
    const next: TranscriptObservation = result.transcript.state === "available"
      ? {
          state: "available",
          source: result.transcript.source,
          truncated: result.transcript.truncated,
          items: result.items,
          forked: result.transcript.forked,
        }
      : {
          state: "unavailable",
          reason: result.transcript.reason ?? "unsupported",
        };
    const previous = observation.previous;
    if (next.state === "unavailable") {
      const availability = unavailableActivity(next.reason);
      const retained = this.#hub.snapshot(observation.session.id)?.items ?? [];
      const existingAvailability = retained.find((item) => item.id === availability.id);
      const availabilityUnchanged = existingAvailability !== undefined
        && sameUnavailableActivity(existingAvailability, availability);
      const hasRetainedTranscriptHistory = retained.some((item) =>
        item.source === "transcript" && item.id !== availability.id
      );
      if (
        previous?.state === "unavailable"
        && previous.reason === next.reason
        && availabilityUnchanged
      ) {
        return false;
      }
      if (hasRetainedTranscriptHistory) {
        // A provider file can rotate or be briefly locked while a live hook/API
        // stream continues. The observer itself is also released when the
        // drawer is deselected, so `previous` can be empty on a later reselect
        // even though the hub still holds the transcript. Retain that history
        // and keep exactly one availability fact beside it.
        if (!availabilityUnchanged) {
          this.#hub.ingest(
            observation.session.id,
            observation.session.provider,
            { type: "upsert", item: availability },
          );
        }
      } else {
        this.#hub.reconcileTranscript(
          observation.session.id,
          observation.session.provider,
          [availability],
          false,
        );
      }
      observation.previous = next;
      return false;
    }
    const reason = next.truncated
      ? "truncation"
      : previous?.state === "available"
        ? replacementReason(previous, next) ?? "transcript-reset"
        : "transcript-reset";
    this.#hub.reconcileTranscript(
      observation.session.id,
      observation.session.provider,
      /*
        The fork fact travels with the transcript items rather than beside them,
        so one reconcile owns the whole projection and a linear read clears the
        warning without a second pass.
      */
      next.forked
        ? [...next.items.flatMap(activityDrafts), forkedActivity()]
        : next.items.flatMap(activityDrafts),
      next.truncated,
      reason,
    );
    observation.previous = structuredClone(next);
    return next.items.length > 0;
  }

  #schedule(observation: ActiveObservation): void {
    if (observation.stopped) return;
    observation.timer = setTimeout(() => {
      observation.timer = null;
      this.#refresh(observation);
      this.#schedule(observation);
    }, this.#runningPollMs);
    observation.timer.unref();
  }
}
