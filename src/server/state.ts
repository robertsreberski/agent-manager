import type {
  Diagnostic,
  SessionAttention,
  SessionRecord,
  SessionView,
  TodoProgress,
} from "../shared/session.ts";
import {
  parseStateEvent,
  parseSessionRecord,
  AGENT_MANAGER_BUILD_ID,
  WIRE_SCHEMA_VERSION,
  type StateEvent,
  type StateEventType,
  type WireActionUpdate,
  type WireStateSnapshot,
} from "../shared/wire.ts";

type StateListener = (event: StateEvent) => void;
type EventOf<T extends StateEventType> = Extract<StateEvent, { type: T }>;
type EventPayload<T extends StateEventType> = EventOf<T>["payload"];

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Strip selected-session content before a record enters global state/SSE. */
function metadataOnly(record: SessionRecord): SessionRecord {
  const copy = clone(record);
  copy.attention = copy.attention.map((attention): SessionAttention => ({
    id: attention.id,
    kind: attention.kind,
    summary: null,
    source: attention.source,
    confidence: attention.confidence,
    details: attention.details === null
      ? null
      : {
          title: null,
          questions: null,
          toolName: null,
          inputSummary: null,
          respondable: attention.details.respondable,
        },
  }));
  return copy;
}

function comparableSession(record: SessionRecord): string {
  return JSON.stringify({ ...record, generation: 0 });
}

function normalizeTodoProgress(progress: TodoProgress | null): TodoProgress | null {
  if (progress === null) return null;
  const keys = Object.keys(progress).sort();
  const expectedKeys = ["active", "completed", "hasMoved", "lastTransitionAt", "total"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new RangeError("todo progress must contain only the exact metadata fields");
  }
  if (
    !Number.isSafeInteger(progress.completed)
    || progress.completed < 0
    || !Number.isSafeInteger(progress.total)
    || progress.total < 0
    || progress.completed > progress.total
  ) throw new RangeError("todo progress must be nonnegative and completed cannot exceed total");
  if (typeof progress.hasMoved !== "boolean" || typeof progress.active !== "boolean") {
    throw new RangeError("todo movement metadata must be boolean");
  }
  if (
    progress.lastTransitionAt !== null
    && (
      typeof progress.lastTransitionAt !== "string"
      || !Number.isFinite(Date.parse(progress.lastTransitionAt))
    )
  ) throw new RangeError("last todo transition must be a timestamp or null");
  if (progress.hasMoved !== (progress.lastTransitionAt !== null)) {
    throw new RangeError("todo movement and transition timestamp must agree");
  }
  if (progress.active && progress.completed >= progress.total) {
    throw new RangeError("completed todo progress cannot be active");
  }
  return {
    completed: progress.completed,
    total: progress.total,
    hasMoved: progress.hasMoved,
    lastTransitionAt: progress.lastTransitionAt,
    active: progress.active,
  };
}

function sameTodoProgress(left: TodoProgress | null, right: TodoProgress | null): boolean {
  return left?.completed === right?.completed
    && left?.total === right?.total
    && left?.hasMoved === right?.hasMoved
    && left?.lastTransitionAt === right?.lastTransitionAt
    && left?.active === right?.active;
}

export class EventReplayRing {
  readonly capacity: number;
  #events: StateEvent[] = [];
  #seq = 0;
  #now: () => number;

