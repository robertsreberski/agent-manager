export type Provider = "codex" | "claude";
export type ModeValue = "planning" | "execution" | "unknown";
export type Activity =
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";
export type Confidence = "exact" | "inferred" | "heuristic";
export type Ownership = "manager" | "external";
export type AttentionKind =
  | "question"
  | "approval"
  | "permission"
  | "sandbox"
  | "elicitation"
  | "blocked";
export type Capability =
  | "queue"
  | "steer"
  | "interrupt"
  | "respond"
  | "set-mode"
  | "preview"
  | "attach"
  | "resume";

export interface ModeState {
  value: ModeValue;
  providerValue: string | null;
  source: string;
  confidence: Confidence;
}

export interface AttentionRequest {
  id: string | null;
  kind: AttentionKind;
  summary: string | null;
  prompt?: string | null;
  options?: Array<{
    id?: string;
    label: string;
    description?: string;
  }>;
  multiple?: boolean;
  title?: string;
  questions?: AttentionQuestion[];
  toolName?: string;
  inputSummary?: string;
  respondable?: boolean;
  source: string;
  confidence: Confidence;
}

export interface AttentionQuestion {
  id: string;
  text: string;
  options: Array<{
    label: string;
    description?: string;
  }>;
  multiSelect: boolean;
  allowFreeText: boolean;
}

export interface EffectiveAccess {
  permissionMode: string | null;
  sandboxMode: string | null;
  fullHostAccess: boolean;
}

export interface TerminalTarget {
  attachAvailable: boolean;
  session: string;
  window: string;
  paneId: string;
  attachedClients: number;
}

export interface SessionControl {
  plane: string;
  capabilities: Capability[];
  managerOwned: boolean;
  writableLease: boolean;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  createdAt?: string | null;
  status?: "running" | "complete" | "incomplete";
  label?: string | null;
}

export type TranscriptState = "not-loaded" | "available" | "unavailable";
export type TranscriptSource = "codex-rollout" | "claude-transcript" | "provider-api";
export type TranscriptUnavailableReason = "not-found" | "unreadable" | "unsupported";

export interface SessionTranscript {
  state: TranscriptState;
  truncated: boolean;
  source: TranscriptSource | null;
  messageCount: number;
  reason: TranscriptUnavailableReason | null;
}

export interface QueueEntry {
  id: string;
  prompt: string;
}

export interface SessionView {
  id: string;
  provider: Provider;
  name: string | null;
  cwd: string | null;
  parentSessionId: string | null;
  depth: number;
  ownership: Ownership;
  runtimeAlive: boolean;
  mode: ModeState;
  activity: Activity;
  attention: AttentionRequest[];
  effectiveAccess: EffectiveAccess;
  terminal: TerminalTarget | null;
  control: SessionControl;
  generation: number;
  runId: string | null;
  updatedAt: string | null;
  messages: ConversationMessage[];
  transcript?: SessionTranscript;
  queue: QueueEntry[];
}

export interface Diagnostic {
  provider?: Provider | "system";
  level: "warning" | "error";
  message: string;
}

export interface SessionsSnapshot {
  sessions: SessionView[];
  diagnostics: Diagnostic[];
  generatedAt: string | null;
  seq: number | null;
  stale: boolean;
}

export interface AuthSession {
  csrfToken: string | null;
  actor: string | null;
}

export interface ControlLease {
  token: string;
  clientId: string;
  expiresAt: string;
  fullHostArmedUntil: string | null;
}

export interface AttachInstruction {
  available: boolean;
  kind: "tmux" | "codex-remote" | "claude-resume" | "manager-cli" | "none" | string;
  command: string | null;
  description: string | null;
  requiresHandoff?: boolean;
  argv?: string[];
  cwd?: string | null;
}

export interface PanePreview {
  content: string;
  capturedAt?: string;
  truncated?: boolean;
  lines?: number;
}

export type SessionAction =
  | {
      type: "send";
      delivery: "queue" | "steer";
      text: string;
      expectedGeneration: number;
      expectedRunId?: string;
      idempotencyKey: string;
    }
  | {
      type: "respond";
      requestId: string;
      response: RequestResponse;
      expectedGeneration: number;
      idempotencyKey: string;
    }
  | {
      type: "interrupt";
      expectedGeneration: number;
      expectedRunId?: string;
      idempotencyKey: string;
    }
  | {
      type: "set-mode";
      mode: "planning" | "execution";
      expectedGeneration: number;
      idempotencyKey: string;
    };

export type SessionFilter = "all" | "attention" | "running" | "managed" | "external";

export interface WorkspaceOption {
  id: string;
  label: string;
  path?: string;
  temporary?: boolean;
}

export interface CreateSessionInput {
  provider: Provider;
  workspaceId: string;
  name?: string;
  initialMessage: string;
  mode: "planning" | "execution";
  permissionPreset: "standard" | "full-host";
  idempotencyKey: string;
}

export type RequestResponse =
  | {
      kind: "answer";
      value: string;
      selectedOptions: string[];
    }
  | {
      kind: "answers";
      answers: Array<{
        questionId: string;
        value: string;
        selectedOptions: string[];
      }>;
    }
  | {
      kind: "decision";
      decision: "allow" | "deny";
      reason?: string;
    };

export type ConnectionState = "connecting" | "open" | "retrying" | "offline";
