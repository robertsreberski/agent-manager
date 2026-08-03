import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server as NetServer } from "node:net";
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
  encodeActivityCursor,
  parseActivityCursor,
  type ActivityFrame,
} from "../activity/index.ts";
import type { Diagnostic, Provider, SessionRecord, SessionView } from "../core/types.ts";
import {
  DiscoveryReconciler,
  type DiscoveryReconcilerOptions,
} from "../discovery/index.ts";
import { AuthManager, type AuthManagerOptions, type AuthSession } from "./auth.ts";
import {
  createSessionSchema,
  leaseRequestSchema,
  requiredCapability,
  sessionActionSchema,
  type ActionRecord,
  type AttachInstruction,
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
import { SessionStateStore } from "./state.ts";
import type { SessionTranscriptReader, TranscriptReadResult } from "./transcript.ts";
import { SelectedTranscriptActivityObserver } from "./activity-observer.ts";

const previewQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(200).default(200),
  bytes: z.coerce.number().int().min(1_024).max(65_536).default(65_536),
});
const eventsQuerySchema = z.object({
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict();
const activityHistoryQuerySchema = z.object({
  before: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(400).default(200),
}).strict();
const bootstrapSchema = z.object({ secret: z.string().min(32).max(256) }).strict();

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
  database?: ManagerDatabase;
  adapters?: ProviderControlAdapters;
  previewAdapter?: PanePreviewAdapter;
  /** Reads bounded conversation detail only for the authenticated detail route. */
  transcriptReader?: SessionTranscriptReader;
  /** Canonical tmux executable used by the production preview adapter. */
  tmuxExecutable?: string;
  replayCapacity?: number;
  bodyLimit?: number;
  logger?: boolean;
  /** Production web assets; false disables static and SPA routes. */
  staticDir?: string | false;
  initialSessions?: readonly (SessionRecord | SessionView)[];
  initialDiagnostics?: readonly Diagnostic[];
  /** Enabled by default; pass false in deterministic unit tests. */
  discovery?: false | Omit<DiscoveryReconcilerOptions, "onUpdate">;
  onShutdown?: () => void | Promise<void>;
  maxSseClients?: number;
  maxSseClientsPerAuthSession?: number;
  shutdownTimeoutMs?: number;
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
    sessions: readonly (SessionRecord | SessionView)[],
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

function actionRecord(
  id: string,
  sessionId: string,
  action: SessionAction,
  status: ActionRecord["status"],
  createdAt: string,
  extra: Pick<ActionRecord, "completedAt" | "error"> = {},
): ActionRecord {
  return { id, sessionId, type: action.type, status, createdAt, ...extra };
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
  const activityHub = options.activityHub ?? new ActivityHub();
  const database = options.database ?? new ManagerDatabase(options.databasePath);
  const adapters = options.adapters ?? {};
  const previewAdapter = options.previewAdapter ?? new TmuxPanePreviewAdapter(
    options.tmuxExecutable === undefined ? {} : { executable: options.tmuxExecutable },
  );
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
    onChange: (sessionId, leased) => void state.setWritableLease(sessionId, leased),
  });
  let controlSocket: NetServer | null = null;
  let databaseClosed = false;
  let discovery: DiscoveryReconciler | null = null;
  let lastStaleDiagnostic: string | null = null;
  let locked = false;
  let cleanupPromise: Promise<void> | null = null;
  const shutdownTimeoutMs = Math.max(250, options.shutdownTimeoutMs ?? 2_000);
  const maxSseClients = Math.max(1, options.maxSseClients ?? 16);
  const maxSseClientsPerAuthSession = Math.max(1, options.maxSseClientsPerAuthSession ?? 2);
  const sseClients = new Map<FastifyReply, {
    authSessionId: string;
    clientId: string | null;
    channel: string;
    close: () => void;
  }>();
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
  const transcriptActivity = new SelectedTranscriptActivityObserver({
    hub: activityHub,
    ...(transcriptReader ? { reader: transcriptReader } : {}),
    resolveSession: (id) => state.get(id),
    eligible: (session) => !session.control.managerOwned || nativeHandoffs.has(session.id),
  });
  const shouldObserveTranscript = (session: SessionView): boolean =>
    !session.control.managerOwned || nativeHandoffs.has(session.id);
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
    sessions: readonly (SessionRecord | SessionView)[],
    diagnostics: readonly Diagnostic[],
  ): void => {
    const managed = state.list().filter((session) => session.control.managerOwned);
    const managedIds = new Set(managed.map((session) => session.id));
    const external = sessions.filter((session) => {
      const id = "id" in session ? session.id : `${session.provider}:${session.sessionId}`;
      return !managedIds.has(id);
    });
    state.replace([...external, ...managed], diagnostics);
  };

  if (options.initialSessions || options.initialDiagnostics) {
    state.replace(options.initialSessions ?? state.list(), []);
    for (const diagnostic of options.initialDiagnostics ?? []) state.addDiagnostic(diagnostic);
  }
  database.markInterruptedDispatchesUnknown();
  database.recoverCreateSessionIntents();

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: "1 minute",
  });

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-write=(self)")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY");

    if (!auth.validateHost(request)) {
      throw new ApiError(400, "INVALID_HOST", "request Host is not allowed");
    }

    if (isMutation(request.method) && !auth.validateMutationOrigin(request)) {
      throw new ApiError(403, "INVALID_ORIGIN", "mutation Origin is not allowed");
    }
    if (
      (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")
      && !request.headers["content-type"]?.toLowerCase().startsWith("application/json")
    ) {
      throw new ApiError(415, "JSON_REQUIRED", "mutations require application/json");
    }

    const path = request.url.split("?", 1)[0];
    if (locked && path !== "/api/v1/healthz") {
      throw new ApiError(423, "CONTROL_PLANE_LOCKED", "Agent Manager is locked");
    }
    const publicPath = path === "/api/v1/healthz"
      || path === "/api/v1/auth/bootstrap"
      || path === "/api/v1/auth/session";
    if (!path?.startsWith("/api/") || publicPath) return;

    const session = auth.authenticateCookie(request);
    if (!session) throw new ApiError(401, "AUTH_REQUIRED", "authentication is required");
    requestSessions.set(request, session);
    if (isMutation(request.method) && !auth.validateCsrf(session, request.headers["x-csrf-token"])) {
      throw new ApiError(403, "CSRF_INVALID", "CSRF token is missing or invalid");
    }
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
      wildcard: false,
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

  app.get("/api/v1/healthz", async () => ({ ok: !locked, locked }));

  app.post("/api/v1/auth/bootstrap", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const body = bootstrapSchema.parse(request.body);
    const session = auth.exchangeBootstrap(body.secret);
    if (!session) throw new ApiError(401, "BOOTSTRAP_INVALID", "bootstrap token is invalid or expired");
    reply.header("Set-Cookie", auth.sessionCookie(session, auth.cookieShouldBeSecure(request)));
    return { authenticated: true, csrfToken: session.csrfToken, actor: session.actor };
  });

  app.get("/api/v1/auth/session", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const existing = auth.authenticateCookie(request);
    if (existing) {
      return { authenticated: true, csrfToken: existing.csrfToken, actor: existing.actor };
    }
    const session = auth.establishTailscaleSession(request);
    if (!session) throw new ApiError(401, "AUTH_REQUIRED", "authentication is required");
    reply.header("Set-Cookie", auth.sessionCookie(session, auth.cookieShouldBeSecure(request)));
    return { authenticated: true, csrfToken: session.csrfToken, actor: session.actor };
  });

  app.get("/api/v1/sessions", async () => state.snapshot());

  app.get("/api/v1/sessions/:id", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    let detail: TranscriptReadResult;
    try {
      detail = transcriptReader?.read(session) ?? {
        messages: [],
        transcript: {
          state: "unavailable",
          truncated: false,
          source: null,
          messageCount: 0,
          reason: "unsupported",
        },
      };
    } catch {
      detail = {
        messages: [],
        transcript: {
          state: "unavailable",
          truncated: false,
          source: null,
          messageCount: 0,
          reason: "unreadable",
        },
      };
    }
    return { session: { ...session, ...detail } };
  });

  app.get("/api/v1/sessions/:id/activity", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request) => {
    const id = routeSessionId(request);
    const session = state.get(id);
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
    activityHub.ensureSession(id, session.provider);
    if (shouldObserveTranscript(session)) transcriptActivity.seedOnce(session);
    const { before, limit } = activityHistoryQuerySchema.parse(request.query);
    const snapshot = activityHub.snapshot(id);
    if (!snapshot) {
      return {
        schemaVersion: 1,
        sessionId: id,
        provider: session.provider,
        streamEpoch: activityHub.streamEpoch,
        cursor: null,
        items: [],
        truncated: false,
        hasMore: false,
        nextBefore: null,
      };
    }
    const beforeSequence = before === undefined
      ? null
      : parseActivityCursor(before, activityHub.streamEpoch, id);
    if (before !== undefined && beforeSequence === null) {
      throw new ApiError(409, "ACTIVITY_CURSOR_STALE", "activity history cursor is invalid or expired");
    }
    const eligible = beforeSequence === null
      ? snapshot.items
      : snapshot.items.filter((item) => item.seq < beforeSequence);
    const items = eligible.slice(-limit);
    const hasMore = snapshot.truncated || eligible.length > items.length;
    const first = items[0];
    return {
      schemaVersion: snapshot.schemaVersion,
      sessionId: id,
      provider: session.provider,
      streamEpoch: snapshot.streamEpoch,
      cursor: snapshot.cursor,
      items,
      truncated: snapshot.truncated,
      hasMore,
      nextBefore: hasMore && first
        ? encodeActivityCursor(snapshot.streamEpoch, id, first.seq)
        : null,
    };
  });

  app.get("/api/v1/workspaces", async () => ({ workspaces: database.listWorkspaces() }));

  app.get("/api/v1/sessions/:id/preview", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request) => {
    const session = state.get(routeSessionId(request));
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "session was not found");
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
    let instruction: AttachInstruction | null = null;
    if (session.control.managerOwned && session.control.capabilities.includes("attach")) {
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
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      unsubscribe();
      sseClients.delete(reply);
      if (!reply.raw.destroyed) reply.raw.destroy();
    };
    const write = (chunk: string): boolean => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return false;
      try {
        const accepted = reply.raw.write(chunk);
        if (!accepted) close();
        return accepted;
      } catch {
        close();
        return false;
      }
    };
    sseClients.set(reply, { authSessionId: authSession.id, clientId, channel, close });

    const supplied = request.headers["last-event-id"];
    const value = Array.isArray(supplied) ? supplied[0] : supplied;
    const after = value === undefined ? null : Number.parseInt(value, 10);
    if (after === null || !Number.isSafeInteger(after) || after < 0) {
      write(encodeSse({
        seq: state.events.sequence,
        type: "snapshot",
        at: new Date().toISOString(),
        payload: state.snapshot(),
      }));
    } else {
      const replay = state.events.replayAfter(after);
      if (replay.gap) {
        write(encodeSse({
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
    heartbeat = setInterval(() => void write(": heartbeat\n\n"), 15_000);
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
    const session = state.get(id);
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
    const releaseTranscript = shouldObserveTranscript(session)
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
    const pending: ActivityFrame[] = [];
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      unsubscribe();
      releaseTranscript();
      sseClients.delete(reply);
      if (!reply.raw.destroyed) reply.raw.destroy();
    };
    const write = (frame: ActivityFrame): boolean => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return false;
      const chunk = encodeActivitySse(frame);
      if (reply.raw.writableLength + Buffer.byteLength(chunk) > 256 * 1_024) {
        close();
        return false;
      }
      try {
        reply.raw.write(chunk);
        return true;
      } catch {
        close();
        return false;
      }
    };
    sseClients.set(reply, { authSessionId: authSession.id, clientId, channel, close });

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
      if (reply.raw.writableLength + 13 > 256 * 1_024) return close();
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        close();
      }
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
    if (input.permissionPreset === "full-host" && request.headers["x-confirm-full-host"] !== "true") {
      throw new ApiError(428, "FULL_HOST_CONFIRMATION_REQUIRED", "full-host session creation requires explicit confirmation");
    }
    const workspace = database.getWorkspace(input.workspaceId);
    if (!workspace) throw new ApiError(400, "WORKSPACE_UNKNOWN", "workspace is not configured");
    const adapter = providerAdapter(adapters, input.provider);
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
          mode: input.mode,
          permissionPreset: input.permissionPreset,
        },
      });
      database.markCreateSessionDispatching(authSession.actor.id, input.idempotencyKey);
    } catch {
      database.markCreateSessionUnknown(authSession.actor.id, input.idempotencyKey);
      throw new ApiError(500, "CREATE_INTENT_FAILED", "session creation could not be recorded safely");
    }

    let created: SessionView;
    try {
      created = await adapter.createSession(
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
    if (created.provider !== input.provider || !created.control.managerOwned) {
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
          providerSessionId: created.sessionId,
          workspaceId: workspace.id,
          metadata: {
            managerRequestId: begun.intent.managerRequestId,
            name: input.name ?? null,
            mode: input.mode,
            permissionPreset: input.permissionPreset,
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
    const stored = state.upsert(created);
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
      ["queue", "steer", "interrupt", "respond", "set-mode"].includes(capability)
    )) {
      throw new ApiError(409, "CONTROL_UNAVAILABLE", "session has no writable semantic controls");
    }
    const body = leaseRequestSchema.parse(request.body);
    const authSession = requireSession(request);
    const renewal = leases.has(session.id);
    const operation = body.armFullHost
      ? "lease.arm"
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
          armFullHost: body.armFullHost,
          ttlSeconds: body.ttlSeconds ?? 60,
        },
      });
    } catch {
      throw new ApiError(500, "LEASE_AUDIT_FAILED", "lease operation could not be recorded safely");
    }
    if (body.armFullHost && !renewal) {
      try {
        database.auditOperation({
          actor: authSession.actor,
          operation,
          targetId: session.id,
          phase: "outcome",
          outcome: "current-token-required",
          details: { armFullHost: true },
        });
      } catch {
        // The durable attempt already records the rejected operation.
      }
      throw new ApiError(
        428,
        "LEASE_TOKEN_REQUIRED",
        "acquire an unarmed lease, then present its current token to arm full-host control",
      );
    }
    const lease = leases.acquire(
      session.id,
      body.clientId,
      principal(authSession),
      request.headers["x-control-lease"],
      body.ttlSeconds === undefined ? undefined : body.ttlSeconds * 1_000,
      body.armFullHost,
    );
    try {
      database.auditOperation({
        actor: authSession.actor,
        operation,
        targetId: session.id,
        phase: "outcome",
        outcome: "succeeded",
        details: { renewal, armFullHost: body.armFullHost },
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
          (session.effectiveAccess.fullHostAccess || database.managedSessionRequiresFullHostArm(id))
          && !leases.isFullHostArmed(id, principal(authSession))
        ) {
          throw new ApiError(428, "FULL_HOST_NOT_ARMED", "full-host control requires an explicitly armed lease");
        }
        if (
          action.type === "respond"
          && !session.attention.some((attention) => attention.id === action.requestId)
        ) {
          throw new ApiError(409, "REQUEST_STALE", "pending request is no longer active");
        }

        const adapter = providerAdapter(adapters, session.provider);
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
            const result = await adapter.performAction(session, action, context(request));
            acknowledged = result.status !== "unknown";
            record = actionRecord(actionId, id, action, result.status, createdAt, {
              ...(result.status === "queued" ? {} : { completedAt: new Date().toISOString() }),
              ...(result.status === "failed"
                ? {
                    error: {
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
            requestOrRunId: action.expectedRunId ?? null,
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
          const result = await adapter.performAction(session, action, context(request));
          acknowledged = result.status !== "unknown";
          record = actionRecord(actionId, id, action, result.status, createdAt, {
            ...(result.status === "queued" ? {} : { completedAt: new Date().toISOString() }),
            ...(result.status === "failed"
              ? {
                  error: {
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
            requestOrRunId: action.expectedRunId ?? null,
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
          database.markActionUnknown(actionId, record.completedAt);
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

  const enterLocked = (): void => {
    if (locked) return;
    locked = true;
    auth.revokeAll();
    leases.releaseAll();
    for (const client of [...sseClients.values()]) client.close();
  };

  const cleanupResources = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors: unknown[] = [];
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

  app.addHook("onClose", async () => {
    enterLocked();
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
    if (view) state.upsert(view);
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
    if (locked) throw new Error("control plane is locked");
    const session = state.get(sessionId);
    if (!session) throw new Error("session not found");
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
      providerSessionId: session.sessionId,
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
      isLocked: () => locked,
      onPanicLock: async () => {
        enterLocked();
        try {
          database.auditOperation({
            actor: localOwnerActor,
            operation: "panic.lock",
            targetId: "control-plane",
            phase: "attempt",
            outcome: "locked-cleanup-starting",
          });
        } catch {
          state.addDiagnostic({
            provider: "system",
            level: "error",
            message: "Panic lock engaged, but its audit row could not be persisted",
          });
        }
        try {
          await bounded(app.close(), shutdownTimeoutMs + 250, "panic cleanup");
        } catch (error) {
          await cleanupResources().catch(() => undefined);
          throw error;
        }
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
        enterLocked();
        await app.close().catch(() => undefined);
        await cleanupResources().catch(() => undefined);
        throw error;
      }
    },
    close: async () => {
      enterLocked();
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
