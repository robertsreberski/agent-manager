import type { ActivityItemDraft, ActivityResetReason } from "../activity/index.ts";
import { ActivityHub } from "../activity/index.ts";
import type { SessionView } from "../core/types.ts";
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
      id: `transcript:${item.id}`,
      reasoningKind: "summary",
      label: item.label,
      text: item.text,
      state: transcriptState(item.status),
      ...timing,
      ...TRANSCRIPT_PROVENANCE,
    };
  }
  if (item.kind === "tool") {
    return {
      kind: "tool",
      id: `transcript:${item.id}`,
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
    id: `transcript:${item.id}`,
    role: item.role,
    phase: item.role === "assistant" && complete ? "final" : null,
    text: item.text,
    label: item.label,
    state: transcriptState(item.status),
    ...timing,
    ...TRANSCRIPT_PROVENANCE,
  };
}

function sameArguments(previous: TranscriptItem, next: TranscriptItem): boolean {
  if (previous.kind !== "tool" || next.kind !== "tool") return true;
  return JSON.stringify(previous.arguments ?? null) === JSON.stringify(next.arguments ?? null);
}

function changed(previous: TranscriptItem, next: TranscriptItem): boolean {
  if (
    previous.kind !== next.kind
    || previous.id !== next.id
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
      || previous.label !== next.label;
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
 * Projects only the currently selected provider transcript into the volatile
 * activity hub. Managed provider streams must remain the sole authority for
 * manager-owned sessions, so callers decide whether a session is eligible.
 */
export class SelectedTranscriptActivityObserver {
  readonly #hub: ActivityHub;
  readonly #reader: SessionTranscriptReader | undefined;
  readonly #resolveSession: ((id: string) => SessionView | null) | undefined;
  readonly #eligible: ((session: SessionView) => boolean) | undefined;
  readonly #runningPollMs: number;
  readonly #idlePollMs: number;
  readonly #active = new Map<string, ActiveObservation>();

  constructor(options: SelectedTranscriptActivityObserverOptions) {
    this.#hub = options.hub;
    this.#reader = options.reader;
    this.#resolveSession = options.resolveSession;
    this.#eligible = options.eligible;
    this.#runningPollMs = Math.max(100, options.runningPollMs ?? 500);
    this.#idlePollMs = Math.max(this.#runningPollMs, options.idlePollMs ?? 2_000);
  }

  seedOnce(session: SessionView): void {
    if (!this.#reader) return;
    const existing = this.#active.get(session.id);
    if (existing) {
      this.#refresh(existing);
      return;
    }
    const temporary: ActiveObservation = {
      refs: 0,
      session,
      timer: null,
      previous: null,
      stopped: false,
    };
    this.#refresh(temporary);
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

  #refresh(observation: ActiveObservation): void {
    if (!this.#reader || observation.stopped) return;
    const latestSession = this.#resolveSession?.(observation.session.id);
    if (latestSession) observation.session = latestSession;
    if (this.#eligible && !this.#eligible(observation.session)) return;
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
        },
      };
    }
    const next: TranscriptObservation = result.transcript.state === "available"
      ? {
          state: "available",
          source: result.transcript.source,
          truncated: result.transcript.truncated,
          items: result.items,
        }
      : {
          state: "unavailable",
          reason: result.transcript.reason ?? "unsupported",
        };
    const previous = observation.previous;
    if (next.state === "unavailable") {
      if (previous?.state === "unavailable" && previous.reason === next.reason) return;
      this.#hub.ingest(observation.session.id, observation.session.provider, {
        type: "reset",
        reason: "transcript-reset",
        items: [unavailableActivity(next.reason)],
      });
      observation.previous = next;
      return;
    }
    if (!previous) {
      this.#hub.ingest(observation.session.id, observation.session.provider, {
        type: "reset",
        reason: next.truncated ? "truncation" : "transcript-reset",
        items: next.items.map(activityDraft),
      });
      observation.previous = structuredClone(next);
      return;
    }
    if (previous.state === "unavailable") {
      this.#hub.ingest(observation.session.id, observation.session.provider, {
        type: "reset",
        reason: "transcript-reset",
        items: next.items.map(activityDraft),
      });
      observation.previous = structuredClone(next);
      return;
    }
    const reset = replacementReason(previous, next);
    if (reset) {
      this.#hub.ingest(observation.session.id, observation.session.provider, {
        type: "reset",
        reason: reset,
        items: next.items.map(activityDraft),
      });
      observation.previous = structuredClone(next);
      return;
    }
    for (let index = 0; index < next.items.length; index += 1) {
      const nextItem = next.items[index]!;
      const previousItem = previous.items[index];
      if (!previousItem || changed(previousItem, nextItem)) {
        this.#hub.ingest(observation.session.id, observation.session.provider, {
          type: "upsert",
          item: activityDraft(nextItem),
        });
      }
    }
    observation.previous = structuredClone(next);
  }

  #schedule(observation: ActiveObservation): void {
    if (observation.stopped) return;
    const active = observation.session.status === "running"
      || observation.session.status === "waiting";
    observation.timer = setTimeout(() => {
      observation.timer = null;
      this.#refresh(observation);
      this.#schedule(observation);
    }, active ? this.#runningPollMs : this.#idlePollMs);
    observation.timer.unref();
  }
}
