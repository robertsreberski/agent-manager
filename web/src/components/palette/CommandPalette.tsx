import { useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandIcon, File, GitBranch, Hash, Server, Terminal } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui";
import { groupPaletteResults, paletteResults, type PaletteEntry, type PaletteKind, type PaletteSources } from "./registry";

const ICON: Record<PaletteKind, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  session: Terminal, command: CommandIcon, transcript: Hash, file: File, slash: Terminal, host: Server, worktree: GitBranch,
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
  // ⌘K and the toolbar button both open the palette through state, so there is
  // no `DialogTrigger` for Radix to hand focus back to on close. Remember what
  // the operator was on — the auto-focus event fires before focus moves in.
  const openerRef = useRef<HTMLElement | null>(null);
  const results = useMemo(() => paletteResults(sources, query), [query, sources]);
  const groups = useMemo(() => groupPaletteResults(results), [results]);
  useEffect(() => { if (open) onQueryChange?.(query); }, [onQueryChange, open, query]);
  return (
    /*
      `shouldFilter={false}` because `registry.ts` owns matching: it owns the
      prefix rules — `>` commands, `#` transcript, `@` files, `/` slash, `~`
      locations — and the honesty rule that a prefix whose source is unavailable
      returns nothing rather than guesses. cmdk's own filter scores the raw
      input, prefix character and all, so leaving it on would silently drop
      every row the registry just vouched for. Everything else — active item,
      roving focus, `aria-activedescendant`, Enter — is still cmdk's.
    */
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search sessions, commands, and this session's transcript."
      commandProps={{ shouldFilter: false }}
      contentProps={{
        onOpenAutoFocus: () => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; },
        onCloseAutoFocus: (event) => { event.preventDefault(); openerRef.current?.focus(); },
      }}
    >
      <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Sessions, commands, # transcript…"
          />
          <CommandList>
            <CommandEmpty>No results from the available sources.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.kind} heading={group.kind}>
                {group.entries.map((entry) => {
                  const Icon = ICON[entry.kind];
                  return (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      data-compact-control
                      disabled={Boolean(entry.disabledReason)}
                      {...(entry.disabledReason ? { title: entry.disabledReason } : {})}
                      onSelect={() => { onChoose(entry); onOpenChange(false); }}
                    >
                      <span className="flex w-[15px] shrink-0 justify-center text-[var(--text-muted)]">
                        {entry.kind === "session"
                          ? <span className={`size-[6px] shrink-0 self-center rounded-full ${sessionDot(entry.boardState)}`} data-palette-session-state={entry.boardState ?? "idle"} aria-hidden="true" />
                          : <Icon size={15} strokeWidth={1.75} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {entry.detail && <span className="shrink-0 truncate font-mono text-code-xs text-[var(--text-faint)]">{entry.detail}</span>}
                      {entry.progress && <span className="shrink-0 font-mono text-code-xs text-[var(--text-faint)]" data-palette-todo-progress>{entry.progress.completed} of {entry.progress.total}</span>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
    </CommandDialog>
  );
}
