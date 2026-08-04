import { useEffect, useMemo, useRef, useState } from "react";
import { Command, File, GitBranch, Hash, Search, Server, Terminal } from "lucide-react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { groupPaletteResults, paletteResults, type PaletteEntry, type PaletteKind, type PaletteSources } from "./registry";

const ICON: Record<PaletteKind, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  session: Terminal, command: Command, transcript: Hash, file: File, slash: Terminal, host: Server, worktree: GitBranch,
};

function sessionDot(state: PaletteEntry["boardState"]): string {
  if (state === "wants-you") return "bg-[var(--accent)]";
  if (state === "working") return "bg-[var(--text-muted)]";
  if (state === "failed") return "bg-[var(--danger)]";
  return "bg-[var(--border)]";
}

export function CommandPalette({
  open,
  sources,
  onOpenChange,
  onChoose,
  onQueryChange,
}: {
  open: boolean;
  sources: PaletteSources;
  onOpenChange: (open: boolean) => void;
  onChoose: (entry: PaletteEntry) => void;
  onQueryChange?: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLElement>({ active: open, initialFocusRef: inputRef, onEscape: () => onOpenChange(false), priority: 70 });
  const results = useMemo(() => paletteResults(sources, query), [query, sources]);
  const groups = useMemo(() => groupPaletteResults(results), [results]);
  useEffect(() => {
    if (!open) return;
    setActive(0);
  }, [open]);
  useEffect(() => setActive((value) => Math.min(value, Math.max(0, results.length - 1))), [results.length]);
  useEffect(() => { if (open) onQueryChange?.(query); }, [onQueryChange, open, query]);
  if (!open) return null;
  function keydown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(results.length - 1, value + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
    else if (event.key === "Enter") {
      const entry = results[active];
      if (entry && !entry.disabledReason) { event.preventDefault(); onChoose(entry); onOpenChange(false); }
    }
  }
  let flatIndex = -1;
  return (
    <div className="fixed inset-0 z-[70] bg-black/70" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1} className="mx-auto mt-[110px] flex max-h-[min(620px,calc(100dvh-140px))] w-[min(600px,calc(100%-24px))] flex-col border border-[var(--border-frame)] bg-[var(--menu)] shadow-[0_30px_100px_rgb(0_0_0/0.7)]">
        <label className="flex min-h-14 items-center gap-3 border-b border-[var(--rule)] px-4"><Search size={16} /><span className="sr-only">Search anything</span><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={keydown} className="min-w-0 flex-1 border-0 bg-transparent text-[15px] outline-none" placeholder="Sessions, commands, # transcript…" /><kbd className="font-mono text-[10px] text-[var(--text-faint)]">esc</kbd></label>
        <div className="overflow-y-auto py-2" role="listbox">
          {groups.map((group) => (
            <section key={group.kind} aria-label={group.kind}>
              <h2 className="px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">{group.kind}</h2>
              {group.entries.map((entry) => {
                flatIndex++;
                const index = flatIndex;
                const Icon = ICON[entry.kind];
                return <button key={entry.id} type="button" role="option" aria-selected={active === index} disabled={Boolean(entry.disabledReason)} data-compact-control className="flex min-h-9 w-full items-center gap-2 px-4 text-left text-[13px] aria-selected:bg-[var(--surface-selected)] disabled:opacity-40" onMouseEnter={() => setActive(index)} onClick={() => { onChoose(entry); onOpenChange(false); }}>{entry.kind === "session" ? <span className={`size-[7px] shrink-0 rounded-full ${sessionDot(entry.boardState)}`} data-palette-session-state={entry.boardState ?? "idle"} aria-hidden="true" /> : <Icon size={13} strokeWidth={1.75} />}<span className="min-w-0 flex-1 truncate">{entry.label}{entry.detail && <span className="text-[var(--text-muted)]"> · {entry.detail}</span>}</span>{entry.progress && <span className="shrink-0 font-mono text-[11px] text-[var(--text-faint)]" data-palette-todo-progress>{entry.progress.completed} of {entry.progress.total}</span>}</button>;
              })}
            </section>
          ))}
          {results.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-[var(--text-muted)]">No results from the available sources.</p>}
        </div>
      </section>
    </div>
  );
}
