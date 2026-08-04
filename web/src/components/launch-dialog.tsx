import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, ChevronRight, Folder, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  clearCreateAttempt,
  createAttemptFingerprint,
  loadCreateAttempt,
  saveCreateAttempt,
  type PersistedCreateAttempt,
} from "../lib/create-attempt";
import { cn, idempotencyKey } from "../lib/utils";
import type { CreateSessionInput, Provider, WorkspaceOption } from "../types";

export function LaunchDialog({
  open,
  onOpenChange,
  workspaces,
  creating,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: WorkspaceOption[];
  creating: boolean;
  onCreate: (input: CreateSessionInput) => Promise<unknown>;
}) {
  const [provider, setProvider] = useState<Provider>("codex");
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"planning" | "execution">("planning");
  const [permissionPreset, setPermissionPreset] = useState<"standard" | "full-host">("standard");
  const [fullHostConfirmed, setFullHostConfirmed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const creationAttempt = useRef<PersistedCreateAttempt | null>(loadCreateAttempt());

  useEffect(() => {
    if (open && !workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id);
  }, [open, workspaceId, workspaces]);

  useEffect(() => {
    if (permissionPreset === "standard") setFullHostConfirmed(false);
  }, [permissionPreset]);

  const submitDisabled =
    creating ||
    !workspaceId ||
    message.trim().length === 0 ||
    (permissionPreset === "full-host" && !fullHostConfirmed);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitDisabled) return;
    const request = {
        provider,
        workspaceId,
        ...(name.trim() ? { name: name.trim() } : {}),
        initialMessage: message.trim(),
        mode,
        permissionPreset,
      };
    const fingerprint = await createAttemptFingerprint(request);
    if (creationAttempt.current?.fingerprint !== fingerprint) {
      if (creationAttempt.current) clearCreateAttempt(creationAttempt.current.key);
      creationAttempt.current = { fingerprint, key: idempotencyKey() };
      saveCreateAttempt(creationAttempt.current);
    }
    const attempt = creationAttempt.current;
    try {
      await onCreate({
        ...request,
        idempotencyKey: attempt.key,
      });
    } catch {
      return;
    }
    clearCreateAttempt(attempt.key);
    creationAttempt.current = null;
    setName("");
    setMessage("");
    setMode("planning");
    setPermissionPreset("standard");
    setFullHostConfirmed(false);
    setAdvancedOpen(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>
              Choose a workspace and tell the agent what to do.
            </DialogDescription>
          </DialogHeader>

          <label className="grid gap-1.5 text-sm font-medium">
            <span>Workspace</span>
            <div className="relative">
              <Folder className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <select
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                disabled={workspaces.length === 0}
                className="h-9 w-full appearance-none rounded-md border border-input bg-background pl-9 pr-8 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {workspaces.length === 0 && <option value="">No configured workspaces</option>}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.label}
                  </option>
                ))}
              </select>
            </div>
            {workspaces.length === 0 && (
              <span className="font-normal text-muted-foreground">
                Add a trusted workspace with the Agent Manager CLI before launching from the browser.
              </span>
            )}
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            <span>Task</span>
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={100_000}
              rows={5}
              placeholder="Describe the outcome you want…"
              autoFocus
            />
          </label>

          <details
            className="group/advanced rounded-lg border bg-muted/15"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium marker:content-none [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-open/advanced:rotate-90 motion-reduce:transition-none" />
              Advanced options
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {provider} · {mode === "planning" ? "plan" : "execute"} · {permissionPreset === "full-host" ? "full host" : "standard"}
              </span>
            </summary>
            <div className="grid gap-4 border-t p-3">
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Provider</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(["codex", "claude"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setProvider(item)}
                      aria-pressed={provider === item}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                        provider === item && "border-primary bg-primary/5",
                      )}
                    >
                      <Bot className={cn("size-4", item === "codex" ? "text-emerald-600" : "text-orange-600")} />
                      <span className="flex-1 capitalize">{item}</span>
                      {provider === item && <Check className="size-4 text-primary" />}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="grid gap-1.5 text-sm font-medium">
                <span>Name <span className="font-normal text-muted-foreground">(optional)</span></span>
                <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="e.g. API cleanup" />
              </label>

              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Starting mode</legend>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant={mode === "planning" ? "secondary" : "outline"} onClick={() => setMode("planning")}>
                    Planning
                  </Button>
                  <Button type="button" variant={mode === "execution" ? "secondary" : "outline"} onClick={() => setMode("execution")}>
                    Execution
                  </Button>
                </div>
              </fieldset>

              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Access</legend>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant={permissionPreset === "standard" ? "secondary" : "outline"} onClick={() => setPermissionPreset("standard")}>
                    Standard
                  </Button>
                  <Button type="button" variant={permissionPreset === "full-host" ? "destructive" : "outline"} onClick={() => setPermissionPreset("full-host")}>
                    <ShieldAlert /> Full host
                  </Button>
                </div>
              </fieldset>

              {permissionPreset === "full-host" && (
                <Alert className="border-red-500/40 bg-red-500/5">
                  <AlertTriangle className="mb-2 size-4 text-red-600" />
                  <AlertTitle>Full host access</AlertTitle>
                  <AlertDescription>
                    This agent can access files and processes outside its workspace. Use only for work you trust.
                  </AlertDescription>
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={fullHostConfirmed}
                      onChange={(event) => setFullHostConfirmed(event.target.checked)}
                      className="mt-0.5 size-4 rounded border-input accent-primary"
                    />
                    <span>I understand this session is not sandboxed.</span>
                  </label>
                </Alert>
              )}
            </div>
          </details>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {creating ? "Launching…" : "Launch session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
