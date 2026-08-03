export const CLAUDE_AGENT_SDK_VERSION = "0.3.220";
export const CLAUDE_CODE_VERSION = "2.1.220";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type ClaudeActivity =
  | "starting"
  | "idle"
  | "running"
  | "requires_action"
  | "failed"
  | "closed"
  | "native";

export type ClaudePendingRequestKind =
  | "question"
  | "plan-approval"
  | "permission"
  | "elicitation";

export interface ClaudeSdkUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  parent_tool_use_id: null;
  priority: "now" | "later";
  origin: { kind: "human" };
  uuid: string;
}

export interface ClaudePermissionResultAllow {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
  toolUseID: string;
  decisionClassification: "user_temporary";
}

export interface ClaudePermissionResultDeny {
  behavior: "deny";
  message: string;
  interrupt: boolean;
  toolUseID: string;
  decisionClassification: "user_reject";
}

export type ClaudePermissionResult =
  | ClaudePermissionResultAllow
  | ClaudePermissionResultDeny;

export interface ClaudeCanUseToolOptions {
  signal: AbortSignal;
  requestId: string;
  toolUseID: string;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  agentID?: string;
}

export interface ClaudeElicitationRequest {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
}

export type ClaudeElicitationResult =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" | "cancel" };

export interface ClaudeSdkQueryOptions {
  cwd: string;
  persistSession: true;
  includePartialMessages: true;
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions: boolean;
  env: Record<string, string | undefined>;
  resume?: string;
  model?: string;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudeCanUseToolOptions,
  ) => Promise<ClaudePermissionResult>;
  onElicitation: (
    request: ClaudeElicitationRequest,
    options: { signal: AbortSignal },
  ) => Promise<ClaudeElicitationResult>;
}

export interface ClaudeSdkQueryParams {
  prompt: AsyncIterable<ClaudeSdkUserMessage>;
  options: ClaudeSdkQueryOptions;
}

export interface ClaudeInterruptReceipt {
  still_queued: string[];
  cancelled?: string[];
}

export interface ClaudeSdkQuery extends AsyncIterable<Record<string, unknown>> {
  interrupt(): Promise<ClaudeInterruptReceipt | undefined>;
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>;
  close(): void;
}

/**
 * The SDK is hidden behind this boundary so unit tests and discovery never start
 * a real Claude process. Production obtains an implementation from
 * `loadClaudeSdkRuntime()` only when creating a manager-owned session.
 */
export interface ClaudeSdkRuntime {
  readonly sdkVersion: string;
  createQuery(params: ClaudeSdkQueryParams): ClaudeSdkQuery;
  randomUUID(): string;
  now(): Date;
}

export interface ClaudeManagedSessionConfig {
  cwd: string;
  mode: ClaudePermissionMode;
  initialMessage?: string;
  model?: string;
  environment?: Record<string, string | undefined>;
  allowDangerouslySkipPermissions?: boolean;
}

export interface ClaudeManagedResumeConfig
  extends ClaudeManagedSessionConfig {
  sessionId: string;
}

export interface ClaudePendingRequest {
  id: string;
  kind: ClaudePendingRequestKind;
  title: string;
  toolName: string | null;
  toolUseId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ClaudeCliHandoffState = "prepared" | "attached" | "exited";

export interface ClaudeCliHandoff {
  id: string;
  state: ClaudeCliHandoffState;
  sessionId: string;
  cwd: string;
  command: {
    executable: "claude";
    args: ["--resume", string];
    cwd: string;
  };
  preparedAt: string;
  attachedAt: string | null;
  exitedAt: string | null;
  wrapperPid: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface ClaudeManagedSessionSnapshot {
  localId: string;
  sessionId: string | null;
  resumedFrom: string | null;
  cwd: string;
  owner: "manager" | "native";
  activity: ClaudeActivity;
  mode: ClaudePermissionMode;
  desiredMode: ClaudePermissionMode;
  sdkVersion: string;
  claudeCodeVersion: string | null;
  capabilities: string[];
  canSteer: boolean;
  pendingRequests: ClaudePendingRequest[];
  outstandingMessageIds: string[];
  stillQueuedMessageIds: string[];
  queueKnowledge: "known" | "unknown";
  handoff: ClaudeCliHandoff | null;
  lastError: string | null;
  generation: number;
  startedAt: string;
  updatedAt: string;
}

export type ClaudeRequestResponse =
  | {
      decision: "answer";
      answers: Record<string, string>;
    }
  | {
      decision: "allow";
      updatedInput?: Record<string, unknown>;
    }
  | {
      decision: "deny";
      reason: string;
      interrupt?: boolean;
    }
  | {
      decision: "accept";
      content?: Record<string, unknown>;
    }
  | {
      decision: "decline" | "cancel";
    };

export interface ClaudeInterruptResult {
  receiptSupported: boolean;
  stillQueuedMessageIds: string[];
  cancelledMessageIds: string[];
}

export type ClaudeSessionListener = (
  snapshot: ClaudeManagedSessionSnapshot,
) => void;

export type ClaudeMessageListener = (message: Record<string, unknown>) => void;
