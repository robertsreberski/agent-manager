import type {
  ExecutionProfile,
  Provider,
  ReasoningEffort,
  SandboxPolicy,
  TakeoverMethod,
} from "./session.ts";

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
      reason?: string | undefined;
      /** Ask the provider to apply its exact persistent choice, when offered. */
      persist?: boolean | undefined;
    };

interface ExpectedSessionState {
  expectedGeneration: number;
  expectedProviderTurnId?: string | undefined;
  idempotencyKey: string;
}

export type SessionAction =
  | (ExpectedSessionState & {
      type: "send";
      delivery: "queue" | "steer";
      text: string;
    })
  | (ExpectedSessionState & {
      type: "respond";
      requestId: string;
      response: RequestResponse;
    })
  | (ExpectedSessionState & { type: "interrupt" })
  | (ExpectedSessionState & { type: "set-profile"; profile: ExecutionProfile })
  | (ExpectedSessionState & { type: "set-sandbox"; sandbox: SandboxPolicy })
  | (ExpectedSessionState & { type: "set-model"; model: string })
  | (ExpectedSessionState & { type: "set-effort"; effort: ReasoningEffort })
  | (ExpectedSessionState & { type: "remove-queued"; messageId: string })
  | (ExpectedSessionState & { type: "end" })
  | (ExpectedSessionState & { type: "archive" })
  | (ExpectedSessionState & { type: "delete" })
  | (ExpectedSessionState & { type: "resume" })
  | (ExpectedSessionState & {
      type: "take-control";
      method: TakeoverMethod;
      /**
       * Binds graceful-stop either to the guided attempt being replaced or to
       * the separately confirmed graceful attempt that will send SIGTERM.
       */
      takeoverId?: string | undefined;
    })
  | (ExpectedSessionState & { type: "cancel-take-control"; takeoverId: string })
  | (ExpectedSessionState & { type: "retry-control" })
  | (ExpectedSessionState & {
      type: "open-editor";
      relativePath: string;
      line?: number | undefined;
      column?: number | undefined;
    });

export interface CreateSessionInput {
  provider: Provider;
  workspaceId: string;
  name?: string | undefined;
  initialMessage: string;
  profile: ExecutionProfile;
  /** Codex only; null asks the provider adapter for its conservative default. */
  sandbox: SandboxPolicy | null;
  model: string | null;
  effort: ReasoningEffort | null;
  idempotencyKey: string;
}
