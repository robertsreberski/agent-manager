import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Globe2, Server, ShieldCheck } from "lucide-react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { usePhoneViewport } from "../../hooks/use-phone-viewport";
import { isCommandEnter, isTypingTarget } from "../../lib/shortcuts";
import { approvalTier, type ApprovalRequestView } from "./model";

export type ApprovalDecision =
  | { decision: "allow"; persist: boolean }
  | { decision: "deny"; reason: string | null };

export function ApprovalRequest({
  request,
  disabled = false,
  onDecision,
}: {
  request: ApprovalRequestView;
  disabled?: boolean;
  onDecision: (requestId: string, decision: ApprovalDecision) => Promise<void> | void;
}) {
  const phone = usePhoneViewport();
  const tier = approvalTier(request);
  const [open, setOpen] = useState(true);
  const [explaining, setExplaining] = useState(false);
  const [persist, setPersist] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLElement>({ active: phone, initialFocusRef: disclosureRef, onEscape: () => setOpen(false), priority: 60 });
  useEffect(() => {
    if (!open || disabled || tier !== "workspace") return;
    function keydown(event: KeyboardEvent) {
      if (!isCommandEnter(event) || isTypingTarget(event.target)) return;
      const candidates = document.querySelectorAll(`[data-approval-tier="workspace"][data-shortcut-ready="true"]`);
      if (candidates.length !== 1 || candidates[0]?.getAttribute("data-request-id") !== request.id) return;
      event.preventDefault();
      void decide({ decision: "allow", persist: false });
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  async function decide(decision: ApprovalDecision) {
    if (disabled || busy) return;
    setBusy(true);
    try { await onDecision(request.id, decision); } finally { setBusy(false); }
  }
  const frame = tier === "outside"
    ? "border-l-2 border-[var(--danger)] bg-[var(--danger-field)]"
    : tier === "remote"
      ? "border-l-2 border-[var(--remote)] bg-[color-mix(in_oklab,var(--remote)_8%,transparent)]"
      : "border border-[var(--border)] bg-[var(--surface-raised)]";
  return (
    <>
      {phone && <div className="approval-request__phone-backdrop" aria-hidden="true" />}
      <section ref={dialogRef} className={`${frame} approval-request p-3`} role={phone ? "dialog" : undefined} aria-modal={phone ? "true" : undefined} {...(phone ? { tabIndex: -1 } : {})} data-phone-bottom-sheet data-approval-tier={tier} data-request-id={request.id} data-shortcut-ready={open && !disabled && !busy ? "true" : "false"} aria-label={`${request.label} approval`}>
      <span className="approval-request__phone-handle" aria-hidden="true" />
      <button ref={disclosureRef} type="button" data-compact-control className="flex min-h-8 w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {tier === "workspace" ? <ShieldCheck size={15} /> : tier === "remote" ? <Server size={15} className="text-[var(--remote)]" /> : <AlertTriangle size={15} className="text-[var(--danger)]" />}
        <span className="font-medium">{request.label}</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{tier === "workspace" ? "inside workspace" : tier === "remote" ? `remote · ${request.remoteHost}` : "outside workspace"}</span>
        <ChevronDown size={13} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="mt-2 grid gap-3">
          {request.command && <pre className="overflow-x-auto bg-[var(--menu)] p-3 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-words">{request.command}</pre>}
          {request.reason && <p className="text-[12.5px] leading-5 text-[var(--text-muted)]">{request.reason}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-[var(--text-muted)]">
            {request.writes.map((path) => <span key={path}>writes {path}</span>)}
            {request.deleteCount !== null && <span>deletes {request.deleteCount} {request.deleteCount === 1 ? "file" : "files"}</span>}
            {request.network !== null && <span className="flex items-center gap-1"><Globe2 size={11} />{request.network ? "network" : "no network"}</span>}
            {tier === "remote" && request.sessionsOnHost !== null && <span>{request.sessionsOnHost} other {request.sessionsOnHost === 1 ? "session" : "sessions"} on host</span>}
          </div>
          {explaining && <textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-20 border border-[var(--border)] bg-transparent p-2 text-sm" aria-label="Reason for denying" />}
          {phone && tier === "workspace" && request.canPersist && (
            <fieldset className="grid gap-1" aria-label="Approval scope">
              <legend className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-muted)]">If allowed</legend>
              <label className="flex min-h-[46px] cursor-pointer items-center gap-3 border border-[var(--border)] px-3 text-[12.5px]">
                <input type="radio" name={`approval-scope-${request.id}`} checked={!persist} onChange={() => setPersist(false)} />
                <span><strong className="block font-medium">Once</strong><span className="text-[var(--text-muted)]">Approve only this request</span></span>
              </label>
              <label className="flex min-h-[46px] cursor-pointer items-center gap-3 border border-[var(--border)] px-3 text-[12.5px]">
                <input type="radio" name={`approval-scope-${request.id}`} checked={persist} onChange={() => setPersist(true)} />
                <span><strong className="block font-medium">Always this class</strong><span className="text-[var(--text-muted)]">Use the persistent choice offered by the provider</span></span>
              </label>
            </fieldset>
          )}
          <div className="approval-request__actions flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" disabled={disabled || busy} data-compact-control className="min-h-12 border border-[var(--border)] px-4 text-[12.5px] sm:min-h-9" onClick={() => explaining ? void decide({ decision: "deny", reason: reason.trim() || null }) : tier === "outside" ? setExplaining(true) : void decide({ decision: "deny", reason: null })}>{tier === "outside" ? explaining ? "Deny with reason" : "Deny and explain" : "Deny"}</button>
            {!phone && tier === "workspace" && request.canPersist && <button type="button" disabled={disabled || busy} data-compact-control className="min-h-12 border border-[var(--border)] px-4 text-[12.5px] sm:min-h-9" onClick={() => void decide({ decision: "allow", persist: true })}>Always allow this class</button>}
            <button type="button" disabled={disabled || busy} data-compact-control className={`min-h-12 px-4 text-[12.5px] font-medium sm:min-h-9 ${tier === "outside" ? "bg-[var(--danger)] text-white" : tier === "remote" ? "bg-[var(--remote)] text-[var(--app)]" : "bg-[var(--accent)] text-[var(--accent-ink)]"}`} onClick={() => void decide({ decision: "allow", persist: phone && tier === "workspace" ? persist : false })}>{tier === "outside" ? "Allow once" : tier === "remote" ? `Allow on ${request.remoteHost}` : phone && request.canPersist ? persist ? "Always allow this class" : "Allow once" : "Allow"}</button>
          </div>
        </div>
      )}
      </section>
    </>
  );
}
