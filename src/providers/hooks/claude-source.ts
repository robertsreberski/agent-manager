import type { ClaudeHookInput } from "./claude-types.ts";

export const CLAUDE_MANAGER_OWNER_ENV = "AGENT_MANAGER_SESSION_OWNER";
export const CLAUDE_MANAGER_OWNER_VALUE = "manager";

export type ClaudeHookSourceDecision =
  | { accepted: true }
  | { accepted: false; reason: "manager-owned" };

/**
 * Which producer projects a session's activity. This is a de-duplication
 * concern, not an ownership one: the manager's own SDK child inherits the owner
 * marker and its global hook is a duplicate of what the SDK stream already
 * reports, so it stays a quiet no-op. Every other hook is accepted, including a
 * markerless one on a session the manager also holds — that is a peer turn from
 * the operator's terminal, and dropping it would leave the cockpit blind to half
 * of a shared conversation.
 *
 * It does *not* decide whether the transcript is read. It used to claim to —
 * `shouldPollTranscript` and a `suppressTranscriptPolling` flag on every accepted
 * decision — but nothing ever consulted either, and the transcript observer runs
 * for every local session regardless. That stale promise mattered: it read as a
 * guarantee that no two producers ever share a session, which is precisely how
 * every assistant reply on a hook-fed session came to be stated twice while the
 * duplication looked impossible by construction. Overlap is expected and the hub
 * correlates it; see `providers/claude/correlation.ts`.
 */
export class ClaudeHookSourceArbiter {
  readonly #managerOwned = new Set<string>();
  readonly #lastHookAt = new Map<string, number>();

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
    /*
      A markerless hook on a manager-owned session is the operator typing in
      their own terminal, and it is now an ordinary peer turn.

      This used to return `ownership-conflict` and fire a listener that disposed
      the manager's SDK query — so joining "worked" right up until the operator
      touched their terminal, at which point web control died and the native
      turn's activity was dropped rather than projected. Under exclusivity that
      was the correct reading of a second writer; under shared join a second
      writer is the point.
    */
    this.#lastHookAt.set(input.session_id, options.now ?? Date.now());
    return { accepted: true };
  }

  /**
   * No producer has claimed this session — the manager does not hold it and no
   * hook has spoken for it. A statement about what has been observed, not a
   * licence to start a second producer.
   */
  isUnclaimed(sessionId: string): boolean {
    return !this.#managerOwned.has(sessionId) && !this.#lastHookAt.has(sessionId);
  }

  /** When the bridge last spoke for this session, for liveness reporting only. */
  lastHookAt(sessionId: string): number | null {
    return this.#lastHookAt.get(sessionId) ?? null;
  }

  forget(sessionId: string): void {
    this.#managerOwned.delete(sessionId);
    this.#lastHookAt.delete(sessionId);
  }
}
