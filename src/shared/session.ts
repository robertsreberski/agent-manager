export type Provider = "codex" | "claude";

export function sessionRecordId(hostId: string, provider: Provider, providerThreadId: string): string {
  return `${hostId}:${provider}:${providerThreadId}`;
}

export type ExecutionProfile =
  | "ask-first"
  | "plan"
  | "execute"
  | "full-access";

/** The complete public effort vocabulary exposed by at least one harness. */
export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/** Codex currently exposes the full public effort vocabulary. */
export const CODEX_REASONING_EFFORTS: readonly ReasoningEffort[] = REASONING_EFFORTS;

/** Claude's SDK deliberately excludes Codex-only `minimal` and `ultra`. */
export const CLAUDE_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningEffort[];

export function reasoningEffortsForProvider(
  provider: Provider,
): readonly ReasoningEffort[] {
  return provider === "codex" ? CODEX_REASONING_EFFORTS : CLAUDE_REASONING_EFFORTS;
}

/**
 * Normalize a provider fact into the public vocabulary without erasing the raw
 * provider value. Callers keep that raw string in `providerValue` even when
 * this function returns null.
 */
export function normalizeProviderReasoningEffort(
  provider: Provider,
  providerValue: string | null,
): ReasoningEffort | null {
  if (providerValue === null) return null;
  return reasoningEffortsForProvider(provider).find((effort) => effort === providerValue) ?? null;
}

export type SessionPresence = "live" | "recent";
export type SessionKind =
  | "interactive"
  | "background"
  | "batch"
  | "subagent"
  | "unknown";

export type SessionStatus =
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export type EvidenceConfidence = "exact" | "inferred" | "heuristic";
export type EvidenceSource =
  | "provider-api"
  | "provider-cli"
  | "hook"
  | "live-registry"
  | "rollout-events"
  | "transcript"
  | "process"
  | "tmux"
  | "inferred";

export interface EvidencedValue<T> {
  value: T;
  providerValue: string | null;
  source: EvidenceSource;
  confidence: EvidenceConfidence;
}

export type SessionProfile = EvidencedValue<ExecutionProfile | null>;
export type SessionModel = EvidencedValue<string | null>;
export type SessionEffort = EvidencedValue<ReasoningEffort | null>;

export type AttentionKind =
  | "question"
  | "approval"
  | "permission"
  | "sandbox"
  | "elicitation"
  | "blocked";

export interface AttentionOption {
  label: string;
  description: string | null;
}

export interface AttentionQuestion {
  id: string;
  header: string | null;
  text: string;
  options: AttentionOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
  isSecret: boolean;
}

export interface AttentionDetails {
  title: string | null;
  questions: AttentionQuestion[] | null;
  toolName: string | null;
  inputSummary: string | null;
  /** False when the cockpit cannot faithfully encode this provider request. */
  respondable: boolean;
}

export interface SessionAttention {
  /** Null only for explicitly heuristic, non-respondable attention. */
  id: string | null;
  kind: AttentionKind;
  summary: string | null;
  source: EvidenceSource;
  confidence: EvidenceConfidence;
  details: AttentionDetails | null;
}

/**
 * An immutable description of a tmux pane. It is safe to display or use as an
 * argv element; it is never interpreted as a shell fragment.
 */
export interface SessionTerminal {
  attachAvailable: boolean;
  socketName: string | null;
  socketPath: string | null;
  session: string;
  window: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  tty: string | null;
  attachedClients: number;
}

export interface WorkspaceIdentity {
  /** Absolute path of the main working tree and the repository identity. */
  repoRoot: string;
  repoName: string;
  /** Absolute path of this working tree. */
  worktreePath: string;
  linked: boolean;
  branch: string | null;
  detached: boolean;
  dirtyCount: number | null;
  ahead: number | null;
  behind: number | null;
  /** Lines added and removed across tracked changes; null when git could not say. */
  insertions: number | null;
  deletions: number | null;
}

