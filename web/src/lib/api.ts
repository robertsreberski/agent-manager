import { z } from "zod";

import {
  selectedAttentionDetailsQuerySchema,
  selectedAttentionDetailsResponseSchema,
  type SelectedAttentionDetailsResponse,
} from "../../../src/shared/attention-detail.ts";
import {
  selectedTodoDetailResponseSchema,
  type SelectedTodoDetailResponse,
} from "../../../src/shared/todo-detail.ts";
import {
  selectedSessionFactsResponseSchema,
  type SelectedSessionFactsResponse,
} from "../../../src/shared/session-facts.ts";
import {
  workspaceListResponseSchema,
  workspaceResolutionResponseSchema,
} from "../../../src/shared/workspace.ts";
import {
  setupReadModelSchema,
  type SetupReadModel,
} from "../../../src/shared/setup.ts";
import { parseSessionRecord, parseSnapshot } from "./normalize";
import type {
  AttachInstruction,
  AuthSession,
  ControlLease,
  CreateSessionInput,
  HostOption,
  PanePreview,
  SessionAction,
  SessionRecord,
  WireStateSnapshot,
  WorkspaceOption,
} from "../types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    if (typeof input.message === "string") return input.message;
    if (typeof input.error === "string") return input.error;
    if (input.error && typeof input.error === "object") {
      const nested = input.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
  }
  return fallback;
}

function shellDisplay(argv: string[]): string {
  return argv
    .map((part) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}

const hostRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["local", "ssh"]),
  sshTarget: z.string().optional(),
  status: z.enum(["online", "offline", "connecting", "unknown"]),
  statusMessage: z.string().optional(),
}).strict();

const previewResponseSchema = z.object({
  sessionId: z.string().min(1),
  capturedAt: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  lineCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
}).strict();

const attachInstructionSchema = z.object({
  kind: z.enum(["tmux", "codex-remote", "claude-resume", "manager-cli", "ssh"]),
  argv: z.array(z.string()).min(1),
  cwd: z.string().nullable(),
  warning: z.string().nullable(),
  handoffId: z.string().optional(),
  spawnNonce: z.string().optional(),
}).strict();

const transcriptSearchInputSchema = z.object({
  q: z.string()
    .trim()
    .min(2)
    .max(200)
    .refine((value) => !value.includes("\0"), "query contains an invalid character"),
  limit: z.number().int().min(1).max(50),
}).strict();

const transcriptSearchMatchSchema = z.object({
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]),
  createdAt: z.string().nullable(),
  snippet: z.string().max(402),
  matchStart: z.number().int().nonnegative(),
  matchEnd: z.number().int().positive(),
}).strict().superRefine((match, context) => {
  if (match.matchEnd <= match.matchStart) {
    context.addIssue({
      code: "custom",
      message: "match end must follow match start",
      path: ["matchEnd"],
    });
  }
  if (match.matchEnd > match.snippet.length) {
    context.addIssue({
      code: "custom",
      message: "match location must stay inside the snippet",
      path: ["matchEnd"],
    });
  }
});

const transcriptSearchResponseSchema = z.object({
  sessionId: z.string().min(1),
  matches: z.array(transcriptSearchMatchSchema).max(50),
  truncated: z.boolean(),
}).strict();

const planFileResponseSchema = z.object({
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
  path: z.string().min(1),
  markdown: z.string().max(256 * 1_024),
  truncated: z.boolean(),
}).strict();

const sessionModelOptionSchema = z.object({
  value: z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  label: z.string().trim().min(1).max(128).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  description: z.string().trim().max(1_000).nullable(),
  isDefault: z.boolean().optional(),
  defaultEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  efforts: z.array(z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])).max(7).optional(),
}).strict();

const sessionModelOptionsSchema = z.array(sessionModelOptionSchema).max(64).superRefine((models, context) => {
  const seen = new Set<string>();
  for (const [index, model] of models.entries()) {
    if (seen.has(model.value)) {
      context.addIssue({ code: "custom", path: [index, "value"], message: "model identifiers must be unique" });
    }
    seen.add(model.value);
    if (model.efforts && new Set(model.efforts).size !== model.efforts.length) {
      context.addIssue({ code: "custom", path: [index, "efforts"], message: "effort identifiers must be unique" });
    }
    if (model.defaultEffort && !model.efforts?.includes(model.defaultEffort)) {
      context.addIssue({ code: "custom", path: [index, "defaultEffort"], message: "default effort must be one of the model efforts" });
    }
  }
  if (models.filter((model) => model.isDefault).length > 1) {
    context.addIssue({ code: "custom", path: [], message: "only one model may be the provider default" });
  }
});

const sessionSettingsOptionsResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    source: z.literal("provider-api"),
    models: sessionModelOptionsSchema,
  }).strict(),
  z.object({
    available: z.literal(false),
    reason: z.enum(["remote-session", "not-manager-owned", "unsupported-provider", "provider-unavailable"]),
    models: z.array(z.never()).max(0),
  }).strict(),
]);

