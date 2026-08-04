import type { BoardSession } from "../board/model";
import type { PaletteEntry } from "./registry";

function basename(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function repoLabel(session: BoardSession): string {
  return session.workspaceIdentity?.repoName ?? basename(session.cwd) ?? "Unknown workspace";
}

function worktreeLabel(session: BoardSession): string {
  return session.workspaceIdentity?.branch
    ?? (session.workspaceIdentity?.detached ? "detached" : null)
    ?? basename(session.workspaceIdentity?.worktreePath ?? session.cwd)
    ?? "Unknown worktree";
}

export function sessionPaletteEntries(sessions: readonly BoardSession[]): PaletteEntry[] {
  return sessions.map((session) => ({
    id: `session:${session.id}`,
    kind: "session" as const,
    label: session.name,
    detail: session.todo?.current ?? `${repoLabel(session)} · ${worktreeLabel(session)}`,
    keywords: [
      session.provider,
      session.hostLabel,
      session.cwd ?? "",
      session.workspaceIdentity?.repoName ?? "",
      session.workspaceIdentity?.branch ?? "",
      session.stateLine,
    ],
    boardState: session.boardState,
    ...(session.todo && session.todo.total > 0
      ? { progress: { completed: session.todo.completed, total: session.todo.total } }
      : {}),
    payload: { type: "session", id: session.id },
  }));
}

/** One real, observed host-qualified worktree path; no filesystem scan. */
export function worktreePaletteEntries(sessions: readonly BoardSession[]): PaletteEntry[] {
  const entries = new Map<string, PaletteEntry>();
  for (const session of sessions) {
    const path = session.workspaceIdentity?.worktreePath ?? session.cwd;
    if (!path) continue;
    const key = `${session.hostId}\0${path}`;
    if (entries.has(key)) continue;
    entries.set(key, {
      id: `worktree:${session.hostId}:${path}`,
      kind: "worktree",
      label: worktreeLabel(session),
      detail: `${repoLabel(session)} · ${session.hostLabel}`,
      keywords: [path, session.hostId, session.hostLabel, repoLabel(session)],
      payload: { type: "session", id: session.id },
    });
  }
  return [...entries.values()];
}
