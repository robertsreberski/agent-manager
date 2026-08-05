import { useEffect, useRef, useState } from "react";

import type { HostOption } from "../../types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui";

/**
 * The folder a new thread runs in: a host, a path, and the directories the
 * server confirms exist under it.
 *
 * Only server-confirmed suggestions are offered — the browser never guesses at
 * a filesystem it cannot see — and the operator can still type a path the
 * completer did not offer.
 */
export function FolderPicker({
  hostId,
  hosts,
  path,
  onPathChange,
  onHostChange,
  onComplete,
}: {
  hostId: string;
  hosts: readonly HostOption[];
  path: string;
  onPathChange: (path: string) => void;
  onHostChange: (hostId: string) => void;
  onComplete: (hostId: string, path: string) => Promise<readonly string[]>;
}) {
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHighlighted(0);
    if (dismissed || path.trim().length === 0) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    // Typing continues while a lookup is in flight; a stale answer must never
    // replace the one for what is in the field now.
    const timer = setTimeout(() => {
      void onComplete(hostId, path)
        .then((paths) => { if (!cancelled) setSuggestions(paths); })
        .catch(() => { if (!cancelled) setSuggestions([]); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [dismissed, hostId, onComplete, path]);

  const visible = suggestions.filter((suggestion) => suggestion !== path.trim());

  function choose(suggestion: string) {
    onPathChange(suggestion);
    setSuggestions([]);
    inputRef.current?.focus();
  }

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (visible.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + visible.length) % visible.length);
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && highlighted > 0)) {
      event.preventDefault();
      choose(visible[highlighted]!);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      setSuggestions([]);
    }
  }

  return (
    <div className="mx-auto mt-4 max-w-lg text-left">
      <span className="font-mono text-eyebrow uppercase text-[var(--text-faint)]">Folder</span>
      <div className="mt-1 flex">
        {/*
          Changing host clears the path: a folder discovered on one machine
          is not a claim about any other, so the draft never carries it over.
        */}
        <Select value={hostId} onValueChange={onHostChange}>
          <SelectTrigger size="touch" aria-label="Host" className="max-w-36 shrink-0 border-[var(--border)] bg-[var(--menu)] px-2"><SelectValue /></SelectTrigger>
          <SelectContent>{hosts.map((host) => <SelectItem key={host.id} value={host.id}>{host.label}</SelectItem>)}</SelectContent>
        </Select>
        <input
          ref={inputRef}
          value={path}
          onChange={(event) => { setDismissed(false); onPathChange(event.target.value); }}
          onKeyDown={keyDown}
          className="min-h-11 min-w-0 flex-1 border border-l-0 border-[var(--border)] bg-transparent px-3 font-mono text-code-sm"
          placeholder="/path/to/repository"
          aria-label="Workspace folder"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {visible.length > 0 && (
        <ul
          className="mt-1 max-h-52 overflow-y-auto overscroll-contain border border-[var(--border)] bg-[var(--menu)]"
          role="listbox"
          aria-label="Folder suggestions"
        >
          {visible.map((suggestion, index) => (
            <li key={suggestion}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                data-compact-control="height"
                className={`flex min-h-9 w-full min-w-0 px-2.5 py-1.5 text-left font-mono text-code-sm ${index === highlighted ? "bg-[var(--surface-selected)] text-[var(--text)]" : "text-[var(--text-secondary)]"}`}
                onMouseEnter={() => setHighlighted(index)}
                // Blur would close the list before the click landed.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(suggestion)}
              >
                <span className="min-w-0 flex-1 truncate">{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
