import type { ClaudeHookInput } from "./claude-types.ts";

export const CLAUDE_MANAGER_OWNER_ENV = "AGENT_MANAGER_SESSION_OWNER";
export const CLAUDE_MANAGER_OWNER_VALUE = "manager";

export type ClaudeHookSourceDecision =
  | { accepted: true; suppressTranscriptPolling: true }
  | { accepted: false; reason: "manager-owned" };

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
    if (
      options.ownerMarker === CLAUDE_MANAGER_OWNER_VALUE
      || this.#managerOwned.has(input.session_id)
    ) {
      return { accepted: false, reason: "manager-owned" };
    }
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
