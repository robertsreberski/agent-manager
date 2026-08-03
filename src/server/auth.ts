import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { Actor } from "./contracts.ts";

const COOKIE_NAME = "agent_manager_session";

export interface AuthSession {
  id: string;
  csrfToken: string;
  actor: Actor;
  expiresAt: number;
  createdAt: number;
}

export interface AuthManagerOptions {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  tailscaleHosts?: readonly string[];
  tailscaleAllowedLogins?: readonly string[];
  bootstrapSecret?: string;
  bootstrapTtlMs?: number;
  sessionTtlMs?: number;
  localActorId?: string;
  maxSessions?: number;
  maxSessionsPerActor?: number;
  now?: () => number;
}

function secret(length = 32): string {
  return randomBytes(length).toString("base64url");
}

function constantTimeEqual(first: string, second: string): boolean {
  const left = Buffer.from(first);
  const right = Buffer.from(second);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      result.set(name, decodeURIComponent(value));
    } catch {
      // Malformed cookies are ignored rather than reflected in an error.
    }
  }
  return result;
}

function loopbackAddress(address: string): boolean {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

export class AuthManager {
  readonly allowedHosts: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly tailscaleHosts: ReadonlySet<string>;
  readonly tailscaleAllowedLogins: ReadonlySet<string>;
  #bootstrapConsumed = false;
  #bootstrapSecret = "";
  #bootstrapExpiresAt = 0;
  #bootstrapTtlMs: number;
  #sessions = new Map<string, AuthSession>();
  #now: () => number;
  #sessionTtlMs: number;
  #localActorId: string;
  #maxSessions: number;
  #maxSessionsPerActor: number;
  #revokedListeners = new Set<(sessionId: string) => void>();

  constructor(options: AuthManagerOptions) {
    this.#now = options.now ?? Date.now;
    this.#sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1_000;
    this.#localActorId = options.localActorId ?? "local-user";
    this.#maxSessions = Math.max(1, options.maxSessions ?? 128);
    this.#maxSessionsPerActor = Math.max(1, options.maxSessionsPerActor ?? 8);
    this.#bootstrapTtlMs = options.bootstrapTtlMs ?? 60_000;
    this.allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.allowedOrigins = new Set(options.allowedOrigins);
    this.tailscaleHosts = new Set(
      (options.tailscaleHosts ?? []).map((host) => host.toLowerCase()),
    );
    this.tailscaleAllowedLogins = new Set(options.tailscaleAllowedLogins ?? []);
    this.issueBootstrapToken(options.bootstrapSecret);
  }

  get bootstrapSecret(): string {
    return this.#bootstrapSecret;
  }

  get bootstrapExpiresAt(): number {
    return this.#bootstrapExpiresAt;
  }

  /** Rotate the in-memory token. This is intended for the owner-only Unix control socket. */
  issueBootstrapToken(candidate?: string): { secret: string; expiresAt: number } {
    this.#bootstrapSecret = candidate ?? secret();
    this.#bootstrapExpiresAt = this.#now() + this.#bootstrapTtlMs;
    this.#bootstrapConsumed = false;
    return { secret: this.#bootstrapSecret, expiresAt: this.#bootstrapExpiresAt };
  }

  validateHost(request: FastifyRequest): boolean {
    const host = request.headers.host?.toLowerCase();
    return !!host && this.allowedHosts.has(host);
  }

  validateMutationOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    return typeof origin === "string" && this.allowedOrigins.has(origin);
  }

  exchangeBootstrap(candidate: string): AuthSession | null {
    if (
      this.#bootstrapConsumed
      || this.#now() > this.#bootstrapExpiresAt
      || !constantTimeEqual(candidate, this.#bootstrapSecret)
    ) {
      return null;
    }
    this.#bootstrapConsumed = true;
    return this.#newSession({
      id: this.#localActorId,
      kind: "local",
      displayName: "Local user",
    });
  }

  authenticateCookie(request: FastifyRequest): AuthSession | null {
    this.#purgeExpired();
    const id = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    if (!id) return null;
    const session = this.#sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  establishTailscaleSession(request: FastifyRequest): AuthSession | null {
    const host = request.headers.host?.toLowerCase();
    const loginHeader = request.headers["tailscale-user-login"];
    const nameHeader = request.headers["tailscale-user-name"];
    const login = Array.isArray(loginHeader) ? loginHeader[0] : loginHeader;
    const displayName = Array.isArray(nameHeader) ? nameHeader[0] : nameHeader;
    if (
      !host
      || !this.tailscaleHosts.has(host)
      || !loopbackAddress(request.ip)
      || typeof login !== "string"
      || !this.tailscaleAllowedLogins.has(login)
    ) {
      return null;
    }
    return this.#newSession({
      id: `tailscale:${login}`,
      kind: "tailscale",
      displayName: typeof displayName === "string" && displayName ? displayName : login,
    });
  }

  validateCsrf(session: AuthSession, supplied: string | string[] | undefined): boolean {
    const value = Array.isArray(supplied) ? supplied[0] : supplied;
    return typeof value === "string" && constantTimeEqual(session.csrfToken, value);
  }

  sessionCookie(session: AuthSession, secure: boolean): string {
    const maxAge = Math.max(0, Math.floor((session.expiresAt - this.#now()) / 1_000));
    return [
      `${COOKIE_NAME}=${encodeURIComponent(session.id)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      secure ? "Secure" : "",
      `Max-Age=${maxAge}`,
    ].filter(Boolean).join("; ");
  }

  cookieShouldBeSecure(request: FastifyRequest): boolean {
    const host = request.headers.host?.toLowerCase();
    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return !!host
      && this.tailscaleHosts.has(host)
      && loopbackAddress(request.ip)
      && protocol === "https";
  }

  revoke(sessionId: string): void {
    this.#removeSession(sessionId);
  }

  revokeAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.#removeSession(sessionId);
  }

  onRevoked(listener: (sessionId: string) => void): () => void {
    this.#revokedListeners.add(listener);
    return () => this.#revokedListeners.delete(listener);
  }

  get sessionCount(): number {
    this.#purgeExpired();
    return this.#sessions.size;
  }

  #newSession(actor: Actor): AuthSession {
    this.#purgeExpired();
    this.#evictOldest(
      [...this.#sessions.values()].filter((session) => session.actor.id === actor.id),
      this.#maxSessionsPerActor - 1,
    );
    this.#evictOldest([...this.#sessions.values()], this.#maxSessions - 1);
    const now = this.#now();
    const session: AuthSession = {
      id: secret(),
      csrfToken: secret(),
      actor,
      expiresAt: now + this.#sessionTtlMs,
      createdAt: now,
    };
    this.#sessions.set(session.id, session);
    return structuredClone(session);
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#removeSession(id);
    }
  }

  #evictOldest(candidates: AuthSession[], keep: number): void {
    if (candidates.length <= keep) return;
    candidates.sort((first, second) => first.createdAt - second.createdAt);
    for (const session of candidates.slice(0, candidates.length - keep)) {
      this.#removeSession(session.id);
    }
  }

  #removeSession(sessionId: string): void {
    if (!this.#sessions.delete(sessionId)) return;
    for (const listener of this.#revokedListeners) {
      try {
        listener(sessionId);
      } catch {
        // Authentication revocation must not be undone by cleanup observers.
      }
    }
  }
}
