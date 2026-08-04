import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { FastifyRequest } from "fastify";

import { AuthManager } from "./auth.ts";
import {
  assertOwnerRuntimeDirectory,
  requestAttachAuthorizeSpawnFromControlSocket,
  requestAttachStartedFromControlSocket,
  requestBootstrapFromControlSocket,
  startOwnerControlSocket,
} from "./control-socket.ts";
import { ControlLeaseBroker, LeaseConflictError } from "./controls.ts";

function authManager(overrides: Partial<ConstructorParameters<typeof AuthManager>[0]> = {}) {
  return new AuthManager({
    allowedHosts: ["localhost:43127"],
    allowedOrigins: ["http://localhost:43127"],
    ...overrides,
  });
}

function tailscaleRequest(cookie?: string): FastifyRequest {
  return {
    ip: "127.0.0.1",
    headers: {
      host: "manager.tailnet.ts.net",
      "tailscale-user-login": "owner@example.com",
      "tailscale-user-name": "Owner",
      ...(cookie === undefined ? {} : { cookie }),
    },
  } as unknown as FastifyRequest;
}

test("leases are bound to one auth session and rotate on every renewal", () => {
  let now = 1_000;
  const broker = new ControlLeaseBroker({ now: () => now, recoveryWindowMs: 15_000 });
  const firstPrincipal = { authSessionId: "auth-one", actorId: "same-actor" };
  const secondPrincipal = { authSessionId: "auth-two", actorId: "same-actor" };
  const first = broker.acquire("codex:one", "browser", firstPrincipal);

  assert.throws(
    () => broker.acquire("codex:one", "browser", secondPrincipal, first.token),
    LeaseConflictError,
  );
  assert.throws(
    () => broker.acquire("codex:one", "browser", firstPrincipal),
    LeaseConflictError,
  );

  const renewed = broker.acquire(
    "codex:one",
    "browser",
    firstPrincipal,
    first.token,
    undefined,
  );
  assert.notEqual(renewed.token, first.token);
  assert.equal(broker.verify("codex:one", first.token, firstPrincipal), false);
  assert.equal(broker.verify("codex:one", renewed.token, firstPrincipal), true);
  assert.equal("actorId" in renewed, false);

  const recovered = broker.acquire(
    "codex:one",
    "browser",
    firstPrincipal,
    first.token,
    undefined,
  );
  assert.equal(recovered.token, renewed.token, "a lost rotation response can be recovered once");
  assert.equal(recovered.expiresAt, renewed.expiresAt);
  assert.equal(broker.release("codex:one", first.token, firstPrincipal), false);
  assert.throws(
    () => broker.acquire("codex:one", "other-browser", firstPrincipal, first.token),
    LeaseConflictError,
  );
  assert.throws(
    () => broker.acquire("codex:one", "browser", secondPrincipal, first.token),
    LeaseConflictError,
  );

  const rotatedAgain = broker.acquire(
    "codex:one",
    "browser",
    firstPrincipal,
    renewed.token,
    undefined,
  );
  assert.notEqual(rotatedAgain.token, renewed.token);
  assert.throws(
    () => broker.acquire("codex:one", "browser", firstPrincipal, first.token),
    LeaseConflictError,
  );

  const takenOver = broker.acquire(
    "codex:one",
    "other-browser",
    secondPrincipal,
    undefined,
    undefined,
    true,
  );
  assert.equal(broker.verify("codex:one", rotatedAgain.token, firstPrincipal), false);
  assert.equal(broker.verify("codex:one", takenOver.token, secondPrincipal), true);
  assert.equal("actorId" in takenOver, false);
  now += 15_001;
  assert.throws(
    () => broker.acquire("codex:one", "browser", firstPrincipal, renewed.token),
    LeaseConflictError,
  );

  assert.deepEqual(broker.releaseForAuthSession(firstPrincipal.authSessionId), []);
  assert.deepEqual(broker.releaseForAuthSession(secondPrincipal.authSessionId), ["codex:one"]);
  assert.equal(broker.has("codex:one"), false);
});

