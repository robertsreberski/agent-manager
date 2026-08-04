import { useMemo, useState } from "react";
import { AlertTriangle, FolderGit2 } from "lucide-react";
import { reasoningEffortsForProvider } from "../../../../src/shared/session.ts";
import type { ReasoningEffort } from "../../../../src/shared/session.ts";
import type { HostOption, WorkspaceOption } from "../../types";
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
        <h2 className="mt-3 text-[20px] font-semibold tracking-[-0.02em]">New thread</h2>
        {needsWorkspace && <p className="mt-1 text-[13px] text-[var(--text-muted)]">Choose where this session should run.</p>}
        {nearby.length > 0 && <div className="mt-5 flex flex-wrap justify-center gap-2">{nearby.map((workspace) => <button key={workspace.id} type="button" className="min-h-10 border border-[var(--border)] px-3 text-left text-[12px]" onClick={() => chooseWorkspace(workspace.hostId, workspace.path)}><strong className="block">{workspace.label}</strong><span className="block max-w-52 truncate font-mono text-[10px] text-[var(--text-muted)]">{workspace.path}</span></button>)}</div>}
        <label className="mx-auto mt-4 block max-w-lg text-left"><span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Folder</span><div className="mt-1 flex"><select aria-label="Host" value={selectedHostId} onChange={(event) => { const nextHost = event.target.value; setPath(""); dispatch({ type: "set-workspace", workspace: { hostId: nextHost, path: "" } }); }} className="min-h-11 max-w-36 border border-[var(--border)] bg-[var(--menu)] px-2 text-[12px]">{hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select><input value={path} onChange={(event) => { setPath(event.target.value); dispatch({ type: "set-workspace", workspace: { hostId: selectedHostId, path: event.target.value } }); }} className="min-h-11 min-w-0 flex-1 border border-l-0 border-[var(--border)] bg-transparent px-3 font-mono text-[11.5px]" placeholder="/path/to/repository" aria-label="Workspace folder" /></div></label>
        {draft.createState === "unknown" && <div className="mx-auto mt-4 max-w-lg border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3 text-left"><p className="flex gap-2 text-[12.5px] text-[var(--warning)]"><AlertTriangle size={14} />Creation outcome is unknown.</p><p className="mt-1 text-[12px] text-[var(--text-muted)]">{draft.error} Check the board or native harness before trying anything else. This request will not be replayed.</p></div>}
        {draft.createState === "failed" && <div className="mx-auto mt-4 max-w-lg border-l-2 border-[var(--danger)] bg-[var(--danger-field)] p-3 text-left"><p className="text-[12.5px] text-[var(--danger)]">{draft.error}</p><button type="button" className="mt-2 min-h-9 text-[12px] underline" onClick={() => dispatch({ type: "retry" })}>Try again</button></div>}
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
        effortOptions={effortOptions ?? reasoningEffortsForProvider(draft.provider)}
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
