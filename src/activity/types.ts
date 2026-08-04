import type { Provider } from "../core/types.ts";

export type { Provider };

export const ACTIVITY_SCHEMA_VERSION = 1 as const;

export type ActivityJsonValue =
  | null
  | boolean
  | number
  | string
  | ActivityJsonValue[]
  | { [key: string]: ActivityJsonValue };

export type ActivityState =
  | "pending"
  | "running"
  | "waiting"
  | "complete"
  | "failed"
  | "interrupted";

export type ActivitySource = "provider-api" | "transcript";
export type ActivityConfidence = "exact" | "inferred" | "heuristic";
export type ActivityExposure = "provider-exposed" | "transcript-derived";

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

interface ActivityItemBase {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  provider: Provider;
  turnId: string | null;
  parentId: string | null;
  seq: number;
  revision: number;
  state: ActivityState;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  source: ActivitySource;
  confidence: ActivityConfidence;
  exposure: ActivityExposure;
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
  category:
    | "command"
    | "mcp"
    | "web-search"
    | "image-view"
    | "dynamic"
    | "collaboration"
    | "other";
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
  attentionKind:
    | "question"
    | "approval"
    | "permission"
    | "sandbox"
    | "elicitation"
    | "blocked";
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

interface ActivityItemDraftBase {
  id: string;
  turnId?: string | null;
  parentId?: string | null;
  state?: ActivityState;
  startedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  source?: ActivitySource;
  confidence?: ActivityConfidence;
  exposure?: ActivityExposure;
}

export type ActivityItemDraft =
  | (ActivityItemDraftBase & {
      kind: "message";
      role: ActivityMessageItem["role"];
      phase?: ActivityMessageItem["phase"];
      text?: string;
      label?: string | null;
    })
  | (ActivityItemDraftBase & {
      kind: "reasoning";
      reasoningKind: ActivityReasoningItem["reasoningKind"];
      label?: string | null;
      text?: string;
    })
  | (ActivityItemDraftBase & {
      kind: "plan";
      text?: string;
      steps?: readonly ActivityPlanStep[];
    })
  | (ActivityItemDraftBase & {
      kind: "tool";
      toolCallId: string;
      name: string;
      category?: ActivityToolItem["category"];
      arguments?: ActivityToolItem["arguments"];
      result?: ActivityToolItem["result"];
      output?: string;
    })
  | (ActivityItemDraftBase & {
      kind: "file-change";
      summary?: string;
      changes?: readonly ActivityFileChange[];
    })
  | (ActivityItemDraftBase & {
      kind: "subagent";
      taskId: string;
      name: string;
      description?: string | null;
      output?: string;
      childItemIds?: readonly string[];
    })
  | (ActivityItemDraftBase & {
      kind: "attention";
      requestId: string;
      attentionKind: ActivityAttentionItem["attentionKind"];
      title?: string | null;
      summary?: string | null;
      questions?: readonly ActivityAttentionQuestion[];
      respondable?: boolean;
      resolved?: boolean;
      isSecret?: boolean;
    })
  | (ActivityItemDraftBase & {
      kind: "queue";
      messages?: readonly ActivityQueuedMessage[];
    })
  | (ActivityItemDraftBase & {
      kind: "lifecycle";
      event: ActivityLifecycleItem["event"];
      level?: ActivityLifecycleItem["level"];
      title: string;
      details?: string | null;
    })
  | (ActivityItemDraftBase & {
      kind: "usage";
      scope: ActivityUsageItem["scope"];
      inputTokens?: number | null;
      outputTokens?: number | null;
      cachedInputTokens?: number | null;
      reasoningTokens?: number | null;
      totalTokens?: number | null;
      costUsd?: number | null;
    });

export type ActivityAppendChannel =
  | "text"
  | "arguments"
  | "result"
  | "output"
  | "diff"
  | "details";

export type ActivityResetReason =
  | "provider-reset"
  | "transcript-reset"
  | "rotation"
  | "truncation"
  | "branch-change"
  | "replay-gap"
  | "cleared"
  | "other";

export type ActivityMutation =
  | { type: "upsert"; item: ActivityItemDraft }
  | {
      type: "append";
      id: string;
      channel: ActivityAppendChannel;
      /** UTF-8 byte offset in the unbounded provider field. */
      offset: number;
      text: string;
    }
  | { type: "remove"; id: string }
  | {
      type: "reset";
      reason: ActivityResetReason;
      items?: readonly ActivityItemDraft[];
    };

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
  /** UTF-8 byte offset in the already-redacted field sent to clients. */
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

export interface ActivityReplayResult {
  gap: boolean;
  cursor: string | null;
  frames: ActivityFrame[];
}

export interface ActivityHubLimits {
  maxItems: number;
  maxViewBytes: number;
  maxFieldBytes: number;
  replayMaxFrames: number;
  replayMaxBytes: number;
  replayMaxAgeMs: number;
}

export interface ActivityHubOptions extends Partial<ActivityHubLimits> {
  now?: () => number;
  streamEpoch?: string;
}

export type ActivityListener = (frame: ActivityFrame) => void;