export type TranscriptSearchMatch = z.infer<typeof transcriptSearchMatchSchema>;
export type TranscriptSearchResponse = z.infer<typeof transcriptSearchResponseSchema>;
export type PlanFileResponse = z.infer<typeof planFileResponseSchema>;
export type SessionModelOption = z.infer<typeof sessionModelOptionSchema>;
export type SessionSettingsOptionsResponse = z.infer<typeof sessionSettingsOptionsResponseSchema>;
export type { SetupHookOffer, SetupReadModel } from "../../../src/shared/setup.ts";
export type { SelectedAttentionDetailsResponse } from "../../../src/shared/attention-detail.ts";
export type { SelectedSessionFactsResponse } from "../../../src/shared/session-facts.ts";
export type { SelectedTodoDetailResponse } from "../../../src/shared/todo-detail.ts";

function invalidResponse(label: string, _value: unknown, error: unknown): never {
  throw new ApiError(`The server returned an invalid ${label} response.`, 502, {
    error: error instanceof Error ? error.message : "wire validation failed",
  });
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) invalidResponse(label, value, result.error);
  return result.data;
}

export class CockpitApi {
  constructor(private readonly auth: AuthSession) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (init.method && init.method !== "GET" && this.auth.csrfToken) {
      headers.set("x-csrf-token", this.auth.csrfToken);
    }
    const response = await fetch(path, {
      ...init,
      headers,
      credentials: "include",
    });
    const body = response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new ApiError(errorMessage(body, `Request failed (${response.status})`), response.status, body);
    }
    return body as T;
  }

  async sessions(): Promise<WireStateSnapshot> {
    return parseSnapshot(await this.request<unknown>("/api/v1/sessions"));
  }

  async attentionDetails(
    id: string,
    requestIds: readonly string[],
  ): Promise<SelectedAttentionDetailsResponse> {
    const query = selectedAttentionDetailsQuerySchema.parse({ requestId: [...requestIds] });
    const params = new URLSearchParams();
    for (const requestId of query.requestId) params.append("requestId", requestId);
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(id)}/attention-details?${params.toString()}`,
    );
    const response = parseResponse(
      selectedAttentionDetailsResponseSchema,
      value,
      "selected attention details",
    );
    const requested = new Set(query.requestId);
    if (
      response.sessionId !== id
      || response.details.some((detail) => !requested.has(detail.requestId))
    ) {
      invalidResponse("selected attention identity", value, new Error("session or request id mismatch"));
    }
    return response;
  }

  async todoDetail(id: string): Promise<SelectedTodoDetailResponse> {
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(id)}/todo-detail`,
    );
    const response = parseResponse(
      selectedTodoDetailResponseSchema,
      value,
      "selected todo detail",
    );
    if (response.sessionId !== id) {
      invalidResponse("selected todo identity", value, new Error("session id mismatch"));
    }
    return response;
  }

  async searchTranscript(id: string, q: string, limit = 20): Promise<TranscriptSearchResponse> {
    const input = transcriptSearchInputSchema.parse({ q, limit });
    const params = new URLSearchParams({
      q: input.q,
      limit: String(input.limit),
    });
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(id)}/search?${params.toString()}`,
    );
    const result = parseResponse(transcriptSearchResponseSchema, value, "transcript search");
    if (result.sessionId !== id) {
      invalidResponse("transcript search identity", value, new Error("session id mismatch"));
    }
    return result;
  }

  async planFile(sessionId: string, itemId: string): Promise<PlanFileResponse> {
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(itemId)}`,
    );
    const result = parseResponse(planFileResponseSchema, value, "plan file");
    if (result.sessionId !== sessionId || result.itemId !== itemId) {
      invalidResponse("plan-file identity", value, new Error("session or item id mismatch"));
    }
    return result;
  }

  async settingsOptions(sessionId: string): Promise<SessionSettingsOptionsResponse> {
    return parseResponse(
      sessionSettingsOptionsResponseSchema,
      await this.request<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/settings-options`),
      "session settings options",
    );
  }

  async sessionFacts(
    sessionId: string,
    generation: number,
  ): Promise<SelectedSessionFactsResponse> {
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/facts?generation=${String(generation)}`,
    );
    const result = parseResponse(selectedSessionFactsResponseSchema, value, "selected session facts");
    if (result.sessionId !== sessionId || result.generation !== generation) {
      invalidResponse("selected session facts identity", value, new Error("session or generation mismatch"));
    }
    return result;
  }

  async setup(): Promise<SetupReadModel> {
    return parseResponse(
      setupReadModelSchema,
      await this.request<unknown>("/api/v1/setup"),
      "first-run setup",
    );
  }

  async workspaces(): Promise<WorkspaceOption[]> {
    const result = await this.request<unknown>("/api/v1/workspaces");
    const { workspaces } = parseResponse(workspaceListResponseSchema, result, "workspaces");
    return workspaces.map((workspace) => ({
      id: workspace.id,
      label: workspace.label,
      path: workspace.path,
      hostId: workspace.hostId,
      hostLabel: workspace.hostLabel,
      hostKind: workspace.hostKind,
      temporary: false,
    }));
  }

  async hosts(): Promise<HostOption[]> {
    const result = await this.request<unknown>("/api/v1/hosts");
    const { hosts } = parseResponse(
      z.object({ hosts: z.array(hostRecordSchema) }).strict(),
      result,
      "hosts",
    );
    return hosts.map((host) => ({
      ...host,
      sshTarget: host.sshTarget ?? null,
      statusMessage: host.statusMessage ?? null,
    }));
  }

  async completeDirectories(hostId: string, path: string): Promise<string[]> {
    const result = await this.request<unknown>(
      `/api/v1/hosts/${encodeURIComponent(hostId)}/directories?path=${encodeURIComponent(path)}&limit=30`,
    );
    const parsed = parseResponse(z.object({
      hostId: z.literal(hostId),
      paths: z.array(z.string()),
    }).strict(), result, "directory completion");
    return parsed.paths;
  }

  async resolveWorkspace(hostId: string, path: string): Promise<WorkspaceOption> {
    const result = await this.request<unknown>("/api/v1/workspaces/resolve", {
      method: "POST",
      body: JSON.stringify({ hostId, path }),
    });
    const { workspace } = parseResponse(workspaceResolutionResponseSchema, result, "workspace");
    if (workspace.hostId !== hostId) {
      invalidResponse("workspace identity", workspace, new Error("host id mismatch"));
    }
    return {
      id: workspace.id,
      label: workspace.label,
      path: workspace.path,
      hostId: workspace.hostId,
      hostLabel: workspace.hostLabel,
      hostKind: workspace.hostKind,
      temporary: false,
    };
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const result = await this.request<unknown>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const payload = parseResponse(z.object({ session: z.unknown() }).strict(), result, "created session");
    const session = parseSessionRecord(payload.session);
    if (session.provider !== input.provider) {
      invalidResponse("created session identity", payload.session, new Error("provider mismatch"));
    }
    return session;
  }

  async action(id: string, action: SessionAction, leaseToken: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      headers: { "x-control-lease": leaseToken },
      body: JSON.stringify(action),
    });
  }

  async preview(id: string): Promise<PanePreview> {
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(id)}/preview`,
    );
    const parsed = parseResponse(previewResponseSchema, value, "preview");
    if (parsed.sessionId !== id) invalidResponse("preview identity", value, new Error("session id mismatch"));
    return {
      content: parsed.content,
      capturedAt: parsed.capturedAt,
      truncated: parsed.truncated,
      lines: parsed.lineCount,
    };
  }

  async attach(id: string): Promise<AttachInstruction> {
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(id)}/attach`,
    );
    const { instruction } = parseResponse(
      z.object({ instruction: attachInstructionSchema.nullable() }).strict(),
      value,
      "attach",
    );
    if (!instruction) {
      return {
        available: false,
        kind: "none",
        command: null,
        description: null,
        requiresHandoff: false,
        argv: [],
        cwd: null,
      };
    }
    return {
      available: true,
      kind: instruction.kind,
      command: shellDisplay(instruction.argv),
      description: instruction.warning,
      requiresHandoff:
        instruction.kind === "claude-resume"
        || instruction.kind === "manager-cli"
        || instruction.kind === "ssh",
      argv: [...instruction.argv],
      cwd: instruction.cwd,
    };
  }

  async acquireLease(
    id: string,
    clientId: string,
    currentToken?: string,
    ttlSeconds = 60,
    takeover = false,
  ): Promise<ControlLease> {
    const value = await this.request<unknown>(
      `/api/v1/sessions/${encodeURIComponent(id)}/control-lease`,
      {
        method: "POST",
        ...(currentToken ? { headers: { "x-control-lease": currentToken } } : {}),
        body: JSON.stringify({ clientId, ttlSeconds, takeover }),
      },
    );
    const { lease } = parseResponse(z.object({
      lease: z.object({
        sessionId: z.literal(id),
        token: z.string().min(1),
        clientId: z.string().min(1),
        acquiredAt: z.string(),
        expiresAt: z.string(),
      }).strict(),
    }).strict(), value, "control lease");
    return {
      token: lease.token,
      clientId: lease.clientId,
      expiresAt: lease.expiresAt,
    };
  }

  async releaseLease(id: string, leaseToken: string, keepalive = false): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/control-lease`, {
      method: "DELETE",
      headers: { "x-control-lease": leaseToken },
      keepalive,
    });
  }
}
