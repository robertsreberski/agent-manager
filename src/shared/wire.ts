import { z } from "zod";

import { AGENT_MANAGER_BUILD_ID } from "./build.ts";
import type {
  Diagnostic,
  SessionRecord,
  WorkspaceIdentity,
} from "./session.ts";
import {
  normalizeProviderReasoningEffort,
  REASONING_EFFORTS,
  sessionRecordId,
} from "./session.ts";

export const WIRE_SCHEMA_VERSION = 3 as const;

export interface WireIdentity {
  schemaVersion: number | null;
  buildId: string | null;
}

export class WireUpgradeRequiredError extends Error {
  readonly code = "UPGRADE_REQUIRED" as const;
  readonly received: WireIdentity;
  readonly expected: WireIdentity = {
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
  };

  constructor(received: WireIdentity) {
    super(
      `Agent Manager build mismatch; expected wire ${String(WIRE_SCHEMA_VERSION)} / ${AGENT_MANAGER_BUILD_ID}, received ${received.schemaVersion === null ? "missing" : String(received.schemaVersion)} / ${received.buildId ?? "missing"}. Deploy one complete build before reconnecting.`,
    );
    this.name = "WireUpgradeRequiredError";
    this.received = received;
  }
}

function recordIdentity(value: unknown): WireIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { schemaVersion: null, buildId: null };
  }
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : null,
    buildId: typeof record.buildId === "string" ? record.buildId : null,
  };
}

export function assertCurrentWireIdentity(value: unknown): void {
  const received = recordIdentity(value);
  if (
    received.schemaVersion !== WIRE_SCHEMA_VERSION
    || received.buildId !== AGENT_MANAGER_BUILD_ID
  ) throw new WireUpgradeRequiredError(received);
}

const evidenceSourceSchema = z.enum([
  "provider-api",
  "provider-cli",
  "hook",
  "live-registry",
  "rollout-events",
  "transcript",
  "process",
  "tmux",
  "inferred",
]);
const evidenceConfidenceSchema = z.enum(["exact", "inferred", "heuristic"]);
const providerSchema = z.enum(["codex", "claude"]);
const executionProfileSchema = z.enum(["ask-first", "plan", "execute", "full-access"]);
const reasoningEffortSchema = z.enum(REASONING_EFFORTS);
const controlCapabilitySchema = z.enum([
  "queue",
  "steer",
  "interrupt",
  "respond",
  "set-profile",
  "set-model",
  "set-effort",
  "remove-queued",
  "preview",
  "attach",
  "resume",
  "end",
  "archive",
  "delete",
  "open-editor",
]);

const evidencedValue = <T extends z.ZodType>(value: T) => z.object({
  value,
  providerValue: z.string().nullable(),
  source: evidenceSourceSchema,
  confidence: evidenceConfidenceSchema,
}).strict();

const attentionQuestionSchema = z.object({
  id: z.string(),
  header: z.string().nullable(),
  text: z.string(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().nullable(),
  }).strict()),
  multiSelect: z.boolean(),
  allowFreeText: z.boolean(),
  isSecret: z.boolean(),
}).strict();

const sessionAttentionSchema = z.object({
  id: z.string().nullable(),
  kind: z.enum(["question", "approval", "permission", "sandbox", "elicitation", "blocked"]),
  summary: z.string().nullable(),
  source: evidenceSourceSchema,
  confidence: evidenceConfidenceSchema,
  details: z.object({
    title: z.string().nullable(),
    questions: z.array(attentionQuestionSchema).nullable(),
    toolName: z.string().nullable(),
    inputSummary: z.string().nullable(),
    respondable: z.boolean(),
  }).strict().nullable(),
}).strict().superRefine((attention, context) => {
  if (attention.id === null && attention.details?.respondable) {
    context.addIssue({
      code: "custom",
      message: "heuristic attention without a stable request id cannot be respondable",
      path: ["details", "respondable"],
    });
  }
});

const childSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  idle: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
}).strict();

