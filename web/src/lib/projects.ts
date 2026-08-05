import type { WorkspaceOption } from "../types";

/**
 * A project is a repository, not a directory. A repository and every worktree
 * of it are one entry, because where in the repository to run is the next
 * question the new-thread screen asks — not a way to pick the project.
 *
 * A directory that is not a repository is still a project: it is simply its
 * own, which is also what a row seeded from config becomes, since no git
 * resolution ran for it.
 */
export interface RecentProject {
  /** Stable per host and repository; usable as a list key. */
  id: string;
  label: string;
  /** The repository root, or the directory itself when there is no repository. */
  path: string;
  hostId: string;
  hostLabel: string;
  /** Most recent open across the whole project; null when never opened. */
  lastOpenedAt: string | null;
  /**
   * The worktree last opened in this project, when that was not the repository
   * root. A preference for the worktree step, never an assertion that it still
   * exists — the repository's own worktree list decides that.
   */
  lastWorktreePath: string | null;
}

function newer(left: string | null, right: string | null): boolean {
  if (right === null) return false;
  if (left === null) return true;
  return right > left;
}

/**
 * Groups workspace rows into projects, most recently opened first. Rows that
 * were never opened keep the server's ordering behind those that were, which
 * is the same rule the server applies to rows.
 */
export function recentProjects(workspaces: readonly WorkspaceOption[]): RecentProject[] {
  // Keyed by host and then path rather than by a joined string: a path may
  // contain any character a delimiter could use, so there is no separator to
  // pick wrongly.
  const byHost = new Map<string, Map<string, RecentProject>>();
  const ordered: RecentProject[] = [];

  for (const workspace of workspaces) {
    const path = workspace.repoRoot ?? workspace.path;
    let projects = byHost.get(workspace.hostId);
    if (!projects) {
      projects = new Map<string, RecentProject>();
      byHost.set(workspace.hostId, projects);
    }
    const existing = projects.get(path);
    const isWorktree = workspace.path !== path;

    if (!existing) {
      const project: RecentProject = {
        id: workspace.id,
        // The repository names the project; a plain directory names itself.
        label: workspace.repoName ?? workspace.label,
        path,
        hostId: workspace.hostId,
        hostLabel: workspace.hostLabel,
        lastOpenedAt: workspace.lastOpenedAt,
        lastWorktreePath: isWorktree && workspace.lastOpenedAt !== null ? workspace.path : null,
      };
      projects.set(path, project);
      ordered.push(project);
      continue;
    }

    // A row that names the repository is a better label source than a worktree
    // row, whose label carries the branch.
    if (workspace.repoName) existing.label = workspace.repoName;
    if (newer(existing.lastOpenedAt, workspace.lastOpenedAt)) {
      existing.lastOpenedAt = workspace.lastOpenedAt;
      existing.lastWorktreePath = isWorktree ? workspace.path : null;
    }
  }

  // Stable: equally-recent projects keep the order the server sent them in.
  return ordered.sort((left, right) => {
    if (left.lastOpenedAt === right.lastOpenedAt) return 0;
    if (left.lastOpenedAt === null) return 1;
    if (right.lastOpenedAt === null) return -1;
    return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
  });
}
