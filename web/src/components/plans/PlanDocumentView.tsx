import { useEffect, useRef, useState } from "react";
import { Bolt, Copy, Download, FileText, LoaderCircle, X } from "lucide-react";
import type { PlanFileResponse } from "../../lib/api";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, Separator } from "../ui";
import { PlanMarkdown } from "./PlanMarkdown";
import type { PlanArtifactView } from "./model";

type DocumentState =
  | { kind: "loading" }
  | { kind: "loaded"; file: PlanFileResponse }
  | { kind: "unavailable"; message: string };

function unavailableMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The provider-named plan file could not be read safely.";
}

function downloadName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || "plan.md";
}

function downloadHref(markdown: string): string {
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;
}

export function PlanDocumentView({
  plan,
  loadFile,
  onClose,
  onExecute,
  disabled = false,
}: {
  plan: PlanArtifactView;
  loadFile: () => Promise<PlanFileResponse>;
  onClose: () => void;
  onExecute?: (plan: PlanArtifactView) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<DocumentState>({ kind: "loading" });
  const requestRef = useRef<Promise<PlanFileResponse> | null>(null);
  // The plan artifact's own disclosure opens this, and it is not a
  // `DialogTrigger`, so the document remembers the opener and restores it.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const request = requestRef.current ?? Promise.resolve().then(loadFile);
    requestRef.current = request;
    void request.then((file) => {
      if (!cancelled) setState({ kind: "loaded", file });
    }).catch((error: unknown) => {
      if (!cancelled) setState({ kind: "unavailable", message: unavailableMessage(error) });
    });
    return () => { cancelled = true; };
  }, [loadFile]);

  const displayedPath = state.kind === "loaded" ? state.file.path : plan.path;
  const executeLabel = plan.version === null ? "Execute this plan" : `Execute v${plan.version}`;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true }); }}
        showCloseButton={false}
        data-plan-document-view
        data-plan-file-state={state.kind}
        className="flex h-[min(860px,calc(100dvh-3rem))] max-w-[880px] flex-col gap-0 bg-[var(--ground)] p-0"
      >
        <DialogTitle className="sr-only">Plan document</DialogTitle>
        <header className="flex min-h-14 shrink-0 items-center gap-2 px-3 sm:px-5">
          <FileText size={15} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left font-mono text-code-sm text-[var(--text-muted)] [direction:rtl]" title={displayedPath ?? undefined}>{displayedPath}</span>
          {displayedPath && <Button variant="ghost" size="icon" data-compact-control className="size-10 shrink-0 sm:size-9" aria-label="Copy plan path" onClick={() => void navigator.clipboard?.writeText(displayedPath)}><Copy size={14} /></Button>}
          {state.kind === "loaded" && <Button asChild variant="ghost" size="icon" data-compact-control className="size-10 shrink-0 sm:size-9"><a aria-label={state.file.truncated ? "Download retained plan prefix" : "Download plan file"} href={downloadHref(state.file.markdown)} download={downloadName(state.file.path)}><Download size={14} /></a></Button>}
          <DialogClose asChild>
            <Button variant="ghost" size="icon" data-compact-control className="size-10 shrink-0 sm:size-9" aria-label="Close plan document"><X size={16} /></Button>
          </DialogClose>
        </header>
        <Separator className="shrink-0" />

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
          {state.kind === "loading" && <div className="grid min-h-full place-content-center gap-2 text-center text-meta-sm text-[var(--text-muted)]"><LoaderCircle className="mx-auto motion-safe:animate-spin" size={18} /><p>Loading provider-named plan file…</p></div>}
          {state.kind === "unavailable" && <section className="mx-auto grid min-h-full max-w-lg place-content-center text-center" aria-label="Plan file unavailable"><h3 className="text-title-sm">Plan file unavailable</h3><p className="mt-2 text-meta-sm leading-5 text-[var(--text-muted)]">{state.message}</p><p className="mt-3 font-mono text-code-xs text-[var(--text-faint)]">No inline fallback is substituted for this filesystem read.</p></section>}
          {state.kind === "loaded" && <div className="mx-auto max-w-3xl"><PlanMarkdown markdown={state.file.markdown} />{state.file.truncated && <p className="mt-4 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3 text-meta-sm text-[var(--warning)]">This file exceeded the safe read limit. Only its retained prefix is shown.</p>}</div>}
        </main>

        <Separator className="shrink-0" />
        <footer className="safe-area-bottom flex min-h-14 shrink-0 flex-wrap items-center gap-3 px-3 py-2 sm:px-5">
          <span className="font-mono text-code-xs text-[var(--text-faint)]">Current provider artifact · no preserved revision history reported</span>
          <span className="min-w-0 flex-1" />
          {/* R3: executing the plan is the operator's own action, so it is the lime one. */}
          {onExecute && plan.approvedAt === null && <Button variant="primary" size="touch" disabled={disabled || state.kind !== "loaded" || state.file.truncated} onClick={() => void onExecute(plan)}><Bolt size={13} />{executeLabel}</Button>}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
