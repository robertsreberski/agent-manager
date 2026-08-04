import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronRight, Folder, Laptop, Server, ShieldAlert } from "lucide-react";
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
import type { HostOption, LaunchSessionInput, Provider, WorkspaceOption } from "../types";

export function LaunchDialog({
  open,
  onOpenChange,
  hosts = [],
  workspaces,
  creating,
  onCompletePath,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts?: HostOption[];
  workspaces: WorkspaceOption[];
  creating: boolean;
  onCompletePath?: (hostId: string, path: string) => Promise<string[]>;
  onCreate: (input: LaunchSessionInput) => Promise<unknown>;
}) {
  const [provider, setProvider] = useState<Provider>("codex");
  const availableHosts = hosts.length > 0
    ? hosts
    : [{ id: "local", label: "This Mac", kind: "local" as const, status: "online" as const }];
  const [hostId, setHostId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [pathOptions, setPathOptions] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"planning" | "execution">("planning");
  const [accessMode, setAccessMode] = useState<"sandboxed" | "bypass-permissions">("sandboxed");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const creationAttempt = useRef<PersistedCreateAttempt | null>(loadCreateAttempt());

  useEffect(() => {
    if (!open || hostId) return;
    const host = availableHosts[0];
    if (!host) return;
    setHostId(host.id);
    setWorkspacePath(workspaces.find((workspace) => (workspace.hostId ?? "local") === host.id)?.path ?? "");
  }, [availableHosts, hostId, open, workspaces]);

  useEffect(() => {
    if (!open || !hostId || !onCompletePath) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onCompletePath(hostId, workspacePath).then((paths) => {
        if (!cancelled) setPathOptions(paths);
      }).catch(() => {
        if (!cancelled) setPathOptions([]);
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hostId, onCompletePath, open, workspacePath]);

  const submitDisabled =
    creating ||
    !hostId ||
    workspacePath.trim().length === 0 ||
    message.trim().length === 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitDisabled) return;
    const request = {
        provider,
        hostId,
        workspacePath: workspacePath.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        initialMessage: message.trim(),
        mode,
        accessMode,
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
    setAccessMode("sandboxed");
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

          <div className="grid gap-3 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.7fr)]">
            <label className="grid gap-1.5 text-sm font-medium">
              <span>Host</span>
              <div className="relative">
                {availableHosts.find((host) => host.id === hostId)?.kind === "ssh"
                  ? <Server className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  : <Laptop className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />}
                <select
                  aria-label="Host"
                  value={hostId}
                  onChange={(event) => {
                    const nextHostId = event.target.value;
                    setHostId(nextHostId);
                    setWorkspacePath(workspaces.find((workspace) => (workspace.hostId ?? "local") === nextHostId)?.path ?? "");
                    setPathOptions([]);
                  }}
                  className="h-9 w-full appearance-none rounded-md border border-input bg-background pl-9 pr-8 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {availableHosts.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.label}{host.status === "offline" ? " · offline" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              <span>Workspace path</span>
              <div className="relative">
                <Folder className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Workspace path"
                  list="agent-manager-workspace-paths"
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  placeholder="/path/to/project"
                  className="pl-9 font-mono text-xs"
                />
                <datalist id="agent-manager-workspace-paths">
                  {[...new Set([
                    ...workspaces.filter((workspace) => (workspace.hostId ?? "local") === hostId).flatMap((workspace) => workspace.path ? [workspace.path] : []),
                    ...pathOptions,
                  ])].map((path) => <option key={path} value={path} />)}
                </datalist>
              </div>
            </label>
          </div>

          {availableHosts.find((host) => host.id === hostId)?.status === "offline" && (
            <p className="-mt-2 text-xs text-amber-700 dark:text-amber-400">
              This host is currently unreachable. Its saved paths remain visible, but launching requires the SSH node.
            </p>
          )}

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
                {provider} · {mode === "planning" ? "plan" : "execute"} · {accessMode === "bypass-permissions" ? "bypass permissions" : "sandboxed"}
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
                  <Button type="button" variant={accessMode === "sandboxed" ? "secondary" : "outline"} onClick={() => setAccessMode("sandboxed")}>
                    Sandboxed
                  </Button>
                  <Button type="button" variant={accessMode === "bypass-permissions" ? "destructive" : "outline"} onClick={() => setAccessMode("bypass-permissions")}>
                    <ShieldAlert /> Bypass permissions
                  </Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Bypass permissions lets the provider read, edit, and execute outside the workspace without approval prompts.
                </p>
              </fieldset>
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
