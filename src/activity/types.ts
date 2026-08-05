import type { Provider } from "../shared/session.ts";
import { WIRE_SCHEMA_VERSION } from "../shared/wire.ts";

export type { Provider };

/** Activity and state frames advance atomically; partial wire upgrades are rejected. */
export const ACTIVITY_SCHEMA_VERSION = WIRE_SCHEMA_VERSION;

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

export interface ActivityTodoStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "removed";
  detail: string | null;
  /** True only when this identity first appeared after the provider's baseline list. */
  addedAfterStart: boolean;
  /** Exact provider explanation only; list replacement never manufactures one. */
  removedReason: string | null;
}

export interface ActivityFileChange {
  /** Destination/current provider path. */
  path: string;
  /** Exact provider old path for a rename; null for every non-rename or when unavailable. */
  previousPath: string | null;
  operation: "add" | "update" | "delete" | "rename";
  diff: string;
}

export interface ActivityAttentionOption {
  label: string;
  description: string | null;
  /** Exact provider recommendation only; null means the provider exposed none. */
  recommended: boolean | null;
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

export interface ActivityAttentionQuestionDraft extends Omit<ActivityAttentionQuestion, "options"> {
  options: Array<Omit<ActivityAttentionOption, "recommended"> & { recommended?: boolean | null }>;
}

/**
 * Exact approval facts exposed by the provider for one request. These fields
 * are deliberately sparse: null and an empty list mean the harness did not
 * supply the fact. Agent Manager never parses shell text or walks the
 * filesystem to manufacture a more reassuring answer.
 */
export interface ActivityApprovalFacts {
  command: string | null;
  /** Paths used for conservative workspace-tier classification. */
  paths: string[] | null;
  /** Write targets named by the provider, preserving its spelling. */
  writes: string[];
  network: boolean | null;
  /** True only when this exact provider request offers a persistent choice. */
  canPersist: boolean;
  /** Exact provider count only; never computed by inspecting the filesystem. */
  deleteCount: number | null;
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
  /** Foreign key to SessionRecord.id; never a provider thread, tree, or turn id. */
  sessionId: string;
  provider: Provider;
  /** Exact provider-scoped identity used only for cross-source reconciliation. */
  correlationId?: string | null;
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
  path: string | null;
  version: number | null;
  markdown: string;
  supersededBy: string | null;
  /** Exact provider request identity for this plan approval, when exposed. */
  approvalRequestId: string | null;
  approvedAt: string | null;
}

export interface ActivityTodoItem extends ActivityItemBase {
  kind: "todo";
  steps: ActivityTodoStep[];
  added: number;
  removed: number;
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
  approvalFacts: ActivityApprovalFacts | null;
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
  /**
   * The model's context window, where the provider stated one.
   *
   * Both providers put it on the wire and both projectors used to drop it —
   * Codex on every `thread/tokenUsage/updated`, Claude on the result message's
   * per-model usage. Without it a token count has no denominator, and a
   * percentage would be the cockpit guessing at the one number it lacked.
   */
  contextWindow: number | null;
}

export type ActivityItem =
  | ActivityMessageItem
  | ActivityReasoningItem
  | ActivityPlanItem
  | ActivityTodoItem
  | ActivityToolItem
  | ActivityFileChangeItem
  | ActivitySubagentItem
  | ActivityAttentionItem
  | ActivityQueueItem
  | ActivityLifecycleItem
  | ActivityUsageItem;

interface ActivityItemDraftBase {
  id: string;
  /** Never synthesize this from text; omit it unless the provider supplied identity. */
  correlationId?: string | null;
  turnId?: string | null;
  parentId?: string | null;
  state?: ActivityState;
  startedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  source?: ActivitySource;
  confidence?: ActivityConfidence;
  exposure?: ActivityExposure;
  /** Preserve a provider/remote truncation fact even when the visible field is bounded. */
  truncated?: boolean;
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
      path?: string | null;
      version?: number | null;
      markdown?: string;
      supersededBy?: string | null;
      approvalRequestId?: string | null;
      approvedAt?: string | null;
    })
  | (ActivityItemDraftBase & {
      kind: "todo";
      steps?: readonly ActivityTodoStep[];
      added?: number;
      removed?: number;
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
      questions?: readonly ActivityAttentionQuestionDraft[];
      approvalFacts?: ActivityApprovalFacts | null;
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
      contextWindow?: number | null;
    });

export type ActivityAppendChannel =
  | "text"
  | "markdown"
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
      /** The source already discarded activity older than this materialized window. */
      truncated?: boolean;
    };

export interface ActivityFrameBase {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  streamEpoch: string;
  /** Foreign key to SessionRecord.id; never a provider thread, tree, or turn id. */
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
