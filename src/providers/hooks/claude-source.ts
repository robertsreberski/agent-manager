import type { ClaudeHookInput } from "./claude-types.ts";

export const CLAUDE_MANAGER_OWNER_ENV = "AGENT_MANAGER_SESSION_OWNER";
export const CLAUDE_MANAGER_OWNER_VALUE = "manager";

export type ClaudeHookSourceDecision =
  | { accepted: true; suppressTranscriptPolling: true }
  | { accepted: false; reason: "manager-owned" | "ownership-conflict" };

export interface ClaudeHookOwnershipConflict {
  sessionId: string;
}

/**
 * One source wins at a time. Manager-owned SDK sessions reject global hooks;
 * an external session that has produced a hook event is owned by the bridge for
 * the rest of its life.
 *
 * Ownership used to lapse after a 30s hook silence, which any single long tool
 * call produced. Polling then resumed alongside the live bridge, and because
 * the two sources id the same tool call differently (`transcript:claude:tool:…`
 * against `claude-hook:<sid>:tool:…`) the hub — which dedupes by id — held both.
 * Every message, thought and tool call in the transcript appeared a second
 * time. Liveness is still tracked, for callers that report it; it just no
 * longer hands the same session to two producers.
 */
export class ClaudeHookSourceArbiter {
  readonly #managerOwned = new Set<string>();
  readonly #lastHookAt = new Map<string, number>();
  readonly #adoptionReservations = new Map<
    string,
    Map<symbol, () => void>
  >();
  readonly #ownershipConflictListeners = new Set<
    (conflict: ClaudeHookOwnershipConflict) => void
  >();

  onOwnershipConflict(
    listener: (conflict: ClaudeHookOwnershipConflict) => void,
  ): () => void {
    this.#ownershipConflictListeners.add(listener);
    return () => this.#ownershipConflictListeners.delete(listener);
  }

  /**
   * Watches a provisional SDK adoption without claiming source authority. A
   * markerless native hook remains accepted and synchronously cancels the
   * reservation; manager-origin hooks from the provisional SDK are still
   * duplicate-source no-ops. The returned release is idempotent.
   */
  reserveManagerAdoption(
    sessionId: string,
    onConflict: () => void,
  ): () => void {
    const token = Symbol(sessionId);
    const reservations = this.#adoptionReservations.get(sessionId)
      ?? new Map<symbol, () => void>();
    reservations.set(token, onConflict);
    this.#adoptionReservations.set(sessionId, reservations);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#adoptionReservations.get(sessionId);
      current?.delete(token);
      if (current?.size === 0) this.#adoptionReservations.delete(sessionId);
    };
  }

  markManagerOwned(sessionId: string, owned = true): void {
    if (owned) {
      this.#managerOwned.add(sessionId);
      this.#lastHookAt.delete(sessionId);
    } else {
      this.#managerOwned.delete(sessionId);
    }
  }

  accept(
    input: ClaudeHookInput,
    options: { ownerMarker?: string; now?: number } = {},
  ): ClaudeHookSourceDecision {
    // The manager's own SDK child inherits this marker. Its global hook is a
    // duplicate source and must remain a quiet no-op.
    if (options.ownerMarker === CLAUDE_MANAGER_OWNER_VALUE) {
      return { accepted: false, reason: "manager-owned" };
    }
    // A markerless hook for an identity whose SDK writer is still registered
    // proves that another Claude process is writing the same conversation.
    // Report the conflict synchronously so the manager can withdraw its writer
    // before this request returns; the event itself is still ignored because
    // ownership recovery, not hook projection, decides the next source.
    if (this.#managerOwned.has(input.session_id)) {
      for (const listener of [...this.#ownershipConflictListeners]) {
        try {
          listener({ sessionId: input.session_id });
        } catch {
          // Conflict observers cannot turn a fail-closed hook response into a
          // provider-visible error or restore manager ownership.
        }
      }
      return { accepted: false, reason: "ownership-conflict" };
    }
    this.#lastHookAt.set(input.session_id, options.now ?? Date.now());
    const reservations = this.#adoptionReservations.get(input.session_id);
    if (reservations) {
      this.#adoptionReservations.delete(input.session_id);
      for (const onConflict of reservations.values()) {
        try {
          onConflict();
        } catch {
          // Provisional cancellation is fail-closed inside its owner. The hook
          // itself remains authoritative even if an observer is faulty.
        }
      }
    }
    return { accepted: true, suppressTranscriptPolling: true };
  }

  shouldPollTranscript(sessionId: string): boolean {
    return !this.#managerOwned.has(sessionId) && !this.#lastHookAt.has(sessionId);
  }

  /** When the bridge last spoke for this session, for liveness reporting only. */
  lastHookAt(sessionId: string): number | null {
    return this.#lastHookAt.get(sessionId) ?? null;
  }

  forget(sessionId: string): void {
    this.#managerOwned.delete(sessionId);
    this.#lastHookAt.delete(sessionId);
    this.#adoptionReservations.delete(sessionId);
  }
}
