import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Files, X } from "lucide-react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { DIFF_PARSE_DEBOUNCE_MS, DiffViewer, type FileChangeView } from "./DiffViewer";
import { parseUnifiedDiff } from "./parser";

type DiffCounts = { add: number; remove: number } | null;

function stableFileIdentity(item: FileChangeView): string {
  return JSON.stringify([item.operation, item.previousPath, item.path]);
}

function useCoalescedCounts(changes: readonly FileChangeView[]): DiffCounts[] {
  const upserting = changes.some((item) => item.upserting);
  const [settled, setSettled] = useState<readonly FileChangeView[]>(changes);

  useEffect(() => {
    if (!upserting) {
      setSettled((current) => current === changes ? current : changes);
      return;
    }
    const timer = window.setTimeout(() => setSettled(changes), DIFF_PARSE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [changes, upserting]);

  const parseTarget = upserting ? settled : changes;
  const parsedByFile = useMemo(() => new Map(parseTarget.map((item) => [
    stableFileIdentity(item),
    parseCounts(item.diff, item.truncated),
  ])), [parseTarget]);
  return changes.map((item) => parsedByFile.get(stableFileIdentity(item)) ?? null);
}

function CountPair({ counts }: { counts: DiffCounts }) {
  if (!counts) return <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]">counts unavailable</span>;
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-[10.5px]">
      <span className="text-[var(--added)]">+{counts.add}</span>
      <span className="text-[var(--removed)]">−{counts.remove}</span>
    </span>
  );
}

function FileChoice({
  item,
  counts,
  current,
  read,
  onSelect,
}: {
  item: FileChangeView;
  counts: DiffCounts;
  current: boolean;
  read: boolean;
  onSelect: () => void;
}) {
  const displayPath = `${item.previousPath && item.operation === "rename" ? `${item.previousPath} → ` : ""}${item.path}`;
  const accessibleCounts = counts ? `+${String(counts.add)}, −${String(counts.remove)}` : "counts unavailable";
  return (
    <button type="button" aria-label={`${displayPath}, ${accessibleCounts}${read ? ", read" : ""}`} aria-current={current ? "true" : undefined} className="flex min-h-11 w-full items-center gap-2 border-b border-[var(--rule)] px-3 text-left aria-current:bg-[var(--surface-selected)]" onClick={onSelect}>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{displayPath}</span>
      <CountPair counts={counts} />
      <span className="grid w-4 place-items-center">{read && <Check size={12} aria-label="Read" />}</span>
    </button>
  );
}

