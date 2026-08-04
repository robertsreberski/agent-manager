export type Provider = "codex" | "claude";
export type SessionOwnership = "external" | "manager";
export type SessionLifecycle = "live" | "recent";
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

export type SessionActivity = SessionStatus;
export type AgentModeValue = "planning" | "execution" | "unknown";
export type EvidenceConfidence = "exact" | "inferred" | "heuristic";
export type EvidenceSource =
  | "provider-api"
  | "provider-cli"
  | "live-registry"
  | "rollout-events"
  | "transcript"
  | "process"
  | "tmux"
  | "inferred";

export interface SessionMode {
  value: AgentModeValue;
  providerValue: string | null;
  source: EvidenceSource;
  confidence: EvidenceConfidence;
}

export type AttentionKind =
  | "question"
  | "approval"
  | "permission"
  | "sandbox"
  | "elicitation"
  | "blocked";

export interface AttentionOption {
  label: string;
  description?: string;
}

export interface AttentionQuestion {
  id: string;
  header?: string;
  text: string;
  options: AttentionOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
  isSecret?: boolean;
}

export interface AttentionDetails {
  title?: string;
  questions?: AttentionQuestion[];
  toolName?: string;
  inputSummary?: string;
  /** False when the cockpit cannot faithfully encode this provider request. */
  respondable?: boolean;
}

export interface SessionAttention {
  id: string | null;
  kind: AttentionKind;
  summary: string | null;
  source: EvidenceSource;
  confidence: EvidenceConfidence;
  /** Exact structured provider input; heuristic external records omit it. */
  details?: AttentionDetails;
}

export interface EffectiveAccess {
  permissionMode: string | null;
  sandboxMode: string | null;
  fullHostAccess: boolean;
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

export type ControlPlane =
  | "codex-app-server"
  | "claude-sdk"
  | "tmux-attach"
  | "resume-only"
  | "observe-only";

export type ControlCapability =
  | "queue"
  | "steer"
  | "interrupt"
  | "respond"
  | "set-mode"
  | "preview"
  | "attach"
  | "resume";

export interface SessionControl {
  plane: ControlPlane;
  capabilities: ControlCapability[];
  managerOwned: boolean;
  writableLease: boolean;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  createdAt: string | null;
  status: "running" | "complete" | "incomplete";
  label: string | null;
}

export type TranscriptState = "not-loaded" | "available" | "unavailable";
export type TranscriptSource = "codex-rollout" | "claude-transcript" | "provider-api";
export type TranscriptUnavailableReason = "not-found" | "unreadable" | "unsupported";

/**
 * Selected-session transcript detail. Collection snapshots and SSE deliberately
 * omit these fields so one open cockpit tab does not receive every local
 * conversation or retain them in the replay ring.
 */
export interface SessionTranscript {
  state: TranscriptState;
  truncated: boolean;
  source: TranscriptSource | null;
  messageCount: number;
  reason: TranscriptUnavailableReason | null;
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

/**
 * Canonical discovery record. Existing v1 fields remain present while the
 * normalized v2 fields provide evidence-aware state for cockpit consumers.
 */
export interface SessionRecord {
  provider: Provider;
  sessionId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  depth: number;
  name: string | null;
  cwd: string | null;
  kind: SessionKind;
  lifecycle: SessionLifecycle;
  status: SessionStatus;
  providerStatus: string | null;
  waitingReason: "approval" | "user-input" | "blocked" | null;
  pid: number | null;
  runtimePid: number | null;
  startedAt: string | null;
  updatedAt: string;
  childSummary: ChildSummary;
  statusSource: Exclude<EvidenceSource, "provider-api" | "tmux">;
  source: string | null;

  ownership: SessionOwnership;
  runtimeAlive: boolean;
  mode: SessionMode;
  activity: SessionActivity;
  attention: SessionAttention[];
  effectiveAccess: EffectiveAccess;
  terminal: SessionTerminal | null;
  control: SessionControl;
  /** Assigned monotonically by the long-lived service; zero means unassigned. */
  generation: number;
}

/** Public API records add an explicit id while retaining sessionId compatibility. */
export interface SessionView extends SessionRecord {
  id: string;
  /** Exact provider turn/run identifier while a managed session is active. */
  runId?: string | null;
  /** Present only on the authenticated per-session detail response. */
  messages?: ConversationMessage[];
  /** Present only on the authenticated per-session detail response. */
  transcript?: SessionTranscript;
}

export interface Diagnostic {
  provider: Provider | "system";
  level: "warning" | "error";
  message: string;
}

export interface ListingResult {
  version: 2;
  generatedAt: string;
  recentWindowSeconds: number;
  sessions: SessionRecord[];
  diagnostics: Diagnostic[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error: Error | null;
}

export interface Runtime {
  now(): number;
  homeDir: string;
  env: Record<string, string | undefined>;
  run(command: string, args: string[], timeoutMs?: number): CommandResult;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  startedAtMs: number | null;
  tty: string;
  state: string;
  command: string;
  executable: string;
}

export interface AdapterResult {
  sessions: SessionRecord[];
  diagnostics: Diagnostic[];
  succeeded: boolean;
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

export function unknownMode(): SessionMode {
  return {
    value: "unknown",
    providerValue: null,
    source: "inferred",
    confidence: "heuristic",
  };
}

export function unknownAccess(): EffectiveAccess {
  return {
    permissionMode: null,
    sandboxMode: null,
    fullHostAccess: false,
  };
}

export function observeOnlyControl(): SessionControl {
  return {
    plane: "observe-only",
    capabilities: [],
    managerOwned: false,
    writableLease: false,
  };
}
