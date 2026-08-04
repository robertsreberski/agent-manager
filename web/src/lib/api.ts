import { normalizeSession, normalizeSnapshot } from "./normalize";
import type {
  AttachInstruction,
  AuthSession,
  ControlLease,
  CreateSessionInput,
  PanePreview,
  SessionAction,
  SessionView,
  SessionsSnapshot,
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

  async sessions(): Promise<SessionsSnapshot> {
    return normalizeSnapshot(await this.request<unknown>("/api/v1/sessions"));
  }

  async session(id: string): Promise<SessionView> {
    const result = await this.request<unknown>(`/api/v1/sessions/${encodeURIComponent(id)}`);
    const payload = result && typeof result === "object" && "session" in result
      ? (result as { session: unknown }).session
      : result;
    return normalizeSession(payload);
  }

  async workspaces(): Promise<WorkspaceOption[]> {
    const result = await this.request<unknown>("/api/v1/workspaces");
    const items = Array.isArray(result)
      ? result
      : result && typeof result === "object" && Array.isArray((result as { workspaces?: unknown }).workspaces)
        ? (result as { workspaces: unknown[] }).workspaces
        : [];
    return items.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const value = raw as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : null;
      if (!id) return [];
      const path = typeof value.path === "string" ? value.path : undefined;
      return [{
        id,
        label: typeof value.label === "string" ? value.label : path ?? id,
        ...(path ? { path } : {}),
        temporary: value.temporary === true,
      }];
    });
  }

  async createSession(input: CreateSessionInput): Promise<SessionView> {
    const result = await this.request<unknown>("/api/v1/sessions", {
      method: "POST",
      ...(input.permissionPreset === "full-host"
        ? { headers: { "x-confirm-full-host": "true" } }
        : {}),
      body: JSON.stringify(input),
    });
    const payload = result && typeof result === "object" && "session" in result
      ? (result as { session: unknown }).session
      : result;
    return normalizeSession(payload);
  }

  async action(id: string, action: SessionAction, leaseToken: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      headers: { "x-control-lease": leaseToken },
      body: JSON.stringify(action),
    });
  }

  async preview(id: string): Promise<PanePreview> {
    const value = await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(id)}/preview`,
    );
    const capturedAt = typeof value.capturedAt === "string" ? value.capturedAt : null;
    const lines = typeof value.lineCount === "number"
      ? value.lineCount
      : typeof value.lines === "number"
        ? value.lines
        : null;
    return {
      content: typeof value.content === "string" ? value.content : "",
      ...(capturedAt ? { capturedAt } : {}),
      truncated: value.truncated === true,
      ...(lines !== null ? { lines } : {}),
    };
  }

  async attach(id: string): Promise<AttachInstruction> {
    const value = await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(id)}/attach`,
    );
    const rawInstruction = value.instruction && typeof value.instruction === "object"
      ? (value.instruction as Record<string, unknown>)
      : value;
    const argv = Array.isArray(rawInstruction.argv)
      ? rawInstruction.argv.filter((part): part is string => typeof part === "string")
      : [];
    return {
      available: value.instruction !== null && (value.available === true || argv.length > 0),
      kind: typeof rawInstruction.kind === "string" ? rawInstruction.kind : "none",
      command: typeof rawInstruction.command === "string"
        ? rawInstruction.command
        : argv.length > 0
          ? shellDisplay(argv)
          : null,
      description: typeof rawInstruction.warning === "string"
        ? rawInstruction.warning
        : typeof rawInstruction.description === "string"
          ? rawInstruction.description
          : null,
      requiresHandoff: rawInstruction.kind === "claude-resume"
        || rawInstruction.kind === "manager-cli"
        || rawInstruction.requiresHandoff === true,
      argv,
      cwd: typeof rawInstruction.cwd === "string" ? rawInstruction.cwd : null,
    };
  }

  async acquireLease(
    id: string,
    clientId: string,
    armFullHost: boolean,
    currentToken?: string,
    ttlSeconds = 300,
  ): Promise<ControlLease> {
    const value = await this.request<Record<string, unknown>>(
      `/api/v1/sessions/${encodeURIComponent(id)}/control-lease`,
      {
        method: "POST",
        ...(currentToken ? { headers: { "x-control-lease": currentToken } } : {}),
        body: JSON.stringify({ clientId, ttlSeconds, armFullHost }),
      },
    );
    const rawLease = value.lease && typeof value.lease === "object"
      ? (value.lease as Record<string, unknown>)
      : value;
    const expiresAt = typeof rawLease.expiresAt === "string"
      ? rawLease.expiresAt
      : new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    const responseToken = typeof rawLease.token === "string" ? rawLease.token : "";
    if (!responseToken) {
      throw new ApiError("The server did not return a control lease token.", 500, value);
    }
    return {
      token: responseToken,
      clientId: typeof rawLease.clientId === "string" ? rawLease.clientId : clientId,
      expiresAt,
      fullHostArmedUntil: typeof rawLease.fullHostArmedUntil === "string"
        ? rawLease.fullHostArmedUntil
        : null,
    };
  }

  async releaseLease(id: string, leaseToken: string): Promise<void> {
    await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/control-lease`, {
      method: "DELETE",
      headers: { "x-control-lease": leaseToken },
    });
  }

  async releaseBrowserLeases(): Promise<void> {
    await this.request("/api/v1/control-leases", { method: "DELETE" });
  }
}
