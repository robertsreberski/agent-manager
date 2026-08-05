import {
  DEFAULT_SANDBOX_POLICY,
  reasoningEffortsForProvider,
  type ReasoningEffort,
  type SandboxPolicy,
} from "../../../../src/shared/session.ts";
import { validWorktreeName } from "../../../../src/shared/workspace.ts";
import type { CockpitProvider, ExecutionProfile } from "../../lib/cockpit-view";

/**
 * Where the session runs relative to the chosen folder.
 *
 * `none` runs in the folder exactly as given, which is also the only option for
 * a folder that is not a repository. `new` is a request, not a fact: the
 * worktree does not exist until the first send creates it.
 */
export type WorktreeSelection =
  | { kind: "none" }
  | { kind: "existing"; path: string; branch: string | null }
  | { kind: "new"; name: string; repoRoot: string };

export interface DraftWorkspace {
  hostId: string;
  path: string;
  worktree: WorktreeSelection;
}

/** What an entry point knows when it opens a draft: a folder, not yet a choice. */
export interface DraftWorkspaceInput {
  hostId: string;
  path: string;
  worktree?: WorktreeSelection;
}

export interface DraftSession {
  key: string;
  workspace: DraftWorkspace | null;
  provider: CockpitProvider;
  model: string | null;
  effort: ReasoningEffort | null;
  profile: ExecutionProfile;
  /** Codex only; Claude sessions never send one. */
  sandbox: SandboxPolicy;
  text: string;
  createState: "draft" | "creating" | "unknown" | "failed";
  error: string | null;
}

export const CONFIGURED_DRAFT_DEFAULTS = Object.freeze({
  provider: "codex" as const,
  model: null,
  effort: null,
  profile: "plan" as const,
  sandbox: DEFAULT_SANDBOX_POLICY,
});

export type DraftAction =
  | { type: "set-text"; text: string }
  | { type: "set-provider"; provider: CockpitProvider; model: string | null }
  | { type: "set-model"; model: string | null }
  | { type: "set-effort"; effort: DraftSession["effort"] }
  | { type: "set-profile"; profile: ExecutionProfile }
  | { type: "set-sandbox"; sandbox: SandboxPolicy }
  | { type: "reset-settings" }
  | { type: "set-workspace"; workspace: DraftWorkspaceInput }
  | { type: "set-worktree"; worktree: WorktreeSelection }
  | { type: "worktree-created"; path: string; branch: string }
  | { type: "creating" }
  | { type: "create-failed"; message: string; outcomeUnknown: boolean }
  | { type: "retry" };

function draftWorkspace(input: DraftWorkspaceInput): DraftWorkspace {
  return { hostId: input.hostId, path: input.path, worktree: input.worktree ?? { kind: "none" } };
}

export function newDraftSession(input: {
  workspace?: DraftWorkspaceInput;
  provider?: CockpitProvider;
  model?: string | null;
  effort?: DraftSession["effort"];
  profile?: ExecutionProfile;
  sandbox?: SandboxPolicy;
  key?: string;
} = {}): DraftSession {
  const provider = input.provider ?? CONFIGURED_DRAFT_DEFAULTS.provider;
  const requestedEffort = input.effort === undefined ? CONFIGURED_DRAFT_DEFAULTS.effort : input.effort;
  return {
    key: input.key ?? globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now().toString(36)}`,
    workspace: input.workspace ? draftWorkspace(input.workspace) : null,
    provider,
    model: input.model ?? null,
    effort: requestedEffort === null || reasoningEffortsForProvider(provider).includes(requestedEffort)
      ? requestedEffort
      : "medium",
    profile: input.profile ?? CONFIGURED_DRAFT_DEFAULTS.profile,
    sandbox: input.sandbox ?? CONFIGURED_DRAFT_DEFAULTS.sandbox,
    text: "",
    createState: "draft",
    error: null,
  };
}

export function draftReducer(state: DraftSession, action: DraftAction): DraftSession {
  switch (action.type) {
    case "set-text": return { ...state, text: action.text };
    case "set-provider": return {
      ...state,
      provider: action.provider,
      model: action.model,
      effort: state.effort === null || reasoningEffortsForProvider(action.provider).includes(state.effort)
        ? state.effort
        : "medium",
    };
    case "set-model": return { ...state, model: action.model };
    case "set-effort": return { ...state, effort: action.effort };
    case "set-profile": return { ...state, profile: action.profile };
    case "set-sandbox": return { ...state, sandbox: action.sandbox };
    case "reset-settings": return { ...state, ...CONFIGURED_DRAFT_DEFAULTS };
    case "set-workspace": {
      // A worktree chosen for one folder is not a claim about another, so a
      // changed host or path drops the selection rather than carrying it over.
      const unmoved = state.workspace !== null
        && state.workspace.hostId === action.workspace.hostId
        && state.workspace.path === action.workspace.path
        ? state.workspace
        : null;
      const worktree = action.workspace.worktree ?? unmoved?.worktree ?? { kind: "none" as const };
      return { ...state, workspace: draftWorkspace({ ...action.workspace, worktree }) };
    }
    case "set-worktree": return state.workspace === null
      ? state
      : { ...state, workspace: { ...state.workspace, worktree: action.worktree } };
    // The worktree now exists, so a retry after a failed create reuses it
    // instead of asking git for a second one under the same name.
    case "worktree-created": return state.workspace === null
      ? state
      : {
        ...state,
        workspace: {
          ...state.workspace,
          worktree: { kind: "existing", path: action.path, branch: action.branch },
        },
      };
    case "creating": return state.createState === "creating" ? state : { ...state, createState: "creating", error: null };
    case "create-failed": return {
      ...state,
      createState: action.outcomeUnknown ? "unknown" : "failed",
      error: action.message,
    };
    case "retry": return state.createState === "failed"
      ? { ...state, createState: "draft", error: null }
      : state;
  }
}

/**
 * Everything a creation needs except the message itself, which the composer
 * already refuses to send while empty.
 */
export function draftTargetReady(draft: DraftSession): boolean {
  if (draft.createState !== "draft") return false;
  if (draft.workspace === null || draft.workspace.path.trim().length === 0) return false;
  if (draft.workspace.worktree.kind === "new" && !validWorktreeName(draft.workspace.worktree.name)) return false;
  return true;
}

export function canAttemptDraftCreation(draft: DraftSession): boolean {
  return draftTargetReady(draft) && draft.text.trim().length > 0;
}

/** The directory the session will actually run in. */
export function draftLaunchPath(workspace: DraftWorkspace): string {
  return workspace.worktree.kind === "existing" ? workspace.worktree.path : workspace.path;
}

export function draftIdempotencyKey(draft: DraftSession): string {
  return `draft:${draft.key}:first-send`;
}