export function DiffReview({
  changes,
  branch,
  uncommitted,
  readKeys,
  onReadChange,
  onOpenEditor,
  resolveEditorPath,
  onClose,
}: {
  changes: readonly FileChangeView[];
  branch: string | null;
  uncommitted: boolean | null;
  readKeys: ReadonlySet<string>;
  onReadChange: (key: string, read: boolean) => void;
  onOpenEditor?: (path: string) => void;
  resolveEditorPath?: (path: string) => string | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [phoneFilesOpen, setPhoneFilesOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useModalFocus<HTMLElement>({ active: true, initialFocusRef: closeRef, onEscape: onClose, priority: 50 });
  const sheetRef = useModalFocus<HTMLElement>({ active: phoneFilesOpen, initialFocusRef: sheetCloseRef, onEscape: () => setPhoneFilesOpen(false), priority: 55 });
  const selectedIndex = Math.min(selected, Math.max(0, changes.length - 1));
  const change = changes[selectedIndex] ?? null;
  const editorPath = change && resolveEditorPath ? resolveEditorPath(change.path) : null;
  const counts = useCoalescedCounts(changes);
  const totals = useMemo<DiffCounts>(() => counts.reduce<DiffCounts>((sum, value) => (
    !sum || !value ? null : { add: sum.add + value.add, remove: sum.remove + value.remove }
  ), { add: 0, remove: 0 }), [counts]);
  return (
    <section ref={reviewRef} role="dialog" aria-modal="true" aria-label="Review changes" tabIndex={-1} className="absolute inset-0 z-50 flex min-w-0 max-w-full flex-col overflow-hidden bg-[var(--app)]">
      <header className="flex min-h-12 min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--rule)] px-3 py-2 min-[901px]:flex-nowrap min-[901px]:px-4">
        <strong className="shrink-0 text-sm">Review changes</strong>{branch && <span className="min-w-0 max-w-28 truncate font-mono text-[11px] text-[var(--text-muted)] min-[901px]:max-w-56">{branch}</span>}<span className="order-3 w-full min-w-0 truncate font-mono text-[11px] text-[var(--text-muted)] min-[901px]:order-none min-[901px]:w-auto">{changes.length} files · {totals ? <><span className="text-[var(--added)]">+{totals.add}</span> <span className="text-[var(--removed)]">−{totals.remove}</span></> : <span>counts unavailable</span>}{uncommitted === true ? " · uncommitted" : uncommitted === false ? " · no uncommitted changes" : ""}</span>
        <button ref={closeRef} type="button" data-compact-control className="ml-auto grid size-9 place-items-center" aria-label="Close review" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav data-desktop-file-rail className="hidden w-[268px] shrink-0 overflow-y-auto border-r border-[var(--rule)] min-[901px]:block" aria-label="Changed files">
          {changes.map((item, index) => <FileChoice key={item.readKey} item={item} counts={counts[index] ?? null} current={index === selectedIndex} read={readKeys.has(item.readKey)} onSelect={() => setSelected(index)} />)}
        </nav>
        <main data-diff-scroll-container className="min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto p-2 min-[390px]:p-3">{change ? <DiffViewer key={stableFileIdentity(change)} change={change} initiallyOpen read={readKeys.has(change.readKey)} onReadChange={onReadChange} {...(onOpenEditor && editorPath ? { onOpenEditor: () => onOpenEditor(editorPath) } : {})} /> : <p className="p-6 text-center text-sm text-[var(--text-muted)]">No file changes in this turn.</p>}</main>
      </div>
      {change && <footer data-phone-file-footer className="safe-area-bottom flex min-h-12 items-center justify-between gap-1 border-t border-[var(--rule)] px-2 min-[390px]:px-3 min-[901px]:hidden"><button type="button" className="flex min-h-11 items-center gap-1.5 px-1 text-[12.5px] min-[390px]:px-2 min-[390px]:text-sm" aria-haspopup="dialog" aria-expanded={phoneFilesOpen} aria-label={`Choose file, ${String(selectedIndex + 1)} of ${String(changes.length)}`} onClick={() => setPhoneFilesOpen(true)}><Files size={15} />{selectedIndex + 1}/{changes.length}</button><button type="button" className="min-h-11 px-1 text-[12.5px] min-[390px]:px-3 min-[390px]:text-sm" onClick={() => onReadChange(change.readKey, !readKeys.has(change.readKey))}>{readKeys.has(change.readKey) ? "Mark unread" : "Mark read"}</button><button type="button" className="flex min-h-11 items-center gap-1 px-1 text-[12.5px] min-[390px]:px-2 min-[390px]:text-sm" disabled={selectedIndex >= changes.length - 1} aria-label="Next file" onClick={() => setSelected(selectedIndex + 1)}>Next<ChevronRight size={16} /></button></footer>}
      {phoneFilesOpen && <div data-phone-file-sheet className="fixed inset-0 z-[70] flex max-w-full items-end overflow-hidden bg-black/70 min-[901px]:hidden" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPhoneFilesOpen(false); }}><section ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby="changed-files-sheet-title" tabIndex={-1} className="safe-area-bottom max-h-[75dvh] w-full max-w-full overflow-hidden border-t border-[var(--border-frame)] bg-[var(--ground)]"><header className="flex min-h-12 items-center border-b border-[var(--rule)] px-3"><h2 id="changed-files-sheet-title" className="text-sm font-semibold">Changed files</h2><button ref={sheetCloseRef} type="button" data-compact-control className="ml-auto grid size-10 place-items-center" aria-label="Close changed files" onClick={() => setPhoneFilesOpen(false)}><X size={16} /></button></header><div className="max-h-[calc(75dvh-48px)] overflow-y-auto">{changes.map((item, index) => <FileChoice key={item.readKey} item={item} counts={counts[index] ?? null} current={index === selectedIndex} read={readKeys.has(item.readKey)} onSelect={() => { setSelected(index); setPhoneFilesOpen(false); }} />)}</div></section></div>}
    </section>
  );
}

function parseCounts(diff: string, truncated: boolean): DiffCounts {
  if (truncated) return null;
  const parsed = parseUnifiedDiff(diff);
  return parsed.kind === "parsed"
    ? { add: parsed.additions, remove: parsed.removals }
    : null;
}
