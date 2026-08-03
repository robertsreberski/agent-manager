import type {
  Diagnostic,
  SessionAttention,
  SessionRecord,
  SessionView,
} from "../core/types.ts";
import type { StateEvent, StateEventType, StateSnapshot } from "./contracts.ts";

type StateListener = (event: StateEvent) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sessionId(record: SessionRecord | SessionView): string {
  return "id" in record && typeof record.id === "string"
    ? record.id
    : `${record.provider}:${record.sessionId}`;
}

function metadataOnly(record: SessionRecord | SessionView): SessionRecord | SessionView {
  const copy = clone(record);
  if ("messages" in copy) delete copy.messages;
  if ("transcript" in copy) delete copy.transcript;
  copy.attention = copy.attention.map((attention): SessionAttention => ({
    id: attention.id,
    kind: attention.kind,
    // Provider summaries can contain the exact question or command input.
    // The global collection and its replay ring carry metadata only; selected
    // clients hydrate exact request content from the activity stream.
    summary: null,
    source: attention.source,
    confidence: attention.confidence,
    ...(typeof attention.details?.respondable === "boolean"
      ? { details: { respondable: attention.details.respondable } }
      : {}),
  }));
  return copy;
}

function comparableSession(record: SessionView): string {
  const copy = clone(record);
  copy.generation = 0;
  // The lease broker owns this transient bit; provider reconciliation must not
  // repeatedly toggle it or advance the provider-state generation.
  copy.control.writableLease = false;
  return JSON.stringify(copy);
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

  append(type: StateEventType, payload: unknown): StateEvent {
    const event: StateEvent = {
      seq: ++this.#seq,
      at: new Date(this.#now()).toISOString(),
      type,
      payload: clone(payload),
    };
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
  #sessions = new Map<string, SessionView>();
  #discoveryDiagnostics: Diagnostic[] = [];
  #persistentDiagnostics: Diagnostic[] = [];
  #listeners = new Set<StateListener>();
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

  snapshot(): StateSnapshot {
    return {
      version: 2,
      generatedAt: new Date(this.#now()).toISOString(),
      seq: this.events.sequence,
      stale: this.#stale,
      sessions: this.list(),
      diagnostics: clone(this.#diagnostics()),
    };
  }

  replace(records: readonly (SessionRecord | SessionView)[], diagnostics: readonly Diagnostic[] = []): void {
    const incomingIds = new Set<string>();
    for (const record of records) {
      const id = sessionId(record);
      incomingIds.add(id);
      const previous = this.#sessions.get(id);
      const candidate: SessionView = {
        ...metadataOnly(record),
        id,
        generation: previous?.generation ?? record.generation,
        control: {
          ...clone(record.control),
          writableLease: previous?.control.writableLease ?? record.control.writableLease,
        },
      };

      if (!previous || comparableSession(previous) !== comparableSession(candidate)) {
        candidate.generation = ++this.#nextGeneration;
        this.#sessions.set(id, candidate);
        this.#publish("session.upsert", candidate);
      } else if (previous.control.writableLease !== candidate.control.writableLease) {
        this.#sessions.set(id, candidate);
        this.#publish("session.upsert", candidate);
      }
    }

    for (const id of this.#sessions.keys()) {
      if (incomingIds.has(id)) continue;
      this.#sessions.delete(id);
      this.#publish("session.remove", { id });
    }

    const previousDiagnostics = this.#diagnostics();
    this.#discoveryDiagnostics = clone([...diagnostics]);
    const nextDiagnostics = this.#diagnostics();
    if (JSON.stringify(previousDiagnostics) !== JSON.stringify(nextDiagnostics)) {
      this.#publish("diagnostic", { diagnostics: clone(nextDiagnostics) });
    }
  }

  upsert(record: SessionRecord | SessionView): SessionView {
    const retained = [...this.#sessions.values()].filter((entry) => entry.id !== sessionId(record));
    this.replace([...retained, record], this.#discoveryDiagnostics);
    const stored = this.get(sessionId(record));
    if (!stored) throw new Error("session disappeared during upsert");
    return stored;
  }

  setWritableLease(id: string, writableLease: boolean): SessionView | null {
    const current = this.#sessions.get(id);
    if (!current || current.control.writableLease === writableLease) return current ? clone(current) : null;
    const next: SessionView = {
      ...current,
      control: { ...current.control, writableLease },
    };
    this.#sessions.set(id, next);
    this.#publish("session.upsert", next);
    return clone(next);
  }

  publishAction(payload: unknown): StateEvent {
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
    this.#publish("diagnostic", { diagnostics: clone(this.#diagnostics()) });
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
        `${diagnostic.provider ?? ""}\u0000${diagnostic.level}\u0000${diagnostic.message}`,
        diagnostic,
      );
    }
    return [...unique.values()];
  }

  #publish(type: StateEventType, payload: unknown): StateEvent {
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
