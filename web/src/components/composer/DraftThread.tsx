import { useMemo, useState } from "react";
import { AlertTriangle, FolderGit2 } from "lucide-react";
import type { ReasoningEffort } from "../../../../src/shared/session.ts";
import type { HostOption, WorkspaceOption } from "../../types";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui";
import { SessionComposer, type ComposerModelOption } from "./SessionComposer";
import type { DraftAction, DraftSession } from "./draft";

export function DraftThread({
  draft,
  hosts,
  workspaces,
  busy,
  mutationsReady,
  modelOptions,
  modelOptionsStatus,
  effortOptions,
  dispatch,
  onFirstSend,
}: {
  draft: DraftSession;
  hosts: readonly HostOption[];
  workspaces: readonly WorkspaceOption[];
  busy: boolean;
  mutationsReady: boolean;
  modelOptions: readonly ComposerModelOption[];
  modelOptionsStatus: string | null;
  effortOptions?: readonly ReasoningEffort[];
  dispatch: (action: DraftAction) => void;
  onFirstSend: () => Promise<void> | void;
}) {
  const [path, setPath] = useState(draft.workspace?.path ?? "");
  const selectedHostId = draft.workspace?.hostId ?? hosts.find((host) => host.kind === "local")?.id ?? hosts[0]?.id ?? "local";
  const nearby = useMemo(() => workspaces.filter((workspace) => workspace.hostId === selectedHostId).slice(0, 8), [selectedHostId, workspaces]);
  const needsWorkspace = draft.workspace === null;
  function chooseWorkspace(hostId: string, value: string) {
    setPath(value);
    dispatch({ type: "set-workspace", workspace: { hostId, path: value } });
  }
  return (
    <div className="grid min-h-full content-between gap-6">
      <section className="mx-auto w-full max-w-2xl py-8 text-center">
        <FolderGit2 size={24} className="mx-auto text-[var(--text-muted)]" />
        <h2 className="mt-3 text-display-sm">New thread</h2>
        {needsWorkspace && <p className="mt-1 text-meta text-[var(--text-muted)]">Choose where this session should run.</p>}
        {nearby.length > 0 && <div className="mt-5 flex flex-wrap justify-center gap-2">{nearby.map((workspace) => <Button key={workspace.id} variant="secondary" size="sm" data-compact-control className="h-auto min-h-10 flex-col items-start justify-center gap-0 px-3 text-left" onClick={() => chooseWorkspace(workspace.hostId, workspace.path)}><strong className="block">{workspace.label}</strong><span className="block max-w-52 truncate font-mono text-code-xs text-[var(--text-muted)]">{workspace.path}</span></Button>)}</div>}
        <div className="mx-auto mt-4 max-w-lg text-left">
          <span className="font-mono text-eyebrow uppercase text-[var(--text-faint)]">Folder</span>
          <div className="mt-1 flex">
            {/*
              Changing host clears the path: a folder discovered on one machine
              is not a claim about any other, so the draft never carries it over.
            */}
            <Select value={selectedHostId} onValueChange={(nextHost) => { setPath(""); dispatch({ type: "set-workspace", workspace: { hostId: nextHost, path: "" } }); }}>
              <SelectTrigger size="touch" aria-label="Host" className="max-w-36 shrink-0 border-[var(--border)] bg-[var(--menu)] px-2"><SelectValue /></SelectTrigger>
              <SelectContent>{hosts.map((host) => <SelectItem key={host.id} value={host.id}>{host.label}</SelectItem>)}</SelectContent>
            </Select>
            <input value={path} onChange={(event) => { setPath(event.target.value); dispatch({ type: "set-workspace", workspace: { hostId: selectedHostId, path: event.target.value } }); }} className="min-h-11 min-w-0 flex-1 border border-l-0 border-[var(--border)] bg-transparent px-3 font-mono text-code-sm" placeholder="/path/to/repository" aria-label="Workspace folder" />
          </div>
        </div>
        {draft.createState === "unknown" && <div className="mx-auto mt-4 max-w-lg border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3 text-left"><p className="flex gap-2 text-meta-sm text-[var(--warning)]"><AlertTriangle size={14} />Creation outcome is unknown.</p><p className="mt-1 text-meta-sm text-[var(--text-muted)]">{draft.error} Check the board or native harness before trying anything else. This request will not be replayed.</p></div>}
        {draft.createState === "failed" && <div className="mx-auto mt-4 max-w-lg border-l-2 border-[var(--danger)] bg-[var(--danger-field)] p-3 text-left"><p className="text-meta-sm text-[var(--danger)]">{draft.error}</p><Button variant="ghost" size="sm" data-compact-control className="mt-2 px-0 underline" onClick={() => dispatch({ type: "retry" })}>Try again</Button></div>}
      </section>
      <SessionComposer
        value={draft.text}
        onChange={(text) => dispatch({ type: "set-text", text })}
        onSend={() => onFirstSend()}
        isRunning={false}
        canQueue={mutationsReady && draft.workspace !== null && draft.workspace.path.trim().length > 0 && draft.createState === "draft"}
        canSteer={false}
        canStop={false}
        provider={draft.provider}
        model={draft.model}
        modelOptions={modelOptions}
        modelOptionsStatus={modelOptionsStatus}
        effort={draft.effort}
        effortOptions={effortOptions ?? []}
        profile={draft.profile}
        draft
        readOnlyReason={mutationsReady ? null : "Reconnect before creating a session."}
        busy={busy || draft.createState === "creating" || draft.createState === "unknown"}
        onProviderChange={(provider) => dispatch({ type: "set-provider", provider, model: null })}
        onModelChange={(model) => dispatch({ type: "set-model", model })}
        onEffortChange={(effort) => dispatch({ type: "set-effort", effort })}
        onProfileChange={(profile) => dispatch({ type: "set-profile", profile })}
        onResetSettings={() => dispatch({ type: "reset-settings" })}
      />
    </div>
  );
}
