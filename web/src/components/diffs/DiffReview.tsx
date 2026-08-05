import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Files, X } from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Separator,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "../ui";
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
  if (!counts) return <span className="shrink-0 font-mono text-eyebrow tracking-normal text-[var(--text-muted)]">counts unavailable</span>;
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-code-xs">
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
    <>
      <Button variant="ghost" size="touch" aria-label={`${displayPath}, ${accessibleCounts}${read ? ", read" : ""}`} aria-current={current ? "true" : undefined} className="w-full justify-start gap-2 px-3 text-left text-[var(--text)] aria-current:bg-[var(--surface-selected)]" onClick={onSelect}>
        <span className="min-w-0 flex-1 truncate font-mono text-code-xs">{displayPath}</span>
        <CountPair counts={counts} />
        <span className="grid w-4 place-items-center">{read && <Check size={12} aria-label="Read" />}</span>
      </Button>
      <Separator />
    </>
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
  const phoneSheetId = useId();
  // Neither surface has a `DialogTrigger` for Radix to hand focus back to — the
  // review opens from ⌘⇧D or the palette — so each remembers its own opener.
  const reviewOpenerRef = useRef<HTMLElement | null>(null);
  const sheetOpenerRef = useRef<HTMLElement | null>(null);
  const selectedIndex = Math.min(selected, Math.max(0, changes.length - 1));
  const change = changes[selectedIndex] ?? null;
  const editorPath = change && resolveEditorPath ? resolveEditorPath(change.path) : null;
  const counts = useCoalescedCounts(changes);
  const totals = useMemo<DiffCounts>(() => counts.reduce<DiffCounts>((sum, value) => (
    !sum || !value ? null : { add: sum.add + value.add, remove: sum.remove + value.remove }
  ), { add: 0, remove: 0 }), [counts]);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* The review is a full surface, not a frame: it takes the whole viewport
          at every width, so the centred frame geometry is overridden away. */}
      <DialogContent
        onOpenAutoFocus={() => { reviewOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (reviewOpenerRef.current?.isConnected) reviewOpenerRef.current.focus({ preventScroll: true }); }}
        showCloseButton={false}
        className="inset-0 flex h-full w-full min-w-0 max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-[var(--app)] p-0 shadow-none"
      >
        <header className="flex min-h-12 min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 min-[901px]:flex-nowrap min-[901px]:px-4">
          <DialogTitle className="shrink-0 pr-0 text-body-sm font-semibold">Review changes</DialogTitle>{branch && <span className="min-w-0 max-w-28 truncate font-mono text-code-xs text-[var(--text-muted)] min-[901px]:max-w-56">{branch}</span>}<span className="order-3 w-full min-w-0 truncate font-mono text-code-xs text-[var(--text-muted)] min-[901px]:order-none min-[901px]:w-auto">{changes.length} files · {totals ? <><span className="text-[var(--added)]">+{totals.add}</span> <span className="text-[var(--removed)]">−{totals.remove}</span></> : <span>counts unavailable</span>}{uncommitted === true ? " · uncommitted" : uncommitted === false ? " · no uncommitted changes" : ""}</span>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" data-compact-control className="ml-auto size-9" aria-label="Close review"><X size={16} /></Button>
          </DialogClose>
        </header>
        <Separator className="shrink-0" />
        <div className="flex min-h-0 flex-1">
          <nav data-desktop-file-rail className="hidden w-[268px] shrink-0 overflow-y-auto min-[901px]:block" aria-label="Changed files">
            {changes.map((item, index) => <FileChoice key={item.readKey} item={item} counts={counts[index] ?? null} current={index === selectedIndex} read={readKeys.has(item.readKey)} onSelect={() => setSelected(index)} />)}
          </nav>
          <Separator orientation="vertical" className="hidden min-[901px]:block" />
          <main data-diff-scroll-container className="min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto p-2 min-[390px]:p-3">{change ? <DiffViewer key={stableFileIdentity(change)} change={change} initiallyOpen read={readKeys.has(change.readKey)} onReadChange={onReadChange} {...(onOpenEditor && editorPath ? { onOpenEditor: () => onOpenEditor(editorPath) } : {})} /> : <p className="p-6 text-center text-body-sm text-[var(--text-muted)]">No file changes in this turn.</p>}</main>
        </div>
        {change && <>
          <Separator className="shrink-0 min-[901px]:hidden" />
          <footer data-phone-file-footer className="safe-area-bottom flex min-h-12 items-center justify-between gap-1 px-2 min-[390px]:px-3 min-[901px]:hidden">
            {/*
              This chooser cannot be a `SheetTrigger`: the sheet's Root shares
              Radix's default dialog scope, so nesting it around this footer
              would steal the review's own content context. It names the layer
              it opens by id instead, which is what a bare `aria-expanded` here
              never did.
            */}
            <Button variant="ghost" size="touch" className="gap-1.5 px-1 text-meta-sm min-[390px]:px-2 min-[390px]:text-body-sm" aria-haspopup="dialog" aria-expanded={phoneFilesOpen} {...(phoneFilesOpen ? { "aria-controls": phoneSheetId } : {})} aria-label={`Choose file, ${String(selectedIndex + 1)} of ${String(changes.length)}`} onClick={() => setPhoneFilesOpen(true)}><Files size={15} />{selectedIndex + 1}/{changes.length}</Button>
            <Button variant="ghost" size="touch" className="px-1 text-meta-sm min-[390px]:px-3 min-[390px]:text-body-sm" onClick={() => onReadChange(change.readKey, !readKeys.has(change.readKey))}>{readKeys.has(change.readKey) ? "Mark unread" : "Mark read"}</Button>
            <Button variant="ghost" size="touch" className="gap-1 px-1 text-meta-sm min-[390px]:px-2 min-[390px]:text-body-sm" disabled={selectedIndex >= changes.length - 1} aria-label="Next file" onClick={() => setSelected(selectedIndex + 1)}>Next<ChevronRight size={16} /></Button>
          </footer>
        </>}

      </DialogContent>

      {/* The phone file chooser is the layer above the review: Radix stacks it,
          so its Escape closes it alone and hands focus back to the chooser. */}
      <Sheet open={phoneFilesOpen} onOpenChange={setPhoneFilesOpen}>
        <SheetContent
          onOpenAutoFocus={() => { sheetOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(event) => { event.preventDefault(); if (sheetOpenerRef.current?.isConnected) sheetOpenerRef.current.focus({ preventScroll: true }); }}
          id={phoneSheetId}
          side="bottom"
          showCloseButton={false}
          data-phone-file-sheet
          className="max-h-[75dvh] max-w-full gap-0 overflow-hidden rounded-t-[var(--radius-sheet)] border-t-[var(--border-frame)] bg-[var(--ground)] p-0 pb-0 shadow-[var(--shadow-sheet-bottom)] min-[901px]:hidden"
        >
          <header className="flex min-h-12 shrink-0 items-center px-3">
            <SheetTitle className="pr-0 text-body-sm font-semibold">Changed files</SheetTitle>
            <SheetClose asChild>
              <Button variant="ghost" size="icon" data-compact-control className="ml-auto size-10" aria-label="Close changed files"><X size={16} /></Button>
            </SheetClose>
          </header>
          <Separator className="shrink-0" />
          <div className="safe-area-bottom min-h-0 flex-1 overflow-y-auto">
            {changes.map((item, index) => <FileChoice key={item.readKey} item={item} counts={counts[index] ?? null} current={index === selectedIndex} read={readKeys.has(item.readKey)} onSelect={() => { setSelected(index); setPhoneFilesOpen(false); }} />)}
          </div>
        </SheetContent>
      </Sheet>
    </Dialog>
  );
}

function parseCounts(diff: string, truncated: boolean): DiffCounts {
  if (truncated) return null;
  const parsed = parseUnifiedDiff(diff);
  return parsed.kind === "parsed"
    ? { add: parsed.additions, remove: parsed.removals }
    : null;
}
