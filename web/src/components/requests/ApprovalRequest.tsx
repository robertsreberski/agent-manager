import { useEffect, useState } from "react";
import { ChevronDown, CircleHelp, Globe2, Server, ShieldAlert } from "lucide-react";
import { usePhoneViewport } from "../../hooks/use-phone-viewport";
import { isCommandEnter, isTypingTarget } from "../../lib/shortcuts";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  RadioGroup,
  RadioGroupItem,
  Sheet,
  SheetContent,
} from "../ui";
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
  // 8a: the routine tier carries no tint and no frame at all; only a tier that
  // leaves the workspace or the machine takes an edge and a field.
  const frame = tier === "outside"
    ? "relative border-l-2 border-[var(--danger)] bg-[var(--danger-field)] py-3.5 pr-4 pl-[15px]"
    : tier === "remote"
      ? "relative border-l-2 border-[var(--remote)] bg-[var(--remote-field)] py-3.5 pr-4 pl-[15px]"
      : "";
  // 8a states the tier in lighter, less saturated red than the 2px tick beside it.
  // The hover pair is spelled out because `Button`'s ghost variant would
  // otherwise repaint the disclosure `--text` the moment a pointer touches it.
  const tierText = tier === "outside"
    ? "text-[var(--danger-text)] hover:text-[var(--danger-text)]"
    : tier === "remote"
      ? "text-[var(--remote)] hover:text-[var(--remote)]"
      : "text-[var(--text-muted)] hover:text-[var(--text-muted)]";
  /*
    The two escalated tiers give their primary action a *filled* pill, so it
    cannot reuse the tier field's own fill or it disappears into it. Frame 8a
    gives it a lighter shade, carried by `--danger-pill-field` and its violet
    counterpart `--remote-pill-field`. Only the routine tier is lime: spec 12 R3
    keeps lime for the operator's own action, never for a tier, so `primary`
    needs no ink override — `Button` already carries `--accent-ink`.
  */
  const allow = tier === "outside"
    ? { variant: "danger" as const, ink: "bg-[var(--danger-pill-field)] [color:var(--danger-text)]" }
    : tier === "remote"
      ? { variant: "secondary" as const, ink: "border-[var(--remote-dim)] bg-[var(--remote-pill-field)] [color:var(--remote)]" }
      : { variant: "primary" as const, ink: "" };
  const shortcutHint = tier === "workspace"
    ? [request.workspaceRoot ? `in ${request.workspaceRoot}` : null, "⌘↵ allow"].filter(Boolean).join(" · ")
    : tier === "remote"
      ? `no shortcut — ${request.remoteHost ?? "this host"} needs a click`
      : "no shortcut — this one needs a click";
  // One element carries the request identity in both presentations, so the
  // ⌘↵ ambiguity check below still counts exactly one node per request.
  const identity = {
    "data-phone-bottom-sheet": true,
    "data-approval-tier": tier,
    "data-request-id": request.id,
    "data-shortcut-ready": open && !disabled && !busy ? "true" : "false",
  } as const;
  const body = (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" data-compact-control className={`h-auto min-h-8 w-full min-w-0 justify-start gap-2 px-0 py-1.5 text-left hover:bg-transparent ${tierText}`}>
          {tier === "workspace" ? <CircleHelp size={16} strokeWidth={1.75} className="shrink-0" /> : tier === "remote" ? <Server size={16} strokeWidth={1.75} className="shrink-0" /> : <ShieldAlert size={16} strokeWidth={1.75} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate text-body-sm">
            {tier === "workspace"
              ? <>Approve <strong className="font-semibold text-[var(--text)]">{request.label}</strong></>
              : tier === "remote"
                ? <>This command runs on <strong className="font-semibold">{request.remoteHost ?? "another host"}</strong></>
                : "This command leaves the workspace"}
          </span>
          <span className="shrink-0 font-mono text-code-sm opacity-70">{tier === "workspace" ? "inside workspace" : tier === "remote" ? "remote host" : "outside workspace"}</span>
          <ChevronDown size={13} className={`shrink-0 ${open ? "rotate-180" : ""}`} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[11px] pt-[11px] ${tier === "workspace" ? "pl-6" : ""}`}>
        {request.command && <pre className={`min-w-0 max-w-full overflow-x-hidden p-[11px_13px] font-mono text-code leading-5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${tier === "workspace" ? "bg-[var(--surface-raised-hover)]" : "bg-[var(--app)]"}`}>{request.command}</pre>}
        {request.reason && <p className="text-meta-sm leading-5 text-[var(--text-muted)]">{request.reason}</p>}
        <div className="flex min-w-0 flex-col gap-1.5 font-mono text-code-sm leading-[1.5] text-[var(--text-muted)] sm:flex-row sm:flex-wrap sm:gap-x-[18px]">
          {request.writes.map((path) => <span key={path} className="min-w-0 truncate">writes <span className="text-[var(--text)]">{path}</span></span>)}
          {request.deleteCount !== null && <span>deletes <span className="text-[var(--text)]">{request.deleteCount} {request.deleteCount === 1 ? "file" : "files"}</span></span>}
          {request.network !== null && <span className="flex items-center gap-1"><Globe2 size={11} />{request.network ? "network" : "no network"}</span>}
          {tier === "remote" && request.sessionsOnHost !== null && <span>{request.sessionsOnHost} other {request.sessionsOnHost === 1 ? "session" : "sessions"} on host</span>}
        </div>
        {explaining && <textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-20 border border-[var(--border)] bg-transparent p-2 text-sm" aria-label="Reason for denying" />}
        {phone && tier === "workspace" && request.canPersist && (
          <div className="min-w-0">
            <p className="mb-1 font-mono text-eyebrow uppercase text-[var(--text-muted)]">If allowed</p>
            {/* "Always" is only ever the provider's own persistent choice; this
                picker names which of the two the single Allow button will send. */}
            <RadioGroup className="gap-1" aria-label="Approval scope" value={persist ? "always" : "once"} onValueChange={(next) => setPersist(next === "always")}>
              <label className="flex min-h-[46px] cursor-pointer items-center gap-3 border border-[var(--border)] px-3 text-meta-sm">
                <RadioGroupItem value="once" />
                <span><strong className="block font-medium">Once</strong><span className="text-[var(--text-muted)]">Approve only this request</span></span>
              </label>
              <label className="flex min-h-[46px] cursor-pointer items-center gap-3 border border-[var(--border)] px-3 text-meta-sm">
                <RadioGroupItem value="always" />
                <span><strong className="block font-medium">Always this class</strong><span className="text-[var(--text-muted)]">Use the persistent choice offered by the provider</span></span>
              </label>
            </RadioGroup>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden min-w-0 flex-1 truncate font-mono text-code-sm text-[var(--text-faint)] sm:inline">{shortcutHint}</span>
          <div className="approval-request__actions flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-end">
            <Button variant={tier === "workspace" ? "ghost" : "secondary"} size="sm" data-compact-control disabled={disabled || busy} className={`min-h-12 sm:min-h-[29px] ${tier === "workspace" ? "px-3 sm:px-1" : "border-[var(--border-strong)] px-4"}`} onClick={() => explaining ? void decide({ decision: "deny", reason: reason.trim() || null }) : tier === "outside" ? setExplaining(true) : void decide({ decision: "deny", reason: null })}>{tier === "outside" ? explaining ? "Deny with reason" : "Deny and explain" : "Deny"}</Button>
            {!phone && tier === "workspace" && request.canPersist && <Button variant="secondary" size="sm" data-compact-control disabled={disabled || busy} className="min-h-12 border-[var(--border-strong)] px-3 sm:min-h-[29px]" onClick={() => void decide({ decision: "allow", persist: true })}>Always allow this class</Button>}
            <Button variant={allow.variant} size="sm" data-compact-control disabled={disabled || busy} className={`min-h-12 rounded-full px-[15px] font-semibold sm:min-h-[29px] ${allow.ink}`} onClick={() => void decide({ decision: "allow", persist: phone && tier === "workspace" ? persist : false })}>{tier === "outside" ? "Allow once" : tier === "remote" ? `Allow on ${request.remoteHost}` : phone && request.canPersist ? persist ? "Always allow this class" : "Allow once" : "Allow"}</Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  if (!phone) {
    return (
      <section className={`${frame} min-w-0 max-w-full`} {...identity} aria-label={`${request.label} approval`}>
        {body}
      </section>
    );
  }

  /*
    An approval is never dismissed, only answered, so the sheet stays mounted:
    Escape and the scrim collapse the disclosure instead of closing the layer.
    Radix supplies the scrim the hand-rolled `aria-hidden` backdrop never had.
  */
  return (
    <Sheet open onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-label={`${request.label} approval`}
        {...identity}
        className={`${frame} fixed left-auto right-0 w-[min(100%,760px)] min-w-0 max-w-full max-h-[min(82dvh,720px)] gap-0 overflow-y-auto border-t-0 px-5 pt-2.5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-sheet-bottom)]`}
      >
        <span aria-hidden="true" className="mx-auto mb-3.5 h-1 w-9 shrink-0 rounded-full bg-[color-mix(in_oklab,currentcolor_24%,transparent)]" />
        {body}
      </SheetContent>
    </Sheet>
  );
}
