import { GitBranch, Plus, Server } from "lucide-react";
import { Badge, Button } from "../ui";
import { SessionCard } from "./SessionCard";
import type { BoardColumn, BoardSession } from "./model";

export interface DesktopBoardProps {
  columns: readonly BoardColumn[];
  selectedSessionIds?: ReadonlySet<string>;
  onOpenSession: (session: BoardSession) => void;
  onToggleSelection?: (session: BoardSession) => void;
  onNewThread?: (column: BoardColumn) => void;
}

/**
 * Frame 7a carries a directory only where it adds a fact the repository name
 * does not already give — a linked worktree living beside the checkout. The
 * main checkout shows no second line at all rather than a bare `.`.
 */
function worktreeDirectory(group: BoardColumn["worktrees"][number]): string | null {
  const identity = group.identity;
  if (!identity) return group.key === "unknown" ? null : group.key;
  if (identity.worktreePath === identity.repoRoot) return null;
  return identity.worktreePath.startsWith(`${identity.repoRoot}/`)
    ? `./${identity.worktreePath.slice(identity.repoRoot.length + 1)}`
    : identity.worktreePath;
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
    // The 1px gap over a hairline fill is what draws the column rules (spec 05
    // R1); the columns themselves carry no border.
    <section
      className="hidden min-h-0 flex-1 gap-px overflow-x-auto bg-[var(--board-rule)] min-[901px]:flex"
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
          <header className="sticky top-0 z-10 flex items-baseline gap-[9px] bg-[var(--app)] pb-0.5 pt-4">
            {column.remote && <Server size={12} strokeWidth={1.75} className="self-center text-[var(--remote)]" />}
            <h2 id={`repo-${encodeURIComponent(column.key)}`} className="truncate text-meta-sm font-semibold leading-none tracking-[-0.01em]">
              {column.repoName}
            </h2>
            <span className="font-mono text-code-xs leading-none text-[var(--text-faint)]">
              {column.worktrees.reduce((total, group) => total + group.sessions.length, 0)}
            </span>
          </header>
          {column.worktrees.map((group) => {
            const directory = worktreeDirectory(group);
            const dirty = typeof group.identity?.dirtyCount === "number" && group.identity.dirtyCount > 0
              ? group.identity.dirtyCount
              : null;
            return <section key={group.key} aria-label={`${group.label} sessions`}>
              <div className="flex flex-col gap-[5px] pb-2 pt-[13px]">
                <div className="flex min-w-0 items-center gap-[7px]">
                  <GitBranch
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className={`shrink-0 ${group.identity?.linked ? "text-[var(--worktree-linked,var(--accent))]" : "text-[var(--text-muted)]"}`}
                  />
                  <span className={`min-w-0 truncate font-mono text-code-sm font-medium leading-none ${group.identity?.linked ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}`}>{group.label}</span>
                  {/* R4: a linked worktree is merely a fact about the checkout. */}
                  {group.identity?.linked && (
                    <Badge tone="neutral" className="px-1.5 py-0.5 text-[9.5px] leading-[1.4] tracking-[0.06em] uppercase">worktree</Badge>
                  )}
                </div>
                {(dirty !== null || directory !== null) && (
                  <div className="flex min-w-0 items-center gap-[9px] pl-[19px]">
                    {dirty !== null && (
                      <span className="flex shrink-0 items-center gap-[5px] font-mono text-eyebrow leading-none tracking-normal text-[var(--dirty)]">
                        <span className="size-[5px] rounded-full bg-current" />{dirty} uncommitted
                      </span>
                    )}
                    {directory !== null && (
                      <span className="truncate font-mono text-eyebrow leading-none tracking-normal text-[var(--text-faint)]" title={group.key}>{directory}</span>
                    )}
                  </div>
                )}
              </div>
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
            </section>;
          })}
          {/*
            R3 keeps the lime for the header's New thread; this per-column
            twin is the same action in a quieter place, so it stays an outline.
          */}
          <Button
            variant="ghost"
            size="touch"
            data-compact-control
            className="mb-5 mt-0.5 w-full gap-[7px] border border-dashed border-[var(--border-frame)] text-meta-sm leading-none text-[var(--text-faint)] hover:border-[var(--text-muted)] hover:bg-transparent hover:text-[var(--text)]"
            onClick={() => onNewThread?.(column)}
          >
            <Plus size={13} strokeWidth={1.75} />New thread here
          </Button>
        </section>
      ))}
    </section>
  );
}
