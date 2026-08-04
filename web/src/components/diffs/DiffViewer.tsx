import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import { parseUnifiedDiff, splitRows, type DiffParseResult, type ParsedDiffLine } from "./parser";

export interface FileChangeView {
  path: string;
  previousPath: string | null;
  operation: "add" | "update" | "delete" | "rename";
  diff: string;
  truncated: boolean;
  readKey: string;
  /** True while the provider can replace this full diff with another upsert. */
  upserting: boolean;
}

export const DIFF_PARSE_DEBOUNCE_MS = 120;

function useCoalescedDiffParse(diff: string, upserting: boolean): DiffParseResult {
  const [settledDiff, setSettledDiff] = useState(diff);

  useEffect(() => {
    if (!upserting) {
      // A terminal activity state is authoritative. Seed any later active turn
      // with the final text, while parsing this completion synchronously below.
      setSettledDiff((current) => current === diff ? current : diff);
      return;
    }
    const timer = window.setTimeout(() => setSettledDiff(diff), DIFF_PARSE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [diff, upserting]);

  // Running file-change notifications are full replacements rather than token
  // appends, so parse only the latest settled replacement. Completion bypasses
  // the debounce to guarantee that the provider's final patch is rendered.
  const parseTarget = upserting ? settledDiff : diff;
  return useMemo(() => parseUnifiedDiff(parseTarget), [parseTarget]);
}

function Line({ line }: { line: ParsedDiffLine }) {
  const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
  const tone = line.kind === "add"
    ? "bg-[var(--added-field)] text-[var(--added)]"
    : line.kind === "remove"
    ? "bg-[var(--removed-field)] text-[var(--removed)]"
    : line.kind === "meta"
    ? "text-[var(--text-muted)]"
    : "";
  return (
    <div className={`grid min-w-0 max-w-full grid-cols-[30px_13px_minmax(0,1fr)] text-[11.5px] leading-[18px] min-[901px]:grid-cols-[38px_38px_16px_minmax(0,1fr)] min-[901px]:text-[12px] min-[901px]:leading-[19px] ${tone}`} data-diff-line={line.kind}>
      <span data-diff-gutter="old" className="hidden select-none pr-2 text-right font-mono text-[var(--text-faint)] min-[901px]:block">{line.oldLine ?? ""}</span>
      <span data-diff-gutter="phone" className="select-none pr-1 text-right font-mono text-[var(--text-faint)] min-[901px]:hidden">{line.newLine ?? line.oldLine ?? ""}</span>
      <span data-diff-gutter="new" className="hidden select-none pr-1 text-right font-mono text-[var(--text-faint)] min-[901px]:block">{line.newLine ?? ""}</span>
      <span className="select-none text-center font-mono">{sign}</span>
      <code className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{line.text}</code>
    </div>
  );
}

function ParsedDiff({ result, view }: { result: Extract<DiffParseResult, { kind: "parsed" }>; view: "unified" | "split" }) {
  return (
    <div className="overflow-hidden font-mono">
      {result.hunks.map((hunk, index) => (
        <section key={`${hunk.header}:${index}`}>
          <div className="max-w-full bg-[var(--menu)] px-2 py-1 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-words text-[var(--text-muted)] [overflow-wrap:anywhere]">{hunk.header}</div>
          {view === "unified" ? hunk.lines.map((line, lineIndex) => <Line key={lineIndex} line={line} />) : (
            <><div data-phone-unified-diff className="min-[901px]:hidden">{hunk.lines.map((line, lineIndex) => <Line key={lineIndex} line={line} />)}</div><div data-desktop-split-diff className="hidden grid-cols-2 divide-x divide-[var(--rule)] min-[901px]:grid">
              {splitRows(hunk).map((row, rowIndex) => (
                <div key={rowIndex} className="col-span-2 grid grid-cols-2">
                  <div>{row.left && <Line line={row.left} />}</div>
                  <div>{row.right && <Line line={row.right} />}</div>
                </div>
              ))}
            </div></>
          )}
        </section>
      ))}
    </div>
  );
}

export function DiffViewer({
  change,
  initiallyOpen = true,
  read = false,
  onReadChange,
  onOpenEditor,
}: {
  change: FileChangeView;
  initiallyOpen?: boolean;
  read?: boolean;
  onReadChange?: (readKey: string, read: boolean) => void;
  onOpenEditor?: () => void;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const pendingScroll = useRef<{ element: HTMLElement; top: number; left: number } | null>(null);
  const [open, setOpen] = useState(initiallyOpen && !read);
  const [view, setView] = useState<"unified" | "split">("unified");
  const parsed = useCoalescedDiffParse(change.diff, change.upserting);
  const counts = parsed.kind === "parsed" && !change.truncated
    ? { additions: parsed.additions, removals: parsed.removals }
    : null;

  useLayoutEffect(() => {
    const scroll = pendingScroll.current;
    if (!scroll) return;
    scroll.element.scrollTop = scroll.top;
    scroll.element.scrollLeft = scroll.left;
    pendingScroll.current = null;
  }, [view]);

  function selectView(next: "unified" | "split") {
    if (next === view) return;
    const scrollContainer = articleRef.current?.closest<HTMLElement>("[data-diff-scroll-container]");
    if (scrollContainer) {
      pendingScroll.current = {
        element: scrollContainer,
        top: scrollContainer.scrollTop,
        left: scrollContainer.scrollLeft,
      };
    }
    setView(next);
  }

  return (
    <article ref={articleRef} className="min-w-0 max-w-full overflow-hidden border border-[var(--border)]" data-read={read}>
      <header className="flex min-h-10 min-w-0 max-w-full items-center gap-2 px-2.5">
        <button type="button" data-compact-control className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronDown size={13} className={open ? "rotate-180" : ""} />
          <span className="min-w-0 truncate font-mono text-[11.5px]">{change.previousPath && change.operation === "rename" ? `${change.previousPath} → ` : ""}{change.path}</span>
        </button>
        {counts ? <><span className="font-mono text-[10.5px] text-[var(--added)]">+{counts.additions}</span><span className="font-mono text-[10.5px] text-[var(--removed)]">−{counts.removals}</span></> : <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]" aria-label="Diff counts unavailable">counts unavailable</span>}
        {read && <Check size={13} className="text-[var(--text-muted)]" aria-label="Read" />}
        <button type="button" data-compact-control className="grid size-7 place-items-center" aria-label={`Copy diff for ${change.path}`} onClick={() => void navigator.clipboard?.writeText(change.diff)}><Copy size={12} /></button>
      </header>
      {open && (
        <div className="border-t border-[var(--rule)]">
          <div className="flex items-center gap-2 border-b border-[var(--rule)] px-2.5 py-1.5">
            <div className="hidden min-[901px]:flex" role="group" aria-label="Diff layout">
              {(["unified", "split"] as const).map((option) => <button key={option} type="button" data-compact-control aria-pressed={view === option} className="min-h-7 border border-[var(--border)] px-2 font-mono text-[10.5px] capitalize aria-pressed:bg-[var(--surface-selected)]" onClick={() => selectView(option)}>{option}</button>)}
            </div>
            <span className="flex-1" />
            {onOpenEditor && change.operation !== "delete" && <button type="button" data-compact-control className="flex min-h-7 items-center gap-1 px-2 text-[11px] text-[var(--accent-quiet)]" onClick={() => onOpenEditor()}><ExternalLink size={12} />Open in editor</button>}
            <button type="button" data-compact-control className="hidden min-h-7 px-2 text-[11px] min-[901px]:block" onClick={() => onReadChange?.(change.readKey, !read)}>{read ? "Mark unread" : "Mark read"}</button>
          </div>
          {change.truncated && <p className="border-b border-[var(--warning)] bg-[var(--warning-field)] px-3 py-2 text-[11.5px] text-[var(--warning)]">This patch is truncated. Lines after this boundary are not shown.</p>}
          {parsed.kind === "parsed" ? <ParsedDiff result={parsed} view={view} /> : parsed.kind === "marker" ? <p className="max-w-full p-3 font-mono text-[12px] whitespace-pre-wrap break-words text-[var(--text-muted)] [overflow-wrap:anywhere]">{parsed.text}</p> : <pre data-raw-diff className="max-w-full overflow-x-hidden p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{parsed.raw}</pre>}
        </div>
      )}
    </article>
  );
}
