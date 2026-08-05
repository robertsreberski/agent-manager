import type {
  CreateSessionInput,
} from "../../src/shared/actions.ts";
import type {
  ActivityItem,
} from "../../src/activity/types.ts";

export type {
  CreateSessionInput,
  RequestResponse,
  SessionAction,
} from "../../src/shared/actions.ts";
export type {
  AttentionDetails,
  AttentionKind,
  AttentionOption,
  AttentionQuestion,
  ChildSummary,
  ControlCapability,
  ControlPlane,
  Diagnostic,
  EvidenceConfidence,
  EvidenceSource,
  EvidencedValue,
  ExecutionProfile,
  Provider,
  ReasoningEffort,
  SandboxPolicy,
  SessionAttention,
  SessionControl,
  SessionEffort,
  SessionKind,
  SessionModel,
  SessionPresence,
  SessionProfile,
  SessionRecord,
  SessionStatus,
  SessionTakeover,
  SessionTerminal,
  SessionView,
  TakeoverMethod,
  TakeoverState,
  WithheldCapability,
  WorkspaceIdentity,
} from "../../src/shared/session.ts";
export {
  sessionRecordId,
} from "../../src/shared/session.ts";
export type {
  StateEvent,
  StateEventType,
  WireActionUpdate,
  WireStateSnapshot,
} from "../../src/shared/wire.ts";
export {
  AGENT_MANAGER_BUILD_ID,
  parseStateEvent,
  parseStateSnapshot,
  WireUpgradeRequiredError,
  WIRE_SCHEMA_VERSION,
} from "../../src/shared/wire.ts";

export type {
  ActivityAppendChannel,
  ActivityAppendFrame,
  ActivityApprovalFacts,
  ActivityAttentionItem,
  ActivityAttentionOption,
  ActivityAttentionQuestion,
  ActivityConfidence,
  ActivityExposure,
  ActivityFileChange,
  ActivityFileChangeItem,
  ActivityFrame,
  ActivityFrameBase,
  ActivityItem,
  ActivityItemBase,
  ActivityJsonValue,
  ActivityLifecycleItem,
  ActivityMessageItem,
  ActivityPlanItem,
  ActivityQueueItem,
  ActivityQueuedMessage,
  ActivityReasoningItem,
  ActivityRemoveFrame,
  ActivityResetFrame,
  ActivityResetReason,
  ActivitySnapshotFrame,
  ActivitySource,
  ActivityState,
  ActivitySubagentItem,
  ActivityToolItem,
  ActivityTodoItem,
  ActivityTodoStep,
  ActivityUpsertFrame,
  ActivityUsageItem,
} from "../../src/activity/types.ts";
export { ACTIVITY_SCHEMA_VERSION } from "../../src/activity/types.ts";

export type ConnectionState = "connecting" | "open" | "retrying" | "offline";

export interface AuthSession {
  csrfToken: string | null;
  actor: string | null;
}

/** Browser-local lease token. It is never part of the session wire record. */
export interface ControlLease {
  token: string;
  clientId: string;
  expiresAt: string;
}

/** Display-safe attach instruction returned by the API adapter. */
export interface AttachInstruction {
  available: boolean;
  kind: "tmux" | "codex-remote" | "claude-resume" | "manager-cli" | "ssh" | "none";
  command: string | null;
  description: string | null;
  requiresHandoff: boolean;
  argv: string[];
  cwd: string | null;
}

export interface PanePreview {
  content: string;
  capturedAt: string | null;
  truncated: boolean;
  lines: number;
}

export interface WorkspaceOption {
  id: string;
  label: string;
  path: string;
  hostId: string;
  hostLabel: string;
  hostKind: "local" | "ssh";
  temporary: boolean;
}

export interface HostOption {
  id: string;
  label: string;
  kind: "local" | "ssh";
  sshTarget: string | null;
  status: "online" | "offline" | "connecting" | "unknown";
  statusMessage: string | null;
}

export interface WorkspaceDraft {
  hostId: string;
  path: string;
}

export interface LaunchSessionInput extends Omit<CreateSessionInput, "workspaceId"> {
  hostId: string;
  workspacePath: string;
}

export interface SessionActivityView {
  sessionId: string | null;
  items: ActivityItem[];
  truncated: boolean;
  streamEpoch: string | null;
  cursor: string | null;
  seq: number | null;
  connection: ConnectionState;
  updateCount: number;
}
