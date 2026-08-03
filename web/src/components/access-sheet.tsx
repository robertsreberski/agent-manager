import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, Monitor, TerminalSquare } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { copyText } from "../lib/utils";
import type { AttachInstruction, PanePreview, SessionView } from "../types";

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
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Native access</SheetTitle>
          <SheetDescription>
            Inspect a bounded pane snapshot or continue through the provider’s normal terminal interface.
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading safe access details…
          </div>
        )}

        {error && !loading && (
          <Alert>
            <AlertTitle>Read-only session</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {attach && (!attach.available || !attach.command) && !loading && (
          <Alert>
            <AlertTitle>Native attachment unavailable</AlertTitle>
            <AlertDescription>
              {attach.description || "The provider does not expose a safe native attachment for this session."}
            </AlertDescription>
          </Alert>
        )}

        {attach?.available && attach.command && (
          <section className="grid gap-3 rounded-xl border bg-muted/20 p-4">
            <div className="flex items-center gap-2">
              <ExternalLink className="size-4 text-primary" />
              <div>
                <h3 className="text-sm font-medium">
                  {attach.requiresHandoff ? "Handoff to the native CLI" : "Open in the native CLI"}
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
              Run this exact command in your terminal. The browser never executes shell commands.
            </p>
          </section>
        )}

        {preview && (
          <section className="grid min-h-0 gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {session.terminal ? <TerminalSquare className="size-4" /> : <Monitor className="size-4" />}
                <h3 className="text-sm font-medium">Read-only pane preview</h3>
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
              This is a bounded snapshot. It does not accept keyboard input and strips terminal control sequences on the server.
            </p>
          </section>
        )}
      </SheetContent>
    </Sheet>
  );
}
