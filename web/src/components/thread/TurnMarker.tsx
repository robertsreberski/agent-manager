export interface TurnFacts {
  endedAt: string | null;
  duration: string | null;
  subagents: number | null;
  additions: number | null;
  removals: number | null;
  tokens: number | null;
  costUsd: number | null;
}

export function TurnMarker({ facts }: { facts: TurnFacts }) {
  const values = [
    facts.endedAt ? new Date(facts.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null,
    facts.duration,
    facts.subagents !== null ? `${facts.subagents} ${facts.subagents === 1 ? "subagent" : "subagents"}` : null,
    facts.additions !== null ? `+${facts.additions}` : null,
    facts.removals !== null ? `−${facts.removals}` : null,
    facts.tokens !== null ? `${facts.tokens} tokens` : null,
    facts.costUsd !== null ? `$${facts.costUsd.toFixed(4)}` : null,
  ].filter((value): value is string => value !== null);
  if (values.length === 0) return null;
  return <div className="my-5 flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--rule)] pt-2 font-mono text-[11px] text-[var(--text-faint)]">{values.map((value, index) => <span key={`${value}:${index}`}>{value}</span>)}</div>;
}
