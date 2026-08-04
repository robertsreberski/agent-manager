import { ChevronRight, Server } from "lucide-react";
import type { BoardSession, PhoneBoardBand } from "./model";
import { TodoProgressMeter } from "./TodoProgressMeter";

export interface PhoneBoardBandsProps {
  bands: readonly PhoneBoardBand[];
  onOpenSession: (session: BoardSession) => void;
}

export function PhoneBoardBands({ bands, onOpenSession }: PhoneBoardBandsProps) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[var(--app)] min-[901px]:hidden" aria-label="Agent sessions" data-phone-board>
      {bands.map((band) => (
        <section key={band.state} aria-labelledby={`band-${band.state}`}>
          <h2
            id={`band-${band.state}`}
            className="sticky top-0 z-10 flex items-center justify-between border-y border-[var(--rule)] bg-[var(--app)] px-4 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]"
          >
            <span>{band.label}</span><span>{band.sessions.length}</span>
          </h2>
          <ul className="m-0 list-none p-0">
            {band.sessions.map((session) => {
              const heuristic = session.boardState === "wants-you" && !session.attentionExact;
              return (
                <li
                  key={session.id}
                  data-board-state={session.boardState}
                  data-attention-confidence={heuristic ? "heuristic" : session.attentionExact ? "exact" : undefined}
                >
                  <button
                    type="button"
                    className="relative grid min-h-[64px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-[var(--rule)] px-4 py-3 text-left focus-visible:z-10"
                    onClick={() => onOpenSession(session)}
                  >
                    {heuristic && <span aria-hidden="true" className="absolute inset-y-2 left-0 border-l-2 border-dashed border-[var(--accent)]" data-attention-edge="inferred" />}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 truncate text-sm font-semibold">
                        {session.remote && <Server size={12} strokeWidth={1.75} className="shrink-0 text-[var(--remote)]" aria-hidden="true" />}
                        <span className="truncate">{session.name}</span>
                      </span>
                      <span className={`mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] ${heuristic ? "text-[var(--text-muted)]" : session.boardState === "wants-you" ? "text-[var(--wants-text)]" : "text-[var(--text-muted)]"}`}>
                        {session.stateLine}
                      </span>
                      {session.todo && session.todo.total > 0 && (
                        <TodoProgressMeter todo={session.todo} className="mt-2" />
                      )}
                    </span>
                    <ChevronRight size={16} strokeWidth={1.75} className="text-[var(--text-faint)]" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
