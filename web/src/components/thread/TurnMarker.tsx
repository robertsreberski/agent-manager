import { GitBranch } from "lucide-react";

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
 */
export function TurnMarker({ facts }: { facts: TurnFacts }) {
  const endedAt = facts.endedAt ? new Date(facts.endedAt) : null;
  const ended = endedAt && !Number.isNaN(endedAt.getTime())
    ? `turn ended ${endedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`
    : null;
  const hasDiff = facts.additions !== null || facts.removals !== null;
  if (!ended && facts.duration === null && facts.subagents === null && !hasDiff && facts.tokens === null && facts.costUsd === null) return null;
  return (
    <div className="mt-[18px] flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-hairline)] pt-[11px] font-mono text-code-xs text-[var(--text-muted)]">
      {ended && <span>{ended}</span>}
      {facts.duration && <span>{facts.duration}</span>}
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
      {facts.tokens !== null && <span>{facts.tokens.toLocaleString()} tokens</span>}
      {facts.costUsd !== null && <span className="text-[var(--text-muted)]">{formatCost(facts.costUsd)}</span>}
    </div>
  );
}
