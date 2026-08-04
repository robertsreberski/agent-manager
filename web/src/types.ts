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
  isSecret?: boolean;
  source: string;
  confidence: Confidence;
}

export interface AttentionQuestion {
  id: string;
  header?: string;
  text: string;
  options: Array<{
    label: string;
    description?: string;
  }>;
  multiSelect: boolean;
  allowFreeText: boolean;
  isSecret?: boolean;
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

// This mirrors the versioned wire contract in src/activity/types.ts. Keep the
// browser copy independent so the web bundle never pulls server modules into
// its runtime graph.
export const ACTIVITY_SCHEMA_VERSION = 1 as const;

export type ActivityJsonValue =
  | null
  | boolean
  | number
  | string
  | ActivityJsonValue[]
  | { [key: string]: ActivityJsonValue };

export type ActivityItemState =
  | "pending"
  | "running"
  | "waiting"
  | "complete"
  | "failed"
  | "interrupted";

export interface ActivityPlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ActivityFileChange {
  path: string;
  operation: "add" | "update" | "delete" | "rename";
  diff: string;
}

export interface ActivityAttentionOption {
  label: string;
  description: string | null;
}

export interface ActivityAttentionQuestion {
  id: string;
  header?: string;
  text: string;
  options: ActivityAttentionOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
  isSecret: boolean;
}

export interface ActivityQueuedMessage {
  id: string;
  text: string;
  status: "queued" | "dispatching" | "dispatched" | "failed";
  enqueuedAt: string;
  turnId: string | null;
}

export interface ActivityItemBase {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  provider: Provider;
  turnId: string | null;
  parentId: string | null;
  seq: number;
  revision: number;
  state: ActivityItemState;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  source: "provider-api" | "transcript";
  confidence: Confidence;
  exposure: "provider-exposed" | "transcript-derived";
  truncated: boolean;
}

export interface ActivityMessageItem extends ActivityItemBase {
  kind: "message";
  role: "user" | "assistant" | "system" | "tool";
  phase: "commentary" | "final" | null;
  text: string;
  label: string | null;
}

export interface ActivityReasoningItem extends ActivityItemBase {
  kind: "reasoning";
  reasoningKind: "summary" | "raw";
  label: string | null;
  text: string;
}

export interface ActivityPlanItem extends ActivityItemBase {
  kind: "plan";
  text: string;
  steps: ActivityPlanStep[];
}

export interface ActivityToolItem extends ActivityItemBase {
  kind: "tool";
  toolCallId: string;
  name: string;
  category: "command" | "mcp" | "web-search" | "image-view" | "dynamic" | "collaboration" | "other";
  arguments: ActivityJsonValue | string | null;
  result: ActivityJsonValue | string | null;
  output: string;
}

export interface ActivityFileChangeItem extends ActivityItemBase {
  kind: "file-change";
  summary: string;
  changes: ActivityFileChange[];
}

export interface ActivitySubagentItem extends ActivityItemBase {
  kind: "subagent";
  taskId: string;
  name: string;
  description: string | null;
  output: string;
  childItemIds: string[];
}

export interface ActivityAttentionItem extends ActivityItemBase {
  kind: "attention";
  requestId: string;
  attentionKind: AttentionKind;
  title: string | null;
  summary: string | null;
  questions: ActivityAttentionQuestion[];
  respondable: boolean;
  resolved: boolean;
  isSecret: boolean;
}

export interface ActivityQueueItem extends ActivityItemBase {
  kind: "queue";
  messages: ActivityQueuedMessage[];
}

export interface ActivityLifecycleItem extends ActivityItemBase {
  kind: "lifecycle";
  event:
    | "turn-started"
    | "turn-completed"
    | "turn-failed"
    | "turn-interrupted"
    | "warning"
    | "error"
    | "hook"
    | "model-routing"
    | "context-compaction"
    | "status";
  level: "info" | "warning" | "error";
  title: string;
  details: string | null;
}

export interface ActivityUsageItem extends ActivityItemBase {
  kind: "usage";
  scope: "turn" | "thread" | "session";
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export type ActivityItem =
  | ActivityMessageItem
  | ActivityReasoningItem
  | ActivityPlanItem
  | ActivityToolItem
  | ActivityFileChangeItem
  | ActivitySubagentItem
  | ActivityAttentionItem
  | ActivityQueueItem
  | ActivityLifecycleItem
  | ActivityUsageItem;

export type ActivityAppendChannel = "text" | "arguments" | "result" | "output" | "diff" | "details";
export type ActivityResetReason =
  | "provider-reset"
  | "transcript-reset"
  | "rotation"
  | "truncation"
  | "branch-change"
  | "replay-gap"
  | "cleared"
  | "other";

interface ActivityFrameBase {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  streamEpoch: string;
  sessionId: string;
  provider: Provider;
  seq: number;
  /** Opaque replay cursor bound to streamEpoch and sessionId. */
  cursor: string;
  at: string;
}

export interface ActivitySnapshotFrame extends ActivityFrameBase {
  type: "activity.snapshot";
  items: ActivityItem[];
  truncated: boolean;
}

export interface ActivityUpsertFrame extends ActivityFrameBase {
  type: "activity.upsert";
  item: ActivityItem;
}

export interface ActivityAppendFrame extends ActivityFrameBase {
  type: "activity.append";
  id: string;
  revision: number;
  channel: ActivityAppendChannel;
  /** UTF-8 byte offset in the already-redacted field rendered by the client. */
  offset: number;
  text: string;
  truncated: boolean;
}

export interface ActivityRemoveFrame extends ActivityFrameBase {
  type: "activity.remove";
  id: string;
}

export interface ActivityResetFrame extends ActivityFrameBase {
  type: "activity.reset";
  reason: ActivityResetReason;
  items: ActivityItem[];
  truncated: boolean;
}

export type ActivityFrame =
  | ActivitySnapshotFrame
  | ActivityUpsertFrame
  | ActivityAppendFrame
  | ActivityRemoveFrame
  | ActivityResetFrame;

export interface SessionActivityView {
  sessionId: string | null;
  items: ActivityItem[];
  hasSnapshot: boolean;
  truncated: boolean;
  streamEpoch: string | null;
  cursor: string | null;
  seq: number | null;
  connection: ConnectionState;
  updateCount: number;
}
