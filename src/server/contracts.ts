import { z } from "zod";

import type {
  ControlCapability,
  Diagnostic,
  Provider,
  SessionTerminal,
  SessionView,
} from "../core/types.ts";

const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "must contain only safe identifier characters");

const expectedState = {
  expectedGeneration: z.number().int().nonnegative(),
  expectedRunId: z.string().min(1).max(256).optional(),
  idempotencyKey,
};

const requestResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    value: z.string().max(20_000),
    selectedOptions: z.array(z.string().min(1).max(512)).max(50),
  }).strict().refine(
    (response) => response.value.length > 0 || response.selectedOptions.length > 0,
    "an answer value or selected option is required",
  ),
  z.object({
    kind: z.literal("answers"),
    answers: z.array(z.object({
      questionId: z.string().min(1).max(20_000),
      value: z.string().max(20_000),
      selectedOptions: z.array(z.string().min(1).max(512)).max(50),
    }).strict().refine(
      (answer) => answer.value.length > 0 || answer.selectedOptions.length > 0,
      "each answer needs a value or selected option",
    )).min(1).max(50),
  }).strict(),
  z.object({
    kind: z.literal("decision"),
    decision: z.enum(["allow", "deny"]),
    reason: z.string().max(4_000).optional(),
  }).strict(),
]);

export const sessionActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    delivery: z.enum(["queue", "steer"]),
    text: z.string().min(1).max(100_000),
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("respond"),
    requestId: z.string().min(1).max(256),
    response: requestResponseSchema,
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("interrupt"),
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("set-mode"),
    mode: z.enum(["planning", "execution"]),
    ...expectedState,
  }).strict(),
]);

export type SessionAction = z.infer<typeof sessionActionSchema>;

export const createSessionSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  workspaceId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(120).optional(),
  initialMessage: z.string().min(1).max(100_000),
  mode: z.enum(["planning", "execution"]).default("planning"),
  accessMode: z.enum(["sandboxed", "bypass-permissions"]).default("sandboxed"),
  idempotencyKey,
}).strict();

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const directoryCompletionQuerySchema = z.object({
  path: z.string().max(4_096).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(30),
}).strict();

export const resolveWorkspaceSchema = z.object({
  hostId: z.string().min(1).max(128),
  path: z.string().trim().min(1).max(4_096),
}).strict();

export const leaseRequestSchema = z.object({
  clientId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, "must contain only safe identifier characters"),
  ttlSeconds: z.number().int().min(15).max(300).optional(),
  takeover: z.boolean().default(false),
}).strict();

export interface Actor {
  id: string;
  kind: "local" | "tailscale";
  displayName: string;
}

export interface ControlLease {
  sessionId: string;
  token: string;
  clientId: string;
  acquiredAt: string;
  expiresAt: string;
}

export type ActionStatus =
  | "pending"
  | "dispatching"
  | "queued"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ActionError {
  code: string;
  message: string;
}

export interface ActionRecord {
  id: string;
  sessionId: string;
  type: SessionAction["type"];
  status: ActionStatus;
  createdAt: string;
  completedAt?: string;
  error?: ActionError;
}

export interface ActionDispatchResult {
  status: Extract<ActionStatus, "queued" | "succeeded" | "failed" | "unknown">;
  result?: unknown;
  error?: ActionError;
}

export interface RequestContext {
  actor: Actor;
  requestId: string;
  signal: AbortSignal;
  workspace: { id: string; label: string; path: string } | null;
  managerSessionId?: string;
}

export interface AttachInstruction {
  kind: "tmux" | "codex-remote" | "claude-resume" | "manager-cli";
  argv: string[];
  cwd: string | null;
  warning: string | null;
  /** Correlates a provider ownership handoff with the native wrapper process. */
  handoffId?: string;
  /** One-use owner-socket capability required before any provider process spawn. */
  spawnNonce?: string;
}

/**
 * Provider controls deliberately receive normalized actions instead of an
 * arbitrary RPC method or shell command. Implementations must still verify
 * provider request/turn identifiers immediately before dispatch.
 */
export interface ProviderControlAdapter {
  createSession(input: CreateSessionInput, context: RequestContext): Promise<SessionView>;
  performAction(
    session: SessionView,
    action: SessionAction,
    context: RequestContext,
  ): Promise<ActionDispatchResult>;
  getAttachInstruction?(
    session: SessionView,
    context: RequestContext,
  ): Promise<AttachInstruction | null>;
  markCliAttached?(sessionId: string, handoffId: string, wrapperPid: number): void;
  markCliExited?(sessionId: string, handoffId: string, exitCode: number | null): void;
  markCliAttachFailed?(sessionId: string, handoffId: string, error: string): void;
  reclaimFromCli?(sessionId: string, handoffId: string): Promise<SessionView>;
  dispose?(): void | Promise<void>;
}

export type ProviderControlAdapters = Partial<Record<Provider, ProviderControlAdapter>>;

export interface PaneCapture {
  content: string;
  truncated: boolean;
  lineCount: number;
  byteCount: number;
}

export interface PanePreviewAdapter {
  capture(
    terminal: SessionTerminal,
    limits: { maxLines: number; maxBytes: number },
    signal: AbortSignal,
  ): Promise<PaneCapture>;
}

export type StateEventType =
  | "snapshot"
  | "session.upsert"
  | "session.remove"
  | "action.updated"
  | "diagnostic";

export interface StateEvent {
  seq: number;
  at: string;
  type: StateEventType;
  payload: unknown;
}

export interface StateSnapshot {
  version: 2;
  generatedAt: string;
  seq: number;
  stale: boolean;
  sessions: SessionView[];
  diagnostics: Diagnostic[];
}

export function requiredCapability(action: SessionAction): ControlCapability {
  switch (action.type) {
    case "send":
      return action.delivery === "queue" ? "queue" : "steer";
    case "respond":
      return "respond";
    case "interrupt":
      return "interrupt";
    case "set-mode":
      return "set-mode";
  }
}
