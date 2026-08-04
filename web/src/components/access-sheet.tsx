import { useEffect, useState } from "react";
import { Check, Copy, LoaderCircle, Monitor, TerminalSquare } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { copyText } from "../lib/utils";
import type { AttachInstruction, PanePreview, SessionView } from "../types";

function displayValue(value: string | null | undefined): string {
  return value || "Not reported";
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function AccessSheet({
  session,
  open,
  onOpenChange,
  loadPreview,
  loadAttach,
}: {
  session: SessionView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadPreview: (session: SessionView) => Promise<PanePreview>;
  loadAttach: (session: SessionView) => Promise<AttachInstruction>;
}) {
  const [preview, setPreview] = useState<PanePreview | null>(null);
  const [attach, setAttach] = useState<AttachInstruction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      session.control.capabilities.includes("preview") || session.terminal
        ? loadPreview(session).catch(() => null)
        : Promise.resolve(null),
      session.control.capabilities.includes("attach") || session.control.capabilities.includes("resume") || session.terminal
        ? loadAttach(session).catch(() => null)
        : Promise.resolve(null),
    ]).then(([nextPreview, nextAttach]) => {
      if (cancelled) return;
      setPreview(nextPreview);
      setAttach(nextAttach);
      if (!nextPreview && !nextAttach) setError("No safe preview or native attachment is available for this session.");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadAttach, loadPreview, open, session]);

  async function copyCommand() {
    if (!attach?.command) return;
    await copyText(attach.command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto [padding-bottom:max(1.25rem,env(safe-area-inset-bottom))] [padding-right:max(1.25rem,env(safe-area-inset-right))] [padding-top:max(1.25rem,env(safe-area-inset-top))]">
        <SheetHeader>
          <SheetTitle>Session details</SheetTitle>
          <SheetDescription>
            Identity, access, and terminal handoff for this session.
          </SheetDescription>
        </SheetHeader>

        <section className="grid gap-3 rounded-xl border bg-muted/15 p-4" aria-labelledby="implementation-details-title">
          <h3 id="implementation-details-title" className="text-sm font-semibold">Implementation</h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Provider"><span className="uppercase">{session.provider}</span></Detail>
            <Detail label="Host">{session.hostLabel ?? "This Mac"}</Detail>
            <Detail label="Session ID"><code className="font-mono text-xs">{session.id}</code></Detail>
            <Detail label="Workspace"><code className="font-mono text-xs">{displayValue(session.cwd)}</code></Detail>
            <Detail label="Owner">{session.ownership === "manager" ? "Agent Manager" : "External"}</Detail>
            <Detail label="Control plane">{displayValue(session.control.plane)}</Detail>
            <Detail label="Provider mode">{displayValue(session.mode.providerValue)}</Detail>
          </dl>
        </section>

        <section className="grid gap-3 rounded-xl border bg-muted/15 p-4" aria-labelledby="access-details-title">
          <h3 id="access-details-title" className="text-sm font-semibold">Access</h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Permission">{displayValue(session.effectiveAccess.permissionMode)}</Detail>
            <Detail label="Sandbox">{displayValue(session.effectiveAccess.sandboxMode)}</Detail>
            <Detail label="Access mode">{
              session.effectiveAccess.accessMode === "bypass-permissions"
                ? "Bypass permissions"
                : session.effectiveAccess.accessMode === "sandboxed"
                  ? "Sandboxed"
                  : "Unknown"
            }</Detail>
            <Detail label="Mode">{session.mode.value === "planning" ? "Plan" : session.mode.value === "execution" ? "Execute" : "Unknown"}</Detail>
            <Detail label="Mode evidence">{session.mode.confidence} · {session.mode.source}</Detail>
          </dl>
        </section>

        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold">Terminal</h3>
          <p className="mt-1 text-xs text-muted-foreground">Preview recent output or copy a native attach command.</p>
        </div>

        {loading && (
          <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading terminal details…
          </div>
        )}

        {error && !loading && (
          <Alert>
            <AlertTitle>Terminal unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {attach && (!attach.available || !attach.command) && !loading && (
          <Alert>
            <AlertTitle>Attach unavailable</AlertTitle>
            <AlertDescription>
              {attach.description || "This provider does not offer a native attach command for the session."}
            </AlertDescription>
          </Alert>
        )}

        {attach?.available && attach.command && (
          <section className="grid gap-3 rounded-xl border bg-muted/20 p-4">
            <div className="flex items-center gap-2">
              <TerminalSquare className="size-4 text-primary" />
              <div>
                <h3 className="text-sm font-medium">
                  {attach.requiresHandoff ? "Continue in terminal" : "Attach in terminal"}
                </h3>
                <p className="text-xs text-muted-foreground">{attach.kind}</p>
              </div>
            </div>
            {attach.description && (
              <Alert className="border-amber-500/30 bg-amber-500/5">
                <AlertDescription>{attach.description}</AlertDescription>
              </Alert>
            )}
            {attach.cwd && (
              <p className="truncate font-mono text-xs text-muted-foreground" title={attach.cwd}>
                from {attach.cwd}
              </p>
            )}
            <div className="flex items-start gap-2 rounded-lg border bg-background p-3">
              <code className="min-w-0 flex-1 break-all text-xs leading-5">{attach.command}</code>
              <Button size="icon" variant="ghost" onClick={() => void copyCommand()} aria-label="Copy attach command" className="size-8">
                {copied ? <Check className="text-emerald-600" /> : <Copy />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Copy this command into your terminal. Agent Manager does not run it in the browser.
            </p>
          </section>
        )}

        {preview && (
          <section className="grid min-h-0 gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {session.terminal ? <TerminalSquare className="size-4" /> : <Monitor className="size-4" />}
                <h3 className="text-sm font-medium">Terminal preview</h3>
              </div>
              <span className="text-xs text-muted-foreground">
                {preview.lines ?? "≤200"} lines{preview.truncated ? " · truncated" : ""}
              </span>
            </div>
            <pre
              tabIndex={0}
              aria-label="Terminal pane preview"
              className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-words rounded-xl border bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-100 shadow-inner"
            >
              {preview.content || "No visible pane output."}
            </pre>
            <p className="text-xs text-muted-foreground">
              Read-only snapshot; terminal control sequences are removed.
            </p>
          </section>
        )}
      </SheetContent>
    </Sheet>
  );
}