export type ControlPlane =
  | "codex-private"
  | "codex-hook-bridge"
  | "claude-sdk"
  | "claude-hook-bridge"
  | "tmux-attach"
  | "resume-only"
  | "observe-only";

export type ControlCapability =
  | "queue"
  | "steer"
  | "interrupt"
  | "respond"
  | "set-profile"
  | "set-model"
  | "set-effort"
  | "remove-queued"
  | "preview"
  | "attach"
  | "resume"
  | "end"
  | "archive"
  | "delete"
  | "open-editor";

export interface WithheldCapability {
  capability: ControlCapability;
  reason: string;
}

export interface SessionControl {
  plane: ControlPlane;
  /** Which controller currently has authority to write to the harness. */
  authority: "manager" | "foreign" | "none";
  capabilities: ControlCapability[];
  /** Display-only explanations. Authorization reads capabilities, never this list. */
  withheld: WithheldCapability[];
}

export interface ChildSummary {
  total: number;
  running: number;
  waiting: number;
  idle: number;
  completed: number;
  failed: number;
  interrupted: number;
  unknown: number;
}

/** Global todo metadata. Todo text and details stay in selected-session activity. */
export interface TodoProgress {
  completed: number;
  total: number;
  /** True only after the hub observed a list-identity or step-status transition. */
  hasMoved: boolean;
  /** Observation time of the latest semantic transition; null for the baseline. */
  lastTransitionAt: string | null;
  /** An incomplete list currently has a provider-reported in-progress step. */
  active: boolean;
}

/**
 * Canonical session identity and state. `id` is Agent Manager's stable,
 * host-and-provider-qualified identifier. Provider identifiers are never
 * overloaded or rewritten: thread, tree, parent, and active turn each have a
 * named field.
 */
export interface SessionRecord {
  id: string;
  provider: Provider;
  providerThreadId: string;
  providerTreeId: string | null;
  parentId: string | null;
  providerTurnId: string | null;
  depth: number;
  hostId: string;
  hostLabel: string;
  name: string | null;
  cwd: string | null;
  kind: SessionKind;
  presence: SessionPresence;
  status: SessionStatus;
  providerStatus: string | null;
  pid: number | null;
  runtimePid: number | null;
  startedAt: string | null;
  updatedAt: string;
  childSummary: ChildSummary;
  statusSource: EvidenceSource;
  source: string | null;
  profile: SessionProfile;
  model: SessionModel;
  effort: SessionEffort;
  todoProgress: TodoProgress | null;
  attention: SessionAttention[];
  terminal: SessionTerminal | null;
  control: SessionControl;
  workspaceIdentity: WorkspaceIdentity | null;
  /** Assigned monotonically by the long-lived service; zero means unassigned. */
  generation: number;
}

/** Public collection and selected-session records use one shape. */
export type SessionView = SessionRecord;

export interface Diagnostic {
  provider: Provider | "system";
  level: "warning" | "error";
  message: string;
}

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "interrupted",
  "unknown",
] as const;

export function emptyChildSummary(): ChildSummary {
  return {
    total: 0,
    running: 0,
    waiting: 0,
    idle: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    unknown: 0,
  };
}

export function unknownProfile(): SessionProfile {
  return {
    value: null,
    providerValue: null,
    source: "inferred",
    confidence: "heuristic",
  };
}

export function unknownModel(): SessionModel {
  return {
    value: null,
    providerValue: null,
    source: "inferred",
    confidence: "heuristic",
  };
}

export function unknownEffort(): SessionEffort {
  return {
    value: null,
    providerValue: null,
    source: "inferred",
    confidence: "heuristic",
  };
}

export function providerEffort(
  provider: Provider,
  providerValue: string | null,
  source: EvidenceSource,
): SessionEffort {
  return {
    value: normalizeProviderReasoningEffort(provider, providerValue),
    providerValue,
    source,
    confidence: providerValue === null ? "heuristic" : "exact",
  };
}

export function observeOnlyControl(): SessionControl {
  return {
    plane: "observe-only",
    authority: "none",
    capabilities: [],
    withheld: [],
  };
}
