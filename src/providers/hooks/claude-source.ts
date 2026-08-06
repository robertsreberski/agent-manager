import type { ClaudeHookInput } from "./claude-types.ts";

export const CLAUDE_MANAGER_OWNER_ENV = "AGENT_MANAGER_SESSION_OWNER";
export const CLAUDE_MANAGER_OWNER_VALUE = "manager";

export type ClaudeHookSourceDecision =
  | { accepted: true; suppressTranscriptPolling: true }
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
  }
}
