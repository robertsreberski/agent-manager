import type { SessionView } from "../types";

export const SESSION_SCOPES = [
  "needs-you",
  "working",
  "all",
  "managed",
  "external",
  "codex",
  "claude",
] as const;

export type SessionScope = (typeof SESSION_SCOPES)[number];

export type SessionScopeCounts = Record<SessionScope, number>;

export interface NavigationSession {
  session: SessionView;
  /** True when this row is visible only to preserve a matching descendant's context. */
  ancestorOnly: boolean;
  /** Provider-reported depth, with structural depth as a fallback. */
  depth: number;
}

const SESSION_SCOPE_SET = new Set<string>(SESSION_SCOPES);

export function sessionScopeFromSearch(search: string): SessionScope {
  const value = new URLSearchParams(search).get("scope");
  if (value === "attention") return "needs-you";
  if (value === "running") return "working";
  return value && SESSION_SCOPE_SET.has(value) ? value as SessionScope : "all";
}

export function searchWithSessionScope(search: string, scope: SessionScope): string {
  const params = new URLSearchParams(search);
  if (scope === "all") params.delete("scope");
  else params.set("scope", scope);
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
    case "needs-you":
      return session.attention.length > 0;
    case "working":
      return session.activity === "running";
    case "all":
      return true;
    case "managed":
      return session.ownership === "manager";
    case "external":
      return session.ownership === "external";
    case "codex":
    case "claude":
      return session.provider === scope;
  }
}

export function reconcileSelectedSessionId({
  sessions,
  scope,
  selectedId,
  hasSuccessfulSnapshot,
}: {
  sessions: readonly SessionView[];
  scope: SessionScope;
  selectedId: string | null;
  hasSuccessfulSnapshot: boolean;
}): string | null {
  // The initial empty client state is not evidence that a deep-linked session
  // disappeared. Wait for an authoritative snapshot before replacing it.
  if (!hasSuccessfulSnapshot) return selectedId;

  const scopedSessions = sessions.filter((session) => sessionMatchesScope(session, scope));
  if (selectedId && scopedSessions.some((session) => session.id === selectedId)) {
    return selectedId;
  }
  return scopedSessions[0]?.id ?? null;
}

export function countSessionScopes(sessions: readonly SessionView[]): SessionScopeCounts {
  return Object.fromEntries(
    SESSION_SCOPES.map((scope) => [
      scope,
      sessions.reduce((count, session) => count + Number(sessionMatchesScope(session, scope)), 0),
    ]),
  ) as SessionScopeCounts;
}

function parentCandidate(
  session: SessionView,
  sessionsById: ReadonlyMap<string, SessionView>,
): SessionView | null {
  if (!session.parentSessionId) return null;
  return sessionsById.get(session.parentSessionId)
    ?? sessionsById.get(`${session.provider}:${session.parentSessionId}`)
    ?? null;
}

function searchableValues(session: SessionView): Array<string | null> {
  return [session.name, session.cwd, session.id, session.provider, session.hostLabel ?? null];
}

function sessionMatchesQuery(session: SessionView, needle: string): boolean {
  if (!needle) return true;
  return searchableValues(session)
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

/**
 * Groups an already-prioritized session collection into a stable forest.
 * Root and sibling order follow their order in `sessions`; only adjacency is
 * changed. Filtering keeps every matching session plus its known ancestors.
 */
export function navigationSessions(
  sessions: readonly SessionView[],
  scope: SessionScope,
  query: string,
): NavigationSession[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const inputIndex = new Map(sessions.map((session, index) => [session.id, index]));
  const parentById = new Map<string, string>();

  for (const session of sessions) {
    const parent = parentCandidate(session, sessionsById);
    if (parent && parent.id !== session.id) parentById.set(session.id, parent.id);
  }

  // Malformed provider data must not hide a whole group. Break each cycle at
  // its earliest input item so the result remains deterministic.
  for (const session of sessions) {
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let currentId: string | undefined = session.id;
    while (currentId !== undefined) {
      const cycleStart = seenAt.get(currentId);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const rootId = cycle.reduce((first, candidate) =>
          (inputIndex.get(candidate) ?? Number.MAX_SAFE_INTEGER)
            < (inputIndex.get(first) ?? Number.MAX_SAFE_INTEGER)
            ? candidate
            : first
        );
        parentById.delete(rootId);
        break;
      }
      seenAt.set(currentId, path.length);
      path.push(currentId);
      currentId = parentById.get(currentId);
    }
  }

  const childrenById = new Map<string, SessionView[]>();
  const roots: SessionView[] = [];
  for (const session of sessions) {
    const parentId = parentById.get(session.id);
    if (!parentId) {
      roots.push(session);
      continue;
    }
    const children = childrenById.get(parentId) ?? [];
    children.push(session);
    childrenById.set(parentId, children);
  }

  const needle = query.trim().toLocaleLowerCase();
  const directMatches = new Set(
    sessions
      .filter((session) => sessionMatchesScope(session, scope) && sessionMatchesQuery(session, needle))
      .map((session) => session.id),
  );
  const visibleIds = new Set(directMatches);
  for (const id of directMatches) {
    const visited = new Set<string>([id]);
    let parentId = parentById.get(id);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      visibleIds.add(parentId);
      parentId = parentById.get(parentId);
    }
  }

  const result: NavigationSession[] = [];
  const append = (session: SessionView, structuralDepth: number): void => {
    if (!visibleIds.has(session.id)) return;
    result.push({
      session,
      ancestorOnly: !directMatches.has(session.id),
      depth: session.depth > 0 ? session.depth : structuralDepth,
    });
    for (const child of childrenById.get(session.id) ?? []) {
      append(child, structuralDepth + 1);
    }
  };
  for (const root of roots) append(root, 0);
  return result.sort((left, right) => {
    const leftHostId = left.session.hostId ?? "local";
    const rightHostId = right.session.hostId ?? "local";
    if (leftHostId === rightHostId) return 0;
    if (leftHostId === "local") return -1;
    if (rightHostId === "local") return 1;
    return (left.session.hostLabel ?? leftHostId).localeCompare(right.session.hostLabel ?? rightHostId);
  });
}
