import { GitBranch } from "lucide-react";
import { useMessageTiming } from "@assistant-ui/react";
import { MessageTiming } from "../assistant-ui/message-timing";

export interface TurnFacts {
  endedAt: string | null;
  duration: string | null;
  subagents: number | null;
  additions: number | null;
  removals: number | null;
  tokens: number | null;
  costUsd: number | null;
}

function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

/**
 * Frame 11b: a hairline closes the turn and carries only the facts the provider
 * supplied — end time, duration, delegation, diff totals, tokens, cost. A `null`
 * fact renders as absent, never as a zero (spec 05 R12).
 *
 * The duration, token count and rate now live in assistant-ui's `MessageTiming`
 * badge, which puts them behind a hover rather than in the row. The badge reads
 * `metadata.timing`, which `activityToThreadMessages` fills from the provider's
 * own span and usage totals; it renders nothing when the provider stated no
 * span, so the inline duration stays as the fallback for exactly that case.
 */
export function TurnMarker({ facts }: { facts: TurnFacts }) {
  // The badge and the row must not both state the span. Where the provider gave
  // one the badge owns it, along with the tokens and rate in its popover;
  // where it did not, the badge renders nothing and the row says what it can.
  const timing = useMessageTiming();
  const timed = timing?.totalStreamTime !== undefined;
  const endedAt = facts.endedAt ? new Date(facts.endedAt) : null;
  const ended = endedAt && !Number.isNaN(endedAt.getTime())
    ? `turn ended ${endedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`
    : null;
  const hasDiff = facts.additions !== null || facts.removals !== null;
  if (!ended && facts.duration === null && facts.subagents === null && !hasDiff && facts.tokens === null && facts.costUsd === null) return null;
  return (
    <div className="mt-[18px] flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-hairline)] pt-[11px] font-mono text-code-xs text-[var(--text-muted)]">
      {ended && <span>{ended}</span>}
      {timed ? <MessageTiming /> : facts.duration && <span data-turn-duration>{facts.duration}</span>}
      {facts.subagents !== null && (
        <>
          <span className="hidden h-[11px] w-px bg-[var(--border-frame)] sm:block" />
          <span className="inline-flex items-center gap-1.5 text-[var(--remote-dim)]">
            <GitBranch size={12} strokeWidth={1.75} className="text-[var(--remote)]" />
            {facts.subagents} {facts.subagents === 1 ? "subagent" : "subagents"}
          </span>
        </>
      )}
      <span className="hidden min-w-0 flex-1 sm:block" />
      {hasDiff && (
        <span className="inline-flex shrink-0 gap-[7px]">
          {facts.additions !== null && <span className="text-[var(--added)]">+{facts.additions}</span>}
          {facts.removals !== null && <span className="text-[var(--removed)]">−{facts.removals}</span>}
        </span>
      )}
      {/* The popover carries the token count wherever the badge is shown. */}
      {!timed && facts.tokens !== null && <span>{facts.tokens.toLocaleString()} tokens</span>}
      {facts.costUsd !== null && <span className="text-[var(--text-muted)]">{formatCost(facts.costUsd)}</span>}
    </div>
  );
}
