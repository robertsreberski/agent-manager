import {
  reasoningEffortsForProvider,
  type ReasoningEffort,
} from "../../../../src/shared/session.ts";
import type { CockpitProvider, ExecutionProfile } from "../../lib/cockpit-view";

export interface DraftWorkspace {
  hostId: string;
  path: string;
  repoRoot?: string;
  worktreePath?: string;
}

export interface DraftSession {
  key: string;
  workspace: DraftWorkspace | null;
  provider: CockpitProvider;
  model: string | null;
  effort: ReasoningEffort | null;
  profile: ExecutionProfile;
  text: string;
  createState: "draft" | "creating" | "unknown" | "failed";
  error: string | null;
}

export const CONFIGURED_DRAFT_DEFAULTS = Object.freeze({
  provider: "codex" as const,
  model: null,
  effort: null,
  profile: "plan" as const,
});

export type DraftAction =
  | { type: "set-text"; text: string }
  | { type: "set-provider"; provider: CockpitProvider; model: string | null }
  | { type: "set-model"; model: string | null }
  | { type: "set-effort"; effort: DraftSession["effort"] }
  | { type: "set-profile"; profile: ExecutionProfile }
  | { type: "reset-settings" }
  | { type: "set-workspace"; workspace: DraftWorkspace }
  | { type: "creating" }
  | { type: "create-failed"; message: string; outcomeUnknown: boolean }
  | { type: "retry" };

export function newDraftSession(input: {
  workspace?: DraftWorkspace;
  provider?: CockpitProvider;
  model?: string | null;
  effort?: DraftSession["effort"];
  profile?: ExecutionProfile;
  key?: string;
} = {}): DraftSession {
  const provider = input.provider ?? CONFIGURED_DRAFT_DEFAULTS.provider;
  const requestedEffort = input.effort === undefined ? CONFIGURED_DRAFT_DEFAULTS.effort : input.effort;
  return {
    key: input.key ?? globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now().toString(36)}`,
    workspace: input.workspace ?? null,
    provider,
    model: input.model ?? null,
    effort: requestedEffort === null || reasoningEffortsForProvider(provider).includes(requestedEffort)
      ? requestedEffort
      : "medium",
    profile: input.profile ?? CONFIGURED_DRAFT_DEFAULTS.profile,
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
    case "reset-settings": return { ...state, ...CONFIGURED_DRAFT_DEFAULTS };
    case "set-workspace": return { ...state, workspace: action.workspace };
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

export function canAttemptDraftCreation(draft: DraftSession): boolean {
  return draft.createState === "draft"
    && draft.workspace !== null
    && draft.text.trim().length > 0;
}

export function draftIdempotencyKey(draft: DraftSession): string {
  return `draft:${draft.key}:first-send`;
}
