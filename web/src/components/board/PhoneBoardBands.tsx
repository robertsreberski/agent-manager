import { CircleX, LoaderCircle, Server } from "lucide-react";
import { Button } from "../ui";
import type { BoardSession, PhoneBoardBand } from "./model";
import { relativeTime } from "./SessionCard";
import { SessionIdentityBadges } from "./SessionIdentityBadges";
import { TodoProgressMeter } from "./TodoProgressMeter";

export interface PhoneBoardBandsProps {
  bands: readonly PhoneBoardBand[];
  onOpenSession: (session: BoardSession) => void;
}

/**
 * Frame 9a-1: wants-you rows are full cards carrying the question itself,
 * working rows carry the step, and idle rows compress to a name and an age.
 */
export function PhoneBoardBands({ bands, onOpenSession }: PhoneBoardBandsProps) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--app)] pb-5 min-[901px]:hidden" aria-label="Agent sessions" data-phone-board>
      {bands.map((band, bandIndex) => (
        <section key={band.state} aria-labelledby={`band-${band.state}`}>
          <h2
            id={`band-${band.state}`}
            className={`px-5 pb-1.5 font-mono text-eyebrow uppercase leading-none ${bandIndex === 0 ? "pt-1" : "pt-4"} ${band.state === "wants-you" ? "text-[var(--accent-quiet)]" : "text-[var(--text-faint)]"}`}
          >
            {band.label} · {band.sessions.length}
          </h2>
          <ul className="m-0 list-none px-5 py-0">
            {band.sessions.map((session) => {
              const heuristic = session.boardState === "wants-you" && !session.attentionExact;
              const wantsYou = session.boardState === "wants-you";
              const working = session.boardState === "working";
              return (
                <li
                  key={session.id}
                  className="mb-[7px]"
                  data-board-state={session.boardState}
                  data-attention-confidence={heuristic ? "heuristic" : session.attentionExact ? "exact" : undefined}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="touch"
                    className={`relative block h-auto min-h-[52px] w-full shrink-0 justify-start rounded-none text-left focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${wantsYou ? "bg-[var(--wants-field)] py-3.5 pl-4 pr-[15px] hover:bg-[var(--wants-field)] active:bg-[var(--wants-field)]" : "bg-[var(--surface-raised)] px-[15px] py-3 hover:bg-[var(--surface-raised)] active:bg-[var(--surface-raised)]"}`}
                    onClick={() => onOpenSession(session)}
                  >
                    {wantsYou && (
                      heuristic
                        ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 border-l-2 border-dashed border-[var(--accent)]" data-attention-edge="inferred" />
                        : <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-[var(--accent)]" />
                    )}
                    <span className="flex items-center gap-2">
                      {working && <LoaderCircle size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--text-muted)] motion-safe:animate-spin" />}
                      {session.boardState === "failed" && <CircleX size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--danger)]" />}
                      <span className={`min-w-0 flex-1 truncate leading-[1.3] ${wantsYou ? "text-title-sm text-[var(--text)]" : working ? "text-body-sm font-medium text-[var(--text)]" : "text-body-sm font-medium text-[var(--text-secondary)]"}`}>
                        {session.name}
                      </span>
                      {session.remote && (
                        <span className="flex shrink-0 items-center gap-1.5 font-mono text-code-xs leading-none text-[var(--remote)]">
                          <Server size={11} strokeWidth={1.75} aria-hidden="true" />{session.hostLabel}
                        </span>
                      )}
                      <time className={`shrink-0 font-mono text-code-xs leading-none ${wantsYou ? "text-[var(--accent-quiet)]" : "text-[var(--text-faint)]"}`} dateTime={session.updatedAt ?? undefined}>
                        {relativeTime(session.updatedAt)}
                      </time>
                    </span>
                    {/*
                      Heuristic attention stays muted so an inferred line never
                      reads as an answerable one (spec 05 R5).
                    */}
                    <span className={`line-clamp-3 ${wantsYou ? "mt-[7px] text-meta" : "mt-1.5 text-meta-sm"} ${heuristic ? "text-[var(--text-muted)]" : wantsYou ? "text-[var(--wants-text)]" : "text-[var(--text-muted)]"}`}>
                      {session.stateLine}
                    </span>
                    {session.todo && session.todo.total > 0 && (
                      <TodoProgressMeter todo={session.todo} className="mt-2" />
                    )}
                    <SessionIdentityBadges session={session} className="mt-[9px]" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
