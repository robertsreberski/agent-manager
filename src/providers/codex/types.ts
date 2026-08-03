import type { ActivityMutation } from "../../activity/index.ts";

export type JsonRpcId = string | number;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type CodexMode = "planning" | "execution";

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
  | "turn.queue"
  | "turn.steer"
  | "turn.interrupt"
  | "request.respond"
  | "mode.set"
  | "native.attach";

export interface CodexAdapterCapabilities {
  /** False as soon as the private App Server transport is lost. */
  runtimeAlive: boolean;
  compatible: boolean;
  serverVersion: string | null;
  serverUserAgent: string | null;
  supportedVersion: "0.146.x";
  controls: readonly CodexControlCapability[];
  reason: string | null;
}

export type CodexPendingRequestKind =
  | "command-approval"
  | "file-change-approval"
  | "user-input"
  | "permission-approval"
  | "elicitation"
  | "legacy-command-approval"
  | "legacy-file-change-approval"
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
  cwd: string | null;
  model: string | null;
  mode: CodexMode | "unknown";
  status: CodexThreadStatus;
  activeTurnId: string | null;
  lastTurnStatus: CodexTurnStatus | null;
  pendingRequests: readonly CodexPendingRequest[];
  queue: readonly CodexQueuedMessage[];
  generation: number;
}

export interface StartCodexThreadOptions {
  cwd: string;
  model?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  permissions?: string;
  mode?: CodexMode;
  initialMessage?: string;
}

export interface ResumeCodexThreadOptions {
  cwd?: string;
  model?: string;
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
  setMode(threadId: string, mode: CodexMode): Promise<void>;
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
