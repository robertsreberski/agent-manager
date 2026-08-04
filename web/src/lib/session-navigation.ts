import type { SessionView } from "../types";

export const SESSION_SCOPES = ["all", "wants-you", "working", "idle"] as const;
export type SessionScope = (typeof SESSION_SCOPES)[number];
export type SessionScopeCounts = Record<SessionScope, number>;

const SESSION_SCOPE_SET = new Set<string>(SESSION_SCOPES);

export function sessionScopeFromSearch(search: string): SessionScope {
  const value = new URLSearchParams(search).get("scope");
  return value && SESSION_SCOPE_SET.has(value) ? value as SessionScope : "all";
}

export function hostFilterFromSearch(search: string): ReadonlySet<string> {
  return new Set(new URLSearchParams(search).getAll("host").filter(Boolean));
}

export function searchWithSessionScope(search: string, scope: SessionScope): string {
  const params = new URLSearchParams(search);
  if (scope === "all") params.delete("scope");
  else params.set("scope", scope);
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function searchWithHostFilter(search: string, hostIds: ReadonlySet<string>): string {
  const params = new URLSearchParams(search);
  params.delete("host");
  for (const hostId of [...hostIds].sort()) params.append("host", hostId);
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function searchWithSelectedSession(search: string, selectedId: string | null): string {
  const params = new URLSearchParams(search);
  if (selectedId) params.set("session", selectedId);
  else params.delete("session");
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function sessionMatchesScope(session: SessionView, scope: SessionScope): boolean {
  switch (scope) {
    case "all": return true;
    case "wants-you": return session.attention.length > 0;
    case "working": return session.status === "running";
    case "idle": return session.attention.length === 0 && session.status !== "running";
  }
}

export function reconcileSelectedSessionId({
  sessions,
  selectedId,
  hasSuccessfulSnapshot,
}: {
  sessions: readonly SessionView[];
  selectedId: string | null;
  hasSuccessfulSnapshot: boolean;
}): string | null {
  if (!hasSuccessfulSnapshot) return selectedId;
  return selectedId && sessions.some((session) => session.id === selectedId) ? selectedId : null;
}

export function countSessionScopes(sessions: readonly SessionView[]): SessionScopeCounts {
  return Object.fromEntries(SESSION_SCOPES.map((scope) => [scope, sessions.filter((session) => sessionMatchesScope(session, scope)).length])) as SessionScopeCounts;
}
