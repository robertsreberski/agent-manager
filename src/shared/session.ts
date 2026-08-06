import {
  DEFERRED,
  allCapabilities,
  deferredToLaterLayers,
  resolveControlCapabilities,
} from "./capabilities.ts";

export type Provider = "codex" | "claude";

export function sessionRecordId(hostId: string, provider: Provider, providerThreadId: string): string {
  return `${hostId}:${provider}:${providerThreadId}`;
}

export type ExecutionProfile =
  | "ask-first"
  | "plan"
  | "execute"
  | "full-access";

/**
 * How far a Codex thread may reach outside its own conversation.
 *
 * This is the containment axis, and it is independent of the execution profile:
 * the profile decides whether the harness asks before acting, this decides what
 * acting can touch at all. Claude has no equivalent setting and never carries
 * one.
 */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export interface SandboxPolicy {
  mode: CodexSandboxMode;
  /**
   * Operator-controllable only for `workspace-write`. The other two modes each
   * have exactly one truthful value, so a policy has one canonical form.
   */
  networkAccess: boolean;
}

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  mode: "workspace-write",
  networkAccess: false,
});

/** The canonical policy for a mode, which is the only form ever transmitted. */
export function sandboxPolicy(mode: CodexSandboxMode, networkAccess = false): SandboxPolicy {
  if (mode === "read-only") return { mode, networkAccess: false };
  if (mode === "danger-full-access") return { mode, networkAccess: true };
  return { mode, networkAccess };
}

export function isCanonicalSandboxPolicy(policy: SandboxPolicy): boolean {
  if (policy.mode === "read-only") return policy.networkAccess === false;
  if (policy.mode === "danger-full-access") return policy.networkAccess === true;
  return true;
}

export function sandboxEquals(left: SandboxPolicy | null, right: SandboxPolicy | null): boolean {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.networkAccess === right.networkAccess;
}

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
export type TakeoverMethod = "guided-exit" | "graceful-stop";
export type TakeoverState =
  | "available"
  | "awaiting-confirmation"
  | "waiting-for-exit"
  | "stopping"
  | "adopting"
  | "failed";

/**
 * Public state for migrating a standalone foreign CLI onto Agent Manager's
 * provider connection. Claude transfers exclusive ownership; Codex may use the
 * same one-time migration before joining the shared App Server connection.
 * `id` is null only while takeover is merely available; an active or failed
 * attempt always carries the identity used to reject stale cancellation.
 */
export interface SessionTakeover {
  id: string | null;
  state: TakeoverState;
  methods: TakeoverMethod[];
  method: TakeoverMethod | null;
  requestedAt: string | null;
  deadlineAt: string | null;
  /** Conservative mode applied only when discovery could not prove one. */
  fallbackProfile: ExecutionProfile | null;
  /** Conservative sandbox applied only when discovery could not prove one. */
  fallbackSandbox: SandboxPolicy | null;
  error: string | null;
}

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
/** Null both for Claude, which has no sandbox, and for an unproven Codex one. */
export type SessionSandbox = EvidencedValue<SandboxPolicy | null>;

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
  | "set-sandbox"
  | "set-model"
  | "set-effort"
  | "remove-queued"
  | "preview"
  | "attach"
  | "resume"
  | "end"
  | "archive"
  | "delete"
  | "take-control"
  | "cancel-take-control"
  | "retry-control"
  | "open-editor";

/**
 * Every control capability, in the order a session view publishes them.
 *
 * The union alone could not stop a new member being silently omitted from the
 * several hand-maintained lists that enumerate capabilities; the two assertions
 * below make adding one a compile error until every list rules on it.
 */
export const CONTROL_CAPABILITIES = [
  "queue",
  "steer",
  "interrupt",
  "respond",
  "set-profile",
  "set-sandbox",
  "set-model",
  "set-effort",
  "remove-queued",
  "preview",
  "attach",
  "resume",
  "end",
  "archive",
  "delete",
  "take-control",
  "cancel-take-control",
  "retry-control",
  "open-editor",
] as const satisfies readonly ControlCapability[];

/** Fails to compile if a `ControlCapability` is missing from the list above. */
type ControlCapabilitiesAreTotal =
  Exclude<ControlCapability, typeof CONTROL_CAPABILITIES[number]> extends never ? true : never;
