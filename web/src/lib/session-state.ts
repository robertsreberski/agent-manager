import { normalizeSession, normalizeSnapshot } from "./normalize";
import type { CockpitEvent } from "./sse";
import type { SessionView, SessionsSnapshot } from "../types";

export interface SessionStateRequest {
  readonly epoch: number;
  readonly ordinal: number;
}

interface SessionVersion {
  epoch: number;
  generation: number;
  seq: number | null;
  tombstone: boolean;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function eventSession(value: unknown): SessionView {
  const payload = payloadRecord(value);
  return normalizeSession(payload.session ?? value);
}

function removedSessionId(value: unknown): string | null {
  const payload = payloadRecord(value);
  return typeof payload.id === "string"
    ? payload.id
    : typeof payload.sessionId === "string"
      ? payload.sessionId
      : typeof value === "string"
        ? value
        : null;
}

export function mergeSession(list: SessionView[], incoming: SessionView): SessionView[] {
  const existing = list.find((session) => session.id === incoming.id);
  const retainedTranscript = existing?.transcript ?? incoming.transcript;
  const merged = existing && (incoming.transcript?.state ?? "not-loaded") === "not-loaded"
    ? {
        ...incoming,
        messages: existing.messages,
        ...(retainedTranscript ? { transcript: retainedTranscript } : {}),
      }
    : incoming;
  return [...list.filter((session) => session.id !== incoming.id), merged];
}

/**
 * Orders the browser's three state sources: SSE, collection REST snapshots,
 * and per-session REST details. SSE is authoritative. REST responses are
 * merged only for sessions that have not changed since the request began.
 */
export class SessionStateGuard {
  #epoch = 0;
  #lastSeq = -1;
  #requestOrdinal = 0;
  #versions = new Map<string, SessionVersion>();
  #lastDetailOrdinal = new Map<string, number>();

