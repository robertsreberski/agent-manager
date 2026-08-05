import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, FolderGit2 } from "lucide-react";
import type { ReasoningEffort } from "../../../../src/shared/session.ts";
import type { WorkspaceGitContext } from "../../../../src/shared/workspace.ts";
import type { HostOption, WorkspaceOption } from "../../types";
import { Button } from "../ui";
import { FolderPicker } from "./FolderPicker";
import { SessionComposer, type ComposerModelOption } from "./SessionComposer";
import { WorktreePicker } from "./WorktreePicker";
import { recentProjects } from "../../lib/projects";
import { draftTargetReady, type DraftAction, type DraftSession, type WorktreeSelection } from "./draft";
import { useGitContext } from "./use-git-context";

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
  onCompletePath,
  onLoadGitContext,
  onReloadModels,
  initialWorktreePath = null,
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
  onCompletePath: (hostId: string, path: string) => Promise<readonly string[]>;
  onLoadGitContext: (hostId: string, path: string) => Promise<WorkspaceGitContext>;
  onReloadModels?: () => void;
  /** Where the project opened from elsewhere was last worked in. */
  initialWorktreePath?: string | null;
}) {
  const [path, setPath] = useState(draft.workspace?.path ?? "");
  const selectedHostId = draft.workspace?.hostId ?? hosts.find((host) => host.kind === "local")?.id ?? hosts[0]?.id ?? "local";
  // A repository and its worktrees are one project; where in it to run is the
  // next question this screen asks, not a way to pick the project.
  const recent = useMemo(
    () => recentProjects(workspaces).filter((project) => project.hostId === selectedHostId).slice(0, 8),
    [selectedHostId, workspaces],
  );
  // Carried until the repository's own worktree list can confirm it still exists.
  const [preferredWorktree, setPreferredWorktree] = useState<string | null>(initialWorktreePath);
  const needsWorkspace = draft.workspace === null;
  const gitContext = useGitContext(selectedHostId, path, onLoadGitContext);
  const chooseWorkspace = useCallback((hostId: string, value: string, worktreePreference: string | null = null) => {
    setPath(value);
    setPreferredWorktree(worktreePreference);
    dispatch({ type: "set-workspace", workspace: { hostId, path: value } });
  }, [dispatch]);

  /*
    Where this project was last worked in is a preference, not a claim that it
    still exists. Apply it only once the repository's own worktree list confirms
    the path — a worktree removed since then quietly leaves the choice open.
  */
  useEffect(() => {
    if (preferredWorktree === null) return;
    if (gitContext.status !== "loaded" || gitContext.context.status !== "repo") return;
    const match = gitContext.context.worktrees.find((worktree) => worktree.path === preferredWorktree);
    setPreferredWorktree(null);
    if (match) dispatch({ type: "set-worktree", worktree: { kind: "existing", path: match.path, branch: match.branch } });
  }, [dispatch, gitContext, preferredWorktree]);

  /*
    An answered question stays answered. "No worktree" is both the default and a
    real choice, so a pending preference cannot be told apart from it by the
    selection alone — dropping the preference the moment the operator selects
    anything keeps a deferred lookup from undoing them.
  */
  const chooseWorktree = useCallback((worktree: WorktreeSelection) => {
    setPreferredWorktree(null);
    dispatch({ type: "set-worktree", worktree });
  }, [dispatch]);

  return (
    <div className="grid min-h-full min-w-0 max-w-full content-between gap-6" data-draft-thread>
      <section className="mx-auto w-full min-w-0 max-w-2xl py-8 text-center">
        <FolderGit2 size={24} className="mx-auto text-[var(--text-muted)]" />
        <h2 className="mt-3 text-display-sm">New thread</h2>
        {needsWorkspace && <p className="mt-1 text-meta text-[var(--text-muted)]">Choose where this session should run.</p>}
        {recent.length > 0 && (
          <div className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Recent projects">
            {recent.map((project) => (
              <Button
                key={project.id}
                variant="secondary"
                size="sm"
                data-compact-control
                className="h-auto min-h-10 flex-col items-start justify-center gap-0 px-3 text-left"
                onClick={() => chooseWorkspace(project.hostId, project.path, project.lastWorktreePath)}
              >
                <strong className="block">{project.label}</strong>
                <span className="block max-w-52 truncate font-mono text-code-xs text-[var(--text-muted)]">{project.path}</span>
              </Button>
            ))}
          </div>
        )}
        <FolderPicker
          hostId={selectedHostId}
          hosts={hosts}
          path={path}
          onPathChange={(next) => chooseWorkspace(selectedHostId, next)}
          onHostChange={(nextHost) => chooseWorkspace(nextHost, "")}
          onComplete={onCompletePath}
        />
        <WorktreePicker
          state={gitContext}
          selection={draft.workspace?.worktree ?? { kind: "none" }}
          folderPath={path}
          onSelect={chooseWorktree}
        />
        {draft.createState === "unknown" && <div className="mx-auto mt-4 max-w-lg border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3 text-left"><p className="flex gap-2 text-meta-sm text-[var(--warning)]"><AlertTriangle size={14} />Creation outcome is unknown.</p><p className="mt-1 text-meta-sm text-[var(--text-muted)]">{draft.error} Check the board or native harness before trying anything else. This request will not be replayed.</p></div>}
        {draft.createState === "failed" && <div className="mx-auto mt-4 max-w-lg border-l-2 border-[var(--danger)] bg-[var(--danger-field)] p-3 text-left"><p className="text-meta-sm text-[var(--danger)]">{draft.error}</p><Button variant="ghost" size="sm" data-compact-control className="mt-2 px-0 underline" onClick={() => dispatch({ type: "retry" })}>Try again</Button></div>}
      </section>
      <SessionComposer
        value={draft.text}
        onChange={(text) => dispatch({ type: "set-text", text })}
        onSend={() => onFirstSend()}
        isRunning={false}
        canQueue={mutationsReady && draftTargetReady(draft)}
        canSteer={false}
        canStop={false}
        provider={draft.provider}
        model={draft.model}
        modelOptions={modelOptions}
        modelOptionsStatus={modelOptionsStatus}
        {...(onReloadModels ? { onReloadModels } : {})}
        effort={draft.effort}
        effortOptions={effortOptions ?? []}
        profile={draft.profile}
        sandbox={draft.sandbox}
        draft
        readOnlyReason={mutationsReady ? null : "Reconnect before creating a session."}
        busy={busy || draft.createState === "creating" || draft.createState === "unknown"}
        onProviderChange={(provider) => dispatch({ type: "set-provider", provider, model: null })}
        onModelChange={(model) => dispatch({ type: "set-model", model })}
        onEffortChange={(effort) => dispatch({ type: "set-effort", effort })}
        onProfileChange={(profile) => dispatch({ type: "set-profile", profile })}
        onSandboxChange={(sandbox) => dispatch({ type: "set-sandbox", sandbox })}
        onResetSettings={() => dispatch({ type: "reset-settings" })}
      />
    </div>
  );
}
