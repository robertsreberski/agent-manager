import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

import type {
  CreateSessionInput,
  RequestResponse,
  SessionAction,
} from "../shared/actions.ts";
import type {
  ControlCapability,
  Provider,
  SessionTerminal,
  SessionView,
} from "../shared/session.ts";
import { REASONING_EFFORTS } from "../shared/session.ts";
import type {
  StateEvent,
  StateEventType,
  WireActionUpdate,
  WireStateSnapshot,
} from "../shared/wire.ts";
import type { AvailableSessionAccountFacts } from "../shared/session-facts.ts";

export type { StateEvent, StateEventType } from "../shared/wire.ts";
export type {
  CreateSessionInput,
  RequestResponse,
  SessionAction,
} from "../shared/actions.ts";

const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "must contain only safe identifier characters");

const expectedState = {
  expectedGeneration: z.number().int().nonnegative(),
  expectedProviderTurnId: z.string().min(1).max(256).optional(),
  idempotencyKey,
};

export const executionProfileSchema = z.enum([
  "ask-first",
  "plan",
  "execute",
  "full-access",
]);

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

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
    persist: z.boolean().optional(),
  }).strict().refine(
    (response) => response.decision === "allow" || response.persist === undefined,
    "persistence can only accompany an allow decision",
  ),
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
    type: z.literal("set-profile"),
    profile: executionProfileSchema,
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("set-model"),
    model: z.string().trim().min(1).max(256),
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("set-effort"),
    effort: reasoningEffortSchema,
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("remove-queued"),
    messageId: z.string().min(1).max(256),
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("end"),
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("archive"),
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("delete"),
    ...expectedState,
  }).strict(),
  z.object({
    type: z.literal("open-editor"),
    relativePath: z.string().min(1).max(4_096).refine((value) => (
      !value.includes("\0")
      && !isAbsolute(value)
      && normalize(value) === value
      && value !== "."
      && value !== ".."
      && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ), "must be a normalized relative path inside the session worktree"),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    ...expectedState,
  }).strict(),
]);

const sessionActionSchemaTypeCheck: z.ZodType<SessionAction> = sessionActionSchema;
void sessionActionSchemaTypeCheck;

export const createSessionSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  workspaceId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(120).optional(),
  initialMessage: z.string().min(1).max(100_000),
  profile: executionProfileSchema.default("plan"),
  model: z.string().trim().min(1).max(256).nullable().default(null),
  effort: reasoningEffortSchema.nullable().default(null),
  idempotencyKey,
}).strict().superRefine((input, context) => {
  if (
    input.provider === "claude"
    && (input.effort === "minimal" || input.effort === "ultra")
  ) {
    context.addIssue({
      code: "custom",
      message: `Claude does not support ${input.effort} effort`,
      path: ["effort"],
    });
  }
});

const createSessionSchemaTypeCheck: z.ZodType<CreateSessionInput> = createSessionSchema;
void createSessionSchemaTypeCheck;

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

export type ActionError = NonNullable<WireActionUpdate["error"]>;
export type ActionRecord = WireActionUpdate;

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

export interface SessionModelOption {
  value: string;
  label: string;
  description: string | null;
  /** Present only when the provider catalog identifies its default model. */
  isDefault?: boolean | undefined;
  /** Present only when the provider catalog declares a model-specific default. */
  defaultEffort?: (typeof REASONING_EFFORTS)[number] | undefined;
  /** Present only when the provider catalog declares model-specific efforts. */
  efforts?: Array<(typeof REASONING_EFFORTS)[number]> | undefined;
}

export interface SessionSettingsOptions {
  source: "provider-api";
  models: SessionModelOption[];
}

