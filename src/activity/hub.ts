import { randomUUID } from "node:crypto";

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
  truncated: boolean;
}

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

function parseCursor(cursor: string, epoch: string): number | null {
  const separator = cursor.lastIndexOf(":");
  if (separator <= 0 || cursor.slice(0, separator) !== epoch) return null;
  const sequence = Number(cursor.slice(separator + 1));
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

export class ActivityHub {
  readonly streamEpoch: string;
  readonly #limits: ActivityHubLimits;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ActivitySession>();

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
      truncated: false,
    });
  }

  ingest(sessionId: string, provider: Provider, mutation: ActivityMutation): ActivityFrame {
    this.ensureSession(sessionId, provider);
    const session = this.#sessions.get(sessionId)!;
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
        this.#syncAppendOffsets(session, item);
        const evicted = this.#trimView(session);
        frame = evicted
          ? this.#resetFrame(sessionId, session, seq, at, "truncation")
          : {
              schemaVersion: ACTIVITY_SCHEMA_VERSION,
              streamEpoch: this.streamEpoch,
              sessionId,
              provider,
              seq,
              cursor: this.#cursor(seq),
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
        session.appendOffsets.set(key, expected + rawBytes);
        const appended = this.#appendToItem(item, mutation.channel, mutation.text, at);
        if (!appended) {
          frame = this.#resetFrame(sessionId, session, seq, at, "replay-gap");
          break;
        }
        session.items.set(item.id, appended.item);
        const evicted = this.#trimView(session);
        frame = evicted
          ? this.#resetFrame(sessionId, session, seq, at, "truncation")
          : {
              schemaVersion: ACTIVITY_SCHEMA_VERSION,
              streamEpoch: this.streamEpoch,
              sessionId,
              provider,
              seq,
              cursor: this.#cursor(seq),
              at,
              type: "activity.append",
              id: item.id,
              revision: appended.item.revision,
              channel: mutation.channel,
              offset: mutation.offset,
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
        frame = {
          schemaVersion: ACTIVITY_SCHEMA_VERSION,
          streamEpoch: this.streamEpoch,
          sessionId,
          provider,
          seq,
          cursor: this.#cursor(seq),
          at,
          type: "activity.remove",
          id: mutation.id,
        };
        break;
      }
      case "reset": {
        session.items.clear();
        session.appendOffsets.clear();
        session.truncated = false;
        for (const draft of mutation.items ?? []) {
          const existing = session.items.get(draft.id);
          const item = this.#materialize(
            sessionId,
            provider,
            draft,
            existing,
            seq,
            (existing?.revision ?? 0) + 1,
            at,
          );
          session.items.set(item.id, item);
          this.#syncAppendOffsets(session, item);
        }
        this.#trimView(session);
        frame = this.#resetFrame(sessionId, session, seq, at, mutation.reason);
        break;
      }
    }

    this.#record(session, frame);
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
      cursor: this.#cursor(session.seq),
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
    const sequence = parseCursor(cursor, this.streamEpoch);
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
      cursor: frames.at(-1)?.cursor ?? this.#cursor(session.seq),
      frames,
    };
  }

  subscribe(sessionId: string, listener: ActivityListener): () => void {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`unknown activity session ${sessionId}`);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  clearSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const listeners = [...session.listeners];
    const seq = ++session.seq;
    session.items.clear();
    session.appendOffsets.clear();
    session.truncated = false;
    const frame = this.#resetFrame(
      sessionId,
      session,
      seq,
      new Date(this.#now()).toISOString(),
      "cleared",
    );
    this.#record(session, frame);
    for (const listener of listeners) listener(clone(frame));
    this.#sessions.delete(sessionId);
  }

  dispose(): void {
    for (const session of this.#sessions.values()) session.listeners.clear();
    this.#sessions.clear();
  }

  #cursor(seq: number): string {
    return `${this.streamEpoch}:${seq}`;
  }

  #items(session: ActivitySession): ActivityItem[] {
    return [...session.items.values()]
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
      .map((item) => clone(item));
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
      cursor: this.#cursor(seq),
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
      evicted = true;
    }
    if (evicted || viewBytes() > this.#limits.maxViewBytes) session.truncated = true;
    return evicted;
  }

  #boundedText(value: string): { value: string; truncated: boolean } {
    return truncateUtf8(redactActivityText(value), this.#limits.maxFieldBytes);
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
    let truncated = previous?.truncated ?? false;
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
        const steps = (draft.steps ?? old?.steps ?? []).map((step) => ({ id: text(step.id), text: text(step.text), status: step.status }));
        return { ...common, kind: "plan", text: text(draft.text ?? old?.text ?? ""), steps, truncated };
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
        const changes = (draft.changes ?? old?.changes ?? []).map((change) => ({ path: text(change.path), operation: change.operation, diff: text(change.diff) }));
        return { ...common, kind: "file-change", summary: text(draft.summary ?? old?.summary ?? "File changes"), changes, truncated };
      }
      case "subagent": {
        const old = previous?.kind === "subagent" ? previous : undefined;
        return { ...common, kind: "subagent", taskId: text(draft.taskId), name: text(draft.name), description: draft.description === undefined ? old?.description ?? null : draft.description === null ? null : text(draft.description), output: text(draft.output ?? old?.output ?? ""), childItemIds: [...(draft.childItemIds ?? old?.childItemIds ?? [])].map(text), truncated };
      }
      case "attention": {
        const old = previous?.kind === "attention" ? previous : undefined;
        const questions = (draft.questions ?? old?.questions ?? []).map((question) => ({ id: text(question.id), text: text(question.text), options: question.options.map((option) => ({ label: text(option.label), description: option.description === null ? null : text(option.description) })), multiSelect: question.multiSelect, allowFreeText: question.allowFreeText, isSecret: question.isSecret }));
        return { ...common, kind: "attention", requestId: text(draft.requestId), attentionKind: draft.attentionKind, title: draft.title === undefined ? old?.title ?? null : draft.title === null ? null : text(draft.title), summary: draft.summary === undefined ? old?.summary ?? null : draft.summary === null ? null : text(draft.summary), questions, respondable: draft.respondable ?? old?.respondable ?? false, resolved: draft.resolved ?? old?.resolved ?? false, isSecret: draft.isSecret ?? old?.isSecret ?? questions.some((question) => question.isSecret), truncated };
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
        return { ...common, kind: "usage", scope: draft.scope, inputTokens: finite(draft.inputTokens), outputTokens: finite(draft.outputTokens), cachedInputTokens: finite(draft.cachedInputTokens), reasoningTokens: finite(draft.reasoningTokens), totalTokens: finite(draft.totalTokens), costUsd: finite(draft.costUsd), truncated };
    }
  }

  #appendToItem(item: ActivityItem, channel: ActivityAppendChannel, rawDelta: string, at: string): {
    item: ActivityItem;
    delta: string;
    truncated: boolean;
  } | null {
    const delta = redactActivityText(rawDelta);
    const append = (current: string): { value: string; delta: string; truncated: boolean } => {
      const remaining = Math.max(0, this.#limits.maxFieldBytes - Buffer.byteLength(current, "utf8"));
      const bounded = truncateUtf8(delta, remaining);
      return { value: current + bounded.value, delta: bounded.value, truncated: bounded.truncated };
    };
    let next: ActivityItem | null = null;
    let emitted = { value: "", delta: "", truncated: false };
    if (channel === "text" && (item.kind === "message" || item.kind === "reasoning" || item.kind === "plan")) {
      emitted = append(item.text);
      next = { ...item, text: emitted.value };
    } else if (channel === "arguments" && item.kind === "tool") {
      emitted = append(typeof item.arguments === "string" ? item.arguments : item.arguments === null ? "" : JSON.stringify(item.arguments));
      next = { ...item, arguments: emitted.value };
    } else if (channel === "result" && item.kind === "tool") {
      emitted = append(typeof item.result === "string" ? item.result : item.result === null ? "" : JSON.stringify(item.result));
      next = { ...item, result: emitted.value };
    } else if (channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
      emitted = append(item.output);
      next = { ...item, output: emitted.value };
    } else if (channel === "details" && item.kind === "lifecycle") {
      emitted = append(item.details ?? "");
      next = { ...item, details: emitted.value };
    } else if (channel === "diff" && item.kind === "file-change") {
      const changes = [...item.changes];
      const index = Math.max(0, changes.length - 1);
      const current = changes[index] ?? { path: "", operation: "update" as const, diff: "" };
      emitted = append(current.diff);
      changes[index] = { ...current, diff: emitted.value };
      next = { ...item, changes };
    }
    if (!next) return null;
    next = { ...next, revision: item.revision + 1, updatedAt: at, truncated: item.truncated || emitted.truncated };
    return { item: next, delta: emitted.delta, truncated: emitted.truncated };
  }

  #syncAppendOffsets(session: ActivitySession, item: ActivityItem): void {
    const set = (channel: ActivityAppendChannel, value: string): void => {
      session.appendOffsets.set(appendKey(item.id, channel), Buffer.byteLength(value, "utf8"));
    };
    if (item.kind === "message" || item.kind === "reasoning" || item.kind === "plan") set("text", item.text);
    if (item.kind === "tool") {
      set("arguments", typeof item.arguments === "string" ? item.arguments : item.arguments === null ? "" : JSON.stringify(item.arguments));
      set("result", typeof item.result === "string" ? item.result : item.result === null ? "" : JSON.stringify(item.result));
      set("output", item.output);
    }
    if (item.kind === "subagent") set("output", item.output);
    if (item.kind === "lifecycle") set("details", item.details ?? "");
    if (item.kind === "file-change") set("diff", item.changes.at(-1)?.diff ?? "");
  }
}

function appendKey(id: string, channel: ActivityAppendChannel): string {
  return `${id}\u0000${channel}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
