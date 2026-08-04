import { GitBranch, Plus, Server } from "lucide-react";
import { SessionCard } from "./SessionCard";
import type { BoardColumn, BoardSession } from "./model";

export interface DesktopBoardProps {
  columns: readonly BoardColumn[];
  selectedSessionIds?: ReadonlySet<string>;
  onOpenSession: (session: BoardSession) => void;
  onToggleSelection?: (session: BoardSession) => void;
  onNewThread?: (column: BoardColumn) => void;
}

function shortPath(path: string, repoRoot: string): string {
  if (path === repoRoot) return ".";
  return path.startsWith(`${repoRoot}/`) ? `./${path.slice(repoRoot.length + 1)}` : path;
}

export function DesktopBoard({
  columns,
  selectedSessionIds = new Set(),
  onOpenSession,
  onToggleSelection,
  onNewThread,
}: DesktopBoardProps) {
  const selectionActive = selectedSessionIds.size > 0;
  return (
    <section
      className="hidden min-h-0 flex-1 gap-px overflow-x-auto bg-[var(--rule)] min-[901px]:flex"
      aria-label="Agent sessions by repository"
      data-desktop-board
    >
      {columns.map((column) => (
        <section
          key={column.key}
          className="box-border flex w-[302px] min-w-[302px] flex-col overflow-y-auto bg-[var(--app)] px-5"
          aria-labelledby={`repo-${encodeURIComponent(column.key)}`}
          data-board-column={column.key}
        >
          <header className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--app)] py-4">
            {column.remote && <Server size={12} strokeWidth={1.75} className="text-[var(--remote)]" />}
            <h2 id={`repo-${encodeURIComponent(column.key)}`} className="truncate text-[12.5px] font-semibold tracking-[-0.01em]">
              {column.repoName}
            </h2>
            <span className="font-mono text-[11px] text-[var(--text-muted)]">
              {column.worktrees.reduce((total, group) => total + group.sessions.length, 0)}
            </span>
          </header>
          <div className="grid gap-5">
            {column.worktrees.map((group) => (
              <section key={group.key} aria-label={`${group.label} sessions`}>
                <div className="mb-2 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-0.5">
                  <GitBranch
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className={group.identity?.linked ? "text-[var(--worktree-linked,var(--accent))]" : "text-[var(--text-muted)]"}
                  />
                  <span className="truncate font-mono text-[11.5px] font-medium">{group.label}</span>
                  {group.identity?.linked && (
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]">worktree</span>
                  )}
                  <span className="col-start-2 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-[var(--text-faint)]">
                    {typeof group.identity?.dirtyCount === "number" && group.identity.dirtyCount > 0 && (
                      <span className="flex shrink-0 items-center gap-1 text-[var(--dirty)]">
                        <span className="size-[5px] rounded-full bg-current" />{group.identity.dirtyCount} uncommitted
                      </span>
                    )}
                    <span className="truncate" title={group.key}>
                      {group.identity ? shortPath(group.identity.worktreePath, group.identity.repoRoot) : group.key}
                    </span>
                  </span>
                </div>
                <div className="grid gap-1.5">
                  {group.sessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      selected={selectedSessionIds.has(session.id)}
                      selectionActive={selectionActive}
                      onOpen={onOpenSession}
                      {...(onToggleSelection ? { onToggleSelection } : {})}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          <button
            type="button"
            className="my-5 flex min-h-10 w-full items-center justify-center gap-1.5 border border-dashed border-[var(--border)] font-mono text-[11px] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text)]"
            onClick={() => onNewThread?.(column)}
          >
            <Plus size={13} strokeWidth={1.75} />New thread here
          </button>
        </section>
      ))}
    </section>
  );
}
