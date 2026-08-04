import type { SessionView, WorkspaceIdentity } from "../core/types.ts";
import type { SetupNearbyWorkspace } from "../shared/setup.ts";
import type { ManagerDatabase, WorkspaceRecord } from "./persistence.ts";

const MAX_DISCOVERED_WORKSPACES = 32;

function workspacePath(session: SessionView): string | null {
  const identity = session.workspaceIdentity;
  if (!identity || !session.cwd) return null;
  return identity.worktreePath || session.cwd;
}

function workspaceLabel(identity: WorkspaceIdentity): string {
  if (!identity.linked) return identity.repoName;
  return identity.branch ? `${identity.repoName} · ${identity.branch}` : identity.repoName;
}

function key(hostId: string, path: string): string {
  return `${hostId}\u0000${path}`;
}

/**
 * Discovery is already bounded. Persist at most one row per observed
 * host/worktree so a disappearing process does not make its folder vanish
 * from the next first-run screen.
 */
export function persistDiscoveredWorkspaces(
  database: ManagerDatabase,
  sessions: readonly SessionView[],
  limit = MAX_DISCOVERED_WORKSPACES,
): WorkspaceRecord[] {
  const stored: WorkspaceRecord[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (stored.length >= Math.max(1, Math.min(MAX_DISCOVERED_WORKSPACES, limit))) break;
    const path = workspacePath(session);
    const identity = session.workspaceIdentity;
    if (!path || !identity) continue;
    const identityKey = key(session.hostId, path);
    if (seen.has(identityKey) || !database.getHost(session.hostId)) continue;
    seen.add(identityKey);
    stored.push(database.addWorkspace({
      hostId: session.hostId,
      label: workspaceLabel(identity),
      path,
      remoteWorkspaceId: null,
    }));
  }
  return stored;
}

export function setupNearbyWorkspaces(
  database: ManagerDatabase,
  sessions: readonly SessionView[],
  limit = 16,
): SetupNearbyWorkspace[] {
  const observed = new Map<string, WorkspaceIdentity>();
  for (const session of sessions) {
    const path = workspacePath(session);
    if (session.hostId !== "local" || !path || !session.workspaceIdentity) continue;
    observed.set(key(session.hostId, path), session.workspaceIdentity);
  }
  return database.listWorkspaces()
    .filter((workspace) => workspace.hostId === "local")
    .sort((left, right) => {
      const leftObserved = observed.has(key(left.hostId, left.path)) ? 0 : 1;
      const rightObserved = observed.has(key(right.hostId, right.path)) ? 0 : 1;
      return leftObserved - rightObserved || left.label.localeCompare(right.label) || left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, Math.min(32, limit)))
    .map((workspace) => {
      const identity = observed.get(key(workspace.hostId, workspace.path)) ?? null;
      return {
        ...workspace,
        source: identity ? "discovered" as const : "configured" as const,
        repoRoot: identity?.repoRoot ?? null,
        worktreePath: identity?.worktreePath ?? null,
        branch: identity?.branch ?? null,
        linked: identity?.linked ?? null,
      };
    });
}
