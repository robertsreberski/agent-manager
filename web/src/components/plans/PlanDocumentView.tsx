import { useEffect, useRef, useState } from "react";
import { Bolt, Copy, Download, FileText, LoaderCircle, X } from "lucide-react";
import type { PlanFileResponse } from "../../lib/api";
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const requestRef = useRef<Promise<PlanFileResponse> | null>(null);

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

  useEffect(() => {
    closeRef.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(surfaceRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? [])];
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      event.stopPropagation();
      focusable[next]?.focus();
    }
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [onClose]);

  const displayedPath = state.kind === "loaded" ? state.file.path : plan.path;
  const executeLabel = plan.version === null ? "Execute this plan" : `Execute v${plan.version}`;
  return (
    <section ref={surfaceRef} className="absolute inset-0 z-[60] flex flex-col bg-[var(--ground)]" role="dialog" aria-modal="true" aria-labelledby="plan-document-title" data-plan-document-view data-plan-file-state={state.kind}>
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-[var(--rule)] px-3 sm:px-5">
        <FileText size={15} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <h2 id="plan-document-title" className="sr-only">Plan document</h2>
        <span className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-[var(--text-muted)] [direction:rtl]" title={displayedPath ?? undefined}>{displayedPath}</span>
        {displayedPath && <button type="button" className="grid size-10 shrink-0 place-items-center sm:size-9" aria-label="Copy plan path" onClick={() => void navigator.clipboard?.writeText(displayedPath)}><Copy size={14} /></button>}
        {state.kind === "loaded" && <a className="grid size-10 shrink-0 place-items-center sm:size-9" aria-label={state.file.truncated ? "Download retained plan prefix" : "Download plan file"} href={downloadHref(state.file.markdown)} download={downloadName(state.file.path)}><Download size={14} /></a>}
        <button ref={closeRef} type="button" className="grid size-10 shrink-0 place-items-center sm:size-9" aria-label="Close plan document" onClick={onClose}><X size={16} /></button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
        {state.kind === "loading" && <div className="grid min-h-full place-content-center gap-2 text-center text-[12.5px] text-[var(--text-muted)]"><LoaderCircle className="mx-auto motion-safe:animate-spin" size={18} /><p>Loading provider-named plan file…</p></div>}
        {state.kind === "unavailable" && <section className="mx-auto grid min-h-full max-w-lg place-content-center text-center" aria-label="Plan file unavailable"><h3 className="text-[15px] font-semibold">Plan file unavailable</h3><p className="mt-2 text-[12.5px] leading-5 text-[var(--text-muted)]">{state.message}</p><p className="mt-3 font-mono text-[10.5px] text-[var(--text-faint)]">No inline fallback is substituted for this filesystem read.</p></section>}
        {state.kind === "loaded" && <div className="mx-auto max-w-3xl"><PlanMarkdown markdown={state.file.markdown} />{state.file.truncated && <p className="mt-4 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3 text-[12px] text-[var(--warning)]">This file exceeded the safe read limit. Only its retained prefix is shown.</p>}</div>}
      </main>

      <footer className="safe-area-bottom flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-t border-[var(--rule)] px-3 py-2 sm:px-5">
        <span className="font-mono text-[10.5px] text-[var(--text-faint)]">Current provider artifact · no preserved revision history reported</span>
        <span className="min-w-0 flex-1" />
        {onExecute && plan.approvedAt === null && <button type="button" disabled={disabled || state.kind !== "loaded" || state.file.truncated} className="flex min-h-10 items-center justify-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[12.5px] font-medium text-[var(--accent-ink)] disabled:opacity-40" onClick={() => void onExecute(plan)}><Bolt size={13} />{executeLabel}</button>}
      </footer>
    </section>
  );
}