  constructor(capacity = 512, now: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("event replay capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.#now = now;
  }

  get sequence(): number {
    return this.#seq;
  }

  append<T extends StateEventType>(type: T, payload: EventPayload<T>): EventOf<T> {
    const event = parseStateEvent({
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      seq: ++this.#seq,
      at: new Date(this.#now()).toISOString(),
      type,
      payload: clone(payload),
    }) as EventOf<T>;
    this.#events.push(event);
    if (this.#events.length > this.capacity) this.#events.shift();
    return clone(event);
  }

  replayAfter(afterSequence: number): { events: StateEvent[]; gap: boolean } {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return { events: [], gap: true };
    }
    const oldest = this.#events[0]?.seq ?? this.#seq + 1;
    const gap = afterSequence < oldest - 1 || afterSequence > this.#seq;
    return {
      events: gap
        ? []
        : this.#events
          .filter((event) => event.seq > afterSequence)
          .map((event) => clone(event)),
      gap,
    };
  }
}

export class SessionStateStore {
  readonly events: EventReplayRing;
  #sessions = new Map<string, SessionRecord>();
  #discoveryDiagnostics: Diagnostic[] = [];
  #persistentDiagnostics: Diagnostic[] = [];
  #listeners = new Set<StateListener>();
  #todoProgressOverrides = new Map<string, TodoProgress | null>();
  #nextGeneration = 0;
  #stale = false;
  #now: () => number;

  constructor(options: { replayCapacity?: number; now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.events = new EventReplayRing(options.replayCapacity ?? 512, this.#now);
  }

  list(): SessionView[] {
    return [...this.#sessions.values()].map((session) => clone(session));
  }

  get(id: string): SessionView | null {
    const session = this.#sessions.get(id);
    return session ? clone(session) : null;
  }

  snapshot(): WireStateSnapshot {
    return {
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      generatedAt: new Date(this.#now()).toISOString(),
      seq: this.events.sequence,
      stale: this.#stale,
      sessions: this.list(),
      diagnostics: clone(this.#diagnostics()),
    };
  }

  replace(records: readonly SessionRecord[], diagnostics: readonly Diagnostic[] = []): void {
    const incomingIds = new Set<string>();
    for (const rawRecord of records) {
      const record = parseSessionRecord(rawRecord);
      const id = record.id;
      incomingIds.add(id);
      const previous = this.#sessions.get(id);
      const metadata = metadataOnly(record);
      const candidate: SessionRecord = {
        ...metadata,
        profile: metadata.profile.value === null
          && metadata.profile.providerValue === null
          && metadata.profile.source === "inferred"
          && metadata.profile.confidence === "heuristic"
          && previous !== undefined
          && previous.profile.value !== null
          ? clone(previous.profile)
          : metadata.profile,
        todoProgress: this.#todoProgressOverrides.has(id)
          ? clone(this.#todoProgressOverrides.get(id) ?? null)
          : metadata.todoProgress,
        generation: previous?.generation ?? record.generation,
      };

      if (!previous || comparableSession(previous) !== comparableSession(candidate)) {
        candidate.generation = ++this.#nextGeneration;
        this.#sessions.set(id, candidate);
        this.#publish("session.upsert", candidate);
      }
    }

    for (const id of this.#sessions.keys()) {
      if (incomingIds.has(id)) continue;
      this.#todoProgressOverrides.delete(id);
      this.#sessions.delete(id);
      this.#publish("session.remove", { id });
    }

    const previousDiagnostics = this.#diagnostics();
    this.#discoveryDiagnostics = clone([...diagnostics]);
    const nextDiagnostics = this.#diagnostics();
    if (JSON.stringify(previousDiagnostics) !== JSON.stringify(nextDiagnostics)) {
      this.#publish("diagnostic", {
        stale: this.#stale,
        diagnostics: clone(nextDiagnostics),
      });
    }
  }

  upsert(record: SessionRecord): SessionView {
    const retained = [...this.#sessions.values()].filter((entry) => entry.id !== record.id);
    this.replace([...retained, record], this.#discoveryDiagnostics);
    const stored = this.get(record.id);
    if (!stored) throw new Error("session disappeared during upsert");
    return stored;
  }

  remove(id: string): boolean {
    const removed = this.#sessions.delete(id);
    this.#todoProgressOverrides.delete(id);
    if (!removed) return false;
    this.#publish("session.remove", { id });
    return true;
  }

  /** Applies ActivityHub's content-free projection without exposing todo text. */
  setTodoProgress(id: string, progress: TodoProgress | null): void {
    const normalized = normalizeTodoProgress(progress);
    this.#todoProgressOverrides.set(id, normalized);
    const previous = this.#sessions.get(id);
    if (!previous || sameTodoProgress(previous.todoProgress, normalized)) return;
    const candidate: SessionRecord = {
      ...previous,
      todoProgress: clone(normalized),
      generation: ++this.#nextGeneration,
    };
    this.#sessions.set(id, candidate);
    this.#publish("session.upsert", candidate);
  }

  publishAction(payload: WireActionUpdate): StateEvent {
    return this.#publish("action.updated", payload);
  }

  addDiagnostic(diagnostic: Diagnostic): void {
    if (this.#diagnostics().some((entry) =>
      entry.provider === diagnostic.provider
      && entry.level === diagnostic.level
      && entry.message === diagnostic.message
    )) return;
    this.#persistentDiagnostics = [
      ...this.#persistentDiagnostics.slice(-99),
      clone(diagnostic),
    ];
    this.#publish("diagnostic", {
      stale: this.#stale,
      diagnostics: clone(this.#diagnostics()),
    });
  }

  setStale(stale: boolean): void {
    if (this.#stale === stale) return;
    this.#stale = stale;
    this.#publish("diagnostic", {
      stale,
      diagnostics: clone(this.#diagnostics()),
    });
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #diagnostics(): Diagnostic[] {
    const unique = new Map<string, Diagnostic>();
    for (const diagnostic of [...this.#discoveryDiagnostics, ...this.#persistentDiagnostics]) {
      unique.set(
        `${diagnostic.provider}\u0000${diagnostic.level}\u0000${diagnostic.message}`,
        diagnostic,
      );
    }
    return [...unique.values()];
  }

  #publish<T extends StateEventType>(type: T, payload: EventPayload<T>): EventOf<T> {
    const event = this.events.append(type, payload);
    for (const listener of this.#listeners) {
      try {
        listener(clone(event));
      } catch {
        // A disconnected observer must never break provider state updates.
      }
    }
    return event;
  }
}
