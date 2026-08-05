import { Check, Server } from "lucide-react";
import type { BoardSession } from "./model";
import { TodoProgressMeter } from "./TodoProgressMeter";

export interface SessionCardProps {
  session: BoardSession;
  selected?: boolean;
  selectionActive?: boolean;
  onOpen: (session: BoardSession) => void;
  onToggleSelection?: (session: BoardSession) => void;
}

export function relativeTime(value: string | null): string {
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
  // Frame 7a fills the card from its state and 12a replaces that fill on a
  // selected card, so the two are resolved together rather than layered.
  const fillClass = selected
    ? "bg-[var(--selected-field)]"
    : heuristic
      ? "bg-[var(--surface-raised)]"
      : session.boardState === "wants-you"
        ? "bg-[var(--wants-field)]"
        : session.boardState === "failed"
          ? "bg-[var(--danger-field)]"
          : "bg-[var(--surface-raised)]";
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
          ? "text-[var(--danger-text)]"
          : "text-[var(--text-muted)]";
  const edgeClass = selected
    ? "[outline:1px_solid_var(--wants-outline)]"
    : "hover:[outline:1px_solid_var(--border)]";
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
      className={`group relative mb-1.5 block w-full border-0 py-3 pl-[15px] pr-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${fillClass} ${edgeClass}`}
      data-board-state={session.boardState}
      data-attention-confidence={heuristic ? "heuristic" : session.attentionExact ? "exact" : undefined}
      aria-pressed={selectionActive ? selected : undefined}
      onClick={activate}
    >
      {/*
        Inferred attention is a dashed lime edge rather than the solid tick, so
        a card that cannot be answered never reads as one that can (spec 05 R5).
      */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-0.5 ${heuristic ? "border-l-2 border-dashed border-[var(--accent)]" : tickClass}`}
      />
      <span className="flex items-start gap-2.5">
        {selectionActive && (
          <span
            aria-hidden="true"
            className={`mt-0.5 grid size-4 shrink-0 place-items-center ${selected ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "border border-[var(--border-loud)]"}`}
          >
            {selected && <Check size={11} strokeWidth={2} />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 truncate text-card leading-[1.35] ${session.boardState === "idle" ? "text-[var(--text-secondary)]" : "text-[var(--text)]"}`}>{session.name}</span>
            <time className="shrink-0 font-mono text-code-xs leading-none text-[var(--text-faint)]" dateTime={session.updatedAt ?? undefined}>
              {relativeTime(session.updatedAt)}
            </time>
          </span>
          {/*
            Heuristic attention keeps the muted body: an inferred state line
            must never read like an answerable one (spec 05 R5).
          */}
          <span className={`mt-1.5 line-clamp-2 text-meta-sm ${stateLineClass}`}>
            {session.stateLine}
          </span>
          {session.todo && session.todo.total > 0 && (
            <TodoProgressMeter todo={session.todo} className="mt-2" />
          )}
          {session.remote && (
            <span className={`mt-[9px] flex items-center gap-1.5 font-mono text-code-xs leading-none ${session.boardState === "idle" ? "text-[var(--remote-dim)]" : "text-[var(--remote)]"}`}>
              <Server size={11} strokeWidth={1.75} />{session.hostLabel}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
