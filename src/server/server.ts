import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server as NetServer } from "node:net";
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ZodError, z } from "zod";

import {
  ActivityHub,
  type ActivityAttentionItem,
  type ActivityFrame,
} from "../activity/index.ts";
import type {
  Diagnostic,
  Provider,
  SessionAttention,
  SessionRecord,
  SessionView,
} from "../core/types.ts";
import { WorkspaceIdentityResolver } from "../core/worktree.ts";
import {
  CodexHookBridge,
} from "../providers/codex/codex-hook-bridge.ts";
import type { CodexHookAuthorizationRecord } from "../providers/codex/codex-hook-auth.ts";
import { registerCodexHookRoute } from "../providers/codex/codex-hook-route.ts";
import {
  ClaudeHookBridge,
  ClaudeHookSourceArbiter,
  registerClaudeHookRoute,
  type ClaudeHookPendingPermission,
  type HookAuthorizationRecord,
} from "../providers/hooks/index.ts";
import {
  selectedAttentionDetailsQuerySchema,
  selectedAttentionDetailsResponseSchema,
  type SelectedAttentionDetail,
} from "../shared/attention-detail.ts";
import {
  availableSessionAccountFactsSchema,
  selectedSessionFactsQuerySchema,
  selectedSessionFactsResponseSchema,
  type SessionAccountFacts,
  type SessionTurnUsage,
} from "../shared/session-facts.ts";
import { selectedTodoDetailResponseSchema } from "../shared/todo-detail.ts";
import {
  setupHarnessProbeResponseSchema,
  setupReadModelSchema,
  type SetupHarnessProbe,
} from "../shared/setup.ts";
import { sessionRecordId } from "../shared/session.ts";
import { AGENT_MANAGER_BUILD_ID, WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import { workspaceListResponseSchema } from "../shared/workspace.ts";
import {
  DiscoveryReconciler,
  type DiscoveryReconcilerOptions,
} from "../discovery/index.ts";
import {
  RemoteHostManager,
  RemoteNodeError,
  type RemoteHostDefinition,
} from "../remote/index.ts";
import { AuthManager, type AuthManagerOptions, type AuthSession } from "./auth.ts";
import {
  createSessionSchema,
  directoryCompletionQuerySchema,
  executionProfileSchema,
  reasoningEffortSchema,
  leaseRequestSchema,
  requiredCapability,
  resolveWorkspaceSchema,
  sessionActionSchema,
  sessionSettingsOptionsSchema,
  type ActionRecord,
  type AttachInstruction,
  type ManagedSessionRecoveryRecord,
  type ProviderControlAdapters,
  type PanePreviewAdapter,
  type RequestContext,
  type SessionAction,
  type StateEvent,
} from "./contracts.ts";
import {
  ControlLeaseBroker,
  IdempotencyConflictError,
  IdempotencyStore,
  LeaseConflictError,
} from "./controls.ts";
import { startOwnerControlSocket } from "./control-socket.ts";
import {
  actionFingerprint,
  createSessionFingerprint,
  ManagerDatabase,
} from "./persistence.ts";
import {
  PanePreviewError,
  TmuxPanePreviewAdapter,
  tmuxAttachInstruction,
} from "./preview.ts";
import { LocalPlanFileReader, type PlanFileReader } from "./plan-file.ts";
import { SessionStateStore } from "./state.ts";
import type { SessionTranscriptReader } from "./transcript.ts";
import { SelectedTranscriptActivityObserver } from "./activity-observer.ts";
import { MacEditorLauncher, type EditorLauncher } from "./editor.ts";
import { probeLocalHarnesses } from "./harness-probe.ts";
import { SetupHookManager, type SetupHookManagerOptions } from "./setup-hooks.ts";
import { probeSetupHosts } from "./setup-hosts.ts";
import {
  ARCHIVED_SESSION_PAGE_LIMIT,
  LocalCodexArchiveCatalog,
  type ArchivedSessionCatalog,
} from "./archive-catalog.ts";
import { OrderedSseWriter } from "./sse-writer.ts";
import {
  CliTakeoverCoordinator,
  type LocalCliProcessInspector,
} from "./cli-takeover.ts";
import {
  persistDiscoveredWorkspaces,
  setupNearbyWorkspaces,
} from "./setup-workspaces.ts";
import {
  localDirectoryCompletions,
  workspaceFileCompletions,
  resolveWorkspaceForHost,
  workspaceResolutionResponse,
} from "./workspaces.ts";

const previewQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(200).default(200),
  bytes: z.coerce.number().int().min(1_024).max(65_536).default(65_536),
});
const transcriptSearchQuerySchema = z.object({
  q: z.string()
    .trim()
    .min(2)
    .max(200)
    .refine((value) => !value.includes("\0"), "query contains an invalid character"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const workspaceFileQuerySchema = z.object({
  q: z.string()
    .trim()
    .max(200)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "query contains an invalid character")
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const archivedSessionQuerySchema = z.object({
  q: z.string().trim().max(200).refine((value) => !value.includes("\0"), "query contains an invalid character").default(""),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(ARCHIVED_SESSION_PAGE_LIMIT).default(ARCHIVED_SESSION_PAGE_LIMIT),
}).strict();
const workspaceFileResponseSchema = z.object({
  sessionId: z.string().min(1),
  paths: z.array(z.string().min(1)).max(50),
}).strict();
const eventsQuerySchema = z.object({
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict();
const providerSettingsOptionsParamsSchema = z.object({
  provider: z.enum(["codex", "claude"]),
}).strict();
const providerSettingsOptionsQuerySchema = z.object({
  hostId: z.string().min(1).max(128).refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "host ID must not contain control characters",
  ),
}).strict();
const bootstrapSchema = z.object({ secret: z.string().min(32).max(256) }).strict();

const NO_STORE = "no-store";
const REVALIDATE = "public, max-age=0, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";
const SETTINGS_OPTIONS_TIMEOUT_MS = 3_000;
const SESSION_FACTS_TIMEOUT_MS = 3_000;
const MANAGED_SESSION_RECOVERY_TIMEOUT_MS = 10_000;
const CODEX_HOOK_FRESHNESS_MS = 30_000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "worker-src 'self'",
].join("; ");

function pathOnly(url: string): string {
  return url.split(/[?#]/u, 1)[0] ?? "/";
}

export function cacheControlForResponse(
  url: string,
  statusCode: number,
  contentType: string | undefined,
): string {
  const path = pathOnly(url).toLowerCase();
  if (
    path === "/api"
    || path.startsWith("/api/")
    || /^\/(?:actions?|auth|events?|healthz|sse)(?:\/|$)/u.test(path)
  ) return NO_STORE;
  if (!((statusCode >= 200 && statusCode < 300) || statusCode === 304)) return NO_STORE;
  if (path === "/sw.js" || path === "/service-worker.js") return "no-cache";
  if (/^\/assets\/.+-[a-z0-9_-]{8,}\.[a-z0-9]+$/iu.test(path)) return IMMUTABLE;
  if (
    path.endsWith(".webmanifest")
    || path === "/manifest.json"
    || contentType?.toLowerCase().startsWith("text/html")
  ) return REVALIDATE;
  return NO_STORE;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface AgentManagerServerOptions {
  host?: string;
  port?: number;
  databasePath?: string;
  controlSocketPath?: string;
  publicOrigin?: string;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  tailscaleHosts?: readonly string[];
  tailscaleAllowedLogins?: readonly string[];
  auth?: Partial<Omit<AuthManagerOptions, "allowedHosts" | "allowedOrigins">>;
  state?: SessionStateStore;
  /** Volatile selected-session activity projection. Never persisted. */
  activityHub?: ActivityHub;
  /** Shared with the Claude SDK adapter so a session has only one activity authority. */
  claudeHookSourceArbiter?: ClaudeHookSourceArbiter;
  /** Test/embedder seam; production authorization records load from ManagerDatabase. */
  claudeHookAuthorizationRecords?: readonly HookAuthorizationRecord[];
  /** Test/embedder seam; production authorization records load from ManagerDatabase. */
  codexHookAuthorizationRecords?: readonly CodexHookAuthorizationRecord[];
  database?: ManagerDatabase;
  adapters?: ProviderControlAdapters;
  previewAdapter?: PanePreviewAdapter;
  /** Pinned local editor operation; false removes the server capability. */
  editorLauncher?: EditorLauncher | false;
  /** Reads only provider-registered plan artifacts from explicit local roots. */
  planFileReader?: PlanFileReader;
  /** Supplies bounded transcript-derived items to the selected-session activity stream. */
  transcriptReader?: SessionTranscriptReader;
  /** Canonical tmux executable used by the production preview adapter. */
  tmuxExecutable?: string;
  replayCapacity?: number;
  bodyLimit?: number;
  logger?: boolean;
  /** Production web assets; false disables static and SPA routes. */
  staticDir?: string | false;
  initialSessions?: readonly SessionRecord[];
  initialDiagnostics?: readonly Diagnostic[];
  /** Enabled by default; pass false in deterministic unit tests. */
  discovery?: false | Omit<DiscoveryReconcilerOptions, "onUpdate">;
  onShutdown?: () => void | Promise<void>;
  maxSseClients?: number;
  maxSseClientsPerAuthSession?: number;
  shutdownTimeoutMs?: number;
  /** Test/embedder seam; production account reads stay under three seconds. */
  sessionFactsTimeoutMs?: number;
  /** Test/embedder seam; production provider draft reads stay under three seconds. */
  providerSettingsOptionsTimeoutMs?: number;
  /** Configured owner SSH nodes. Browser input can only select these stable IDs. */
  remoteHosts?: readonly RemoteHostDefinition[];
  sshExecutable?: string;
  remotePollIntervalMs?: number;
  /** Test/embedder seam for the bounded local setup probe. */
  setupHarnessProbe?: () => Promise<SetupHarnessProbe>;
  /** Test/embedder seam for an already configured remote host. */
  setupRemoteHarnessProbe?: (hostId: string) => Promise<SetupHarnessProbe>;
  /** User settings root used by hook status/preview. */
  homeDirectory?: string;
  /** Loopback origin written into provider hooks. */
  hookEndpointOrigin?: string;
  /** Pinned Node executable written into the Codex hook shim. */
  nodeExecutable?: string;
  /** Read-only live Codex hooks/list trust and enable probe. */
  codexHookTrustStatus?: SetupHookManagerOptions["codexTrustStatus"];
  /** Test/embedder seam; production hook authority evidence expires after 30 seconds. */
  codexHookFreshnessMs?: number;
  /** Test seam for identity-checked local CLI takeover. */
  cliTakeoverInspector?: LocalCliProcessInspector;
  cliTakeoverTimings?: {
    guidedTimeoutMs?: number;
    gracefulExitTimeoutMs?: number;
    adoptionTimeoutMs?: number;
    pollIntervalMs?: number;
  };
  archivedSessionCatalog?: ArchivedSessionCatalog;
}

export interface AgentManagerBackend {
  app: FastifyInstance;
  state: SessionStateStore;
  activityHub: ActivityHub;
  auth: AuthManager;
  database: ManagerDatabase;
  controlSocketPath: string | null;
  listen(): Promise<string>;
  close(): Promise<void>;
  bootstrapUrl(origin?: string): string;
  replaceSessions(
    sessions: readonly SessionRecord[],
    diagnostics?: readonly Diagnostic[],
  ): void;
}

function errorBody(code: string, message: string, details?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  return { error };
}

function zodDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function requestAbortSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort());
  return controller.signal;
}

function encodeSse(event: StateEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function encodeActivitySse(frame: ActivityFrame): string {
  return `id: ${frame.cursor}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function boundedProviderLookup<T>(
  start: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out`));
  }, timeoutMs);
  timer.unref();

  try {
    controller.signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", abort);
        complete();
      };
      const abort = (): void => finish(() => {
        const reason = controller.signal.reason;
        reject(reason instanceof Error ? reason : new Error(`${label} was cancelled`));
      });
      controller.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => start(controller.signal))
        .then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
    });
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function actionRecord(
  id: string,
  sessionId: string,
  action: SessionAction,
  status: ActionRecord["status"],
  createdAt: string,
  extra: Partial<Pick<ActionRecord, "completedAt" | "error">> = {},
): ActionRecord {
  return {
    id,
    sessionId,
    type: action.type,
    status,
    createdAt,
    completedAt: extra.completedAt ?? null,
    error: extra.error ?? null,
  };
}

