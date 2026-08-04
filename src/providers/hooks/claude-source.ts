import type { ClaudeHookInput } from "./claude-types.ts";

export const CLAUDE_MANAGER_OWNER_ENV = "AGENT_MANAGER_SESSION_OWNER";
export const CLAUDE_MANAGER_OWNER_VALUE = "manager";

export type ClaudeHookSourceDecision =
  | { accepted: true; suppressTranscriptPolling: true }
  | { accepted: false; reason: "manager-owned" };

/**
 * One source wins at a time. Manager-owned SDK sessions reject global hooks;
 * external sessions use hooks until the health window expires, then polling may resume.
 */
export class ClaudeHookSourceArbiter {
  readonly #managerOwned = new Set<string>();
  readonly #lastHookAt = new Map<string, number>();
  readonly #healthyForMs: number;

  constructor(options: { healthyForMs?: number } = {}) {
    this.#healthyForMs = options.healthyForMs ?? 30_000;
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
    if (
      options.ownerMarker === CLAUDE_MANAGER_OWNER_VALUE
      || this.#managerOwned.has(input.session_id)
    ) {
      return { accepted: false, reason: "manager-owned" };
    }
    this.#lastHookAt.set(input.session_id, options.now ?? Date.now());
    return { accepted: true, suppressTranscriptPolling: true };
  }

  shouldPollTranscript(sessionId: string, now = Date.now()): boolean {
    if (this.#managerOwned.has(sessionId)) return false;
    const lastHookAt = this.#lastHookAt.get(sessionId);
    return lastHookAt === undefined || now - lastHookAt > this.#healthyForMs;
  }

  forget(sessionId: string): void {
    this.#managerOwned.delete(sessionId);
    this.#lastHookAt.delete(sessionId);
  }
}
