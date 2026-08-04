import type { ActivityMutation } from "../../activity/index.ts";
import {
  authorizeCodexHook,
  type CodexHookAuthorizationRecord,
} from "./codex-hook-auth.ts";
import { codexNoDecisionHookOutput, parseCodexHookInput } from "./codex-hook.ts";
import { projectCodexHook } from "./codex-hook-projector.ts";

export interface CodexHookBridgeRequest {
  authorization?: string;
  body: unknown;
}

export interface CodexHookBridgeResponse {
  statusCode: 200 | 400 | 401;
  body: Record<string, unknown> | null;
}

export interface CodexHookSeenEvent {
  providerSessionId: string;
  hookEventName: string;
  installId: string;
  receivedAt: string;
}

export interface CodexHookBridgeOptions {
  authorizationRecords?: readonly CodexHookAuthorizationRecord[];
  now?: () => Date;
  onActivity?: (providerSessionId: string, mutation: ActivityMutation) => void;
  onHookSeen?: (event: CodexHookSeenEvent) => void;
  onError?: (message: string) => void;
}

/**
 * Observation-only bridge for ordinary Codex CLI sessions. No request is held:
 * the pinned live request-response form has not been proven, so every hook
 * invocation returns Codex's exact no-decision object and native UI stays in charge.
 */
export class CodexHookBridge {
  readonly #now: () => Date;
  readonly #onActivity: CodexHookBridgeOptions["onActivity"];
  readonly #onHookSeen: CodexHookBridgeOptions["onHookSeen"];
  readonly #onError: CodexHookBridgeOptions["onError"];
  #authorizationRecords: CodexHookAuthorizationRecord[];

  constructor(options: CodexHookBridgeOptions = {}) {
    this.#authorizationRecords = (options.authorizationRecords ?? []).map((record) => structuredClone(record));
    this.#now = options.now ?? (() => new Date());
    this.#onActivity = options.onActivity;
    this.#onHookSeen = options.onHookSeen;
    this.#onError = options.onError;
  }

  replaceAuthorizationRecords(records: readonly CodexHookAuthorizationRecord[]): void {
    this.#authorizationRecords = records.map((record) => structuredClone(record));
  }

  handle(request: CodexHookBridgeRequest): CodexHookBridgeResponse {
    const authorization = authorizeCodexHook(request.authorization, this.#authorizationRecords);
    if (!authorization) return { statusCode: 401, body: null };

    let input;
    try {
      const raw = Buffer.from(JSON.stringify(request.body), "utf8");
      input = parseCodexHookInput(raw);
    } catch {
      return { statusCode: 400, body: null };
    }

    const receivedAt = this.#now().toISOString();
    try {
      this.#onHookSeen?.({
        providerSessionId: input.sessionId,
        hookEventName: input.event,
        installId: authorization.id,
        receivedAt,
      });
    } catch (error) {
      this.#report(error);
    }
    try {
      const projection = projectCodexHook(input, receivedAt);
      for (const mutation of projection.mutations) {
        this.#onActivity?.(input.sessionId, mutation);
      }
    } catch (error) {
      this.#report(error);
    }
    return { statusCode: 200, body: codexNoDecisionHookOutput() };
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error instanceof Error ? error.message : "Codex hook projection failed");
    } catch {
      // Reporting cannot alter Codex's native fallback behavior.
    }
  }
}
