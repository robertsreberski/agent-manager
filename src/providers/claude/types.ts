import type {
  CanUseTool,
  EffortLevel,
  ElicitationRequest,
  ModelInfo,
  PermissionUpdate,
  PermissionMode,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.220";
export const CLAUDE_CODE_VERSION = "2.1.223";

export type ClaudePermissionMode = PermissionMode;
export type ClaudeEffortLevel = EffortLevel;
export type ClaudeModelInfo = ModelInfo;
export type ClaudePermissionUpdate = PermissionUpdate;

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

export type ClaudeSdkMessage = SDKMessage;
export interface ClaudePermissionResultAllow {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
  updatedPermissions?: ClaudePermissionUpdate[];
  toolUseID: string;
  decisionClassification: "user_temporary" | "user_permanent";
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
export type ClaudeCanUseToolOptions = Parameters<CanUseTool>[2];
export type ClaudeElicitationRequest = ElicitationRequest;
export type ClaudeElicitationResult =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" | "cancel" };

export interface ClaudeSdkQueryOptions {
  /**
   * Every SDK process is owned by an explicit controller. Aborting it is the
   * provider-supported way to stop initialization and release the subprocess.
   */
  abortController: AbortController;
  cwd: string;
  /**
   * Managed sessions persist so they stay resumable. A bounded draft catalog
   * probe sets this false: it must never leave a phantom resumable session
   * behind for discovery to surface.
   */
  persistSession: boolean;
  includePartialMessages: true;
  includeHookEvents: true;
  forwardSubagentText: true;
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions: boolean;
  effort?: ClaudeEffortLevel;
  env: Record<string, string | undefined>;
  resume?: string;
  model?: string;
  pathToClaudeCodeExecutable?: string;
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

export interface ClaudeSdkQuery extends AsyncIterable<ClaudeSdkMessage> {
  /**
   * Completes the provider initialize handshake without submitting a user
   * message. Claude does not yield `system/init` until streaming input has a
   * first message, so an exact resume with an intentionally empty inbox uses
   * this control response to prove that the persisted session exists.
   */
  initializationResult(): Promise<unknown>;
  interrupt(): Promise<ClaudeInterruptReceipt | undefined>;
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: {
    effortLevel?: ClaudeEffortLevel | null;
  }): Promise<void>;
  supportedModels(): Promise<ClaudeModelInfo[]>;
  close(): void;
}

/**
 * The SDK is hidden behind this boundary so unit tests and discovery never start
 * a real Claude process. Production obtains an implementation from
 * `loadClaudeSdkRuntime()` only when creating a manager-owned session.
 */
export interface ClaudeSdkRuntime {
  readonly sdkVersion: string;
  /** Canonical executable selected by Agent Manager's production composition. */
  readonly claudeCodeExecutable?: string;
  /** Exact version read from that executable before it can own a resume. */
  readonly claudeCodeVersion: string | null;
  createQuery(params: ClaudeSdkQueryParams): ClaudeSdkQuery;
  randomUUID(): string;
  now(): Date;
}

export interface ClaudeManagedSessionConfig {
  cwd: string;
  mode: ClaudePermissionMode;
  /** Exact executable to use for both SDK ownership and native handoff. */
  claudeCodeExecutable?: string;
  /** Defaults to true; only a disposable read probe turns persistence off. */
  persistSession?: boolean;
  initialMessage?: string;
  model?: string;
  effort?: ClaudeEffortLevel;
  environment?: Record<string, string | undefined>;
  allowDangerouslySkipPermissions?: boolean;
}

export interface ClaudeManagedResumeConfig
  extends ClaudeManagedSessionConfig {
  sessionId: string;
}

/**
 * A persisted conversation whose manager-owned SDK consumer was deliberately
 * stopped. Reconstructing this state must not open a provider process; it only
 * retains the exact information needed for an explicit native resume.
 */
export type ClaudeManagedDormantConfig = ClaudeManagedResumeConfig;

export interface ClaudePendingRequest {
  id: string;
  kind: ClaudePendingRequestKind;
  title: string;
  toolName: string | null;
  toolUseId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ClaudeStagedMessage {
  id: string;
  text: string;
  enqueuedAt: string;
}

export type ClaudeCliHandoffState = "prepared" | "attached" | "exited";

export interface ClaudeCliHandoff {
  id: string;
  state: ClaudeCliHandoffState;
  sessionId: string;
  cwd: string;
  command: {
    executable: string;
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
  model: string | null;
  desiredModel: string | null;
  effort: ClaudeEffortLevel | null;
  sdkVersion: string;
  claudeCodeVersion: string | null;
  capabilities: string[];
  canSteer: boolean;
  pendingRequests: ClaudePendingRequest[];
  stagedMessages: ClaudeStagedMessage[];
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
      persist?: boolean;
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

export type ClaudeMessageListener = (message: ClaudeSdkMessage) => void;
