import { useCallback, useEffect, useState } from "react";
import { Bolt, Check, ChevronDown, Copy, FileText, Maximize2, MessageSquareReply } from "lucide-react";
import type { PlanFileResponse } from "../../lib/api";
import { PlanDocumentView } from "./PlanDocumentView";
import { PlanMarkdown } from "./PlanMarkdown";
import { planHeading, type PlanArtifactView } from "./model";

export function PlanPath({ path, onOpen }: { path: string | null; onOpen?: () => void }) {
  if (!path) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 bg-[var(--surface-raised)] px-2 py-1 font-mono text-[11.5px] text-[var(--text-muted)]">
      <FileText size={12} strokeWidth={1.75} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left [direction:rtl]" title={path}>{path}</span>
      <button type="button" className="grid size-6 shrink-0 place-items-center" aria-label="Copy plan path" onClick={() => void navigator.clipboard?.writeText(path)}><Copy size={12} /></button>
      {onOpen && <button type="button" className="grid size-6 shrink-0 place-items-center" aria-label="Open plan document" onClick={onOpen}><Maximize2 size={12} /></button>}
    </span>
  );
}

export function PlanArtifact({
  plan,
  onExecute,
  onSendBack,
  loadFile,
  disabled = false,
}: {
  plan: PlanArtifactView;
  onExecute?: (plan: PlanArtifactView) => Promise<void> | void;
  onSendBack?: (plan: PlanArtifactView, notes: string) => Promise<void> | void;
  loadFile?: (itemId: string) => Promise<PlanFileResponse>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(plan.approvedAt === null);
  const [reviewing, setReviewing] = useState(false);
  const [notes, setNotes] = useState("");
  const [fileOpen, setFileOpen] = useState(false);
  const approved = plan.approvedAt !== null;
  const versionLabel = plan.version === null ? null : `v${plan.version}`;
  useEffect(() => {
    if (!approved) return;
    setOpen(false);
    setReviewing(false);
  }, [approved]);
  const loadDocument = useCallback(() => {
    if (!loadFile) return Promise.reject(new Error("Plan file loading is unavailable."));
    return loadFile(plan.id);
  }, [loadFile, plan.id]);
  return (
    <article className="border border-[var(--border)]" data-plan-version={plan.version ?? undefined}>
      <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <FileText size={15} className="text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{approved ? versionLabel ? `Executing ${versionLabel}` : "Executing plan" : "Wrote a plan"} · <strong>{planHeading(plan.markdown)}</strong></span>
        {versionLabel && <span className="bg-[var(--surface-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">{versionLabel}</span>}
        <ChevronDown size={13} className={open ? "rotate-180" : ""} />
      </button>
      <div className="border-t border-[var(--rule)] px-3 py-2"><PlanPath path={plan.path} {...(loadFile && plan.path ? { onOpen: () => setFileOpen(true) } : {})} /></div>
      {approved && !open && <p className="px-3 pb-3 font-mono text-[11px] text-[var(--text-muted)]">approved {new Date(plan.approvedAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>}
      {open && (
        <div className="grid gap-3 border-t border-[var(--rule)] p-3">
          <PlanMarkdown markdown={plan.markdown} />
          {!approved && (
            <>
              <p className="font-mono text-[10.5px] text-[var(--text-muted)]">Nothing has run — the profile is Plan.</p>
              {reviewing && <label className="grid gap-1.5 text-[12px]"><span className="font-medium">What should change?</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-24 resize-y border border-[var(--border)] bg-[var(--surface-raised)] p-2.5 text-[13px] leading-5 outline-none focus:border-[var(--accent)]" autoFocus /></label>}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {onSendBack && (reviewing ? <button type="button" disabled={disabled || notes.trim().length === 0} className="flex min-h-10 items-center justify-center gap-1.5 border border-[var(--border)] px-3 text-[12.5px] disabled:opacity-40" onClick={() => void onSendBack(plan, notes.trim())}><MessageSquareReply size={13} />Send notes</button> : <button type="button" disabled={disabled} className="flex min-h-10 items-center justify-center gap-1.5 border border-[var(--border)] px-3 text-[12.5px] disabled:opacity-40" onClick={() => setReviewing(true)}><MessageSquareReply size={13} />Send it back with notes</button>)}
                {onExecute && <button type="button" disabled={disabled} className="flex min-h-10 items-center justify-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[12.5px] font-medium text-[var(--accent-ink)] disabled:opacity-40" onClick={() => void onExecute(plan)}><Bolt size={13} />Execute this plan</button>}
              </div>
            </>
          )}
          {approved && <p className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)]"><Check size={13} />Approved and handed to the live todo list.</p>}
        </div>
      )}
      {fileOpen && plan.path && loadFile && <PlanDocumentView key={`${plan.id}\u0000${plan.path}\u0000${plan.version ?? "current"}\u0000${plan.writtenAt ?? "unknown"}`} plan={plan} loadFile={loadDocument} onClose={() => setFileOpen(false)} disabled={disabled} {...(onExecute ? { onExecute } : {})} />}
    </article>
  );
}
