import type { AuthSession } from "../types";

function bootstrapSecretFromFragment(): string | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return fragment.get("bootstrap") ?? fragment.get("token");
}

function clearFragment(): void {
  const cleanUrl = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, "", cleanUrl);
}

async function exchangeBootstrapSecret(secret: string): Promise<void> {
  const response = await fetch("/api/v1/auth/bootstrap", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? "This bootstrap link is invalid or has expired." : "Could not establish a secure cockpit session.");
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

  const response = await fetch("/api/v1/auth/session", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    return { csrfToken: null, actor: null };
  }
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Open Agent Manager from a fresh local bootstrap link." : "Could not verify this browser session.");
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