const controlCapabilitiesAreTotal: ControlCapabilitiesAreTotal = true;
void controlCapabilitiesAreTotal;

export type ControlCoordinationMode = "shared" | "exclusive" | "observe-only";
export type NativeAttachCoordination = "join" | "handoff" | "none";
export type ResponseResolution = "first-response-wins" | "single-controller";

/** Provider concurrency semantics, independent of the current writer lease. */
export interface SessionControlCoordination {
  mode: ControlCoordinationMode;
  nativeAttach: NativeAttachCoordination;
  responseResolution: ResponseResolution;
}

/** Canonical live-control semantics for each provider. */
export function providerControlCoordination(
  provider: Provider,
): SessionControlCoordination {
  return provider === "codex"
    ? {
        mode: "shared",
        nativeAttach: "join",
        responseResolution: "first-response-wins",
      }
    : {
        mode: "exclusive",
        nativeAttach: "handoff",
        responseResolution: "single-controller",
      };
}

export type SessionControlRecoveryState =
  | "reconnecting"
  | "waiting-for-native-exit"
  | "retrying"
  | "needs-attention";

/** Bounded provider-control recovery state; transcript reads remain independent. */
export interface SessionControlRecovery {
  state: SessionControlRecoveryState;
  /** One-based attempt number for the current recovery series. */
  attempt: number;
  startedAt: string;
  deadlineAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
}

export interface WithheldCapability {
  capability: ControlCapability;
  reason: string;
}

export interface SessionControl {
  plane: ControlPlane;
  /** Which controller currently has authority to write to the harness. */
  authority: "manager" | "foreign" | "none";
  /** Whether provider clients may join or must hand exclusive ownership over. */
  coordination: SessionControlCoordination;
  /** Null while provider control is healthy or no recovery has been attempted. */
  recovery: SessionControlRecovery | null;
  capabilities: ControlCapability[];
  /** Display-only explanations. Authorization reads capabilities, never this list. */
  withheld: WithheldCapability[];
  /** Null when this session is already manager-owned or cannot be adopted safely. */
  takeover: SessionTakeover | null;
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
  /** Provider-owned archive lifecycle, independent of live/recent presence. */
  archived: boolean;
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
  sandbox: SessionSandbox;
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

export function unknownSandbox(): SessionSandbox {
  return {
    value: null,
    providerValue: null,
    source: "inferred",
    confidence: "heuristic",
  };
}

/** Claude having no sandbox is an exact fact, not an unproven one. */
export function noSandbox(): SessionSandbox {
  return {
    value: null,
    providerValue: null,
    source: "provider-api",
    confidence: "exact",
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

/**
 * Why a session Agent Manager only watches refuses a write.
 *
 * Naming the remedy rather than the absence is the whole point. This is a
 * session the manager can see but does not own — the harness supports the
 * write perfectly well, and `take-control` is offered alongside. Saying the
 * harness lacks the feature would be false, and would send the operator
 * looking for a setting instead of the button that fixes it.
 */
export const OBSERVE_ONLY_REASON =
  "Agent Manager is observing this session. Take control to change it.";

export function observeOnlyControl(): SessionControl {
  return {
    plane: "observe-only",
    authority: "none",
    coordination: {
      mode: "observe-only",
      nativeAttach: "none",
      responseResolution: "single-controller",
    },
    recovery: null,
    /*
      Rule on every control, rather than publishing two empty lists.
      A capability in neither list is a hole: the cockpit disables the control
      because it was not granted, then finds no reason to show and invents one.
      That is exactly how an observed session came to claim its harness had no
      model setting.

      `take-control` and the rest of the later-layer capabilities stay deferred
      — the takeover coordinator and the editor launcher decide those after
      this record is published, and a withheld entry here reads as a standing
      refusal that stops them being granted at all.
    */
    ...resolveControlCapabilities({
      ...allCapabilities(OBSERVE_ONLY_REASON),
      ...deferredToLaterLayers(),
      /*
        Discovery decides these too, and it decides them by *replacing*
        `capabilities` while keeping `withheld` as it found it — see the tmux
        pane matcher. Withholding them here would leave them granted and
        withheld at once the moment an observed session is matched to a pane.
      */
      attach: DEFERRED,
      resume: DEFERRED,
    }),
    takeover: null,
  };
}
