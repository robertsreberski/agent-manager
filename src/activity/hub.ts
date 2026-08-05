import { randomUUID } from "node:crypto";

import type { TodoProgress } from "../shared/session.ts";
import { encodeActivityCursor, parseActivityCursor } from "./cursor.ts";
import {
  ACTIVITY_SCHEMA_VERSION,
  type ActivityAppendChannel,
  type ActivityFrame,
  type ActivityHubLimits,
  type ActivityHubOptions,
  type ActivityItem,
  type ActivityItemDraft,
  type ActivityJsonValue,
  type ActivityListener,
  type ActivityMutation,
  type ActivityReplayResult,
  type ActivityResetFrame,
  type ActivitySnapshotFrame,
  type Provider,
} from "./types.ts";
import { redactActivityJson, redactActivityText } from "./redaction.ts";

export const ACTIVITY_DEFAULT_LIMITS: ActivityHubLimits = Object.freeze({
  maxItems: 400,
  maxViewBytes: 1 * 1_024 * 1_024,
  maxFieldBytes: 128 * 1_024,
  replayMaxFrames: 512,
  replayMaxBytes: 2 * 1_024 * 1_024,
  replayMaxAgeMs: 15 * 60 * 1_000,
});

interface StoredFrame {
  frame: ActivityFrame;
  bytes: number;
  atMs: number;
}

interface ActivitySession {
  provider: Provider;
  seq: number;
  items: Map<string, ActivityItem>;
  replay: StoredFrame[];
  replayBytes: number;
  listeners: Set<ActivityListener>;
  appendOffsets: Map<string, number>;
  appendSources: Map<string, AppendSourceState>;
  truncated: boolean;
  /** Content-free state retained across todo rewrites for exact stall metadata. */
  todoSemantic: string | null;
  todoProgress: TodoProgress | null;
}

interface AppendSourceState {
  /** Raw provider prefix retained only up to maxFieldBytes. */
  raw: string;
  /** Once saturated, later source bytes are accepted but never rendered. */
  saturated: boolean;
}

export type TodoProgressListener = (
  sessionId: string,
  progress: TodoProgress | null,
) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  while (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return { value: value.slice(0, end), truncated: true };
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : fallback;
}

function nonnegativeIntegerOrNull(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : null;
}

function positiveIntegerOrNull(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : null;
}

export class ActivityHub {
  readonly streamEpoch: string;
  readonly #limits: ActivityHubLimits;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ActivitySession>();
  readonly #todoProgressListeners = new Set<TodoProgressListener>();

