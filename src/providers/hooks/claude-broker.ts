import { randomUUID } from "node:crypto";

import type {
  PermissionRequestHookInput,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudeHookPermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

export interface ClaudeHookPendingPermission {
  id: string;
  sessionId: string;
  promptId: string | null;
  toolName: string;
  toolInput: unknown;
  permissionSuggestions: PermissionUpdate[];
  createdAt: string;
  deadlineAt: string;
}

export interface ClaudeHookHttpResponse {
  statusCode: 200;
  body: Record<string, unknown> | null;
}

interface HeldPermission {
  public: ClaudeHookPendingPermission;
  timer: ReturnType<typeof setTimeout>;
  resolve(response: ClaudeHookHttpResponse): void;
}

const EMPTY_SUCCESS: ClaudeHookHttpResponse = { statusCode: 200, body: null };

/** Claude Code's configured HTTP timeout for a held PermissionRequest hook. */
export const CLAUDE_PERMISSION_PROVIDER_TIMEOUT_MS = 480_000;
/** Minimum time reserved for the empty response to reach Claude before its deadline. */
export const CLAUDE_PERMISSION_FAIL_OPEN_MARGIN_MS = 10_000;
export const CLAUDE_PERMISSION_MAX_DEADLINE_MS =
  CLAUDE_PERMISSION_PROVIDER_TIMEOUT_MS - CLAUDE_PERMISSION_FAIL_OPEN_MARGIN_MS;
/** Personal-cockpit holds fall back to the native prompt promptly by default. */
export const CLAUDE_PERMISSION_DEFAULT_DEADLINE_MS = 60_000;

export class ClaudePermissionBroker {
  readonly #held = new Map<string, HeldPermission>();
  readonly #listeners = new Set<(
    event: { type: "opened"; request: ClaudeHookPendingPermission }
      | { type: "closed"; request: ClaudeHookPendingPermission; reason: string },
  ) => void>();
  readonly #randomUUID: () => string;
  readonly #now: () => Date;
  readonly #deadlineMs: number;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  #closed = false;

  constructor(options: {
    randomUUID?: () => string;
    now?: () => Date;
    deadlineMs?: number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  } = {}) {
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#deadlineMs = options.deadlineMs ?? CLAUDE_PERMISSION_DEFAULT_DEADLINE_MS;
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
    if (
      !Number.isInteger(this.#deadlineMs)
      || this.#deadlineMs < 1_000
      || this.#deadlineMs > CLAUDE_PERMISSION_MAX_DEADLINE_MS
    ) {
      throw new Error("Claude PermissionRequest deadline must be 1-470 seconds");
    }
  }

  subscribe(listener: (event:
    { type: "opened"; request: ClaudeHookPendingPermission }
    | { type: "closed"; request: ClaudeHookPendingPermission; reason: string }
  ) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hold(input: PermissionRequestHookInput): {
    request: ClaudeHookPendingPermission;
    response: Promise<ClaudeHookHttpResponse>;
    release(): void;
  } {
    const now = this.#now();
    const request: ClaudeHookPendingPermission = {
      id: this.#allocateRequestId(),
      sessionId: input.session_id,
      promptId: input.prompt_id ?? null,
      toolName: input.tool_name,
      toolInput: structuredClone(input.tool_input),
      permissionSuggestions: structuredClone(input.permission_suggestions ?? []),
      createdAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + this.#deadlineMs).toISOString(),
    };
    if (this.#closed) {
      return {
        request,
        response: Promise.resolve(EMPTY_SUCCESS),
        release: () => undefined,
      };
    }

    let settle!: (response: ClaudeHookHttpResponse) => void;
    const response = new Promise<ClaudeHookHttpResponse>((resolve) => {
      settle = resolve;
    });
    const timer = this.#setTimeout(() => this.#release(request.id, "timeout"), this.#deadlineMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.#held.set(request.id, { public: request, timer, resolve: settle });
    this.#emit({ type: "opened", request });
    return {
      request,
      response,
      release: () => this.#release(request.id, "request-aborted"),
    };
  }

  pending(): ClaudeHookPendingPermission[] {
    return [...this.#held.values()].map(({ public: request }) => structuredClone(request));
  }

  respond(id: string, decision: ClaudeHookPermissionDecision): boolean {
    const held = this.#held.get(id);
    if (!held) return false;
    const output = decision.behavior === "allow"
      ? {
          behavior: "allow" as const,
          ...(decision.updatedInput
            ? { updatedInput: structuredClone(decision.updatedInput) }
            : {}),
          ...(decision.updatedPermissions
            ? { updatedPermissions: structuredClone(decision.updatedPermissions) }
            : {}),
        }
      : {
          behavior: "deny" as const,
          ...(decision.message ? { message: decision.message } : {}),
          ...(decision.interrupt === true ? { interrupt: true } : {}),
        };
    this.#settle(id, {
      statusCode: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: output,
        },
      },
    }, "answered");
    return true;
  }

  /**
   * Resolve a held provider request without a decision so Claude falls back to
   * its native prompt. This is intentionally separate from `respond`: losing
   * the cockpit must never be represented as an operator allow or deny.
   */
  failOpen(id: string, reason = "browser-lost"): boolean {
    if (!this.#held.has(id)) return false;
    this.#release(id, reason);
    return true;
  }

  releaseSession(sessionId: string): void {
    for (const [id, held] of this.#held) {
      if (held.public.sessionId === sessionId) this.#release(id, "session-ended");
    }
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of [...this.#held.keys()]) this.#release(id, "shutdown");
  }

  #allocateRequestId(): string {
    // randomUUID collisions are vanishingly unlikely in production, but an
    // injected/broken generator must never overwrite a live permission hold.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.#randomUUID();
      if (id.length > 0 && !this.#held.has(id)) return id;
    }
    throw new Error("Unable to allocate a unique Claude permission request id");
  }

  #release(id: string, reason: string): void {
    this.#settle(id, EMPTY_SUCCESS, reason);
  }

  #settle(id: string, response: ClaudeHookHttpResponse, reason: string): void {
    const held = this.#held.get(id);
    if (!held) return;
    this.#held.delete(id);
    this.#clearTimeout(held.timer);
    held.resolve(response);
    this.#emit({ type: "closed", request: held.public, reason });
  }

  #emit(event:
    { type: "opened"; request: ClaudeHookPendingPermission }
    | { type: "closed"; request: ClaudeHookPendingPermission; reason: string }
  ): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Broker lifetimes cannot depend on observers.
      }
    }
  }
}