function routeSessionId(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

function isMutation(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function providerAdapter(
  adapters: ProviderControlAdapters,
  provider: Provider,
) {
  const adapter = adapters[provider];
  if (!adapter) throw new ApiError(501, "PROVIDER_CONTROL_UNAVAILABLE", `${provider} control is unavailable`);
  return adapter;
}

function managedRecoveryRecords(database: ManagerDatabase, provider: Provider): {
  records: ManagedSessionRecoveryRecord[];
  diagnostics: Diagnostic[];
} {
  const records: ManagedSessionRecoveryRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const persisted of database.listManagedSessions()) {
    if (persisted.provider !== provider) continue;
    const workspace = persisted.workspaceId
      ? database.getWorkspace(persisted.workspaceId)
      : null;
    const profile = executionProfileSchema.safeParse(persisted.metadata.profile);
    const effort = reasoningEffortSchema.nullable().safeParse(persisted.metadata.effort);
    const name = persisted.metadata.name;
    const model = persisted.metadata.model;
    const valid = persisted.providerSessionId.length > 0
      && persisted.providerSessionId.length <= 512
      && persisted.id === sessionRecordId("local", provider, persisted.providerSessionId)
      && workspace !== null
      && workspace.hostId === "local"
      && workspace.hostKind === "local"
      && isAbsolute(workspace.path)
      && persisted.metadata.hostId === "local"
      && (name === null || (typeof name === "string" && name.length <= 120))
      && (model === null || (typeof model === "string" && model.length > 0 && model.length <= 256))
      && profile.success
      && effort.success
      && Number.isFinite(Date.parse(persisted.createdAt))
      && Number.isFinite(Date.parse(persisted.updatedAt));
    if (!valid || !workspace || !persisted.workspaceId || !profile.success || !effort.success) {
      diagnostics.push({
        provider,
        level: "warning",
        message: `Skipped invalid persisted ${provider === "codex" ? "Codex" : "Claude"} manager identity ${persisted.id}`,
      });
      continue;
    }
    records.push({
      managerSessionId: persisted.id,
      provider,
      providerThreadId: persisted.providerSessionId,
      workspaceId: persisted.workspaceId,
      workspacePath: workspace.path,
      name: name as string | null,
      profile: profile.data,
      model: model as string | null,
      effort: effort.data,
      createdAt: persisted.createdAt,
    });
  }
  return { records, diagnostics };
}

function withLocalEditorCapability(
  session: SessionRecord,
  available: boolean,
): SessionRecord {
  if (
    !available
    || session.hostId !== "local"
    || session.workspaceIdentity === null
    || session.control.capabilities.includes("open-editor")
  ) return session;
  return {
    ...session,
    control: {
      ...session.control,
      capabilities: [...session.control.capabilities, "open-editor"],
    },
  };
}

export async function createAgentManagerServer(
  options: AgentManagerServerOptions = {},
): Promise<AgentManagerBackend> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43_127;
  const publicOrigin = options.publicOrigin ?? `http://${host}:${port}`;
  const tailscaleHosts = options.tailscaleHosts ?? [];
  const allowedHosts = options.allowedHosts ?? [
    `${host}:${port}`,
    `localhost:${port}`,
    ...tailscaleHosts,
  ];
  const allowedOrigins = options.allowedOrigins ?? [
    publicOrigin,
    ...tailscaleHosts.map((tailscaleHost) => `https://${tailscaleHost}`),
  ];
  const state = options.state ?? new SessionStateStore({
    replayCapacity: options.replayCapacity ?? 512,
  });
  const workspaceIdentityResolver = new WorkspaceIdentityResolver();
  const activityHub = options.activityHub ?? new ActivityHub();
  const releaseTodoProgress = activityHub.subscribeTodoProgress(
    (sessionId, progress) => state.setTodoProgress(sessionId, progress),
  );
  const database = options.database ?? new ManagerDatabase(options.databasePath);
  const archivedSessions = options.archivedSessionCatalog ?? new LocalCodexArchiveCatalog();
  const resolveArchivedSession = (id: string): SessionRecord | null => {
    try {
      return archivedSessions.get(id);
    } catch {
      return null;
    }
  };
  const resolveReadableSession = (id: string): SessionRecord | null =>
    state.get(id) ?? resolveArchivedSession(id);
  for (const remoteHost of options.remoteHosts ?? []) {
    database.addHost({
      id: remoteHost.id,
      label: remoteHost.label,
      kind: "ssh",
      sshTarget: remoteHost.target,
    });
  }
  const remoteHosts = new RemoteHostManager(options.remoteHosts ?? [], {
    ...(options.sshExecutable ? { sshExecutable: options.sshExecutable } : {}),
    ...(options.remotePollIntervalMs ? { pollIntervalMs: options.remotePollIntervalMs } : {}),
  });
  const adapters = options.adapters ?? {};
  const previewAdapter = options.previewAdapter ?? new TmuxPanePreviewAdapter(
    options.tmuxExecutable === undefined ? {} : { executable: options.tmuxExecutable },
  );
  const editorLauncher = options.editorLauncher === false
    ? null
    : options.editorLauncher ?? new MacEditorLauncher();
  const planFileReader = options.planFileReader ?? new LocalPlanFileReader();
  let discovery: DiscoveryReconciler | null = null;
  const claudeHookSourceArbiter = options.claudeHookSourceArbiter
    ?? new ClaudeHookSourceArbiter();
  const claudeHookBases = new Map<string, SessionRecord>();
  const claudeHookPermissions = new Map<
    string,
    Map<string, ClaudeHookPendingPermission>
  >();
  const sseClients = new Map<FastifyReply, {
    authSessionId: string;
    clientId: string | null;
    channel: "global" | "activity";
    sessionId: string | null;
    close: () => void;
  }>();
  const cliTakeover = new CliTakeoverCoordinator({
    ...(options.cliTakeoverInspector ? { inspector: options.cliTakeoverInspector } : {}),
    ...(options.cliTakeoverTimings ?? {}),
    canAdopt: (provider) => typeof adapters[provider]?.adoptExternalSession === "function",
    adopt: async (session, profile, signal) => {
      const adapter = adapters[session.provider];
      if (!adapter?.adoptExternalSession || !session.cwd) {
        throw new Error(`${session.provider} takeover is unavailable`);
      }
      const workspace = database.listWorkspaces().find((candidate) =>
        candidate.hostId === "local"
        && candidate.hostKind === "local"
        && candidate.path === session.cwd
      );
      if (!workspace) throw new Error("The discovered session workspace is not registered locally");
      return adapter.adoptExternalSession(session, profile, {
        actor: { id: "cli-takeover", kind: "local", displayName: "Local owner" },
        requestId: `cli-takeover:${randomUUID()}`,
        signal,
        workspace: { id: workspace.id, label: workspace.label, path: workspace.path },
        managerSessionId: session.id,
      });
    },
    persist: async (original, adopted, profile) => {
      const workspace = database.listWorkspaces().find((candidate) =>
        candidate.hostId === "local"
        && candidate.hostKind === "local"
        && candidate.path === adopted.cwd
      );
      if (!workspace) throw new Error("The adopted session workspace could not be committed");
      const prior = database.listManagedSessions().find((record) => record.id === adopted.id) ?? null;
      const now = new Date().toISOString();
      const adapter = adapters[adopted.provider];
      try {
        database.upsertManagedSession({
          id: adopted.id,
          provider: adopted.provider,
          providerSessionId: adopted.providerThreadId,
          workspaceId: workspace.id,
          metadata: {
            adoptedFromCli: true,
            name: adopted.name,
            profile,
            model: original.model.value,
            effort: original.effort.value,
            hostId: "local",
          },
          createdAt: adopted.startedAt ?? original.startedAt ?? now,
          updatedAt: now,
        });
        await adapter?.commitExternalAdoption?.(adopted.providerThreadId);
      } catch (error) {
        if (prior) database.upsertManagedSession(prior);
        else database.removeManagedSession(adopted.id);
        await Promise.resolve(adapter?.abortExternalAdoption?.(adopted.providerThreadId))
          .catch(() => undefined);
        throw error;
      }
    },
    rollback: async (session) => {
      await Promise.resolve(
        adapters[session.provider]?.abortExternalAdoption?.(session.providerThreadId),
      ).catch(() => undefined);
    },
    onChange: (sessionId) => {
      const current = state.get(sessionId) ?? cliTakeover.retainedSession(sessionId);
      if (!current) return;
      state.upsert(withLocalEditorCapability(
        cliTakeover.decorate(current),
        editorLauncher !== null,
      ));
    },
    onAdopted: (session) => {
      state.upsert(withLocalEditorCapability(session, editorLauncher !== null));
      // The existing activity stream was opened while the session was foreign.
      // Reconnect it so provider-specific selected-session adoption occurs.
      for (const client of [...sseClients.values()]) {
        if (client.channel === "activity" && client.sessionId === session.id) client.close();
      }
    },
  });
  let scheduleClaudePermissionPresenceCheck = (): void => undefined;
  const claudeHookSession = (providerSessionId: string): string =>
    sessionRecordId("local", "claude", providerSessionId);
  const hookAttention = (
    request: ClaudeHookPendingPermission,
  ): SessionAttention => ({
    id: request.id,
    kind: request.toolName === "AskUserQuestion"
      ? "question"
      : request.toolName === "ExitPlanMode"
        ? "approval"
        : "permission",
    summary: null,
    source: "hook",
    confidence: "exact",
    details: {
      title: null,
      questions: null,
      toolName: null,
      inputSummary: null,
      respondable: true,
    },
  });
  const decorateClaudeHookSession = (session: SessionRecord): SessionRecord => {
    const pending = claudeHookPermissions.get(session.id);
    if (!pending || pending.size === 0) return session;
    const hookRequests = [...pending.values()];
    return {
      ...session,
      status: "waiting",
      statusSource: "hook",
      updatedAt: hookRequests.reduce(
        (latest, request) => request.createdAt > latest ? request.createdAt : latest,
        session.updatedAt,
      ),
      attention: [
        ...session.attention.filter((attention) => attention.source !== "hook"),
        ...hookRequests.map(hookAttention),
      ],
      control: {
        plane: "claude-hook-bridge",
        // A held hook grants one exact response path; it does not transfer
        // ownership of the externally-started provider process to the SDK.
        authority: "foreign",
        capabilities: session.control.capabilities.includes("respond")
          ? session.control.capabilities
          : [...session.control.capabilities, "respond"],
        withheld: session.control.withheld.filter(
          (withheld) => withheld.capability !== "respond",
        ),
        takeover: session.control.takeover,
      },
    };
  };
  const rememberClaudeHookBase = (session: SessionRecord): SessionRecord => {
    if (
      session.provider !== "claude"
      || session.hostId !== "local"
      || session.control.authority === "manager"
    ) return session;
    claudeHookBases.set(session.id, structuredClone(session));
    return decorateClaudeHookSession(session);
  };
  const refreshClaudeHookSession = (sessionId: string): void => {
    const base = claudeHookBases.get(sessionId);
    if (!base || !state.get(sessionId)) return;
    state.upsert(withLocalEditorCapability(
      cliTakeover.decorate(decorateClaudeHookSession(base)),
      editorLauncher !== null,
    ));
  };
  const hookAuthorizationRecords = (): HookAuthorizationRecord[] =>
    (options.claudeHookAuthorizationRecords
      ?? database.listClaudeHookInstallRecords()).map((record) => ({
      id: record.id,
      provider: "claude",
      tokenDigest: record.tokenDigest,
      createdAt: record.createdAt,
      settingsPath: record.settingsPath,
    }));
  const claudeHookBridge = new ClaudeHookBridge({
    authorizationRecords: hookAuthorizationRecords(),
    sourceArbiter: claudeHookSourceArbiter,
    onHookSeen: (event) => {
      try {
        database.markClaudeHookSeen(event.installId, event.receivedAt);
      } catch {
        state.addDiagnostic({
          provider: "claude",
          level: "warning",
          message: "Claude hook activity is live, but its liveness receipt could not be persisted.",
        });
      }
      discovery?.scan();
    },
    onActivity: (providerSessionId, mutation) => {
      activityHub.ingest(claudeHookSession(providerSessionId), "claude", mutation);
    },
    onPermissionChanged: (event) => {
      const sessionId = claudeHookSession(event.request.sessionId);
      let pending = claudeHookPermissions.get(sessionId);
      if (event.type === "opened") {
        if (!pending) {
          pending = new Map();
          claudeHookPermissions.set(sessionId, pending);
        }
        pending.set(event.request.id, structuredClone(event.request));
      } else if (pending) {
        pending.delete(event.request.id);
        if (pending.size === 0) claudeHookPermissions.delete(sessionId);
      }
      refreshClaudeHookSession(sessionId);
      scheduleClaudePermissionPresenceCheck();
    },
    onError: () => state.addDiagnostic({
      provider: "claude",
      level: "warning",
      message: "A Claude hook event could not be projected faithfully.",
    }),
  });
  const codexHookLastSeenAt = new Map<string, number>();
  const codexHookBases = new Map<string, SessionRecord>();
  const codexHookExpiryTimers = new Map<string, NodeJS.Timeout>();
  const codexHookFreshnessMs = Math.max(
    1,
    options.codexHookFreshnessMs ?? CODEX_HOOK_FRESHNESS_MS,
  );
  const codexHookSession = (providerSessionId: string): string =>
    sessionRecordId("local", "codex", providerSessionId);
  const hasRecentCodexHookEvidence = (sessionId: string, now = Date.now()): boolean => {
    const lastSeenAt = codexHookLastSeenAt.get(sessionId);
    return lastSeenAt !== undefined
      && lastSeenAt <= now
      && now - lastSeenAt <= codexHookFreshnessMs;
  };
  const codexHookCapabilities = (
    session: SessionRecord,
  ): SessionRecord["control"]["capabilities"] => session.control.capabilities.filter(
    (capability) => capability === "preview"
      || capability === "attach"
      || capability === "resume"
      || capability === "open-editor",
  );
  const decorateCodexHookSession = (session: SessionRecord): SessionRecord => {
    if (
      session.provider !== "codex"
      || session.hostId !== "local"
      || session.control.authority === "manager"
      || !hasRecentCodexHookEvidence(session.id)
    ) return session;
    const capabilities = codexHookCapabilities(session);
    return {
      ...session,
      control: {
        plane: "codex-hook-bridge",
        authority: "foreign",
        capabilities,
        withheld: session.control.withheld.filter((withheld) =>
          capabilities.includes(withheld.capability)
        ),
        takeover: session.control.takeover,
      },
    };
  };
  const rememberCodexHookBase = (session: SessionRecord): SessionRecord => {
    if (
      session.provider !== "codex"
      || session.hostId !== "local"
      || session.control.authority === "manager"
    ) return session;
    if (session.control.plane !== "codex-hook-bridge") {
      codexHookBases.set(session.id, structuredClone(session));
    }
    return decorateCodexHookSession(codexHookBases.get(session.id) ?? session);
  };
  const refreshCodexHookSession = (sessionId: string): void => {
    const current = state.get(sessionId);
    if (!current || current.control.authority === "manager") return;
    const base = codexHookBases.get(sessionId);
    if (!base) return;
    state.upsert(withLocalEditorCapability(
      cliTakeover.decorate(decorateCodexHookSession(base)),
      editorLauncher !== null,
    ));
  };
  const scheduleCodexHookExpiry = (sessionId: string, seenAt: number): void => {
    const previous = codexHookExpiryTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      codexHookExpiryTimers.delete(sessionId);
      if (codexHookLastSeenAt.get(sessionId) !== seenAt) return;
      codexHookLastSeenAt.delete(sessionId);
      refreshCodexHookSession(sessionId);
    }, codexHookFreshnessMs + 1);
    timer.unref();
    codexHookExpiryTimers.set(sessionId, timer);
  };
  const codexHookAuthorizationRecords = (): CodexHookAuthorizationRecord[] =>
    (options.codexHookAuthorizationRecords
      ?? database.listCodexHookInstallRecords()).map((record) => ({
      id: record.id,
      provider: "codex",
      tokenDigest: record.tokenDigest,
      createdAt: record.createdAt,
      settingsPath: record.settingsPath,
      shimPath: record.shimPath,
    }));
  const codexHookBridge = new CodexHookBridge({
    authorizationRecords: codexHookAuthorizationRecords(),
    onActivity: (providerSessionId, mutation) => {
      const sessionId = codexHookSession(providerSessionId);
      if (state.get(sessionId)?.control.authority === "manager") return;
      activityHub.ingest(sessionId, "codex", mutation);
    },
    onHookSeen: (event) => {
      const sessionId = codexHookSession(event.providerSessionId);
      if (state.get(sessionId)?.control.authority !== "manager") {
        const receivedAt = Date.parse(event.receivedAt);
        const at = Number.isFinite(receivedAt) ? receivedAt : Date.now();
        codexHookLastSeenAt.set(sessionId, at);
        refreshCodexHookSession(sessionId);
        scheduleCodexHookExpiry(sessionId, at);
      }
      try {
        database.markCodexHookSeen(event.installId, event.receivedAt);
      } catch {
        state.addDiagnostic({
          provider: "codex",
          level: "warning",
          message: "Codex hook activity is live, but its liveness receipt could not be persisted.",
        });
      }
      discovery?.scan();
    },
    onError: () => state.addDiagnostic({
      provider: "codex",
      level: "warning",
      message: "A Codex hook event could not be projected faithfully.",
    }),
  });
  const reloadHookAuthorizations = (): void => {
    claudeHookBridge.replaceAuthorizationRecords(
      database.listClaudeHookInstallRecords().map((record) => ({
        id: record.id,
        provider: "claude",
        tokenDigest: record.tokenDigest,
        createdAt: record.createdAt,
        settingsPath: record.settingsPath,
      })),
    );
    codexHookBridge.replaceAuthorizationRecords(
      database.listCodexHookInstallRecords().map((record) => ({
        id: record.id,
        provider: "codex",
        tokenDigest: record.tokenDigest,
        createdAt: record.createdAt,
        settingsPath: record.settingsPath,
        shimPath: record.shimPath,
      })),
    );
  };
  const setupHooks = new SetupHookManager({
    database,
    homeDirectory: options.homeDirectory ?? homedir(),
    endpointOrigin: options.hookEndpointOrigin ?? `http://127.0.0.1:${String(port)}`,
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    ...(options.codexHookTrustStatus
      ? { codexTrustStatus: options.codexHookTrustStatus }
      : {}),
  });
  const transcriptReader = options.transcriptReader;
  const auth = new AuthManager({
    allowedHosts,
    allowedOrigins,
    tailscaleHosts,
    tailscaleAllowedLogins: options.tailscaleAllowedLogins ?? [],
    ...options.auth,
  });
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 128 * 1_024,
    trustProxy: false,
    requestIdHeader: false,
  });
  const requestSessions = new WeakMap<FastifyRequest, AuthSession>();
  const idempotency = new IdempotencyStore();
  const leases = new ControlLeaseBroker({
    onChange: (sessionId, leased) => {
      const session = state.get(sessionId);
      if (!leased && session?.hostId && session.hostId !== "local") {
        void remoteHosts.releaseControl(sessionId).catch(() => undefined);
      }
    },
  });
  let controlSocket: NetServer | null = null;
  let databaseClosed = false;
  let lastStaleDiagnostic: string | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const shutdownTimeoutMs = Math.max(250, options.shutdownTimeoutMs ?? 2_000);
  const maxSseClients = Math.max(1, options.maxSseClients ?? 16);
  // A selected browser tab owns two streams: global metadata and activity.
  // Let the personal-tool owner use the bounded process pool by default (eight
  // fully selected tabs), while embedders can still impose a stricter actor cap.
  const maxSseClientsPerAuthSession = Math.max(
    1,
    options.maxSseClientsPerAuthSession ?? maxSseClients,
  );
  const hasRelevantCockpitConnection = (sessionId: string): boolean =>
    [...sseClients.values()].some((client) =>
      client.channel === "global"
      || (client.channel === "activity" && client.sessionId === sessionId)
    );
  let claudePermissionPresenceCheckScheduled = false;
  scheduleClaudePermissionPresenceCheck = (): void => {
    if (claudePermissionPresenceCheckScheduled) return;
    claudePermissionPresenceCheckScheduled = true;
    // EventSource replaces a same-client stream synchronously. Reconcile in a
    // microtask so closing the superseded socket cannot create a false
    // zero-client window, while a real last disconnect still fails open now.
    queueMicrotask(() => {
      claudePermissionPresenceCheckScheduled = false;
      for (const request of claudeHookBridge.pending()) {
        const sessionId = claudeHookSession(request.sessionId);
        if (!hasRelevantCockpitConnection(sessionId)) {
          claudeHookBridge.failOpen(request.id, "browser-lost");
        }
      }
    });
  };
  interface NativeHandoff {
    handoffId: string;
    spawnNonce: string;
    provider: Provider;
    providerSessionId: string;
    timer: NodeJS.Timeout;
    status: "preparing" | "prepared" | "authorized" | "attached" | "reclaiming" | "degraded";
    providerNotified: boolean;
    providerAttached: boolean;
    pid: number | null;
    wrapperPid: number | null;
    wrapperMonitor: NodeJS.Timeout | null;
    childMonitor: NodeJS.Timeout | null;
    reclaimPromise: Promise<void> | null;
    providerReclaimPromise: Promise<SessionView | null> | null;
    terminalKind: "exit" | "failure" | null;
    exitCode: number | null;
    reclaimCompleted: boolean;
    reclaimedView: SessionView | null;
  }
  const nativeHandoffs = new Map<string, NativeHandoff>();
  const remoteSessionIds = new Map<string, Set<string>>();
  const syncRemoteHostDefinitions = (): void => {
    const stored = database.listHosts().filter((host) => host.kind === "ssh" && host.sshTarget);
    const storedIds = new Set(stored.map((host) => host.id));
    for (const host of stored) {
      remoteHosts.upsertHost({ id: host.id, label: host.label, target: host.sshTarget! });
    }
    for (const remoteState of remoteHosts.states()) {
      if (storedIds.has(remoteState.id)) continue;
      for (const sessionId of remoteHosts.removeHost(remoteState.id)) state.remove(sessionId);
      remoteSessionIds.delete(remoteState.id);
    }
  };
  // Transcript history remains the selected session's bounded historical
  // source while hooks/APIs contribute exact live events. ActivityHub
  // correlates overlaps atomically, so neither source has to erase the other.
  const transcriptMayPoll = (_session: SessionView): boolean => true;
  const transcriptActivity = new SelectedTranscriptActivityObserver({
    hub: activityHub,
    ...(transcriptReader ? { reader: transcriptReader } : {}),
    resolveSession: resolveReadableSession,
    eligible: transcriptMayPoll,
  });
  const shouldObserveTranscript = (session: SessionView): boolean =>
    session.hostId === "local" && transcriptMayPoll(session);
  const isRemoteSession = (session: SessionView): boolean =>
    typeof session.hostId === "string" && session.hostId !== "local";
  const localOwnerActor = {
    id: "owner-control-socket",
    kind: "local" as const,
    displayName: "Local owner",
  };
  auth.onRevoked((authSessionId) => {
    leases.releaseForAuthSession(authSessionId);
    for (const client of [...sseClients.values()]) {
      if (client.authSessionId === authSessionId) client.close();
    }
  });
  const replaceDiscoveredSessions = (
    sessions: readonly SessionRecord[],
    diagnostics: readonly Diagnostic[],
  ): void => {
    let nextDiagnostics = [...diagnostics];
    try {
      persistDiscoveredWorkspaces(database, sessions);
    } catch {
      nextDiagnostics = [...nextDiagnostics, {
        provider: "system",
        level: "warning",
        message: "A discovered repository could not be remembered for first run.",
      }];
    }
    const discoveredIds = new Set(sessions.map((session) => session.id));
    const retained = state.list().filter((session) => (
      session.control.authority === "manager"
      && session.control.plane !== "claude-hook-bridge"
    ) || (
      claudeHookPermissions.has(session.id)
      && !discoveredIds.has(session.id)
    ) || isRemoteSession(session) || cliTakeover.retainedSession(session.id) !== null);
    const retainedIds = new Set(retained.map((session) => session.id));
    const external = sessions
      .filter((session) => !retainedIds.has(session.id))
      .map(rememberClaudeHookBase)
      .map(rememberCodexHookBase)
      .map((session) => cliTakeover.decorate(session))
      .map((session) => withLocalEditorCapability(session, editorLauncher !== null));
    state.replace([
      ...external,
      ...retained.map((session) => cliTakeover.decorate(session)),
    ], nextDiagnostics);
  };

  if (options.initialSessions || options.initialDiagnostics) {
    try {
      persistDiscoveredWorkspaces(database, options.initialSessions ?? state.list());
    } catch {
      // Initial observation must still render when optional setup persistence fails.
    }
    state.replace(
      (options.initialSessions ?? state.list())
        .map(rememberClaudeHookBase)
        .map(rememberCodexHookBase)
        .map((session) => cliTakeover.decorate(session))
        .map((session) => withLocalEditorCapability(session, editorLauncher !== null)),
      [],
    );
    for (const diagnostic of options.initialDiagnostics ?? []) state.addDiagnostic(diagnostic);
  }
  database.markInterruptedDispatchesUnknown();
  database.recoverCreateSessionIntents();

  for (const provider of ["codex", "claude"] as const) {
    const providerLabel = provider === "codex" ? "Codex" : "Claude";
    try {
      const recovery = managedRecoveryRecords(database, provider);
      for (const diagnostic of recovery.diagnostics) state.addDiagnostic(diagnostic);
      if (recovery.records.length === 0) continue;
      const adapter = adapters[provider];
      const restore = adapter?.restoreManagedSessions;
      if (!restore) {
        state.addDiagnostic({
          provider,
          level: "warning",
          message: `${recovery.records.length} persisted ${providerLabel} manager session(s) could not be restored because private controls are unavailable`,
        });
        continue;
      }
      const controller = new AbortController();
      const abortTimer = setTimeout(
        () => controller.abort(new Error(`Managed ${providerLabel} recovery timed out`)),
        MANAGED_SESSION_RECOVERY_TIMEOUT_MS,
      );
      abortTimer.unref();
      try {
        const report = await bounded(
          restore.call(adapter, recovery.records, controller.signal),
          MANAGED_SESSION_RECOVERY_TIMEOUT_MS,
          `managed ${providerLabel} recovery`,
        );
        for (const failure of report.failures) {
          state.addDiagnostic({
            provider,
            level: "warning",
            message: `Could not restore ${failure.managerSessionId}: ${failure.reason}`,
          });
        }
        if (report.truncated) {
          state.addDiagnostic({
            provider,
            level: "warning",
            message: `Managed ${providerLabel} recovery reached its persisted-session limit`,
          });
        }
      } catch (error) {
        controller.abort(error);
        state.addDiagnostic({
          provider,
          level: "warning",
          message: `Managed ${providerLabel} recovery stopped safely: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        clearTimeout(abortTimer);
      }
    } catch (error) {
      state.addDiagnostic({
        provider,
        level: "warning",
        message: `Persisted ${providerLabel} manager identities could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  remoteHosts.start({
    onSessions: (hostId, sessions) => {
      const nextIds = new Set(sessions.map((session) => session.id));
      for (const previousId of remoteSessionIds.get(hostId) ?? []) {
        if (!nextIds.has(previousId)) state.remove(previousId);
      }
      remoteSessionIds.set(hostId, nextIds);
      try {
        persistDiscoveredWorkspaces(database, sessions);
      } catch {
        state.addDiagnostic({
          provider: "system",
          level: "warning",
          message: `A repository observed on ${hostId} could not be remembered.`,
        });
      }
      for (const session of sessions) state.upsert(session);
    },
    onDiagnostic: (diagnostic) => state.addDiagnostic(diagnostic),
  });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: "1 minute",
  });

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", NO_STORE)
      .header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-write=(self)")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY");

    if (!auth.validateHost(request)) {
      throw new ApiError(400, "INVALID_HOST", "request Host is not allowed");
    }

    const isProviderHook = request.routeOptions.config.agentManagerPublicHook === true;
    if (
      isMutation(request.method)
      && !isProviderHook
      && !auth.validateMutationOrigin(request)
    ) {
      throw new ApiError(403, "INVALID_ORIGIN", "mutation Origin is not allowed");
    }
    if (
      (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")
      && !request.headers["content-type"]?.toLowerCase().startsWith("application/json")
    ) {
      throw new ApiError(415, "JSON_REQUIRED", "mutations require application/json");
    }

    const path = request.url.split("?", 1)[0];
    const publicPath = path === "/api/v1/healthz"
      || path === "/api/v1/auth/bootstrap"
      || path === "/api/v1/auth/session";
    if (!path?.startsWith("/api/") || publicPath || isProviderHook) return;

    const session = auth.authenticateCookie(request);
    if (!session) throw new ApiError(401, "AUTH_REQUIRED", "authentication is required");
    requestSessions.set(request, session);
    if (isMutation(request.method) && !auth.validateCsrf(session, request.headers["x-csrf-token"])) {
      throw new ApiError(403, "CSRF_INVALID", "CSRF token is missing or invalid");
    }
  });

  registerClaudeHookRoute(app, claudeHookBridge);
  registerCodexHookRoute(app, codexHookBridge);

  app.addHook("onSend", async (request, reply, payload) => {
    const rawContentType = reply.getHeader("content-type");
    const contentType = Array.isArray(rawContentType)
      ? rawContentType[0]
      : typeof rawContentType === "string"
        ? rawContentType
        : undefined;
    reply.header(
      "Cache-Control",
      cacheControlForResponse(request.url, reply.statusCode, contentType),
    );
    const path = pathOnly(request.url).toLowerCase();
    if (
      (path === "/sw.js" || path === "/service-worker.js")
      && reply.statusCode >= 200
      && reply.statusCode < 300
    ) {
      reply.header("Service-Worker-Allowed", "/");
    }
    return payload;
  });

  const defaultStaticDir = fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "../../dist/web/" : "../web/",
    import.meta.url,
  ));
  const staticDir = options.staticDir === false ? null : options.staticDir ?? defaultStaticDir;
  const servesUi = !!staticDir && existsSync(staticDir);
  if (servesUi) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
      wildcard: true,
      decorateReply: true,
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send(errorBody("VALIDATION_ERROR", "request validation failed", zodDetails(error)));
      return;
    }
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send(errorBody(error.code, error.message, error.details));
      return;
    }
    if (error instanceof LeaseConflictError) {
      void reply.status(409).send(errorBody("LEASE_CONFLICT", error.message, {
        expiresAt: error.expiresAt,
      }));
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      void reply.status(409).send(errorBody("IDEMPOTENCY_CONFLICT", error.message));
      return;
    }
    if (error instanceof RemoteNodeError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      void reply.status(status).send(errorBody(error.code, error.message));
      return;
    }
    const status = typeof error === "object"
      && error !== null
      && "statusCode" in error
      && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    if (status >= 500) request.log.error("agent-manager request failed");
    void reply.status(status).send(errorBody(
      status === 413 ? "BODY_TOO_LARGE" : "INTERNAL_ERROR",
      status === 413 ? "request body is too large" : "request could not be completed",
    ));
  });

  const requireSession = (request: FastifyRequest): AuthSession => {
    const session = requestSessions.get(request);
    if (!session) throw new ApiError(401, "AUTH_REQUIRED", "authentication is required");
    return session;
  };
  const context = (
    request: FastifyRequest,
    workspace: RequestContext["workspace"] = null,
    managerSessionId?: string,
  ): RequestContext => ({
    actor: requireSession(request).actor,
    requestId: request.id,
    signal: requestAbortSignal(request),
    workspace,
    ...(managerSessionId === undefined ? {} : { managerSessionId }),
  });
  const principal = (session: AuthSession) => ({
    authSessionId: session.id,
    actorId: session.actor.id,
  });

  app.get("/api/v1/healthz", async () => ({ ok: true }));

  app.post("/api/v1/auth/bootstrap", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const body = bootstrapSchema.parse(request.body);
    const session = auth.exchangeBootstrap(body.secret);
    if (!session) throw new ApiError(401, "BOOTSTRAP_INVALID", "bootstrap token is invalid or expired");
    reply.header("Set-Cookie", auth.sessionCookie(session, auth.cookieShouldBeSecure(request)));
    return {
      authenticated: true,
      csrfToken: session.csrfToken,
      actor: session.actor,
      wireSchemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
    };
  });

  app.get("/api/v1/auth/session", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const existing = auth.authenticateCookie(request);
    if (existing) {
      return {
        authenticated: true,
        csrfToken: existing.csrfToken,
        actor: existing.actor,
        wireSchemaVersion: WIRE_SCHEMA_VERSION,
        buildId: AGENT_MANAGER_BUILD_ID,
      };
    }
    const session = auth.establishTailscaleSession(request);
    if (!session) throw new ApiError(401, "AUTH_REQUIRED", "authentication is required");
    reply.header("Set-Cookie", auth.sessionCookie(session, auth.cookieShouldBeSecure(request)));
    return {
      authenticated: true,
      csrfToken: session.csrfToken,
      actor: session.actor,
      wireSchemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
    };
  });

  app.get("/api/v1/sessions", async () => state.snapshot());

  app.get("/api/v1/archived-sessions", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const query = archivedSessionQuerySchema.parse(request.query);
    try {
      const page = archivedSessions.list({
        query: query.q,
        cursor: query.cursor ?? null,
        limit: query.limit,
      });
      return {
        schemaVersion: WIRE_SCHEMA_VERSION,
        buildId: AGENT_MANAGER_BUILD_ID,
        query: query.q,
        ...page,
      };
    } catch (error) {
      if (error instanceof Error && /cursor is invalid/iu.test(error.message)) {
        throw new ApiError(400, "ARCHIVE_CURSOR_INVALID", "archived-session cursor is invalid");
      }
      throw new ApiError(503, "ARCHIVE_UNAVAILABLE", "the archived-session catalog could not be read safely");
    }
  });

  app.get("/api/v1/archived-sessions/:id", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const session = resolveArchivedSession(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "archived session was not found");
    return {
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      session,
    };
  });

  app.get("/api/v1/sessions/:id", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const id = routeSessionId(request);
    const session = resolveReadableSession(id);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    if (isRemoteSession(session)) {
      return { session: await remoteHosts.session(id) };
    }
    return { session };
  });

  app.get("/api/v1/sessions/:id/attention-details", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const sessionId = routeSessionId(request);
    const session = state.get(sessionId);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    const query = selectedAttentionDetailsQuerySchema.parse(request.query);
    const snapshot = activityHub.snapshot(sessionId);
    const details: SelectedAttentionDetail[] = [];

    for (const requestId of query.requestId) {
      // The metadata record is the liveness gate. ActivityHub can retain a
      // resolved or evicted request, but content is returned only while this
      // exact request ID is still pending in the current global generation.
      const metadataMatches = session.attention.filter((attention) =>
        attention.id === requestId && attention.confidence === "exact"
      );
      if (metadataMatches.length !== 1) continue;
      const metadata = metadataMatches[0]!;
      const activityMatches = (snapshot?.items ?? []).filter((item): item is ActivityAttentionItem =>
        item.kind === "attention"
        && item.requestId === requestId
        && item.attentionKind === metadata.kind
        && item.confidence === "exact"
        && item.exposure === "provider-exposed"
        && !item.resolved
        && (item.state === "pending" || item.state === "waiting")
      );
      if (activityMatches.length !== 1) continue;
      const activity = activityMatches[0]!;
      const parentTool = activity.parentId === null
        ? null
        : snapshot?.items.find((item) =>
            item.id === activity.parentId
            && item.kind === "tool"
            && item.confidence === "exact"
            && item.exposure === "provider-exposed"
          ) ?? null;
      const hookToolName = claudeHookPermissions.get(sessionId)?.get(requestId)?.toolName ?? null;

      details.push({
        requestId,
        kind: activity.attentionKind,
        title: activity.title && activity.title.trim().length > 0 ? activity.title : null,
        toolName: hookToolName
          ?? (parentTool?.kind === "tool" && parentTool.name.trim().length > 0 ? parentTool.name : null),
        questions: activity.questions.flatMap((question) =>
          question.id.trim().length > 0 && question.text.trim().length > 0
            ? [{ id: question.id, text: question.text }]
            : []
        ),
        truncated: activity.truncated,
      });
    }

    // State and activity are updated independently. Never return a projection
    // assembled across generations; the phone keeps the generic metadata row
    // and will retry against the next request-ID key instead.
    const current = state.get(sessionId);
    if (!current) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    const stable = current.generation === session.generation
      && current.provider === session.provider
      && current.providerThreadId === session.providerThreadId;
    return selectedAttentionDetailsResponseSchema.parse({
      sessionId,
      generation: current.generation,
      details: stable ? details : [],
    });
  });

  app.get("/api/v1/sessions/:id/todo-detail", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const sessionId = routeSessionId(request);
    const session = state.get(sessionId);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");

    const progress = session.todoProgress;
    const snapshot = activityHub.snapshot(sessionId);
    const currentTodo = [...(snapshot?.items ?? [])]
      .filter((item) => item.kind === "todo")
      .sort((left, right) => right.seq - left.seq || right.id.localeCompare(left.id))[0];
    let todo: {
      completed: number;
      total: number;
      current: string | null;
    } | null = null;

    if (
      progress
      && progress.total > 0
      && currentTodo?.kind === "todo"
      && currentTodo.confidence === "exact"
      && currentTodo.exposure === "provider-exposed"
    ) {
      const live = currentTodo.steps.filter((step) => step.status !== "removed");
      const completed = live.filter((step) => step.status === "completed").length;
      const active = live.filter((step) => step.status === "in_progress");
      const activeMatches = active.length > 0 && completed < live.length;
      if (
        completed === progress.completed
        && live.length === progress.total
        && activeMatches === progress.active
      ) {
        const exactCurrent = active.length === 1 && active[0]!.text.trim().length > 0
          ? active[0]!.text
          : null;
        todo = { completed, total: live.length, current: exactCurrent };
      }
    }

    // Counts are the content-free join key. Recheck the global identity after
    // reading ActivityHub so stale text can never be paired with a newer row.
    const current = state.get(sessionId);
    if (!current) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    const stable = current.generation === session.generation
      && current.provider === session.provider
      && current.providerThreadId === session.providerThreadId
      && current.todoProgress?.completed === progress?.completed
      && current.todoProgress?.total === progress?.total
      && current.todoProgress?.active === progress?.active;
    return selectedTodoDetailResponseSchema.parse({
      sessionId,
      generation: current.generation,
      todo: stable ? todo : null,
    });
  });

  app.get("/api/v1/providers/:provider/settings-options", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const { provider } = providerSettingsOptionsParamsSchema.parse(request.params);
    const { hostId } = providerSettingsOptionsQuerySchema.parse(request.query);
    if (hostId !== "local") {
      const host = database.getHost(hostId);
      if (!host || host.kind !== "ssh") {
        throw new ApiError(404, "HOST_NOT_FOUND", "host is not configured");
      }
      return { available: false as const, reason: "remote-host" as const, models: [] };
    }

    const adapter = adapters[provider];
    if (!adapter) {
      return { available: false as const, reason: "provider-unavailable" as const, models: [] };
    }
    if (!adapter.getCreateSettingsOptions) {
      return { available: false as const, reason: "unsupported-provider" as const, models: [] };
    }
    const getCreateSettingsOptions = adapter.getCreateSettingsOptions.bind(adapter);

    try {
      const requestContext = context(request);
      const settingsOptions = sessionSettingsOptionsSchema.parse(await boundedProviderLookup(
        (signal) => getCreateSettingsOptions({ ...requestContext, signal }),
        requestContext.signal,
        Math.max(1, options.providerSettingsOptionsTimeoutMs ?? SETTINGS_OPTIONS_TIMEOUT_MS),
        "provider draft settings lookup",
      ));
      return { available: true as const, ...settingsOptions };
    } catch {
      return { available: false as const, reason: "provider-unavailable" as const, models: [] };
    }
  });

  app.get("/api/v1/sessions/:id/settings-options", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    if (isRemoteSession(session)) {
      return { available: false as const, reason: "remote-session" as const, models: [] };
    }
    if (session.control.authority !== "manager") {
      return { available: false as const, reason: "not-manager-owned" as const, models: [] };
    }
    /*
      Deliberately not gated on `set-model`. Reading the catalog is a bounded
      provider read, not a write, and gating it on the write capability made the
      cockpit's model control dead precisely when it was most worth reading: a
      Codex thread withholds `set-model` for the whole of every turn, so the
      browser could neither change the model nor show what the alternatives
      were. The browser renders the list disabled with the harness's own
      withheld reason instead.
    */
    const adapter = adapters[session.provider];
    if (!adapter?.getSettingsOptions) {
      return { available: false as const, reason: "unsupported-provider" as const, models: [] };
    }
    try {
      const options = sessionSettingsOptionsSchema.parse(
        await bounded(
          adapter.getSettingsOptions(session, context(request)),
          SETTINGS_OPTIONS_TIMEOUT_MS,
          "provider settings lookup",
        ),
      );
      /*
        Identity and ownership only — deliberately not generation. A fresh
        managed session streams its first turn from creation, and every
        streamed message bumps the generation, so a generation comparison
        withdraws the catalog from exactly the sessions reading it. The
        catalog is thread-scoped provider data; only the thread being
        replaced, removed, or leaving manager ownership invalidates it.
      */
      const current = state.get(session.id);
      if (
        !current
        || current.provider !== session.provider
        || current.providerThreadId !== session.providerThreadId
        || current.hostId !== "local"
        || current.control.authority !== "manager"
      ) {
        return { available: false as const, reason: "provider-unavailable" as const, models: [] };
      }
      return { available: true as const, ...options };
    } catch {
      return { available: false as const, reason: "provider-unavailable" as const, models: [] };
    }
  });

  app.get("/api/v1/sessions/:id/facts", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request) => {
    const sessionId = routeSessionId(request);
    const session = resolveReadableSession(sessionId);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    const query = selectedSessionFactsQuerySchema.parse(request.query);
    if (query.generation !== session.generation) {
      throw new ApiError(409, "STALE_GENERATION", "session state changed before facts were read");
    }

    const usageItems = (activityHub.snapshot(sessionId)?.items ?? [])
      .filter((item) => item.kind === "usage" && item.scope === "turn")
      .filter((item) => session.providerTurnId === null || item.turnId === session.providerTurnId)
      .sort((left, right) => right.seq - left.seq || right.id.localeCompare(left.id));
    const usage = usageItems[0];
    const token = (value: number | null): number | null =>
      value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const money = (value: number | null): number | null =>
      value !== null && Number.isFinite(value) && value >= 0 ? value : null;
    const turnUsage: SessionTurnUsage | null = usage?.kind === "usage"
      ? {
          turnId: usage.turnId,
          inputTokens: token(usage.inputTokens),
          outputTokens: token(usage.outputTokens),
          cachedInputTokens: token(usage.cachedInputTokens),
          reasoningTokens: token(usage.reasoningTokens),
          totalTokens: token(usage.totalTokens),
          costUsd: money(usage.costUsd),
        }
      : null;

    let account: SessionAccountFacts;
    if (isRemoteSession(session)) {
      account = { available: false, reason: "remote-session" };
    } else if (session.control.authority !== "manager") {
      account = { available: false, reason: "not-manager-owned" };
    } else if (session.provider !== "codex") {
      account = { available: false, reason: "unsupported-provider" };
    } else {
      const adapter = adapters.codex;
      if (!adapter?.getAccountFacts) {
        account = { available: false, reason: "unsupported-provider" };
      } else {
        try {
          account = availableSessionAccountFactsSchema.parse(await bounded(
            adapter.getAccountFacts(session, context(request)),
            Math.max(1, options.sessionFactsTimeoutMs ?? SESSION_FACTS_TIMEOUT_MS),
            "Codex account facts lookup",
          ));
        } catch {
          account = { available: false, reason: "provider-unavailable" };
        }
      }
    }

    const current = resolveReadableSession(sessionId);
    if (
      !current
      || current.generation !== session.generation
      || current.provider !== session.provider
      || current.providerThreadId !== session.providerThreadId
      || current.providerTurnId !== session.providerTurnId
    ) {
      throw new ApiError(409, "STALE_GENERATION", "session state changed while facts were read");
    }
    return selectedSessionFactsResponseSchema.parse({
      sessionId,
      generation: current.generation,
      turnUsage,
      account,
    });
  });

  app.get("/api/v1/sessions/:id/search", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const id = routeSessionId(request);
    const session = resolveReadableSession(id);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    const query = transcriptSearchQuerySchema.parse(request.query);
    if (isRemoteSession(session)) {
      throw new ApiError(
        409,
        "TRANSCRIPT_SEARCH_UNAVAILABLE",
        "remote transcript search is not available",
      );
    }
    if (!transcriptReader?.search) {
      throw new ApiError(
        409,
        "TRANSCRIPT_SEARCH_UNAVAILABLE",
        "transcript search is not available for this session",
      );
    }
    return {
      sessionId: session.id,
      ...transcriptReader.search(session, query.q, query.limit),
    };
  });

  app.get("/api/v1/sessions/:id/plans/:itemId", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const sessionId = routeSessionId(request);
    const session = resolveReadableSession(sessionId);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    if (isRemoteSession(session)) {
      throw new ApiError(409, "PLAN_FILE_UNAVAILABLE", "remote plan-file reads are not available");
    }
    const itemId = (request.params as { itemId: string }).itemId;
    const item = activityHub.snapshot(sessionId)?.items.find((candidate) =>
      candidate.id === itemId && candidate.kind === "plan"
    );
    if (!item || item.kind !== "plan") {
      throw new ApiError(404, "PLAN_ITEM_NOT_FOUND", "registered plan item was not found");
    }
    if (item.path === null) {
      throw new ApiError(
        409,
        "PLAN_FILE_UNAVAILABLE",
        "the provider did not supply a path for this plan",
        { reason: "no-path" },
      );
    }
    const result = planFileReader.read(item.path);
    if (result.state === "unavailable") {
      throw new ApiError(
        409,
        "PLAN_FILE_UNAVAILABLE",
        "the registered plan file cannot be read safely",
        { reason: result.reason },
      );
    }
    return {
      sessionId,
      itemId: item.id,
      path: item.path,
      markdown: result.markdown,
      truncated: result.truncated,
    };
  });

  app.get("/api/v1/setup/harnesses", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async () => setupHarnessProbeResponseSchema.parse({
    harnesses: await (options.setupHarnessProbe ?? probeLocalHarnesses)(),
  }));

  app.get("/api/v1/setup", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request) => {
    requireSession(request);
    syncRemoteHostDefinitions();
    try {
      persistDiscoveredWorkspaces(database, state.list());
    } catch {
      // The read model can still return already-known folders.
    }
    const [hooks, hosts] = await Promise.all([
      setupHooks.offers(),
      probeSetupHosts({
        hosts: database.listHosts(),
        remoteStates: remoteHosts.states(),
        localProbe: options.setupHarnessProbe ?? probeLocalHarnesses,
        remoteProbe: options.setupRemoteHarnessProbe ?? ((hostId) => remoteHosts.probeHarnesses(hostId)),
      }),
    ]);
    return setupReadModelSchema.parse({
      nearby: setupNearbyWorkspaces(database, state.list()),
      hooks,
      hosts,
    });
  });

  app.get("/api/v1/hosts", async () => {
    syncRemoteHostDefinitions();
    const remoteStates = new Map(remoteHosts.states().map((host) => [host.id, host]));
    return {
      hosts: database.listHosts().map((host) => {
        const remote = remoteStates.get(host.id);
        return {
          id: host.id,
          label: host.label,
          kind: host.kind,
          ...(host.sshTarget ? { sshTarget: host.sshTarget } : {}),
          status: host.kind === "local" ? "online" : remote?.status ?? "unknown",
          ...(remote?.statusMessage ? { statusMessage: remote.statusMessage } : {}),
        };
      }),
    };
  });

  app.get("/api/v1/hosts/:id/directories", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    syncRemoteHostDefinitions();
    const hostId = (request.params as { id?: string }).id ?? "";
    const host = database.getHost(hostId);
    if (!host) throw new ApiError(404, "HOST_NOT_FOUND", "host is not configured");
    const query = directoryCompletionQuerySchema.parse(request.query);
    const paths = host.kind === "local"
      ? localDirectoryCompletions(query.path, query.limit)
      : await remoteHosts.completePath(host.id, query.path, query.limit);
    return { hostId, paths };
  });

  /*
    The composer's `@mention` needs the names of files in the session's own
    worktree. Nothing here reads a file's contents, the paths returned are
    workspace-relative, and the walk is bounded and does not follow symlinks —
    a link out of the worktree would otherwise turn this into a directory
    listing of the whole machine.
  */
  app.get("/api/v1/sessions/:id/files", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    requireSession(request);
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    if (isRemoteSession(session)) {
      throw new ApiError(409, "FILE_SEARCH_UNAVAILABLE", "remote workspace file search is not available");
    }
    const root = session.workspaceIdentity?.worktreePath ?? session.cwd;
    if (!root) throw new ApiError(409, "FILE_SEARCH_UNAVAILABLE", "this session has no resolved workspace");
    const query = workspaceFileQuerySchema.parse(request.query);
    return workspaceFileResponseSchema.parse({
      sessionId: session.id,
      paths: workspaceFileCompletions(root, query.q ?? "", query.limit),
    });
  });

  app.get("/api/v1/workspaces", async () => workspaceListResponseSchema.parse({
    workspaces: database.listWorkspaces(),
  }));

  app.post("/api/v1/workspaces/resolve", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request) => {
    syncRemoteHostDefinitions();
    const input = resolveWorkspaceSchema.parse(request.body);
    const host = database.getHost(input.hostId);
    if (!host) throw new ApiError(404, "HOST_NOT_FOUND", "host is not configured");
    try {
      const resolved = await resolveWorkspaceForHost({
        hostId: host.id,
        hostKind: host.kind,
        path: input.path,
        localResolver: workspaceIdentityResolver,
        remote: remoteHosts,
      });
      const workspace = database.addWorkspace({
        hostId: host.id,
        label: resolved.label,
        path: resolved.path,
        remoteWorkspaceId: resolved.remoteWorkspaceId,
      });
      return workspaceResolutionResponse(workspace, resolved.workspaceIdentity);
    } catch (error) {
      if (error instanceof RemoteNodeError) throw error;
      throw new ApiError(400, "WORKSPACE_INVALID", "workspace path is not an accessible directory");
    }
  });

  app.get("/api/v1/sessions/:id/preview", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request) => {
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    if (isRemoteSession(session)) {
      const limits = previewQuerySchema.parse(request.query);
      return remoteHosts.preview(
        session.id,
        `?lines=${String(limits.lines)}&bytes=${String(limits.bytes)}`,
      );
    }
    if (!session.terminal || !session.control.capabilities.includes("preview")) {
      throw new ApiError(409, "PREVIEW_UNAVAILABLE", "this session has no safe pane preview");
    }
    const limits = previewQuerySchema.parse(request.query);
    try {
      const capture = await previewAdapter.capture(session.terminal, {
        maxLines: limits.lines,
        maxBytes: limits.bytes,
      }, requestAbortSignal(request));
      return {
        sessionId: session.id,
        capturedAt: new Date().toISOString(),
        ...capture,
      };
    } catch (error) {
      if (error instanceof PanePreviewError) {
        throw new ApiError(502, error.code, "tmux pane preview is unavailable");
      }
      throw error;
    }
  });

  app.get("/api/v1/sessions/:id/attach", async (request) => {
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    if (isRemoteSession(session)) return remoteHosts.attach(session.id);
    let instruction: AttachInstruction | null = null;
    if (
      session.control.authority === "manager"
      && (
        session.control.capabilities.includes("attach")
        || session.control.capabilities.includes("resume")
      )
    ) {
      // The browser may only advertise the owner-socket wrapper. Returning a
      // raw provider command here would let a copied command bypass the
      // native handoff state machine and race the manager for ownership.
      instruction = {
        kind: "manager-cli",
        argv: ["agent-manager", "attach", session.id],
        cwd: session.cwd,
        warning: "Run this command locally to perform a guarded ownership handoff through Agent Manager.",
      };
    } else {
      if (session.terminal?.attachAvailable) {
        instruction = tmuxAttachInstruction(session.terminal, session.cwd);
      }
    }
    return { instruction };
  });

  app.get("/api/v1/events", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const authSession = requireSession(request);
    const { clientId = null } = eventsQuerySchema.parse(request.query);
    const channel = "global";
    if (clientId) {
      for (const client of [...sseClients.values()]) {
        if (
          client.authSessionId === authSession.id
          && client.clientId === clientId
          && client.channel === channel
        ) {
          client.close();
        }
      }
    }
    const actorStreams = [...sseClients.values()].filter((client) =>
      client.authSessionId === authSession.id
    ).length;
    if (sseClients.size >= maxSseClients || actorStreams >= maxSseClientsPerAuthSession) {
      throw new ApiError(429, "SSE_LIMIT_REACHED", "too many live event streams");
    }
    reply
      .header("Content-Type", "text/event-stream; charset=utf-8")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no");
    // A hijacked Fastify reply bypasses Fastify's normal header serialization.
    // Copy the accumulated route and security headers onto the raw response
    // before flushing, otherwise browsers see the stream as text/plain and
    // EventSource immediately enters its reconnect loop.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    reply.raw.flushHeaders();

    let closed = false;
    let unsubscribe = (): void => undefined;
    let heartbeat: NodeJS.Timeout | null = null;
    let expiry: NodeJS.Timeout | null = null;
    let writer: OrderedSseWriter | null = null;
    const close = (): void => {
      if (closed) return;
      closed = true;
      writer?.dispose();
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      unsubscribe();
      sseClients.delete(reply);
      scheduleClaudePermissionPresenceCheck();
      if (!reply.raw.destroyed) reply.raw.destroy();
    };
    writer = new OrderedSseWriter(reply.raw, { onFailure: close });
    const write = (chunk: string): boolean => {
      if (closed) return false;
      return writer?.writeEvent(chunk) ?? false;
    };
    sseClients.set(reply, {
      authSessionId: authSession.id,
      clientId,
      channel,
      sessionId: null,
      close,
    });

    const supplied = request.headers["last-event-id"];
    const value = Array.isArray(supplied) ? supplied[0] : supplied;
    const after = value === undefined ? null : Number.parseInt(value, 10);
    if (after === null || !Number.isSafeInteger(after) || after < 0) {
      write(encodeSse({
        schemaVersion: WIRE_SCHEMA_VERSION,
        buildId: AGENT_MANAGER_BUILD_ID,
        seq: state.events.sequence,
        type: "snapshot",
        at: new Date().toISOString(),
        payload: state.snapshot(),
      }));
    } else {
      const replay = state.events.replayAfter(after);
      if (replay.gap) {
        write(encodeSse({
          schemaVersion: WIRE_SCHEMA_VERSION,
          buildId: AGENT_MANAGER_BUILD_ID,
          seq: state.events.sequence,
          type: "snapshot",
          at: new Date().toISOString(),
          payload: state.snapshot(),
        }));
      } else {
        for (const event of replay.events) {
          if (!write(encodeSse(event))) break;
        }
      }
    }

    if (closed) return;
    unsubscribe = state.subscribe((event) => void write(encodeSse(event)));
    heartbeat = setInterval(() => void writer?.writeHeartbeat(), 15_000);
    heartbeat.unref();
    expiry = setTimeout(close, Math.max(1, authSession.expiresAt - Date.now()));
    expiry.unref();
    reply.raw.once("close", close);
    reply.raw.once("error", close);
  });

  app.get("/api/v1/sessions/:id/activity/events", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const id = routeSessionId(request);
    const session = resolveReadableSession(id);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    activityHub.ensureSession(id, session.provider);
    const authSession = requireSession(request);
    const { clientId = null } = eventsQuerySchema.parse(request.query);
    const channel = "activity";
    if (clientId) {
      for (const client of [...sseClients.values()]) {
        if (
          client.authSessionId === authSession.id
          && client.clientId === clientId
          && client.channel === channel
        ) {
          client.close();
        }
      }
    }
    const actorStreams = [...sseClients.values()].filter((client) =>
      client.authSessionId === authSession.id
    ).length;
    if (sseClients.size >= maxSseClients || actorStreams >= maxSseClientsPerAuthSession) {
      throw new ApiError(429, "SSE_LIMIT_REACHED", "too many live event streams");
    }
    const providerAdapter = adapters[session.provider];
    let releaseProviderSelection: () => void | Promise<void> = () => undefined;
    if (
      session.hostId === "local"
      && session.provider === "codex"
      && session.control.plane === "codex-private"
      && session.control.authority === "manager"
      && providerAdapter?.acquireSelectedSession
    ) {
      try {
        releaseProviderSelection = await providerAdapter.acquireSelectedSession(session, {
          actor: authSession.actor,
          requestId: request.id,
          signal: requestAbortSignal(request),
          workspace: null,
          managerSessionId: id,
        });
      } catch {
        throw new ApiError(
          503,
          "SESSION_DETAIL_UNAVAILABLE",
          "the selected Codex session could not be loaded safely",
        );
      }
    }
    const releaseTranscript = isRemoteSession(session)
      ? remoteHosts.acquireActivity(id, activityHub, session.provider)
      : shouldObserveTranscript(session)
        ? transcriptActivity.acquire(session)
        : () => undefined;

    reply
      .header("Content-Type", "text/event-stream; charset=utf-8")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no");
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    reply.raw.flushHeaders();

    let closed = false;
    let initialized = false;
    let unsubscribe = (): void => undefined;
    let heartbeat: NodeJS.Timeout | null = null;
    let expiry: NodeJS.Timeout | null = null;
    let writer: OrderedSseWriter | null = null;
    const pending: ActivityFrame[] = [];
    const close = (): void => {
      if (closed) return;
      closed = true;
      writer?.dispose();
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      unsubscribe();
      releaseTranscript();
      void Promise.resolve(releaseProviderSelection()).catch(() => undefined);
      sseClients.delete(reply);
      scheduleClaudePermissionPresenceCheck();
      if (!reply.raw.destroyed) reply.raw.destroy();
    };
    writer = new OrderedSseWriter(reply.raw, { onFailure: close });
    const write = (frame: ActivityFrame): boolean => {
      if (closed) return false;
      return writer?.writeEvent(encodeActivitySse(frame)) ?? false;
    };
    sseClients.set(reply, {
      authSessionId: authSession.id,
      clientId,
      channel,
      sessionId: id,
      close,
    });

    // Subscribe before reading the snapshot/replay high-water. Frames that
    // arrive during initialization are buffered, then de-duplicated by the
    // hub's monotonic sequence after the atomic replay result is written.
    unsubscribe = activityHub.subscribe(id, (frame) => {
      if (!initialized) {
        pending.push(frame);
        return;
      }
      void write(frame);
    });

    const supplied = request.headers["last-event-id"];
    const requestedCursor = Array.isArray(supplied) ? supplied[0] : supplied;
    const replay = activityHub.replay(id, requestedCursor ?? null);
    let highWater = -1;
    for (const frame of replay.frames) {
      highWater = Math.max(highWater, frame.seq);
      if (!write(frame)) break;
    }
    initialized = true;
    for (const frame of pending.splice(0)) {
      if (frame.seq <= highWater) continue;
      highWater = frame.seq;
      if (!write(frame)) break;
    }

    if (closed) return;
    heartbeat = setInterval(() => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return close();
      writer?.writeHeartbeat();
    }, 15_000);
    heartbeat.unref();
    expiry = setTimeout(close, Math.max(1, authSession.expiresAt - Date.now()));
    expiry.unref();
    reply.raw.once("close", close);
    reply.raw.once("error", close);
  });

  app.post("/api/v1/sessions", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const input = createSessionSchema.parse(request.body);
    const workspace = database.getWorkspace(input.workspaceId);
    if (!workspace) throw new ApiError(400, "WORKSPACE_UNKNOWN", "workspace is not configured");
    const adapter = workspace.hostKind === "local"
      ? providerAdapter(adapters, input.provider)
      : null;
    const authSession = requireSession(request);
    const begun = database.beginCreateSessionIntent({
      actorId: authSession.actor.id,
      request: input,
    });
    if (begun.intent.requestSha256 !== createSessionFingerprint(input)) {
      throw new IdempotencyConflictError();
    }
    if (!begun.created) {
      if (begun.intent.status === "succeeded" && begun.intent.managedSessionId) {
        const existing = state.get(begun.intent.managedSessionId);
        if (!existing) {
          throw new ApiError(
            409,
            "CREATE_RESULT_UNAVAILABLE",
            "the session was created previously but its live state is unavailable",
          );
        }
        return { session: existing };
      }
      if (begun.intent.status === "unknown") {
        throw new ApiError(
          409,
          "CREATE_OUTCOME_UNKNOWN",
          "the previous create outcome is unknown and will not be replayed",
        );
      }
      throw new ApiError(409, "CREATE_IN_PROGRESS", "session creation is already in progress");
    }
    try {
      database.auditOperation({
        actor: authSession.actor,
        operation: "session.create",
        targetId: begun.intent.managerRequestId,
        phase: "attempt",
        outcome: "dispatching",
        idempotencyKey: input.idempotencyKey,
        details: {
          provider: input.provider,
          workspaceId: input.workspaceId,
          hostId: workspace.hostId,
          profile: input.profile,
          model: input.model,
          effort: input.effort,
        },
      });
      database.markCreateSessionDispatching(authSession.actor.id, input.idempotencyKey);
    } catch {
      database.markCreateSessionUnknown(authSession.actor.id, input.idempotencyKey);
      throw new ApiError(500, "CREATE_INTENT_FAILED", "session creation could not be recorded safely");
    }

    let created: SessionView;
    try {
      created = workspace.hostKind === "ssh"
        ? await remoteHosts.createSession(workspace.hostId, input, workspace)
        : await adapter!.createSession(
            input,
            context(request, workspace, begun.intent.managerRequestId),
          );
    } catch {
      database.markCreateSessionUnknown(authSession.actor.id, input.idempotencyKey);
      try {
        database.auditOperation({
          actor: authSession.actor,
          operation: "session.create",
          targetId: begun.intent.managerRequestId,
          phase: "outcome",
          outcome: "unknown",
          idempotencyKey: input.idempotencyKey,
          details: { provider: input.provider },
        });
      } catch {
        state.addDiagnostic({
          provider: "system",
          level: "error",
          message: "A failed session creation could not append its outcome audit",
        });
      }
      throw new ApiError(
        502,
        "CREATE_OUTCOME_UNKNOWN",
        "the provider creation outcome is unknown and will not be replayed",
      );
    }
    if (created.provider !== input.provider || created.control.authority !== "manager") {
      database.markCreateSessionUnknown(authSession.actor.id, input.idempotencyKey);
      try {
        database.auditOperation({
          actor: authSession.actor,
          operation: "session.create",
          targetId: begun.intent.managerRequestId,
          phase: "outcome",
          outcome: "provider-contract-invalid",
          idempotencyKey: input.idempotencyKey,
          details: { provider: input.provider },
        });
      } catch {
        // The durable attempt remains available even if this append fails.
      }
      throw new ApiError(502, "PROVIDER_CONTRACT_ERROR", "provider returned an invalid managed session");
    }
    const now = new Date().toISOString();
    try {
      database.completeCreateSessionIntent({
        actorId: authSession.actor.id,
        idempotencyKey: input.idempotencyKey,
        session: {
          id: created.id,
          provider: created.provider,
          providerSessionId: created.providerThreadId,
          workspaceId: workspace.id,
          metadata: {
            managerRequestId: begun.intent.managerRequestId,
            name: input.name ?? null,
            profile: input.profile,
            model: input.model,
            effort: input.effort,
            hostId: workspace.hostId,
          },
          createdAt: created.startedAt ?? now,
          updatedAt: now,
        },
      });
    } catch {
      database.markCreateSessionUnknown(authSession.actor.id, input.idempotencyKey);
      try {
        database.auditOperation({
          actor: authSession.actor,
          operation: "session.create",
          targetId: begun.intent.managerRequestId,
          phase: "outcome",
          outcome: "commit-unknown",
          idempotencyKey: input.idempotencyKey,
          details: { provider: input.provider },
        });
      } catch {
        // The durable pre-dispatch attempt is still retained.
      }
      throw new ApiError(
        500,
        "CREATE_COMMIT_UNKNOWN",
        "the session may exist but its durable creation receipt could not be committed",
      );
    }
    const stored = state.upsert(withLocalEditorCapability(created, editorLauncher !== null));
    try {
      database.auditOperation({
        actor: authSession.actor,
        operation: "session.create",
        targetId: stored.id,
        phase: "outcome",
        outcome: "succeeded",
        idempotencyKey: input.idempotencyKey,
        details: { provider: stored.provider },
      });
    } catch {
      state.addDiagnostic({
        provider: "system",
        level: "error",
        message: `Session ${stored.id} was created but its outcome audit could not be persisted`,
      });
    }
    void reply.status(201);
    return { session: stored };
  });

  app.post("/api/v1/sessions/:id/control-lease", async (request) => {
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    if (!session.control.capabilities.some((capability) =>
      [
        "queue",
        "steer",
        "interrupt",
        "respond",
        "set-profile",
        "set-model",
        "set-effort",
        "remove-queued",
        "end",
        "archive",
        "delete",
        "take-control",
        "cancel-take-control",
        "open-editor",
      ].includes(capability)
    )) {
      throw new ApiError(409, "CONTROL_UNAVAILABLE", "session has no writable semantic controls");
    }
    const body = leaseRequestSchema.parse(request.body);
    const authSession = requireSession(request);
    const renewal = leases.has(session.id);
    const operation = body.takeover
      ? "lease.takeover"
      : renewal
      ? "lease.renew"
      : "lease.acquire";
    try {
      database.auditOperation({
        actor: authSession.actor,
        operation,
        targetId: session.id,
        phase: "attempt",
        outcome: "requested",
        details: {
          renewal,
          takeover: body.takeover,
          ttlSeconds: body.ttlSeconds ?? 60,
        },
      });
    } catch {
      throw new ApiError(500, "LEASE_AUDIT_FAILED", "lease operation could not be recorded safely");
    }
    const lease = leases.acquire(
      session.id,
      body.clientId,
      principal(authSession),
      request.headers["x-control-lease"],
      body.ttlSeconds === undefined ? undefined : body.ttlSeconds * 1_000,
      body.takeover,
    );
    if (isRemoteSession(session)) {
      try {
        await remoteHosts.acquireControl(session.id, body.takeover);
      } catch (error) {
        leases.forceRelease(session.id);
        throw error;
      }
    }
    try {
      database.auditOperation({
        actor: authSession.actor,
        operation,
        targetId: session.id,
        phase: "outcome",
        outcome: "succeeded",
        details: { renewal, takeover: body.takeover },
      });
    } catch {
      leases.forceRelease(session.id);
      throw new ApiError(500, "LEASE_AUDIT_FAILED", "lease outcome could not be recorded safely");
    }
    return { lease };
  });

  app.delete("/api/v1/sessions/:id/control-lease", async (request, reply) => {
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    const authSession = requireSession(request);
    try {
      database.auditOperation({
        actor: authSession.actor,
        operation: "lease.release",
        targetId: session.id,
        phase: "attempt",
        outcome: "requested",
      });
    } catch {
      throw new ApiError(500, "LEASE_AUDIT_FAILED", "lease release could not be recorded safely");
    }
    if (!leases.release(
      session.id,
      request.headers["x-control-lease"],
      principal(authSession),
    )) {
      try {
        database.auditOperation({
          actor: authSession.actor,
          operation: "lease.release",
          targetId: session.id,
          phase: "outcome",
          outcome: "rejected",
        });
      } catch {
        // The durable attempt remains available.
      }
      throw new ApiError(409, "LEASE_INVALID", "writable control lease is missing or invalid");
    }
    try {
      database.auditOperation({
        actor: authSession.actor,
        operation: "lease.release",
        targetId: session.id,
        phase: "outcome",
        outcome: "succeeded",
      });
    } catch {
      state.addDiagnostic({
        provider: "system",
        level: "error",
        message: `Lease release for ${session.id} completed without an outcome audit`,
      });
    }
    void reply.status(204).send();
  });

  app.post("/api/v1/sessions/:id/actions", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const id = routeSessionId(request);
    const action = sessionActionSchema.parse(request.body);
    const authSession = requireSession(request);
    const durableReceipt = database.getActionReceipt(id, action.idempotencyKey);
    if (durableReceipt) {
      if (durableReceipt.requestSha256 !== actionFingerprint(action)) {
        throw new IdempotencyConflictError();
      }
      return {
        action: actionRecord(
          durableReceipt.actionId,
          durableReceipt.sessionId,
          action,
          durableReceipt.status,
          durableReceipt.createdAt,
          { completedAt: durableReceipt.completedAt },
        ),
      };
    }
    const persisted = database.getPersistedAction(id, action.idempotencyKey);
    if (persisted) {
      if (actionFingerprint(persisted.action) !== actionFingerprint(action)) {
        throw new IdempotencyConflictError();
      }
      if (persisted.status === "queued") {
        return {
          action: actionRecord(
            persisted.id,
            persisted.sessionId,
            action,
            "queued",
            persisted.createdAt,
          ),
        };
      }
      throw new ApiError(
        409,
        persisted.status === "unknown" ? "ACTION_OUTCOME_UNKNOWN" : "ACTION_IN_PROGRESS",
        persisted.status === "unknown"
          ? "the previous action outcome is unknown and will not be replayed"
          : "the action is already durably reserved or dispatching",
      );
    }
    const persistedStatus = database.getPersistedActionStatus(id, action.idempotencyKey);
    if (persistedStatus) {
      throw new ApiError(
        409,
        "ACTION_OUTCOME_UNKNOWN",
        "the previous action outcome is unknown and will not be replayed",
      );
    }
    return {
      action: await idempotency.run(id, action, async () => {
        const session = state.get(id);
        if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
        if (session.generation !== action.expectedGeneration) {
          throw new ApiError(409, "STALE_GENERATION", "session state changed; refresh before retrying", {
            expected: action.expectedGeneration,
            actual: session.generation,
          });
        }
        const capability = requiredCapability(action);
        if (!session.control.capabilities.includes(capability)) {
          throw new ApiError(409, "CAPABILITY_UNAVAILABLE", `${capability} is unavailable for this session`);
        }
        if (nativeHandoffs.has(id)) {
          throw new ApiError(409, "NATIVE_CONTROLLER_ACTIVE", "a native provider client owns this session");
        }
        if (!leases.verify(id, request.headers["x-control-lease"], principal(authSession))) {
          throw new ApiError(409, "LEASE_INVALID", "writable control lease is missing or invalid");
        }
        if (
          action.type === "respond"
          && !session.attention.some((attention) => attention.id === action.requestId)
        ) {
          throw new ApiError(409, "REQUEST_STALE", "pending request is no longer active");
        }
        if (isRemoteSession(session)) {
          // Validate the remote node's auth-bound lease before persisting the
          // local action intent. An SSH reconnect can replace the bridge auth
          // session; a conflict here is safe to retry after explicit takeover.
          await remoteHosts.acquireControl(session.id, false, true);
        }

        const dispatchAction = async () => {
          if (
            action.type === "respond"
            && session.control.plane === "claude-hook-bridge"
          ) {
            try {
              return claudeHookBridge.respondWithEnvelope(
                action.requestId,
                action.response.kind === "decision"
                  ? {
                      kind: "decision",
                      decision: action.response.decision,
                      ...(action.response.reason === undefined
                        ? {}
                        : { reason: action.response.reason }),
                      ...(action.response.persist === undefined
                        ? {}
                        : { persist: action.response.persist }),
                    }
                  : action.response,
              )
                ? { status: "succeeded" as const }
                : {
                    status: "failed" as const,
                    error: {
                      code: "REQUEST_STALE",
                      message: "the Claude hook request is no longer active",
                    },
                  };
            } catch {
              return {
                status: "failed" as const,
                error: {
                  code: "CLAUDE_HOOK_RESPONSE_INVALID",
                  message: "the response does not match the exact Claude request",
                },
              };
            }
          }
          if (action.type === "open-editor" && editorLauncher) {
            await editorLauncher.open(session, action);
            return { status: "succeeded" as const };
          }
          if (action.type === "take-control") {
            try {
              return {
                status: "succeeded" as const,
                result: await cliTakeover.begin(session, action.method),
              };
            } catch (error) {
              return {
                status: "failed" as const,
                error: {
                  code: "TAKEOVER_REJECTED",
                  message: error instanceof Error ? error.message : String(error),
                },
              };
            }
          }
          if (action.type === "cancel-take-control") {
            try {
              cliTakeover.cancel(session.id, action.takeoverId);
              return { status: "succeeded" as const };
            } catch (error) {
              return {
                status: "failed" as const,
                error: {
                  code: "TAKEOVER_CANCEL_REJECTED",
                  message: error instanceof Error ? error.message : String(error),
                },
              };
            }
          }
          if (isRemoteSession(session)) {
            return remoteHosts.performAction(session.id, action);
          }
          return providerAdapter(adapters, session.provider).performAction(
            session,
            action,
            context(request),
          );
        };
        const actionId = randomUUID();
        const createdAt = new Date().toISOString();
        let record = actionRecord(actionId, id, action, "pending", createdAt);
        if (action.type === "respond") {
          // Every provider response is deliberately dispatched from memory
          // only. Secret classification is presentation metadata and can be
          // missing, stale, or evicted; it must never decide whether an answer
          // or denial reason is written to the durable outbox. A restart leaves
          // an unacknowledged outcome unknown and the provider must advertise
          // the still-pending request again before another response.
          try {
            database.auditOperation({
              actor: authSession.actor,
              operation: "session.respond.ephemeral",
              targetId: action.requestId,
              phase: "attempt",
              outcome: "ephemeral-dispatching",
              idempotencyKey: action.idempotencyKey,
              details: { provider: session.provider },
            });
          } catch {
            throw new ApiError(
              500,
              "RESPONSE_AUDIT_FAILED",
              "the provider response could not be dispatched safely",
            );
          }
          state.publishAction(record);
          record = actionRecord(actionId, id, action, "dispatching", createdAt);
          state.publishAction(record);

          let acknowledged = false;
          try {
            const result = await dispatchAction();
            acknowledged = result.status !== "unknown";
            record = actionRecord(actionId, id, action, result.status, createdAt, {
              ...(result.status === "queued" ? {} : { completedAt: new Date().toISOString() }),
              ...(result.status === "failed"
                ? {
                    error: result.error ?? {
                      code: "PROVIDER_REJECTED",
                      message: "the provider rejected the requested action",
                    },
                  }
                : result.status === "unknown"
                ? {
                    error: {
                      code: "PROVIDER_OUTCOME_UNKNOWN",
                      message: "provider acknowledgement was not received; this response was not persisted",
                    },
                  }
                : {}),
            });
          } catch {
            record = actionRecord(actionId, id, action, "unknown", createdAt, {
              completedAt: new Date().toISOString(),
              error: {
                code: "PROVIDER_OUTCOME_UNKNOWN",
                message: "provider acknowledgement was not received; this response was not persisted",
              },
            });
          }
          try {
            database.auditOperation({
              actor: authSession.actor,
              operation: "session.respond.ephemeral",
              targetId: action.requestId,
              phase: "outcome",
              outcome: record.status,
              idempotencyKey: action.idempotencyKey,
              details: { provider: session.provider, acknowledged },
            });
          } catch {
            acknowledged = false;
            record = actionRecord(actionId, id, action, "unknown", createdAt, {
              completedAt: record.completedAt ?? new Date().toISOString(),
              error: {
                code: "AUDIT_PERSISTENCE_FAILED",
                message: "the provider may have acted, but the content-free audit outcome was not persisted",
              },
            });
          }
          state.publishAction(record);
          return record;
        }
        try {
          database.persistActionWithAudit({
            id: actionId,
            sessionId: id,
            actionType: action.type,
            action,
            idempotencyKey: action.idempotencyKey,
            status: "pending",
            createdAt,
            updatedAt: createdAt,
          }, {
            actor: authSession.actor,
            actionId,
            sessionId: id,
            generation: action.expectedGeneration,
            action,
            requestOrRunId: action.expectedProviderTurnId ?? null,
            outcome: "dispatch-attempt",
            providerAcknowledged: false,
            precondition: `generation=${action.expectedGeneration};capability=${capability}`,
            at: createdAt,
          });
          database.markActionDispatching(actionId);
        } catch {
          try {
            database.markActionUnknown(actionId);
            database.recordActionReceipt({
              sessionId: id,
              idempotencyKey: action.idempotencyKey,
              requestSha256: actionFingerprint(action),
              actionId,
              actionType: action.type,
              status: "unknown",
              createdAt,
              completedAt: new Date().toISOString(),
            });
          } catch {
            // A retained unique outbox row still prevents unsafe redispatch.
          }
          throw new ApiError(
            500,
            "ACTION_INTENT_FAILED",
            "the action could not be reserved and audited safely",
          );
        }
        state.publishAction(record);
        record = actionRecord(actionId, id, action, "dispatching", createdAt);
        state.publishAction(record);

        let acknowledged = false;
        try {
          const result = await dispatchAction();
          acknowledged = result.status !== "unknown";
          record = actionRecord(actionId, id, action, result.status, createdAt, {
            ...(result.status === "queued" ? {} : { completedAt: new Date().toISOString() }),
            ...(result.status === "failed"
              ? {
                  error: result.error ?? {
                    code: "PROVIDER_REJECTED",
                    message: "the provider rejected the requested action",
                  },
                }
              : result.status === "unknown"
              ? {
                  error: {
                    code: "PROVIDER_OUTCOME_UNKNOWN",
                    message: "provider acknowledgement was not received; this action will not be replayed automatically",
                  },
                }
              : {}),
          });
        } catch {
          const completedAt = new Date().toISOString();
          record = actionRecord(actionId, id, action, "unknown", createdAt, {
            completedAt,
            error: {
              code: "PROVIDER_OUTCOME_UNKNOWN",
              message: "provider acknowledgement was not received; this action will not be replayed automatically",
            },
          });
        }

        let auditPersisted = true;
        try {
          database.audit({
            actor: authSession.actor,
            actionId,
            sessionId: id,
            generation: action.expectedGeneration,
            action,
            requestOrRunId: action.expectedProviderTurnId ?? null,
            outcome: record.status,
            providerAcknowledged: acknowledged,
            precondition: `generation=${action.expectedGeneration};capability=${capability}`,
          });
        } catch {
          auditPersisted = false;
          acknowledged = false;
          request.log.error("action audit persistence failed");
          record = actionRecord(actionId, id, action, "unknown", createdAt, {
            completedAt: record.completedAt ?? new Date().toISOString(),
            error: {
              code: "AUDIT_PERSISTENCE_FAILED",
              message: "the provider may have acted, but the audit receipt could not be persisted",
            },
          });
        }
        if (record.status === "queued" && auditPersisted) {
          try {
            database.markActionQueued(actionId);
            state.publishAction(record);
            return record;
          } catch {
            acknowledged = false;
            record = actionRecord(actionId, id, action, "unknown", createdAt, {
              completedAt: new Date().toISOString(),
              error: {
                code: "QUEUE_PERSISTENCE_FAILED",
                message: "the provider accepted queued work, but its durable state could not be recorded",
              },
            });
          }
        }
        try {
          database.recordActionReceipt({
            sessionId: id,
            idempotencyKey: action.idempotencyKey,
            requestSha256: actionFingerprint(action),
            actionId,
            actionType: action.type,
            status: record.status === "pending" || record.status === "dispatching" || record.status === "queued"
              ? "unknown"
              : record.status,
            createdAt,
            completedAt: record.completedAt ?? new Date().toISOString(),
          });
        } catch {
          acknowledged = false;
          record = actionRecord(actionId, id, action, "unknown", createdAt, {
            completedAt: record.completedAt ?? new Date().toISOString(),
            error: {
              code: "IDEMPOTENCY_RECEIPT_FAILED",
              message: "the provider may have acted, but the durable idempotency receipt could not be persisted",
            },
          });
        }
        if (acknowledged && auditPersisted && record.status !== "unknown") {
          database.acknowledgeAction(actionId);
        } else {
          database.markActionUnknown(actionId, record.completedAt ?? undefined);
        }
        state.publishAction(record);
        return record;
      }),
    };
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (
      servesUi
      && request.method === "GET"
      && !request.url.startsWith("/api/")
      && request.headers.accept?.includes("text/html")
    ) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    return reply.status(404).send(errorBody("NOT_FOUND", "route was not found"));
  });

  const cleanupResources = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors: unknown[] = [];
      claudeHookBridge.shutdown();
      cliTakeover.dispose();
      for (const timer of codexHookExpiryTimers.values()) clearTimeout(timer);
      codexHookExpiryTimers.clear();
      for (const handoff of nativeHandoffs.values()) {
        clearTimeout(handoff.timer);
        if (handoff.wrapperMonitor) clearInterval(handoff.wrapperMonitor);
        if (handoff.childMonitor) clearInterval(handoff.childMonitor);
      }
      nativeHandoffs.clear();
      try {
        database.markInterruptedDispatchesUnknown();
        database.recoverCreateSessionIntents();
      } catch (error) {
        errors.push(error);
      }

      const tasks: Promise<unknown>[] = [];
      if (discovery) {
        const activeDiscovery = discovery;
        discovery = null;
        tasks.push(bounded(activeDiscovery.stop(), shutdownTimeoutMs, "discovery shutdown"));
      }
      if (controlSocket) {
        const socket = controlSocket;
        controlSocket = null;
        tasks.push(Promise.resolve().then(() => {
          try {
            socket.close();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
          }
        }));
      }
      const uniqueAdapters = new Set(
        Object.values(adapters).filter((adapter) => adapter !== undefined),
      );
      for (const adapter of uniqueAdapters) {
        if (adapter.dispose) {
          tasks.push(bounded(Promise.resolve(adapter.dispose()), shutdownTimeoutMs, "provider shutdown"));
        }
      }
      transcriptActivity.dispose();
      releaseTodoProgress();
      remoteHosts.dispose();
      if (options.onShutdown) {
        tasks.push(bounded(Promise.resolve(options.onShutdown()), shutdownTimeoutMs, "runtime shutdown"));
      }
      try {
        const results = await Promise.allSettled(tasks);
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason);
        }
      } finally {
        try {
          activityHub.dispose();
        } catch (error) {
          errors.push(error);
        }
        if (!databaseClosed) {
          databaseClosed = true;
          try {
            database.close();
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "Agent Manager cleanup was incomplete");
    })();
    return cleanupPromise;
  };

  app.addHook("preClose", async () => {
    // Release held PermissionRequest POSTs before Fastify waits for routes to drain.
    claudeHookBridge.shutdown();
    // Hijacked SSE replies are not completed by Fastify's ordinary request
    // lifecycle. Close them explicitly so an open browser cannot hold service
    // replacement past the bounded shutdown window.
    for (const client of [...sseClients.values()]) client.close();
  });

  app.addHook("onClose", async () => {
    await cleanupResources();
  });

  const handoffDiagnostic = (sessionId: string, message: string): void => {
    state.addDiagnostic({
      provider: "system",
      level: "error",
      message: `Native handoff for ${sessionId}: ${message}`,
    });
  };

  const requireNativeHandoff = (sessionId: string, handoffId: string) => {
    const handoff = nativeHandoffs.get(sessionId);
    if (!handoff || handoff.handoffId !== handoffId) {
      throw new Error("native handoff is stale");
    }
    return handoff;
  };

  const auditHandoff = (
    sessionId: string,
    phase: "attempt" | "outcome" | "lifecycle",
    outcome: string,
    details: Record<string, string | number | boolean | null> = {},
  ): void => {
    database.auditOperation({
      actor: localOwnerActor,
      operation: "native.handoff",
      targetId: sessionId,
      phase,
      outcome,
      details,
    });
  };

  type NativeTerminalTransition = "exited" | "failed" | "timeout" | "pid-exit";
  const clearNativeHandoffMonitors = (handoff: NativeHandoff): void => {
    clearTimeout(handoff.timer);
    if (handoff.wrapperMonitor) {
      clearInterval(handoff.wrapperMonitor);
      handoff.wrapperMonitor = null;
    }
    if (handoff.childMonitor) {
      clearInterval(handoff.childMonitor);
      handoff.childMonitor = null;
    }
  };

  const completeNativeReclaim = (
    sessionId: string,
    handoff: NativeHandoff,
    view: SessionView | null,
  ): void => {
    if (handoff.reclaimCompleted) return;
    handoff.reclaimCompleted = true;
    handoff.reclaimedView = view;
    if (view) state.upsert(withLocalEditorCapability(view, editorLauncher !== null));
    try {
      auditHandoff(sessionId, "outcome", "reclaimed", { provider: handoff.provider });
    } catch {
      handoffDiagnostic(sessionId, "reclaim succeeded but its outcome audit could not be appended");
    }
    clearNativeHandoffMonitors(handoff);
    if (nativeHandoffs.get(sessionId) === handoff) nativeHandoffs.delete(sessionId);
  };

  const finishNativeHandoff = (
    sessionId: string,
    handoffId: string,
    transition: NativeTerminalTransition,
    exitCode: number | null = null,
  ): Promise<void> => {
    const handoff = requireNativeHandoff(sessionId, handoffId);
    if (handoff.status === "reclaiming" && handoff.reclaimPromise) {
      return handoff.reclaimPromise;
    }
    clearNativeHandoffMonitors(handoff);
    if (!handoff.terminalKind) {
      handoff.terminalKind = handoff.providerAttached
        || transition === "exited"
        || transition === "pid-exit"
        ? "exit"
        : "failure";
      handoff.exitCode = exitCode;
    }
    handoff.status = "reclaiming";
    const reclaim = (async () => {
      const adapter = adapters[handoff.provider];
      try {
        if (!handoff.providerReclaimPromise) {
          try {
            auditHandoff(sessionId, "lifecycle", "reclaim-attempt", {
              transition,
              provider: handoff.provider,
            });
          } catch {
            handoffDiagnostic(sessionId, "reclaim is proceeding after its lifecycle audit failed");
          }
        }
        if (!handoff.providerNotified) {
          // Provider lifecycle transitions may not be idempotent. Record the
          // single attempt before invoking it and never replay it after an
          // ambiguous throw.
          handoff.providerNotified = true;
          try {
            if (handoff.terminalKind === "exit") {
              adapter?.markCliExited?.(
                handoff.providerSessionId,
                handoff.handoffId,
                handoff.exitCode,
              );
            } else {
              adapter?.markCliAttachFailed?.(
                handoff.providerSessionId,
                handoff.handoffId,
                "native attach did not complete",
              );
            }
          } catch {
            handoffDiagnostic(sessionId, "provider lifecycle notification failed; reclaim will still be attempted");
          }
        }
        if (!handoff.providerReclaimPromise) {
          const providerReclaim = adapter?.reclaimFromCli
            ? Promise.resolve().then(() =>
                adapter.reclaimFromCli!(handoff.providerSessionId, handoff.handoffId)
              )
            : Promise.resolve(null);
          handoff.providerReclaimPromise = providerReclaim;
          void providerReclaim.then(
            (view) => completeNativeReclaim(sessionId, handoff, view),
            () => {
              if (nativeHandoffs.get(sessionId) !== handoff) return;
              handoff.status = "degraded";
              handoffDiagnostic(
                sessionId,
                "provider reclaim failed; cockpit writes remain disabled without replaying the transition",
              );
            },
          );
        }
        const sharedReclaim = handoff.providerReclaimPromise;
        if (!sharedReclaim) throw new Error("native handoff reclaim did not initialize");
        const reclaimedView = await bounded(
          sharedReclaim,
          shutdownTimeoutMs,
          "native handoff reclaim",
        );
        completeNativeReclaim(sessionId, handoff, reclaimedView);
      } catch {
        if (nativeHandoffs.get(sessionId) === handoff && !handoff.reclaimCompleted) {
          handoff.status = "degraded";
          handoffDiagnostic(
            sessionId,
            "reclaim is unresolved; cockpit writes remain disabled while the original transition is observed",
          );
          try {
            auditHandoff(sessionId, "outcome", "reclaim-degraded", {
              provider: handoff.provider,
            });
          } catch {
            // The durable preparation attempt remains available.
          }
        }
        throw new Error("native handoff reclaim failed");
      } finally {
        handoff.reclaimPromise = null;
      }
    })();
    handoff.reclaimPromise = reclaim;
    return reclaim;
  };

  const nativeAttach = async (sessionId: string): Promise<AttachInstruction> => {
    const session = state.get(sessionId);
    if (!session) throw new Error("session not found");
    if (
      !session.control.capabilities.includes("attach")
      && !session.control.capabilities.includes("resume")
    ) {
      throw new Error("session does not advertise native attach or resume");
    }
    if (nativeHandoffs.has(sessionId)) throw new Error("native handoff is already active");
    const adapter = adapters[session.provider];
    const reservationId = randomUUID();
    const spawnNonce = randomUUID();
    const timer = setTimeout(() => {
      const pending = nativeHandoffs.get(sessionId);
      if (!pending || pending.handoffId !== reservationId || pending.status !== "preparing") return;
      void finishNativeHandoff(sessionId, reservationId, "timeout").catch(() => undefined);
    }, 30_000);
    timer.unref();
    const handoff: NativeHandoff = {
      handoffId: reservationId,
      spawnNonce,
      provider: session.provider,
      providerSessionId: session.providerThreadId,
      timer,
      status: "preparing",
      providerNotified: false,
      providerAttached: false,
      pid: null,
      wrapperPid: null,
      wrapperMonitor: null,
      childMonitor: null,
      reclaimPromise: null,
      providerReclaimPromise: null,
      terminalKind: null,
      exitCode: null,
      reclaimCompleted: false,
      reclaimedView: null,
    };
    nativeHandoffs.set(sessionId, handoff);
    try {
      auditHandoff(sessionId, "attempt", "prepare", { provider: session.provider });
    } catch {
      clearTimeout(timer);
      nativeHandoffs.delete(sessionId);
      throw new Error("native handoff audit failed");
    }

    let instruction: AttachInstruction | null = null;
    try {
      if (adapter?.getAttachInstruction) {
        instruction = await adapter.getAttachInstruction(session, {
          actor: localOwnerActor,
          requestId: randomUUID(),
          signal: new AbortController().signal,
          workspace: null,
        });
      } else if (session.terminal?.attachAvailable) {
        instruction = tmuxAttachInstruction(session.terminal, session.cwd);
      }
    } catch {
      handoff.status = "degraded";
      clearTimeout(handoff.timer);
      handoffDiagnostic(sessionId, "preparation failed after ownership reservation; cockpit writes remain disabled");
      try {
        auditHandoff(sessionId, "outcome", "prepare-degraded", { provider: session.provider });
      } catch {
        // The durable preparation attempt remains available.
      }
      throw new Error("attach unavailable");
    }
    if (!instruction) {
      clearTimeout(handoff.timer);
      nativeHandoffs.delete(sessionId);
      try {
        auditHandoff(sessionId, "outcome", "unavailable", { provider: session.provider });
      } catch {
        // The durable preparation attempt remains available.
      }
      throw new Error("attach unavailable");
    }
    const handoffId = instruction.handoffId ?? reservationId;
    handoff.handoffId = handoffId;
    handoff.status = "prepared";
    clearTimeout(handoff.timer);
    handoff.timer = setTimeout(() => {
      const pending = nativeHandoffs.get(sessionId);
      if (!pending || pending.handoffId !== handoffId || pending.status !== "prepared") return;
      void finishNativeHandoff(sessionId, handoffId, "timeout").catch(() => undefined);
    }, 30_000);
    handoff.timer.unref();
    leases.forceRelease(sessionId);
    try {
      auditHandoff(sessionId, "outcome", "prepared", { provider: session.provider });
    } catch {
      handoffDiagnostic(sessionId, "prepared successfully but its outcome audit could not be appended");
    }
    return { ...instruction, handoffId, spawnNonce };
  };

  const monitorNativeChild = (
    sessionId: string,
    handoffId: string,
    pid: number,
  ): NodeJS.Timeout => {
    const timer = setInterval(() => {
      const current = nativeHandoffs.get(sessionId);
      if (!current || current.handoffId !== handoffId || current.pid !== pid) {
        clearInterval(timer);
        return;
      }
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
        clearInterval(timer);
        void finishNativeHandoff(
          sessionId,
          handoffId,
          current.providerAttached ? "pid-exit" : "failed",
        ).catch(() => undefined);
      }
    }, 1_000);
    timer.unref();
    return timer;
  };

  const monitorNativeWrapper = (
    sessionId: string,
    handoffId: string,
    wrapperPid: number,
  ): NodeJS.Timeout => {
    const timer = setInterval(() => {
      const current = nativeHandoffs.get(sessionId);
      if (!current || current.handoffId !== handoffId || current.wrapperPid !== wrapperPid) {
        clearInterval(timer);
        return;
      }
      try {
        process.kill(wrapperPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
        clearInterval(timer);
        current.wrapperMonitor = null;
        current.status = "degraded";
        clearTimeout(current.timer);
        handoffDiagnostic(
          sessionId,
          current.pid === null
            ? "authorized wrapper died before reporting the provider child; ownership remains fail-closed"
            : "authorized wrapper died; ownership remains excluded until the provider child exits",
        );
        try {
          auditHandoff(sessionId, "lifecycle", "wrapper-exited", {
            provider: current.provider,
            wrapperPid,
            childPid: current.pid,
          });
        } catch {
          // The durable preparation attempt remains available.
        }
      }
    }, 1_000);
    timer.unref();
    return timer;
  };

  if (options.controlSocketPath) {
    controlSocket = await startOwnerControlSocket(options.controlSocketPath, {
      auth,
      bootstrapOrigin: publicOrigin,
      onReloadHooks: () => {
        claudeHookBridge.replaceAuthorizationRecords(
          database.listClaudeHookInstallRecords().map((record) => ({
            id: record.id,
            provider: "claude",
            tokenDigest: record.tokenDigest,
            createdAt: record.createdAt,
            settingsPath: record.settingsPath,
          })),
        );
        codexHookBridge.replaceAuthorizationRecords(
          database.listCodexHookInstallRecords().map((record) => ({
            id: record.id,
            provider: "codex",
            tokenDigest: record.tokenDigest,
            createdAt: record.createdAt,
            settingsPath: record.settingsPath,
            shimPath: record.shimPath,
          })),
        );
      },
      onAttach: nativeAttach,
      onAttachAuthorizeSpawn: (sessionId, handoffId, spawnNonce, wrapperPid) => {
        const handoff = requireNativeHandoff(sessionId, handoffId);
        if (handoff.status !== "prepared" || handoff.spawnNonce !== spawnNonce) {
          throw new Error("native handoff pre-spawn authorization is invalid");
        }
        try {
          process.kill(wrapperPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            throw new Error("native attach wrapper is not alive");
          }
          throw error;
        }
        clearTimeout(handoff.timer);
        handoff.wrapperPid = wrapperPid;
        handoff.status = "authorized";
        handoff.wrapperMonitor = monitorNativeWrapper(sessionId, handoffId, wrapperPid);
        try {
          auditHandoff(sessionId, "lifecycle", "spawn-authorized", {
            provider: handoff.provider,
            wrapperPid,
          });
        } catch {
          handoffDiagnostic(sessionId, "spawn was authorized but its lifecycle audit failed");
        }
      },
      onAttachStarted: (sessionId, handoffId, spawnNonce, pid) => {
        const handoff = requireNativeHandoff(sessionId, handoffId);
        if (handoff.status !== "authorized" || handoff.spawnNonce !== spawnNonce) {
          throw new Error("native handoff was not authorized for process spawn");
        }
        handoff.pid = pid;
        handoff.childMonitor = monitorNativeChild(sessionId, handoffId, pid);
        try {
          auditHandoff(sessionId, "lifecycle", "attach-started", {
            provider: handoff.provider,
            pid,
          });
        } catch {
          handoffDiagnostic(sessionId, "provider child started but its lifecycle audit failed");
        }
        try {
          adapters[handoff.provider]?.markCliAttached?.(
            handoff.providerSessionId,
            handoff.handoffId,
            pid,
          );
          handoff.providerAttached = true;
          handoff.status = "attached";
        } catch {
          handoff.status = "degraded";
          handoffDiagnostic(sessionId, "provider attach hook failed; cockpit writes remain disabled");
          try {
            auditHandoff(sessionId, "outcome", "attach-hook-failed", {
              provider: handoff.provider,
            });
          } catch {
            // The durable lifecycle attempt remains available.
          }
          throw new Error("provider attach hook failed");
        }
        try {
          auditHandoff(sessionId, "outcome", "attached", { provider: handoff.provider });
        } catch {
          handoffDiagnostic(sessionId, "provider attached but its outcome audit failed");
        }
      },
      onAttachExited: (sessionId, handoffId, exitCode) =>
        finishNativeHandoff(sessionId, handoffId, "exited", exitCode),
      onAttachFailed: (sessionId, handoffId) =>
        finishNativeHandoff(sessionId, handoffId, "failed"),
    });
  }

  if (options.discovery !== false) {
    discovery = new DiscoveryReconciler({
      workspaceResolver: workspaceIdentityResolver,
      ...(options.discovery ?? {}),
      onUpdate: (update) => {
        if (update.ok) {
          lastStaleDiagnostic = null;
          replaceDiscoveredSessions(update.sessions, update.diagnostics);
          state.setStale(false);
        } else {
          const snapshot = state.snapshot();
          const diagnostics = snapshot.diagnostics.filter((diagnostic) =>
            diagnostic.message !== lastStaleDiagnostic
          );
          lastStaleDiagnostic = update.diagnostic.message;
          state.replace(snapshot.sessions, [...diagnostics, update.diagnostic]);
          state.setStale(true);
        }
      },
    });
    // The initial worker scan is asynchronous. Until it completes, an empty
    // snapshot is not evidence that there are no local sessions.
    state.setStale(true);
    discovery.start();
  }

  const backend: AgentManagerBackend = {
    app,
    state,
    activityHub,
    auth,
    database,
    controlSocketPath: options.controlSocketPath ?? null,
    listen: async () => {
      try {
        return await app.listen({ host, port });
      } catch (error) {
        await app.close().catch(() => undefined);
        await cleanupResources().catch(() => undefined);
        throw error;
      }
    },
    close: async () => {
      try {
        await bounded(app.close(), shutdownTimeoutMs + 250, "server shutdown");
      } catch (error) {
        await cleanupResources().catch(() => undefined);
        throw error;
      }
    },
    bootstrapUrl: (origin = publicOrigin) =>
      `${origin}/#bootstrap=${encodeURIComponent(auth.bootstrapSecret)}`,
    replaceSessions: (sessions, diagnostics = []) => {
      replaceDiscoveredSessions(sessions, diagnostics);
    },
  };
  return backend;
}