export const workspaceIdentitySchema: z.ZodType<WorkspaceIdentity> = z.object({
  repoRoot: z.string().min(1),
  repoName: z.string().min(1),
  worktreePath: z.string().min(1),
  linked: z.boolean(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  dirtyCount: z.number().int().nonnegative().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
}).strict();

export const sessionRecordSchema: z.ZodType<SessionRecord> = z.object({
  id: z.string().min(1),
  provider: providerSchema,
  providerThreadId: z.string().min(1),
  providerTreeId: z.string().min(1).nullable(),
  parentId: z.string().min(1).nullable(),
  providerTurnId: z.string().min(1).nullable(),
  depth: z.number().int().nonnegative(),
  hostId: z.string().min(1),
  hostLabel: z.string().min(1),
  name: z.string().nullable(),
  cwd: z.string().nullable(),
  kind: z.enum(["interactive", "background", "batch", "subagent", "unknown"]),
  presence: z.enum(["live", "recent"]),
  status: z.enum(["running", "waiting", "idle", "completed", "failed", "interrupted", "unknown"]),
  providerStatus: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  runtimePid: z.number().int().positive().nullable(),
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  childSummary: childSummarySchema,
  statusSource: evidenceSourceSchema,
  source: z.string().nullable(),
  profile: evidencedValue(executionProfileSchema.nullable()),
  model: evidencedValue(z.string().nullable()),
  effort: evidencedValue(reasoningEffortSchema.nullable()),
  todoProgress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    hasMoved: z.boolean(),
    lastTransitionAt: z.string().refine(
      (value) => Number.isFinite(Date.parse(value)),
      "last todo transition must be a timestamp",
    ).nullable(),
    active: z.boolean(),
  }).strict().nullable(),
  attention: z.array(sessionAttentionSchema),
  terminal: z.object({
    attachAvailable: z.boolean(),
    socketName: z.string().nullable(),
    socketPath: z.string().nullable(),
    session: z.string(),
    window: z.string(),
    windowIndex: z.number().int().nonnegative(),
    paneIndex: z.number().int().nonnegative(),
    paneId: z.string(),
    tty: z.string().nullable(),
    attachedClients: z.number().int().nonnegative(),
  }).strict().nullable(),
  control: z.object({
    plane: z.enum([
      "codex-private",
      "codex-hook-bridge",
      "claude-sdk",
      "claude-hook-bridge",
      "tmux-attach",
      "resume-only",
      "observe-only",
    ]),
    authority: z.enum(["manager", "foreign", "none"]),
    capabilities: z.array(controlCapabilitySchema),
    withheld: z.array(z.object({
      capability: controlCapabilitySchema,
      reason: z.string().min(1),
    }).strict()),
  }).strict(),
  workspaceIdentity: workspaceIdentitySchema.nullable(),
  generation: z.number().int().nonnegative(),
}).strict().superRefine((session, context) => {
  if (session.id !== sessionRecordId(session.hostId, session.provider, session.providerThreadId)) {
    context.addIssue({
      code: "custom",
      message: "session id must be the host-and-provider-qualified providerThreadId",
      path: ["id"],
    });
  }
  if (
    session.effort.value !== null
    && normalizeProviderReasoningEffort(session.provider, session.effort.value) === null
  ) {
    context.addIssue({
      code: "custom",
      message: `${session.provider} does not support ${session.effort.value} effort`,
      path: ["effort", "value"],
    });
  }
  if (session.todoProgress && session.todoProgress.completed > session.todoProgress.total) {
    context.addIssue({
      code: "custom",
      message: "completed todo count cannot exceed total todo count",
      path: ["todoProgress", "completed"],
    });
  }
  if (
    session.todoProgress
    && session.todoProgress.hasMoved !== (session.todoProgress.lastTransitionAt !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "todo movement and transition timestamp must agree",
      path: ["todoProgress", "lastTransitionAt"],
    });
  }
  if (
    session.todoProgress?.active
    && session.todoProgress.completed >= session.todoProgress.total
  ) {
    context.addIssue({
      code: "custom",
      message: "completed todo progress cannot be active",
      path: ["todoProgress", "active"],
    });
  }
  const duplicated = session.control.capabilities.find(
    (capability, index) => session.control.capabilities.indexOf(capability) !== index,
  );
  if (duplicated) {
    context.addIssue({
      code: "custom",
      message: `duplicate capability: ${duplicated}`,
      path: ["control", "capabilities"],
    });
  }
});

