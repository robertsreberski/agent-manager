import type { ActivityMutation } from "../../activity/index.ts";
import type { AvailableSessionAccountFacts } from "../../shared/session-facts.ts";

export type JsonRpcId = string | number;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type CodexExecutionProfile =
  | "ask-first"
  | "plan"
  | "execute"
  | "full-access";

export type CodexReasoningEffort = string;

export type CodexSettingsDelivery =
  | "experimental-rpc"
  | "next-turn"
  | "unavailable";

export type CodexControllerState =
  | "available"
  | "foreign-environment"
  | "ambiguous-environment";

export type CodexThreadStatus =
  | "not-loaded"
  | "idle"
  | "running"
  | "system-error"
  | "unknown";

export type CodexTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export type CodexControlCapability =
  | "thread.start"
  | "thread.resume"
  | "thread.read"
  | "thread.unsubscribe"
  | "thread.rename"
  | "thread.archive"
  | "thread.delete"
  | "turn.queue"
  | "turn.steer"
  | "turn.interrupt"
  | "request.respond"
  | "profile.set"
  | "model.set"
  | "effort.set"
  | "native.attach";

export interface CodexAdapterCapabilities {
  /** False as soon as the App Server transport is lost. */
  runtimeAlive: boolean;
  compatible: boolean;
  serverVersion: string | null;
  serverUserAgent: string | null;
  supportedVersion: "0.146.x";
  settingsDelivery: CodexSettingsDelivery;
  controls: readonly CodexControlCapability[];
  reason: string | null;
}

export type CodexPendingRequestKind =
  | "command-approval"
  | "file-change-approval"
  | "user-input"
  | "permission-approval"
  | "elicitation"
  | "unsupported";

export interface CodexPendingRequest {
  id: JsonRpcId;
  method: string;
  kind: CodexPendingRequestKind;
  threadId: string;
  turnId: string | null;
  params: JsonObject;
  respondable: boolean;
  receivedAt: string;
}

export interface CodexQueuedMessage {
  id: string;
  text: string;
  status: "queued" | "dispatching" | "dispatched";
  enqueuedAt: string;
  turnId: string | null;
}

export interface CodexThreadState {
  threadId: string;
  treeId: string | null;
  parentThreadId: string | null;
  cwd: string | null;
  name: string | null;
  preview: string | null;
  source: string | null;
  model: string | null;
  effort: CodexReasoningEffort | null;
  profile: CodexExecutionProfile | null;
  status: CodexThreadStatus;
  activeTurnId: string | null;
  lastTurnStatus: CodexTurnStatus | null;
  pendingRequests: readonly CodexPendingRequest[];
  queue: readonly CodexQueuedMessage[];
  environmentIds: readonly string[];
  controller: CodexControllerState;
  writeBlockedReason: string | null;
  pendingSettings: CodexPendingSettings | null;
  generation: number;
}

export interface CodexThreadIdentity {
  threadId: string;
  treeId: string | null;
  parentThreadId: string | null;
  cwd: string | null;
}

export interface CodexPendingSettings {
  profile?: CodexExecutionProfile;
  model?: string;
  effort?: CodexReasoningEffort;
  delivery: Exclude<CodexSettingsDelivery, "unavailable">;
}

/** A picker entry returned by the pinned App Server's `model/list` method. */
export interface CodexModelOption {
  value: string;
  label: string;
  description: string | null;
  isDefault: boolean;
  defaultEffort: string;
  efforts: readonly string[];
}

export interface StartCodexThreadOptions {
  cwd: string;
  model?: string;
  effort?: CodexReasoningEffort;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  permissions?: string;
  profile?: CodexExecutionProfile;
  initialMessage?: string;
}

export interface ResumeCodexThreadOptions {
  cwd?: string;
  model?: string;
  effort?: CodexReasoningEffort;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  permissions?: string;
}

export interface CodexAttachCommand {
  executable: string;
  args: readonly string[];
  display: string;
}

export type CodexAdapterEvent =
  | {
      type: "state.changed";
      threadId: string;
      state: CodexThreadState;
    }
  | {
      type: "thread.removed";
      threadId: string;
      reason: "ended" | "archived" | "deleted";
    }
  | {
      type: "request.pending";
      threadId: string;
      request: CodexPendingRequest;
    }
  | {
      type: "request.resolved";
      threadId: string;
      requestId: JsonRpcId;
    }
  | {
      type: "queue.changed";
      threadId: string;
      queue: readonly CodexQueuedMessage[];
    }
  | {
      type: "activity";
      threadId: string;
      mutation: ActivityMutation;
    }
  | {
      type: "diagnostic";
      level: "info" | "warning" | "error";
      code: string;
      message: string;
      threadId?: string;
    };

export type CodexAdapterEventListener = (event: CodexAdapterEvent) => void;

export interface ManagedCodexAdapter {
  readonly runtimeAlive: boolean;
  readonly runtimeFailure: string | null;
  readonly capabilities: CodexAdapterCapabilities;
  initialize(): Promise<CodexAdapterCapabilities>;
  startThread(options: StartCodexThreadOptions): Promise<CodexThreadState>;
  resumeThread(
    threadId: string,
    options?: ResumeCodexThreadOptions,
  ): Promise<CodexThreadState>;
  readThread(threadId: string): Promise<CodexThreadState>;
  listModels(): Promise<readonly CodexModelOption[]>;
  readAccountFacts(): Promise<AvailableSessionAccountFacts>;
  adoptThread(
    threadId: string,
    expectedIdentity: CodexThreadIdentity,
  ): Promise<CodexThreadState>;
  releaseThread(threadId: string): Promise<void>;
  queueMessage(threadId: string, text: string): Promise<CodexQueuedMessage>;
  steer(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<string>;
  interrupt(threadId: string, expectedTurnId: string): Promise<void>;
  respondToRequest(
    threadId: string,
    requestId: JsonRpcId,
    response: JsonObject,
  ): Promise<void>;
  setProfile(threadId: string, profile: CodexExecutionProfile): Promise<void>;
  setModel(threadId: string, model: string): Promise<void>;
  setEffort(threadId: string, effort: CodexReasoningEffort): Promise<void>;
  removeQueuedMessage(threadId: string, messageId: string): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  endThread(threadId: string): Promise<void>;
  getThreadState(threadId: string): CodexThreadState | null;
  listThreadStates(): readonly CodexThreadState[];
  buildAttachCommand(threadId: string): CodexAttachCommand;
  subscribe(listener: CodexAdapterEventListener): () => void;
  /**
   * Permanently fail this adapter instance and withdraw every control. The
   * supervisor calls this before publishing an unexpected child exit.
   */
  markRuntimeUnavailable(error: Error): void;
  dispose(): Promise<void>;
}
