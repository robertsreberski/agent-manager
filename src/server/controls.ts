import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { ActionRecord, ControlLease, SessionAction } from "./contracts.ts";

export class LeaseConflictError extends Error {
  readonly expiresAt: string;

  constructor(expiresAt: string) {
    super("another client currently holds the writable control lease");
    this.name = "LeaseConflictError";
    this.expiresAt = expiresAt;
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("the idempotency key was already used with a different request");
    this.name = "IdempotencyConflictError";
  }
}

export interface LeaseBrokerOptions {
  now?: () => number;
  defaultTtlMs?: number;
  recoveryWindowMs?: number;
  onChange?: (sessionId: string, leased: boolean) => void;
}

interface StoredLease extends ControlLease {
  actorId: string;
  authSessionId: string;
  expiresAtMs: number;
  previousToken: string | null;
  previousTokenExpiresAtMs: number;
  timer: NodeJS.Timeout;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function tokenMatches(expected: string, supplied: string | string[] | undefined): boolean {
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (typeof value !== "string") return false;
  const first = Buffer.from(expected);
  const second = Buffer.from(value);
  return first.length === second.length && timingSafeEqual(first, second);
}

export interface LeasePrincipal {
  authSessionId: string;
  actorId: string;
}

function publicLease(lease: StoredLease): ControlLease {
  return {
    sessionId: lease.sessionId,
    token: lease.token,
    clientId: lease.clientId,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    fullHostArmedUntil: lease.fullHostArmedUntil,
  };
}

export class ControlLeaseBroker {
  #leases = new Map<string, StoredLease>();
  #now: () => number;
  #defaultTtlMs: number;
  #recoveryWindowMs: number;
  #onChange: (sessionId: string, leased: boolean) => void;

  constructor(options: LeaseBrokerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.#recoveryWindowMs = options.recoveryWindowMs ?? 15_000;
    this.#onChange = options.onChange ?? (() => undefined);
  }

  acquire(
    sessionId: string,
    clientId: string,
    principal: LeasePrincipal,
    currentToken?: string | string[],
    ttlMs?: number,
    armFullHost = false,
  ): ControlLease {
    this.#purge(sessionId);
    const active = this.#leases.get(sessionId);
    const duration = Math.min(300_000, Math.max(15_000, ttlMs ?? this.#defaultTtlMs));
    const expiresAtMs = this.#now() + duration;
    if (active) {
      const samePrincipal = active.clientId === clientId
        && active.actorId === principal.actorId
        && active.authSessionId === principal.authSessionId;
      if (
        samePrincipal
        && active.previousToken !== null
        && active.previousTokenExpiresAtMs > this.#now()
        && tokenMatches(active.previousToken, currentToken)
      ) {
        // A response can be lost after the token rotated. Return the already
        // committed lease unchanged for a short recovery window; do not rotate
        // again or extend/alter its authority.
        return publicLease(active);
      }
      if (!samePrincipal || !tokenMatches(active.token, currentToken)) {
        throw new LeaseConflictError(active.expiresAt);
      }
      clearTimeout(active.timer);
      active.expiresAtMs = expiresAtMs;
      active.expiresAt = new Date(expiresAtMs).toISOString();
      active.previousToken = active.token;
      active.previousTokenExpiresAtMs = this.#now() + this.#recoveryWindowMs;
      active.token = token();
      if (armFullHost) active.fullHostArmedUntil = new Date(expiresAtMs).toISOString();
      active.timer = this.#expiryTimer(sessionId, duration);
      return publicLease(active);
    }

    const now = this.#now();
    const lease: StoredLease = {
      sessionId,
      token: token(),
      clientId,
      actorId: principal.actorId,
      authSessionId: principal.authSessionId,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      previousToken: null,
      previousTokenExpiresAtMs: 0,
      fullHostArmedUntil: armFullHost ? new Date(expiresAtMs).toISOString() : null,
      timer: this.#expiryTimer(sessionId, duration),
    };
    this.#leases.set(sessionId, lease);
    this.#onChange(sessionId, true);
    return publicLease(lease);
  }

  verify(sessionId: string, suppliedToken: string | string[] | undefined, principal: LeasePrincipal): boolean {
    this.#purge(sessionId);
    const active = this.#leases.get(sessionId);
    const value = Array.isArray(suppliedToken) ? suppliedToken[0] : suppliedToken;
    return !!active
      && tokenMatches(active.token, value)
      && active.actorId === principal.actorId
      && active.authSessionId === principal.authSessionId;
  }

  isFullHostArmed(sessionId: string, principal: LeasePrincipal): boolean {
    this.#purge(sessionId);
    const active = this.#leases.get(sessionId);
    return !!active
      && active.actorId === principal.actorId
      && active.authSessionId === principal.authSessionId
      && active.fullHostArmedUntil !== null
      && Date.parse(active.fullHostArmedUntil) > this.#now();
  }

  has(sessionId: string): boolean {
    this.#purge(sessionId);
    return this.#leases.has(sessionId);
  }

  release(sessionId: string, suppliedToken: string | string[] | undefined, principal: LeasePrincipal): boolean {
    if (!this.verify(sessionId, suppliedToken, principal)) return false;
    const active = this.#leases.get(sessionId);
    if (active) clearTimeout(active.timer);
    this.#leases.delete(sessionId);
    this.#onChange(sessionId, false);
    return true;
  }

  releaseAll(): void {
    for (const [sessionId, lease] of this.#leases) {
      clearTimeout(lease.timer);
      this.#onChange(sessionId, false);
    }
    this.#leases.clear();
  }

  releaseForAuthSession(authSessionId: string): void {
    for (const [sessionId, lease] of this.#leases) {
      if (lease.authSessionId !== authSessionId) continue;
      clearTimeout(lease.timer);
      this.#leases.delete(sessionId);
      this.#onChange(sessionId, false);
    }
  }

  forceRelease(sessionId: string): void {
    const active = this.#leases.get(sessionId);
    if (!active) return;
    clearTimeout(active.timer);
    this.#leases.delete(sessionId);
    this.#onChange(sessionId, false);
  }

  #purge(sessionId: string): void {
    const active = this.#leases.get(sessionId);
    if (active && active.expiresAtMs <= this.#now()) {
      clearTimeout(active.timer);
      this.#leases.delete(sessionId);
      this.#onChange(sessionId, false);
    }
  }

  #expiryTimer(sessionId: string, duration: number): NodeJS.Timeout {
    const timer = setTimeout(() => this.#purge(sessionId), duration + 5);
    timer.unref();
    return timer;
  }
}

interface IdempotentEntry {
  fingerprint: string;
  promise: Promise<ActionRecord>;
  expiresAt: number;
}

export class IdempotencyStore {
  #entries = new Map<string, IdempotentEntry>();
  #now: () => number;
  #ttlMs: number;
  #capacity: number;

  constructor(options: { now?: () => number; ttlMs?: number; capacity?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#capacity = options.capacity ?? 1_024;
  }

  run(
    sessionId: string,
    action: SessionAction,
    execute: () => Promise<ActionRecord>,
  ): Promise<ActionRecord> {
    this.#purge();
    const key = `${sessionId}\u0000${action.idempotencyKey}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return existing.promise;
    }
    const promise = execute();
    this.#entries.set(key, {
      fingerprint,
      promise,
      expiresAt: this.#now() + this.#ttlMs,
    });
    this.#trim();
    return promise;
  }

  #purge(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  #trim(): void {
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }
}