  beginRequest(): SessionStateRequest {
    return { epoch: this.#epoch, ordinal: ++this.#requestOrdinal };
  }

  applyEvent(
    current: SessionsSnapshot,
    event: CockpitEvent,
  ): { accepted: boolean; snapshot: SessionsSnapshot } {
    if (event.seq !== null && event.seq <= this.#lastSeq) {
      return { accepted: false, snapshot: current };
    }
    const epoch = ++this.#epoch;
    if (event.seq !== null) this.#lastSeq = event.seq;

    switch (event.type) {
      case "snapshot": {
        const incoming = normalizeSnapshot(event.payload);
        const seq = event.seq ?? incoming.seq;
        const incomingIds = new Set(incoming.sessions.map((session) => session.id));
        for (const [id, version] of this.#versions) {
          if (!incomingIds.has(id) && version.tombstone) {
            this.#versions.set(id, { ...version, epoch, seq });
          }
        }
        for (const previous of current.sessions) {
          if (!incomingIds.has(previous.id)) {
            this.#versions.set(previous.id, {
              epoch,
              generation: previous.generation,
              seq,
              tombstone: true,
            });
          }
        }
        const sessions = incoming.sessions.map((session) =>
          current.sessions.some((previous) => previous.id === session.id)
            ? mergeSession(current.sessions, session).find((item) => item.id === session.id)!
            : session
        );
        for (const session of incoming.sessions) {
          this.#versions.set(session.id, {
            epoch,
            generation: session.generation,
            seq,
            tombstone: false,
          });
        }
        return {
          accepted: true,
          snapshot: { ...incoming, sessions, seq: seq ?? incoming.seq },
        };
      }
      case "session.upsert": {
        const incoming = eventSession(event.payload);
        this.#versions.set(incoming.id, {
          epoch,
          generation: incoming.generation,
          seq: event.seq,
          tombstone: false,
        });
        return {
          accepted: true,
          snapshot: {
            ...current,
            seq: event.seq ?? current.seq,
            sessions: mergeSession(current.sessions, incoming),
          },
        };
      }
      case "session.remove": {
        const id = removedSessionId(event.payload);
        if (!id) return { accepted: true, snapshot: current };
        const previous = current.sessions.find((session) => session.id === id);
        this.#versions.set(id, {
          epoch,
          generation: previous?.generation ?? this.#versions.get(id)?.generation ?? 0,
          seq: event.seq,
          tombstone: true,
        });
        return {
          accepted: true,
          snapshot: {
            ...current,
            seq: event.seq ?? current.seq,
            sessions: current.sessions.filter((session) => session.id !== id),
          },
        };
      }
      case "diagnostic": {
        const payload = payloadRecord(event.payload);
        if (Array.isArray(payload.diagnostics) || typeof payload.stale === "boolean") {
          const normalized = normalizeSnapshot({
            diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics : [],
            stale: typeof payload.stale === "boolean" ? payload.stale : false,
          });
          return {
            accepted: true,
            snapshot: {
              ...current,
              seq: event.seq ?? current.seq,
              ...(Array.isArray(payload.diagnostics)
                ? { diagnostics: normalized.diagnostics }
                : {}),
              ...(typeof payload.stale === "boolean"
                ? { stale: payload.stale }
                : {}),
            },
          };
        }
        return { accepted: true, snapshot: { ...current, seq: event.seq ?? current.seq } };
      }
      case "action.updated":
        return { accepted: true, snapshot: { ...current, seq: event.seq ?? current.seq } };
    }
  }

  applyRestSnapshot(
    current: SessionsSnapshot,
    incoming: SessionsSnapshot,
    request: SessionStateRequest,
  ): SessionsSnapshot {
    const responseEpoch = ++this.#epoch;
    const incomingById = new Map(incoming.sessions.map((session) => [session.id, session]));
    const currentById = new Map(current.sessions.map((session) => [session.id, session]));
    const ids = new Set([...currentById.keys(), ...incomingById.keys()]);
    const sessions: SessionView[] = [];

    for (const id of ids) {
      const previous = currentById.get(id);
      const candidate = incomingById.get(id);
      const version = this.#versions.get(id);
      const changedAfterRequest = version !== undefined && version.epoch > request.epoch;
      const responsePredatesVersion = incoming.seq !== null && version?.seq !== null &&
        version?.seq !== undefined && incoming.seq < version.seq;

      if (changedAfterRequest || responsePredatesVersion) {
        if (previous) sessions.push(previous);
        continue;
      }

      if (!candidate) {
        if (previous) {
          this.#versions.set(id, {
            epoch: responseEpoch,
            generation: previous.generation,
            seq: incoming.seq,
            tombstone: true,
          });
        }
        continue;
      }

      if (version?.tombstone) {
        const isConfirmedRecreation = incoming.seq !== null && version.seq !== null &&
          incoming.seq > version.seq && candidate.generation > version.generation;
        if (!isConfirmedRecreation) continue;
      }
      if (previous && candidate.generation < previous.generation) {
        sessions.push(previous);
        continue;
      }

      const merged = previous
        ? mergeSession([previous], candidate)[0]!
        : candidate;
      sessions.push(merged);
      this.#versions.set(id, {
        epoch: responseEpoch,
        generation: merged.generation,
        seq: incoming.seq,
        tombstone: false,
      });
    }

    if (incoming.seq !== null && incoming.seq > this.#lastSeq) this.#lastSeq = incoming.seq;
    const globalStateIsCurrent = request.epoch === responseEpoch - 1 ||
      (incoming.seq !== null && incoming.seq >= this.#lastSeq);
    const sequences = [current.seq, incoming.seq].filter(
      (value): value is number => value !== null,
    );
    return {
      sessions,
      diagnostics: globalStateIsCurrent ? incoming.diagnostics : current.diagnostics,
      generatedAt: globalStateIsCurrent ? incoming.generatedAt : current.generatedAt,
      seq: sequences.length > 0 ? Math.max(...sequences) : null,
      stale: globalStateIsCurrent ? incoming.stale : current.stale,
    };
  }

  applyRestSession(
    current: SessionsSnapshot,
    incoming: SessionView,
    request: SessionStateRequest,
  ): SessionsSnapshot {
    const version = this.#versions.get(incoming.id);
    const previous = current.sessions.find((session) => session.id === incoming.id);
    const newerDetailOrdinal = this.#lastDetailOrdinal.get(incoming.id);
    if (version?.tombstone ||
        (newerDetailOrdinal !== undefined && newerDetailOrdinal > request.ordinal)) {
      return current;
    }

    // A detail response owns only transcript fields. An SSE upsert may have
    // advanced activity, controls, or generation while this request was in
    // flight; keep that authoritative live state and still accept the fetched
    // transcript. Transcript-free detail responses do not erase prior detail.
    const detailTranscript = incoming.transcript;
    if (previous && (detailTranscript?.state ?? "not-loaded") === "not-loaded") return current;

    const epoch = ++this.#epoch;
    this.#lastDetailOrdinal.set(incoming.id, request.ordinal);
    const merged = previous
      ? {
          ...previous,
          messages: incoming.messages,
          ...(detailTranscript ? { transcript: detailTranscript } : {}),
        }
      : incoming;
    this.#versions.set(incoming.id, {
      epoch,
      generation: merged.generation,
      seq: version?.seq ?? current.seq,
      tombstone: false,
    });
    return {
      ...current,
      sessions: [...current.sessions.filter((session) => session.id !== incoming.id), merged],
    };
  }

  applyLocalSession(current: SessionsSnapshot, incoming: SessionView): SessionsSnapshot {
    const epoch = ++this.#epoch;
    this.#versions.set(incoming.id, {
      epoch,
      generation: incoming.generation,
      seq: this.#versions.get(incoming.id)?.seq ?? current.seq,
      tombstone: false,
    });
    return { ...current, sessions: mergeSession(current.sessions, incoming) };
  }
}