const providerModelIdentifierSchema = z.string()
  .min(1)
  .max(256)
  .refine(
    (value) => value === value.trim(),
    "must not contain surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );

const providerModelLabelSchema = z.string()
  .min(1)
  .max(128)
  .refine(
    (value) => value === value.trim(),
    "must not contain surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must be a single-line label",
  );

/**
 * Provider catalogs are runtime input, even when their TypeScript SDK claims a
 * narrower shape. Parse them before they cross the HTTP boundary so an SDK
 * regression cannot create an unbounded settings response.
 */
export const sessionSettingsOptionsSchema: z.ZodType<SessionSettingsOptions> = z.object({
  source: z.literal("provider-api"),
  models: z.array(z.object({
    value: providerModelIdentifierSchema,
    label: providerModelLabelSchema,
    description: z.string().max(1_000).nullable(),
    isDefault: z.boolean().optional(),
    defaultEffort: reasoningEffortSchema.optional(),
    efforts: z.array(reasoningEffortSchema).max(REASONING_EFFORTS.length).optional(),
  }).strict()).max(64),
}).strict().superRefine((options, refinement) => {
  const seen = new Set<string>();
  let defaultModels = 0;
  for (const [index, model] of options.models.entries()) {
    if (seen.has(model.value)) {
      refinement.addIssue({
        code: "custom",
        path: ["models", index, "value"],
        message: "model identifiers must be unique",
      });
    }
    seen.add(model.value);
    if (model.isDefault) defaultModels += 1;
    if (model.efforts) {
      const efforts = new Set(model.efforts);
      if (efforts.size !== model.efforts.length) {
        refinement.addIssue({
          code: "custom",
          path: ["models", index, "efforts"],
          message: "effort identifiers must be unique",
        });
      }
      if (model.defaultEffort && !efforts.has(model.defaultEffort)) {
        refinement.addIssue({
          code: "custom",
          path: ["models", index, "defaultEffort"],
          message: "default effort must be one of the model efforts",
        });
      }
    } else if (model.defaultEffort) {
      refinement.addIssue({
        code: "custom",
        path: ["models", index, "defaultEffort"],
        message: "default effort requires model efforts",
      });
    }
  }
  if (defaultModels > 1) {
    refinement.addIssue({
      code: "custom",
      path: ["models"],
      message: "only one model may be the provider default",
    });
  }
});

/**
 * Provider controls deliberately receive normalized actions instead of an
 * arbitrary RPC method or shell command. Implementations must still verify
 * provider request/turn identifiers immediately before dispatch.
 */
export interface ProviderControlAdapter {
  createSession(input: CreateSessionInput, context: RequestContext): Promise<SessionView>;
  /**
   * Re-adopt only identities previously committed by the manager. Startup
   * recovery is deliberately separate from discovery and never receives an
   * action log: implementations may list/read/resume provider state, but must
   * not replay prompts or mutations.
   */
  restoreManagedSessions?(
    records: readonly ManagedSessionRecoveryRecord[],
    signal: AbortSignal,
  ): Promise<ManagedSessionRecoveryReport>;
  /**
   * Acquire the provider detail plane for one authenticated selected-session
   * stream. Implementations may ref-count concurrent browser selections, but
   * the returned release must detach the provider when the final selection
   * closes. This lifecycle never replays prompts or actions.
   */
  acquireSelectedSession?(
    session: SessionView,
    context: RequestContext,
  ): Promise<() => void | Promise<void>>;
  performAction(
    session: SessionView,
    action: SessionAction,
    context: RequestContext,
  ): Promise<ActionDispatchResult>;
  getAttachInstruction?(
    session: SessionView,
    context: RequestContext,
  ): Promise<AttachInstruction | null>;
  getSettingsOptions?(
    session: SessionView,
    context: RequestContext,
  ): Promise<SessionSettingsOptions>;
  getAccountFacts?(
    session: SessionView,
    context: RequestContext,
  ): Promise<AvailableSessionAccountFacts>;
  markCliAttached?(sessionId: string, handoffId: string, wrapperPid: number): void;
  markCliExited?(sessionId: string, handoffId: string, exitCode: number | null): void;
  markCliAttachFailed?(sessionId: string, handoffId: string, error: string): void;
  reclaimFromCli?(sessionId: string, handoffId: string): Promise<SessionView>;
  dispose?(): void | Promise<void>;
}

export interface ManagedSessionRecoveryRecord {
  managerSessionId: string;
  provider: "codex";
  providerThreadId: string;
  workspaceId: string;
  workspacePath: string;
  name: string | null;
  profile: CreateSessionInput["profile"];
  createdAt: string;
}

export interface ManagedSessionRecoveryFailure {
  managerSessionId: string;
  providerThreadId: string;
  reason: string;
}

export interface ManagedSessionRecoveryReport {
  restoredSessionIds: readonly string[];
  failures: readonly ManagedSessionRecoveryFailure[];
  truncated: boolean;
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

export type StateSnapshot = WireStateSnapshot;

export function requiredCapability(action: SessionAction): ControlCapability {
  switch (action.type) {
    case "send":
      return action.delivery === "queue" ? "queue" : "steer";
    case "respond":
      return "respond";
    case "interrupt":
      return "interrupt";
    case "set-profile":
      return "set-profile";
    case "set-model":
      return "set-model";
    case "set-effort":
      return "set-effort";
    case "remove-queued":
      return "remove-queued";
    case "end":
      return "end";
    case "archive":
      return "archive";
    case "delete":
      return "delete";
    case "open-editor":
      return "open-editor";
  }
}