test("lease release retries are idempotent only after the active lease is gone", () => {
  const broker = new ControlLeaseBroker();
  const principal = { authSessionId: "auth-one", actorId: "actor-one" };
  const lease = broker.acquire("codex:one", "browser", principal);

  assert.equal(broker.release("codex:one", "mismatched-token", principal), false);
  assert.equal(broker.has("codex:one"), true);
  assert.equal(broker.release("codex:one", lease.token, principal), true);
  assert.equal(broker.release("codex:one", lease.token, principal), true);
});

test("authentication caps evict the oldest session and report revocation", () => {
  let now = 1_000;
  const revoked: string[] = [];
  const auth = authManager({
    tailscaleHosts: ["manager.tailnet.ts.net"],
    tailscaleAllowedLogins: ["owner@example.com"],
    maxSessions: 2,
    maxSessionsPerActor: 2,
    now: () => now,
  });
  auth.onRevoked((sessionId) => revoked.push(sessionId));
  const first = auth.establishTailscaleSession(tailscaleRequest());
  now += 1;
  const second = auth.establishTailscaleSession(tailscaleRequest());
  now += 1;
  const third = auth.establishTailscaleSession(tailscaleRequest());
  assert.ok(first && second && third);
  assert.equal(auth.sessionCount, 2);
  assert.deepEqual(revoked, [first.id]);
  assert.equal(
    auth.authenticateCookie(tailscaleRequest(`agent_manager_session=${first.id}`)),
    null,
  );
});

test("owner control socket rejects unsafe parents and validates socket permissions", async () => {
  const root = mkdtempSync("/tmp/am-control-");
  const unsafe = join(root, "unsafe");
  const real = join(root, "real");
  const linked = join(root, "linked");
  const runtime = join(root, "runtime");
  mkdirSync(unsafe, { mode: 0o700 });
  chmodSync(unsafe, 0o755);
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, linked);
  mkdirSync(runtime, { mode: 0o700 });
  const auth = authManager();
  try {
    await assert.rejects(
      startOwnerControlSocket(join(unsafe, "control.sock"), {
        auth,
        bootstrapOrigin: "http://localhost:43127",
      }),
      /mode 0700/,
    );
    assert.throws(() => assertOwnerRuntimeDirectory(linked), /real directory/);

    const socketPath = join(runtime, "control.sock");
    const attachLifecycle: unknown[][] = [];
    const server = await startOwnerControlSocket(socketPath, {
      auth,
      bootstrapOrigin: "http://localhost:43127",
      onAttachAuthorizeSpawn: (...args) => {
        attachLifecycle.push(["authorize", ...args]);
      },
      onAttachStarted: (...args) => {
        attachLifecycle.push(["started", ...args]);
      },
    });
    assert.equal(lstatSync(runtime).mode & 0o777, 0o700);
    assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);
    assert.equal((await requestBootstrapFromControlSocket(socketPath)).origin, "http://localhost:43127");
    await requestAttachAuthorizeSpawnFromControlSocket(
      socketPath,
      "claude:session-1",
      "handoff-1",
      "spawn-nonce-00000001",
      process.pid,
    );
    await requestAttachStartedFromControlSocket(
      socketPath,
      "claude:session-1",
      "handoff-1",
      "spawn-nonce-00000001",
      1234,
    );
    assert.deepEqual(attachLifecycle, [
      ["authorize", "claude:session-1", "handoff-1", "spawn-nonce-00000001", process.pid],
      ["started", "claude:session-1", "handoff-1", "spawn-nonce-00000001", 1234],
    ]);

    chmodSync(socketPath, 0o644);
    await assert.rejects(requestBootstrapFromControlSocket(socketPath), /mode 0600/);
    chmodSync(socketPath, 0o600);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