  constructor(options: ActivityHubOptions = {}) {
    this.#limits = {
      maxItems: positiveInteger(options.maxItems, ACTIVITY_DEFAULT_LIMITS.maxItems),
      maxViewBytes: positiveInteger(options.maxViewBytes, ACTIVITY_DEFAULT_LIMITS.maxViewBytes),
      maxFieldBytes: positiveInteger(options.maxFieldBytes, ACTIVITY_DEFAULT_LIMITS.maxFieldBytes),
      replayMaxFrames: positiveInteger(options.replayMaxFrames, ACTIVITY_DEFAULT_LIMITS.replayMaxFrames),
      replayMaxBytes: positiveInteger(options.replayMaxBytes, ACTIVITY_DEFAULT_LIMITS.replayMaxBytes),
      replayMaxAgeMs: positiveInteger(options.replayMaxAgeMs, ACTIVITY_DEFAULT_LIMITS.replayMaxAgeMs),
    };
    this.#now = options.now ?? Date.now;
    this.streamEpoch = options.streamEpoch?.trim() || randomUUID();
  }

  ensureSession(sessionId: string, provider: Provider): void {
    const existing = this.#sessions.get(sessionId);
    if (existing) {
      if (existing.provider !== provider) throw new Error("activity session provider cannot change");
      return;
    }
    this.#sessions.set(sessionId, {
      provider,
      seq: 0,
      items: new Map(),
      replay: [],
      replayBytes: 0,
      listeners: new Set(),
      appendOffsets: new Map(),
      appendSources: new Map(),
      truncated: false,
      todoSemantic: null,
      todoProgress: null,
    });
  }

  /** True when this session's view holds nothing yet. */
  isEmpty(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    return !session || session.items.size === 0;
  }

  /**
   * Records that activity exists which this window does not hold.
   *
   * The window is volatile and bounded, so "empty" has two very different
   * meanings: a session that has genuinely said nothing yet, and one whose
   * history died with the previous process. Only the first is honestly
   * described as waiting for provider activity. This marks the second, and the
   * drawer states the retention boundary it already has a component for.
   */
  markRetentionBoundary(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.truncated) return;
    session.truncated = true;
    const at = new Date(this.#now()).toISOString();
    const frame = this.#resetFrame(sessionId, session, ++session.seq, at, "truncation");
    this.#record(session, frame);
    for (const listener of session.listeners) {
      try {
        listener(clone(frame));
      } catch {
        // Activity consumers cannot interrupt a provider pump.
      }
    }
  }

  ingest(sessionId: string, provider: Provider, mutation: ActivityMutation): ActivityFrame {
    this.ensureSession(sessionId, provider);
    const session = this.#sessions.get(sessionId)!;
    const previousTodoProgress = clone(session.todoProgress);
    const seq = ++session.seq;
    const at = new Date(this.#now()).toISOString();
    let frame: ActivityFrame;

    switch (mutation.type) {
      case "upsert": {
        const existing = session.items.get(mutation.item.id);
        const item = this.#materialize(
          sessionId,
          provider,
          mutation.item,
          existing,
          existing?.seq ?? seq,
          (existing?.revision ?? 0) + 1,
          at,
        );
        session.items.set(item.id, item);
        this.#syncAppendOffsets(
          session,
          item,
          mutation.item,
          !existing || existing.kind !== mutation.item.kind,
        );
        const evicted = this.#trimView(session);
        frame = evicted
          ? this.#resetFrame(sessionId, session, seq, at, "truncation")
          : {
              schemaVersion: ACTIVITY_SCHEMA_VERSION,
              streamEpoch: this.streamEpoch,
              sessionId,
              provider,
              seq,
              cursor: this.#cursor(sessionId, seq),
              at,
              type: "activity.upsert",
              item: clone(item),
            };
        break;
      }
      case "append": {
        const item = session.items.get(mutation.id);
        const key = appendKey(mutation.id, mutation.channel);
        const expected = session.appendOffsets.get(key) ?? 0;
        if (!item || mutation.offset !== expected) {
          frame = this.#resetFrame(sessionId, session, seq, at, "replay-gap");
          break;
        }
        const rawBytes = Buffer.byteLength(mutation.text, "utf8");
        const displayOffset = this.#displayOffset(item, mutation.channel);
        if (displayOffset === null) {
          frame = this.#resetFrame(sessionId, session, seq, at, "replay-gap");
          break;
        }
        session.appendOffsets.set(key, expected + rawBytes);
        const appended = this.#appendToItem(
          session,
          key,
          item,
          mutation.channel,
          mutation.text,
          at,
        );
        if (!appended) {
          frame = this.#resetFrame(sessionId, session, seq, at, "replay-gap");
          break;
        }
        session.items.set(item.id, appended.item);
        const evicted = this.#trimView(session);
        frame = evicted
          ? this.#resetFrame(sessionId, session, seq, at, "truncation")
          : appended.replacement
            ? {
                schemaVersion: ACTIVITY_SCHEMA_VERSION,
                streamEpoch: this.streamEpoch,
                sessionId,
                provider,
                seq,
                cursor: this.#cursor(sessionId, seq),
                at,
                type: "activity.upsert",
                item: clone(appended.item),
              }
          : {
              schemaVersion: ACTIVITY_SCHEMA_VERSION,
              streamEpoch: this.streamEpoch,
              sessionId,
              provider,
              seq,
              cursor: this.#cursor(sessionId, seq),
              at,
              type: "activity.append",
              id: item.id,
              revision: appended.item.revision,
              channel: mutation.channel,
              // Provider offsets validate the unredacted source stream. Wire
              // offsets describe the redacted field the browser has rendered.
              offset: displayOffset,
              text: appended.delta,
              truncated: appended.truncated,
            };
        break;
      }
      case "remove": {
        session.items.delete(mutation.id);
        for (const key of session.appendOffsets.keys()) {
          if (key.startsWith(`${mutation.id}\u0000`)) session.appendOffsets.delete(key);
        }
        for (const key of session.appendSources.keys()) {
          if (key.startsWith(`${mutation.id}\u0000`)) session.appendSources.delete(key);
        }
        frame = {
          schemaVersion: ACTIVITY_SCHEMA_VERSION,
          streamEpoch: this.streamEpoch,
          sessionId,
          provider,
          seq,
          cursor: this.#cursor(sessionId, seq),
          at,
          type: "activity.remove",
          id: mutation.id,
        };
        break;
      }
      case "reset": {
        session.items.clear();
        session.appendOffsets.clear();
        session.appendSources.clear();
        session.truncated = mutation.truncated ?? false;
        /*
          Every reset item used to share one seq, so `#view`'s
          `seq - seq || id.localeCompare(id)` fell through to the id — and a
          provider id is a random token. The whole timeline re-sorted
          alphabetically on every reset, which reads as events appearing twice
          in different places. The submitted order is the provider's order, so
          it is what the seq has to encode.
        */
        const drafts = mutation.items ?? [];
        drafts.forEach((draft, index) => {
          const item = this.#materialize(
            sessionId,
            provider,
            draft,
            undefined,
            seq + index,
            1,
            at,
          );
          session.items.set(item.id, item);
          this.#syncAppendOffsets(session, item, draft, true);
        });
        session.seq = seq + Math.max(drafts.length, 1) - 1;
        this.#trimView(session);
        frame = this.#resetFrame(sessionId, session, session.seq, at, mutation.reason);
        break;
      }
    }

    this.#advanceTodoProgress(session, at);
    this.#record(session, frame);
    this.#publishTodoProgress(
      sessionId,
      previousTodoProgress,
      session.todoProgress,
    );
    for (const listener of session.listeners) {
      try {
        listener(clone(frame));
      } catch {
        // Activity consumers cannot interrupt a provider pump.
      }
    }
    return clone(frame);
  }

  snapshot(sessionId: string): ActivitySnapshotFrame | null {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    const at = new Date(this.#now()).toISOString();
    return {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      streamEpoch: this.streamEpoch,
      sessionId,
      provider: session.provider,
      seq: session.seq,
      cursor: this.#cursor(sessionId, session.seq),
      at,
      type: "activity.snapshot",
      items: this.#items(session),
      truncated: session.truncated,
    };
  }

  replay(sessionId: string, cursor: string | null): ActivityReplayResult {
    const session = this.#sessions.get(sessionId);
    if (!session) return { gap: cursor !== null, cursor: null, frames: [] };
    this.#pruneReplay(session);
    if (cursor === null) {
      const snapshot = this.snapshot(sessionId)!;
      return { gap: false, cursor: snapshot.cursor, frames: [snapshot] };
    }
    const sequence = parseActivityCursor(cursor, this.streamEpoch, sessionId);
    const oldest = session.replay[0]?.frame.seq ?? session.seq + 1;
    const gap = sequence === null || sequence > session.seq || sequence < oldest - 1;
    if (gap) {
      const at = new Date(this.#now()).toISOString();
      const reset = this.#resetFrame(sessionId, session, session.seq, at, "replay-gap");
      return { gap: true, cursor: reset.cursor, frames: [reset] };
    }
    const frames = session.replay
      .filter((entry) => entry.frame.seq > sequence)
      .map((entry) => clone(entry.frame));
    return {
      gap: false,
      cursor: frames.at(-1)?.cursor ?? this.#cursor(sessionId, session.seq),
      frames,
    };
  }

  subscribe(sessionId: string, listener: ActivityListener): () => void {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`unknown activity session ${sessionId}`);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  todoProgress(sessionId: string): TodoProgress | null {
    const session = this.#sessions.get(sessionId);
    return session ? clone(session.todoProgress) : null;
  }

  /**
   * Emits content-free progress when the authoritative todo changes. Existing
   * non-empty summaries are emitted on subscribe so late server composition
   * does not miss provider activity that already arrived.
   */
  subscribeTodoProgress(listener: TodoProgressListener): () => void {
    this.#todoProgressListeners.add(listener);
    for (const [sessionId, session] of this.#sessions) {
      const progress = session.todoProgress;
      if (progress) this.#callTodoProgressListener(listener, sessionId, progress);
    }
    return () => this.#todoProgressListeners.delete(listener);
  }

  /**
   * Drops every item whose id the predicate matches, as one reset.
   *
   * Sources own id prefixes, so this is how a producer that has handed a
   * session over withdraws what it wrote. Without it, the items a transcript
   * poller ingested before a hook bridge came online stay in the view forever
   * beside the bridge's own — the same events under two ids.
   *
   * Returns false when nothing matched, so callers can skip the frame.
   */
  removeMatching(sessionId: string, matches: (id: string) => boolean): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    const doomed = [...session.items.keys()].filter(matches);
    if (doomed.length === 0) return false;
    const previousTodoProgress = clone(session.todoProgress);
    const seq = ++session.seq;
    for (const id of doomed) {
      session.items.delete(id);
      for (const key of session.appendOffsets.keys()) {
        if (key.startsWith(`${id}\u0000`)) session.appendOffsets.delete(key);
      }
      for (const key of session.appendSources.keys()) {
        if (key.startsWith(`${id}\u0000`)) session.appendSources.delete(key);
      }
    }
    const at = new Date(this.#now()).toISOString();
    const frame = this.#resetFrame(sessionId, session, seq, at, "provider-reset");
    this.#advanceTodoProgress(session, at);
    this.#record(session, frame);
    this.#publishTodoProgress(sessionId, previousTodoProgress, clone(session.todoProgress));
    for (const listener of [...session.listeners]) listener(clone(frame));
    return true;
  }

  clearSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const previousTodoProgress = clone(session.todoProgress);
    const listeners = [...session.listeners];
    const seq = ++session.seq;
    session.items.clear();
    session.appendOffsets.clear();
    session.appendSources.clear();
    session.truncated = false;
    session.todoSemantic = null;
    session.todoProgress = null;
    const frame = this.#resetFrame(
      sessionId,
      session,
      seq,
      new Date(this.#now()).toISOString(),
      "cleared",
    );
    this.#record(session, frame);
    this.#publishTodoProgress(sessionId, previousTodoProgress, null);
    for (const listener of listeners) listener(clone(frame));
    this.#sessions.delete(sessionId);
  }

  dispose(): void {
    for (const session of this.#sessions.values()) session.listeners.clear();
    this.#sessions.clear();
    this.#todoProgressListeners.clear();
  }

  #cursor(sessionId: string, seq: number): string {
    return encodeActivityCursor(this.streamEpoch, sessionId, seq);
  }

  #items(session: ActivitySession): ActivityItem[] {
    return [...session.items.values()]
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
      .map((item) => clone(item));
  }

  #currentTodo(session: ActivitySession): Extract<ActivityItem, { kind: "todo" }> | null {
    let current: Extract<ActivityItem, { kind: "todo" }> | null = null;
    for (const item of session.items.values()) {
      if (item.kind !== "todo") continue;
      if (current === null || item.seq >= current.seq) current = item;
    }
    return current && current.steps.length > 0 ? current : null;
  }

  #advanceTodoProgress(session: ActivitySession, observedAt: string): void {
    const current = this.#currentTodo(session);
    if (!current) {
      session.todoSemantic = null;
      session.todoProgress = null;
      return;
    }
    // IDs and provider statuses are the only semantic fields. Text and detail
    // may be rewritten without indicating progress and never cross this edge.
    const semantic = JSON.stringify(current.steps.map((step) => [step.id, step.status]));
    const live = current.steps.filter((step) => step.status !== "removed");
    const completed = live.filter((step) => step.status === "completed").length;
    const active = completed < live.length
      && live.some((step) => step.status === "in_progress");
    const transitioned = session.todoSemantic !== null && session.todoSemantic !== semantic;
    session.todoProgress = {
      completed,
      total: live.length,
      hasMoved: transitioned || (session.todoProgress?.hasMoved ?? false),
      lastTransitionAt: transitioned
        ? observedAt
        : session.todoProgress?.lastTransitionAt ?? null,
      active,
    };
    session.todoSemantic = semantic;
  }

  #publishTodoProgress(
    sessionId: string,
    previous: TodoProgress | null,
    next: TodoProgress | null,
  ): void {
    if (
      previous?.completed === next?.completed
      && previous?.total === next?.total
      && previous?.hasMoved === next?.hasMoved
      && previous?.lastTransitionAt === next?.lastTransitionAt
      && previous?.active === next?.active
    ) return;
    for (const listener of this.#todoProgressListeners) {
      this.#callTodoProgressListener(listener, sessionId, next);
    }
  }

  #callTodoProgressListener(
    listener: TodoProgressListener,
    sessionId: string,
    progress: TodoProgress | null,
  ): void {
    try {
      listener(sessionId, clone(progress));
    } catch {
      // Metadata observers cannot interrupt provider activity ingestion.
    }
  }

  #resetFrame(
    sessionId: string,
    session: ActivitySession,
    seq: number,
    at: string,
    reason: ActivityResetFrame["reason"],
  ): ActivityResetFrame {
    return {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      streamEpoch: this.streamEpoch,
      sessionId,
      provider: session.provider,
      seq,
      cursor: this.#cursor(sessionId, seq),
      at,
      type: "activity.reset",
      reason,
      items: this.#items(session),
      truncated: session.truncated,
    };
  }

  #record(session: ActivitySession, frame: ActivityFrame): void {
    const stored = clone(frame);
    const bytes = encodedBytes(stored);
    session.replay.push({ frame: stored, bytes, atMs: this.#now() });
    session.replayBytes += bytes;
    this.#pruneReplay(session);
  }

  #pruneReplay(session: ActivitySession): void {
    const cutoff = this.#now() - this.#limits.replayMaxAgeMs;
    while (
      session.replay.length > 0
      && (
        session.replay.length > this.#limits.replayMaxFrames
        || session.replayBytes > this.#limits.replayMaxBytes
        || session.replay[0]!.atMs < cutoff
      )
    ) {
      session.replayBytes -= session.replay.shift()!.bytes;
    }
  }

  #trimView(session: ActivitySession): boolean {
    let evicted = false;
    const viewBytes = (): number => encodedBytes([...session.items.values()]);
    while (
      session.items.size > this.#limits.maxItems
      || (session.items.size > 1 && viewBytes() > this.#limits.maxViewBytes)
    ) {
      const ordered = [...session.items.values()].sort((left, right) => {
        const leftActive = left.state === "running" || left.state === "waiting" ? 1 : 0;
        const rightActive = right.state === "running" || right.state === "waiting" ? 1 : 0;
        return leftActive - rightActive || left.seq - right.seq;
      });
      const oldest = ordered[0];
      if (!oldest) break;
      session.items.delete(oldest.id);
      for (const key of session.appendOffsets.keys()) {
        if (key.startsWith(`${oldest.id}\u0000`)) session.appendOffsets.delete(key);
      }
      for (const key of session.appendSources.keys()) {
        if (key.startsWith(`${oldest.id}\u0000`)) session.appendSources.delete(key);
      }
      evicted = true;
    }
    if (evicted || viewBytes() > this.#limits.maxViewBytes) session.truncated = true;
    return evicted;
  }

  #boundedText(value: string): { value: string; truncated: boolean } {
    const bounded = truncateUtf8(redactActivityText(value), this.#limits.maxFieldBytes);
    return {
      value: bounded.value,
      // Bound retained unredacted streaming state too. A very large secret can
      // redact to a tiny display value, but keeping it in memory indefinitely
      // would defeat the hub's memory limits.
      truncated: bounded.truncated
        || Buffer.byteLength(value, "utf8") > this.#limits.maxFieldBytes,
    };
  }

  #boundedJson(value: ActivityJsonValue | string | null | undefined): {
    value: ActivityJsonValue | string | null;
    truncated: boolean;
  } {
    if (value === undefined || value === null) return { value: null, truncated: false };
    if (typeof value === "string") return this.#boundedText(value);
    const redacted = redactActivityJson(value);
    if (encodedBytes(redacted) <= this.#limits.maxFieldBytes) {
      return { value: redacted, truncated: false };
    }
    const capped = this.#boundedText(JSON.stringify(redacted));
    return { value: capped.value, truncated: true };
  }

  #materialize(
    sessionId: string,
    provider: Provider,
    draft: ActivityItemDraft,
    existing: ActivityItem | undefined,
    seq: number,
    revision: number,
    at: string,
  ): ActivityItem {
    const previous = existing?.kind === draft.kind ? existing : undefined;
    const common = {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      id: redactActivityText(draft.id),
      sessionId,
      provider,
      turnId: draft.turnId === undefined ? previous?.turnId ?? null : draft.turnId,
      parentId: draft.parentId === undefined ? previous?.parentId ?? null : draft.parentId,
      seq,
      revision,
      state: draft.state ?? previous?.state ?? "pending",
      startedAt: draft.startedAt === undefined ? previous?.startedAt ?? null : draft.startedAt,
      updatedAt: draft.updatedAt === undefined ? at : draft.updatedAt,
      completedAt: draft.completedAt === undefined ? previous?.completedAt ?? null : draft.completedAt,
      source: draft.source ?? previous?.source ?? "provider-api",
      confidence: draft.confidence ?? previous?.confidence ?? "exact",
      exposure: draft.exposure ?? previous?.exposure ?? "provider-exposed",
    } as const;
    let truncated = draft.truncated ?? previous?.truncated ?? false;
    const text = (value: string): string => {
      const bounded = this.#boundedText(value);
      truncated ||= bounded.truncated;
      return bounded.value;
    };

    switch (draft.kind) {
      case "message": {
        const old = previous?.kind === "message" ? previous : undefined;
        return { ...common, kind: "message", role: draft.role, phase: draft.phase ?? old?.phase ?? null, text: text(draft.text ?? old?.text ?? ""), label: draft.label === undefined ? old?.label ?? null : draft.label === null ? null : text(draft.label), truncated };
      }
      case "reasoning": {
        const old = previous?.kind === "reasoning" ? previous : undefined;
        return { ...common, kind: "reasoning", reasoningKind: draft.reasoningKind, label: draft.label === undefined ? old?.label ?? null : draft.label === null ? null : text(draft.label), text: text(draft.text ?? old?.text ?? ""), truncated };
      }
      case "plan": {
        const old = previous?.kind === "plan" ? previous : undefined;
        return {
          ...common,
          kind: "plan",
          path: draft.path === undefined ? old?.path ?? null : draft.path === null ? null : text(draft.path),
          version: draft.version === undefined ? old?.version ?? null : positiveIntegerOrNull(draft.version),
          markdown: text(draft.markdown ?? old?.markdown ?? ""),
          supersededBy: draft.supersededBy === undefined ? old?.supersededBy ?? null : draft.supersededBy === null ? null : text(draft.supersededBy),
          approvalRequestId: draft.approvalRequestId === undefined ? old?.approvalRequestId ?? null : draft.approvalRequestId === null ? null : text(draft.approvalRequestId),
          approvedAt: draft.approvedAt === undefined ? old?.approvedAt ?? null : draft.approvedAt === null ? null : text(draft.approvedAt),
          truncated,
        };
      }
      case "todo": {
        const old = previous?.kind === "todo" ? previous : undefined;
        const steps = (draft.steps ?? old?.steps ?? []).map((step) => ({
          id: text(step.id),
          text: text(step.text),
          status: step.status,
          detail: step.detail === null ? null : text(step.detail),
          addedAfterStart: step.addedAfterStart,
          removedReason: step.removedReason === null ? null : text(step.removedReason),
        }));
        return {
          ...common,
          kind: "todo",
          steps,
          added: nonnegativeInteger(draft.added, old?.added ?? 0),
          removed: nonnegativeInteger(draft.removed, old?.removed ?? 0),
          truncated,
        };
      }
      case "tool": {
        const old = previous?.kind === "tool" ? previous : undefined;
        const args = this.#boundedJson(draft.arguments === undefined ? old?.arguments : draft.arguments);
        const result = this.#boundedJson(draft.result === undefined ? old?.result : draft.result);
        truncated ||= args.truncated || result.truncated;
        return { ...common, kind: "tool", toolCallId: text(draft.toolCallId), name: text(draft.name), category: draft.category ?? old?.category ?? "other", arguments: args.value, result: result.value, output: text(draft.output ?? old?.output ?? ""), truncated };
      }
      case "file-change": {
        const old = previous?.kind === "file-change" ? previous : undefined;
        const changes = (draft.changes ?? old?.changes ?? []).map((change) => ({
          path: text(change.path),
          previousPath: change.previousPath === null ? null : text(change.previousPath),
          operation: change.operation,
          diff: text(change.diff),
        }));
        return { ...common, kind: "file-change", summary: text(draft.summary ?? old?.summary ?? "File changes"), changes, truncated };
      }
      case "subagent": {
        const old = previous?.kind === "subagent" ? previous : undefined;
        return { ...common, kind: "subagent", taskId: text(draft.taskId), name: text(draft.name), description: draft.description === undefined ? old?.description ?? null : draft.description === null ? null : text(draft.description), output: text(draft.output ?? old?.output ?? ""), childItemIds: [...(draft.childItemIds ?? old?.childItemIds ?? [])].map(text), truncated };
      }
      case "attention": {
        const old = previous?.kind === "attention" ? previous : undefined;
        const questions = (draft.questions ?? old?.questions ?? []).map((question) => ({ id: text(question.id), ...(question.header === undefined ? {} : { header: text(question.header) }), text: text(question.text), options: question.options.map((option) => ({ label: text(option.label), description: option.description === null ? null : text(option.description), recommended: option.recommended === true ? true : option.recommended === false ? false : null })), multiSelect: question.multiSelect, allowFreeText: question.allowFreeText, isSecret: question.isSecret }));
        const rawApprovalFacts = draft.approvalFacts === undefined
          ? old?.approvalFacts ?? null
          : draft.approvalFacts;
        const approvalFacts = rawApprovalFacts === null ? null : {
          command: rawApprovalFacts.command === null ? null : text(rawApprovalFacts.command),
          paths: rawApprovalFacts.paths === null
            ? null
            : rawApprovalFacts.paths.map(text),
          writes: rawApprovalFacts.writes.map(text),
          network: rawApprovalFacts.network,
          canPersist: rawApprovalFacts.canPersist,
          deleteCount: nonnegativeIntegerOrNull(rawApprovalFacts.deleteCount),
        };
        return { ...common, kind: "attention", requestId: text(draft.requestId), attentionKind: draft.attentionKind, title: draft.title === undefined ? old?.title ?? null : draft.title === null ? null : text(draft.title), summary: draft.summary === undefined ? old?.summary ?? null : draft.summary === null ? null : text(draft.summary), questions, approvalFacts, respondable: draft.respondable ?? old?.respondable ?? false, resolved: draft.resolved ?? old?.resolved ?? false, isSecret: draft.isSecret ?? old?.isSecret ?? questions.some((question) => question.isSecret), truncated };
      }
      case "queue": {
        const old = previous?.kind === "queue" ? previous : undefined;
        const messages = (draft.messages ?? old?.messages ?? []).map((message) => ({ ...message, id: text(message.id), text: text(message.text), enqueuedAt: text(message.enqueuedAt), turnId: message.turnId === null ? null : text(message.turnId) }));
        return { ...common, kind: "queue", messages, truncated };
      }
      case "lifecycle": {
        const old = previous?.kind === "lifecycle" ? previous : undefined;
        return { ...common, kind: "lifecycle", event: draft.event, level: draft.level ?? old?.level ?? "info", title: text(draft.title), details: draft.details === undefined ? old?.details ?? null : draft.details === null ? null : text(draft.details), truncated };
      }
      case "usage":
        return { ...common, kind: "usage", scope: draft.scope, inputTokens: finite(draft.inputTokens), outputTokens: finite(draft.outputTokens), cachedInputTokens: finite(draft.cachedInputTokens), reasoningTokens: finite(draft.reasoningTokens), totalTokens: finite(draft.totalTokens), costUsd: finite(draft.costUsd), contextWindow: finite(draft.contextWindow), truncated };
    }
  }

  #appendToItem(
    session: ActivitySession,
    key: string,
    item: ActivityItem,
    channel: ActivityAppendChannel,
    rawDelta: string,
    at: string,
  ): {
    item: ActivityItem;
    delta: string;
    truncated: boolean;
    replacement: boolean;
  } | null {
    const source = session.appendSources.get(key) ?? this.#appendSourceState("");
    const combined = source.saturated
      ? source
      : this.#appendSourceDelta(source, rawDelta);
    session.appendSources.set(key, combined);

    const current = this.#channelValue(item, channel);
    if (current === null) return null;
    const rendered = source.saturated
      ? { value: current, truncated: true }
      : truncateUtf8(redactActivityText(combined.raw), this.#limits.maxFieldBytes);
    const wasTruncated = source.saturated || combined.saturated || rendered.truncated;
    const replacement = !rendered.value.startsWith(current);
    const delta = replacement ? "" : rendered.value.slice(current.length);

    let next: ActivityItem | null = null;
    if (channel === "text" && (item.kind === "message" || item.kind === "reasoning")) {
      next = { ...item, text: rendered.value };
    } else if (channel === "markdown" && item.kind === "plan") {
      next = { ...item, markdown: rendered.value };
    } else if (channel === "arguments" && item.kind === "tool") {
      next = { ...item, arguments: rendered.value };
    } else if (channel === "result" && item.kind === "tool") {
      next = { ...item, result: rendered.value };
    } else if (channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
      next = { ...item, output: rendered.value };
    } else if (channel === "details" && item.kind === "lifecycle") {
      next = { ...item, details: rendered.value };
    } else if (channel === "diff" && item.kind === "file-change") {
      const changes = [...item.changes];
      const index = Math.max(0, changes.length - 1);
      const current = changes[index] ?? { path: "", previousPath: null, operation: "update" as const, diff: "" };
      changes[index] = { ...current, diff: rendered.value };
      next = { ...item, changes };
    }
    if (!next) return null;
    next = {
      ...next,
      revision: item.revision + 1,
      updatedAt: at,
      truncated: item.truncated || wasTruncated,
    };
    return { item: next, delta, truncated: wasTruncated, replacement };
  }

  #appendSourceState(raw: string): AppendSourceState {
    const bounded = truncateUtf8(raw, this.#limits.maxFieldBytes);
    return { raw: bounded.value, saturated: bounded.truncated };
  }

  #appendSourceDelta(source: AppendSourceState, delta: string): AppendSourceState {
    const remaining = Math.max(
      0,
      this.#limits.maxFieldBytes - Buffer.byteLength(source.raw, "utf8"),
    );
    const boundedDelta = truncateUtf8(delta, remaining);
    return {
      raw: source.raw + boundedDelta.value,
      saturated: boundedDelta.truncated,
    };
  }

  #channelValue(item: ActivityItem, channel: ActivityAppendChannel): string | null {
    if (channel === "text" && (item.kind === "message" || item.kind === "reasoning")) {
      return item.text;
    }
    if (channel === "markdown" && item.kind === "plan") return item.markdown;
    if (channel === "arguments" && item.kind === "tool") {
      return typeof item.arguments === "string"
        ? item.arguments
        : item.arguments === null ? "" : JSON.stringify(item.arguments);
    }
    if (channel === "result" && item.kind === "tool") {
      return typeof item.result === "string"
        ? item.result
        : item.result === null ? "" : JSON.stringify(item.result);
    }
    if (channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
      return item.output;
    }
    if (channel === "details" && item.kind === "lifecycle") {
      return item.details ?? "";
    }
    if (channel === "diff" && item.kind === "file-change") {
      return item.changes.at(-1)?.diff ?? "";
    }
    return null;
  }

  #displayOffset(item: ActivityItem, channel: ActivityAppendChannel): number | null {
    let value: string | null = null;
    if (channel === "text" && (item.kind === "message" || item.kind === "reasoning")) {
      value = item.text;
    } else if (channel === "markdown" && item.kind === "plan") {
      value = item.markdown;
    } else if (channel === "arguments" && item.kind === "tool") {
      value = typeof item.arguments === "string"
        ? item.arguments
        : item.arguments === null ? "" : JSON.stringify(item.arguments);
    } else if (channel === "result" && item.kind === "tool") {
      value = typeof item.result === "string"
        ? item.result
        : item.result === null ? "" : JSON.stringify(item.result);
    } else if (channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
      value = item.output;
    } else if (channel === "details" && item.kind === "lifecycle") {
      value = item.details ?? "";
    } else if (channel === "diff" && item.kind === "file-change") {
      value = item.changes.at(-1)?.diff ?? "";
    }
    return value === null ? null : Buffer.byteLength(value, "utf8");
  }

  #syncAppendOffsets(
    session: ActivitySession,
    item: ActivityItem,
    draft: ActivityItemDraft,
    replace: boolean,
  ): void {
    if (replace) {
      for (const key of session.appendOffsets.keys()) {
        if (key.startsWith(`${item.id}\u0000`)) session.appendOffsets.delete(key);
      }
      for (const key of session.appendSources.keys()) {
        if (key.startsWith(`${item.id}\u0000`)) session.appendSources.delete(key);
      }
    }
    const set = (channel: ActivityAppendChannel, displayValue: string, sourceValue?: string): void => {
      const key = appendKey(item.id, channel);
      if (!replace && sourceValue === undefined && session.appendOffsets.has(key)) return;
      const source = sourceValue ?? displayValue;
      session.appendOffsets.set(
        key,
        Buffer.byteLength(source, "utf8"),
      );
      session.appendSources.set(key, this.#appendSourceState(source));
    };
    const serialized = (value: ActivityJsonValue | string | null): string =>
      typeof value === "string" ? value : value === null ? "" : JSON.stringify(value);
    if (
      (item.kind === "message" || item.kind === "reasoning")
      && (draft.kind === "message" || draft.kind === "reasoning")
    ) {
      set("text", item.text, draft.text);
    }
    if (item.kind === "plan" && draft.kind === "plan") {
      set("markdown", item.markdown, draft.markdown);
    }
    if (item.kind === "tool" && draft.kind === "tool") {
      set(
        "arguments",
        serialized(item.arguments),
        draft.arguments === undefined ? undefined : serialized(draft.arguments),
      );
      set(
        "result",
        serialized(item.result),
        draft.result === undefined ? undefined : serialized(draft.result),
      );
      set("output", item.output, draft.output);
    }
    if (item.kind === "subagent" && draft.kind === "subagent") {
      set("output", item.output, draft.output);
    }
    if (item.kind === "lifecycle" && draft.kind === "lifecycle") {
      set("details", item.details ?? "", draft.details === undefined ? undefined : draft.details ?? "");
    }
    if (item.kind === "file-change" && draft.kind === "file-change") {
      set("diff", item.changes.at(-1)?.diff ?? "", draft.changes?.at(-1)?.diff);
    }
  }
}

function appendKey(id: string, channel: ActivityAppendChannel): string {
  return `${id}\u0000${channel}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
