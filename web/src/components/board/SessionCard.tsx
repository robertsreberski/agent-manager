import { GitBranch, Server } from "lucide-react";
import type { BoardSession } from "./model";
import { TodoProgressMeter } from "./TodoProgressMeter";

export interface SessionCardProps {
  session: BoardSession;
  selected?: boolean;
  selectionActive?: boolean;
  onOpen: (session: BoardSession) => void;
  onToggleSelection?: (session: BoardSession) => void;
}

function relativeTime(value: string | null): string {
  if (!value) return "";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function SessionCard({
  session,
  selected = false,
  selectionActive = false,
  onOpen,
  onToggleSelection,
}: SessionCardProps) {
  const heuristic = session.boardState === "wants-you" && !session.attentionExact;
  const stateClasses = heuristic
    ? "bg-[var(--surface-raised)] text-[var(--text-muted)]"
    : session.boardState === "wants-you"
      ? "bg-[var(--wants-field)] text-[var(--accent)]"
      : session.boardState === "working"
        ? "bg-[var(--surface-raised)] text-[var(--text-secondary)]"
        : session.boardState === "failed"
          ? "bg-[var(--danger-field)] text-[var(--danger)]"
          : "bg-[var(--surface-raised)] text-[var(--text-muted)]";
  const tickClass = session.boardState === "wants-you"
    ? "bg-[var(--accent)]"
    : session.boardState === "failed"
      ? "bg-[var(--danger)]"
      : session.boardState === "working"
        ? "bg-[var(--text-muted)]"
        : "bg-[var(--border)]";
  const stateLineClass = heuristic
    ? "text-[var(--text-muted)]"
    : session.boardState === "wants-you"
      ? "text-[var(--wants-text)]"
      : session.boardState === "working"
        ? "text-[var(--text-secondary)]"
        : session.boardState === "failed"
          ? "text-[var(--danger)]"
          : "text-[var(--text-muted)]";
  function activate(event: React.MouseEvent<HTMLButtonElement>) {
    if (event.shiftKey || event.metaKey || event.ctrlKey || selectionActive) {
      event.preventDefault();
      onToggleSelection?.(session);
      return;
    }
    onOpen(session);
  }
  return (
    <button
      type="button"
      className={`group relative grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-0 px-3.5 py-3 text-left outline-none hover:bg-[var(--surface-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${stateClasses}`}
      data-board-state={session.boardState}
      data-attention-confidence={heuristic ? "heuristic" : session.attentionExact ? "exact" : undefined}
      aria-pressed={selectionActive ? selected : undefined}
      onClick={activate}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-0.5 ${heuristic ? "border-l-2 border-dashed border-[var(--accent)]" : tickClass}`}
      />
      {selectionActive && (
        <span aria-hidden="true" className={`absolute right-2 top-2 size-3 border ${selected ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--text-faint)]"}`} />
      )}
      <span className={`truncate text-[13.5px] font-semibold tracking-[-0.01em] ${session.boardState === "idle" ? "text-[var(--text-secondary)]" : "text-[var(--text)]"}`}>{session.name}</span>
      <time className="font-mono text-[10.5px] text-[var(--text-muted)]" dateTime={session.updatedAt ?? undefined}>
        {relativeTime(session.updatedAt)}
      </time>
      <span className={`col-span-2 line-clamp-2 text-[12.5px] leading-[18px] ${stateLineClass}`}>
        {session.stateLine}
      </span>
      {session.todo && session.todo.total > 0 && (
        <TodoProgressMeter todo={session.todo} className="col-span-2" />
      )}
      {session.remote && (
        <span className="col-span-2 flex items-center gap-1 font-mono text-[10px] text-[var(--remote)]">
          <Server size={11} strokeWidth={1.75} />{session.hostLabel}
        </span>
      )}
      {session.workspaceIdentity?.linked && (
        <span className="col-span-2 flex items-center gap-1 font-mono text-[10px] text-[var(--text-faint)]">
          <GitBranch size={11} strokeWidth={1.75} />linked worktree
        </span>
      )}
    </button>
  );
}