export function parseSessionRecord(value: unknown): SessionRecord {
  return sessionRecordSchema.parse(value);
}

export const diagnosticSchema: z.ZodType<Diagnostic> = z.object({
  provider: z.enum(["codex", "claude", "system"]),
  level: z.enum(["warning", "error"]),
  message: z.string(),
}).strict();

export interface WireStateSnapshot {
  schemaVersion: typeof WIRE_SCHEMA_VERSION;
  buildId: string;
  generatedAt: string;
  seq: number;
  stale: boolean;
  sessions: SessionRecord[];
  diagnostics: Diagnostic[];
}

export const stateSnapshotSchema: z.ZodType<WireStateSnapshot> = z.object({
  schemaVersion: z.literal(WIRE_SCHEMA_VERSION),
  buildId: z.literal(AGENT_MANAGER_BUILD_ID),
  generatedAt: z.string(),
  seq: z.number().int().nonnegative(),
  stale: z.boolean(),
  sessions: z.array(sessionRecordSchema),
  diagnostics: z.array(diagnosticSchema),
}).strict();

export function parseStateSnapshot(value: unknown): WireStateSnapshot {
  assertCurrentWireIdentity(value);
  return stateSnapshotSchema.parse(value);
}

export const sessionActionTypeSchema = z.enum([
  "send",
  "respond",
  "interrupt",
  "set-profile",
  "set-model",
  "set-effort",
  "remove-queued",
  "end",
  "archive",
  "delete",
  "open-editor",
]);

export interface WireActionUpdate {
  id: string;
  /** Foreign key to SessionRecord.id. */
  sessionId: string;
  type: z.infer<typeof sessionActionTypeSchema>;
  status: "pending" | "dispatching" | "queued" | "succeeded" | "failed" | "unknown";
  createdAt: string;
  completedAt: string | null;
  error: { code: string; message: string } | null;
}

export const actionUpdateSchema: z.ZodType<WireActionUpdate> = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  type: sessionActionTypeSchema,
  status: z.enum(["pending", "dispatching", "queued", "succeeded", "failed", "unknown"]),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.object({ code: z.string().min(1), message: z.string() }).strict().nullable(),
}).strict();

const stateEventBaseSchema = {
  schemaVersion: z.literal(WIRE_SCHEMA_VERSION),
  buildId: z.literal(AGENT_MANAGER_BUILD_ID),
  seq: z.number().int().positive(),
  at: z.string(),
};

export const stateEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...stateEventBaseSchema,
    type: z.literal("snapshot"),
    payload: stateSnapshotSchema,
  }).strict(),
  z.object({
    ...stateEventBaseSchema,
    type: z.literal("session.upsert"),
    payload: sessionRecordSchema,
  }).strict(),
  z.object({
    ...stateEventBaseSchema,
    type: z.literal("session.remove"),
    payload: z.object({ id: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    ...stateEventBaseSchema,
    type: z.literal("action.updated"),
    payload: actionUpdateSchema,
  }).strict(),
  z.object({
    ...stateEventBaseSchema,
    type: z.literal("diagnostic"),
    payload: z.object({
      stale: z.boolean(),
      diagnostics: z.array(diagnosticSchema),
    }).strict(),
  }).strict(),
]);

export type StateEvent = z.infer<typeof stateEventSchema>;
export type StateEventType = StateEvent["type"];

export function parseStateEvent(value: unknown): StateEvent {
  assertCurrentWireIdentity(value);
  if (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "snapshot"
  ) assertCurrentWireIdentity((value as Record<string, unknown>).payload);
  return stateEventSchema.parse(value);
}

export { AGENT_MANAGER_BUILD_ID } from "./build.ts";
