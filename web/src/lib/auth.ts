import type { AuthSession } from "../types";

export type BrowserSessionFailure = "offline" | "unauthorized" | "locked" | "unknown";

export class BrowserSessionError extends Error {
  constructor(
    message: string,
    readonly kind: BrowserSessionFailure,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

function networkFailure(error: unknown): BrowserSessionError {
  if (error instanceof BrowserSessionError) return error;
  if (error instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return new BrowserSessionError("Agent Manager host unavailable.", "offline");
  }
  return new BrowserSessionError(
    error instanceof Error ? error.message : "Could not verify this browser session.",
    "unknown",
  );
}

function bootstrapSecretFromFragment(): string | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return fragment.get("bootstrap") ?? fragment.get("token");
}

function clearFragment(): void {
  const cleanUrl = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, "", cleanUrl);
}

async function exchangeBootstrapSecret(secret: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/v1/auth/bootstrap", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
  } catch (error) {
    throw networkFailure(error);
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new BrowserSessionError("This bootstrap link is invalid or has expired.", "unauthorized", 401);
    }
    if (response.status === 423) {
      throw new BrowserSessionError("Agent Manager is locked.", "locked", 423);
    }
    throw new BrowserSessionError("Could not establish a secure cockpit session.", "unknown", response.status);
  }
}

export async function establishBrowserSession(): Promise<AuthSession> {
  const secret = bootstrapSecretFromFragment();
  if (secret) {
    try {
      await exchangeBootstrapSecret(secret);
    } finally {
      clearFragment();
    }
  }

  let response: Response;
  try {
    response = await fetch("/api/v1/auth/session", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw networkFailure(error);
  }
  if (response.status === 404) {
    return { csrfToken: null, actor: null };
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new BrowserSessionError(
        "Open Agent Manager from a fresh local bootstrap link.",
        "unauthorized",
        401,
      );
    }
    if (response.status === 423) {
      throw new BrowserSessionError("Agent Manager is locked.", "locked", 423);
    }
    throw new BrowserSessionError("Could not verify this browser session.", "unknown", response.status);
  }
  const value = (await response.json()) as Record<string, unknown>;
  const actorValue = value.actor && typeof value.actor === "object"
    ? (value.actor as Record<string, unknown>)
    : null;
  return {
    csrfToken: typeof value.csrfToken === "string" ? value.csrfToken : null,
    actor: typeof value.actor === "string"
      ? value.actor
      : actorValue && typeof actorValue.displayName === "string"
        ? actorValue.displayName
        : null,
  };
}
