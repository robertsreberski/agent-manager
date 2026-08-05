import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { AuthManager } from "./auth.ts";
import type { AttachInstruction } from "./contracts.ts";

const MAX_REQUEST_BYTES = 1_024;
const DIRECTORY_MODE = 0o700;
const SOCKET_MODE = 0o600;
const ORDINARY_REQUEST_TIMEOUT_MS = 2_000;
// Native attach preparation has its own 30-second provider deadline. Leave
// enough transport margin for that deadline to settle and serialize a reply.
const ATTACH_PREPARATION_TIMEOUT_MS = 35_000;
// A started acknowledgement can perform two independent five-second identity
// scans before it commits native ownership. Keep real transport margin around
// both scans; timing out the wrapper while the owner is still validating would
// create an avoidable uncertain-cleanup state. Pre-spawn authorization stays
// on the ordinary short deadline.
const ATTACH_LIFECYCLE_TIMEOUT_MS = 15_000;
const instanceLeaseSockets = new WeakMap<Server, Set<Socket>>();
const instanceLeaseClosures = new WeakMap<Server, Promise<void>>();

function requestTimeoutMs(command: unknown): number {
  if (command === "attach") return ATTACH_PREPARATION_TIMEOUT_MS;
  if (
    command === "attach-started"
    || command === "attach-exited"
    || command === "attach-failed"
  ) {
    return ATTACH_LIFECYCLE_TIMEOUT_MS;
  }
  return ORDINARY_REQUEST_TIMEOUT_MS;
}

export interface BootstrapTokenReply {
  secret: string;
  expiresAt: number;
  origin: string;
  bootstrapUrl: string;
}

export interface OwnerControlSocketHandlers {
  auth: AuthManager;
  bootstrapOrigin: string;
  /** Reloads one-way provider-hook authorization digests from the owned database. */
  onReloadHooks?: () => void | Promise<void>;
  onAttach?: (sessionId: string) => Promise<AttachInstruction>;
  onAttachAuthorizeSpawn?: (
    sessionId: string,
    handoffId: string,
    spawnNonce: string,
    wrapperPid: number,
  ) => void | Promise<void>;
  onAttachStarted?: (
    sessionId: string,
    handoffId: string,
    spawnNonce: string,
    pid: number,
  ) => void | Promise<void>;
  onAttachExited?: (
    sessionId: string,
    handoffId: string,
    exitCode: number | null,
  ) => void | Promise<void>;
  onAttachFailed?: (sessionId: string, handoffId: string, error: string) => void | Promise<void>;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("owner control sockets require an operating-system user id");
  }
  return process.getuid();
}

function permissions(stat: Stats): number {
  return stat.mode & 0o777;
}

export function assertOwnerRuntimeDirectory(directory: string, uid = currentUid()): Stats {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`owner control directory must be a real directory: ${directory}`);
  }
  if (stat.uid !== uid) {
    throw new Error(`owner control directory is not owned by the current user: ${directory}`);
  }
  if (permissions(stat) !== DIRECTORY_MODE) {
    throw new Error(`owner control directory must have mode 0700: ${directory}`);
  }
  return stat;
}

export function ensureOwnerRuntimeDirectory(directory: string, uid = currentUid()): Stats {
  try {
    return assertOwnerRuntimeDirectory(directory, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);
  return assertOwnerRuntimeDirectory(directory, uid);
}

export function assertOwnerControlSocket(path: string, uid = currentUid()): Stats {
  assertOwnerRuntimeDirectory(dirname(path), uid);
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error(`owner control path must be a Unix socket: ${path}`);
  }
  if (stat.uid !== uid) {
    throw new Error(`owner control socket is not owned by the current user: ${path}`);
  }
  if (permissions(stat) !== SOCKET_MODE) {
    throw new Error(`owner control socket must have mode 0600: ${path}`);
  }
  return stat;
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function removeSocketIfPresent(path: string, expected: Stats, uid: number): void {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isSocket()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || permissions(stat) !== SOCKET_MODE
      || !sameFile(stat, expected)
    ) {
      throw new Error(`refusing to replace changed or unsafe control path: ${path}`);
    }
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

export type OwnerSocketProbeResult = "live" | "dead" | "missing" | "inconclusive";

function probeErrorResult(error: unknown): OwnerSocketProbeResult {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return "dead";
  if (code === "ENOENT") return "missing";
  return "inconclusive";
}

export function probeOwnerSocket(
  path: string,
  connect: (socketPath: string) => Socket = createConnection,
): Promise<OwnerSocketProbeResult> {
  return new Promise((resolve) => {
    let socket: Socket;
    try {
      socket = connect(path);
    } catch (error) {
      resolve(probeErrorResult(error));
      return;
    }

    let settled = false;
    const finish = (result: OwnerSocketProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.destroy();
      resolve(result);
    };
    const onConnect = (): void => finish("live");
    const onError = (error: Error): void => finish(probeErrorResult(error));
    const timer = setTimeout(() => finish("inconclusive"), 250);
    timer.unref();
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function removeStaleOwnerSocket(
  path: string,
  existing: Stats,
  uid: number,
  activeMessage: string,
): Promise<void> {
  const result = await probeOwnerSocket(path);
  if (result === "live") throw new Error(activeMessage);
  if (result === "inconclusive") {
    throw new Error(`could not safely determine owner socket liveness: ${path}`);
  }
  if (result === "dead") removeSocketIfPresent(path, existing, uid);
}

/**
 * Atomically claims one runtime directory before any provider process is
 * started. The listening socket itself is the lease: kernel bind arbitration
 * chooses exactly one owner, and an active owner is never unlinked.
 *
 * This is deliberately separate from the authenticated control socket. The
 * latter is assembled by the HTTP server and therefore cannot protect the
 * provider-construction boundary.
 */
export async function startOwnerInstanceLease(path: string): Promise<Server> {
  const uid = currentUid();
  ensureOwnerRuntimeDirectory(dirname(path), uid);
  try {
    const existing = lstatSync(path);
    if (!existing.isSocket() || existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-socket owner lease path: ${path}`);
    }
    if (existing.uid !== uid || permissions(existing) !== SOCKET_MODE) {
      throw new Error(`refusing unsafe existing owner lease socket: ${path}`);
    }
    await removeStaleOwnerSocket(
      path,
      existing,
      uid,
      `another Agent Manager already owns this runtime: ${path}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const startedAt = new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString();
  const identity = JSON.stringify({ pid: process.pid, uid, startedAt });
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(1_000, () => socket.destroy());
    socket.end(`${identity}\n`);
  });
  instanceLeaseSockets.set(server, sockets);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(path, SOCKET_MODE);
    const leaseIdentity = assertOwnerControlSocket(path, uid);
    server.once("close", () => {
      try {
        const current = lstatSync(path);
        if (current.isSocket() && current.uid === uid && sameFile(current, leaseIdentity)) {
          unlinkSync(path);
        }
      } catch {
        // A replaced or already-removed path must not make shutdown fail.
      }
    });
    return server;
  } catch (error) {
    try {
      server.close();
    } catch {
      // Binding may not have completed.
    }
    throw error;
  }
}

/**
 * Releases the kernel-owned instance lease and its short-lived identity probes.
 * This never touches provider or attach processes: the tracked sockets belong
 * only to the instance-ownership listener created above.
 */
export function closeOwnerInstanceLease(server: Server): Promise<void> {
  const existing = instanceLeaseClosures.get(server);
  if (existing) return existing;

  const closing = new Promise<void>((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
      // A peer can stop reading after connecting. Destroy only lease-probe
      // sockets so that such a peer cannot prolong manager shutdown.
      for (const socket of instanceLeaseSockets.get(server) ?? []) socket.destroy();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
  instanceLeaseClosures.set(server, closing);
  return closing;
}

export async function startOwnerControlSocket(
  path: string,
  handlers: OwnerControlSocketHandlers,
): Promise<Server> {
  const uid = currentUid();
  ensureOwnerRuntimeDirectory(dirname(path), uid);
  try {
    const existing = lstatSync(path);
    if (!existing.isSocket() || existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-socket control path: ${path}`);
    }
    if (existing.uid !== uid || permissions(existing) !== SOCKET_MODE) {
      throw new Error(`refusing unsafe existing owner control socket: ${path}`);
    }
    await removeStaleOwnerSocket(
      path,
      existing,
      uid,
      `owner control socket is already active: ${path}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    // Keep unauthenticated request ingress short. Once a complete command is
    // parsed, align the server-side deadline with that command's bounded work.
    socket.setTimeout(ORDINARY_REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ error: "request-too-large" })}\n`);
        return;
      }
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const request = JSON.parse(input.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
        socket.setTimeout(requestTimeoutMs(request.command));
        if (request.command === "issue-bootstrap") {
          const issued = handlers.auth.issueBootstrapToken();
          socket.end(`${JSON.stringify({
            ...issued,
            origin: handlers.bootstrapOrigin,
            bootstrapUrl: `${handlers.bootstrapOrigin}/#bootstrap=${encodeURIComponent(issued.secret)}`,
          })}\n`);
        } else if (
          request.command === "reload-hooks"
          && Object.keys(request).length === 1
          && handlers.onReloadHooks
        ) {
          void Promise.resolve(handlers.onReloadHooks())
            .then(() => socket.end(`${JSON.stringify({ ok: true })}\n`))
            .catch(() => socket.end(`${JSON.stringify({ error: "hook-reload-failed" })}\n`));
        } else if (
          request.command === "attach"
          && typeof request.sessionId === "string"
          && handlers.onAttach
        ) {
          void handlers.onAttach(request.sessionId)
            .then((instruction) => socket.end(`${JSON.stringify({ instruction })}\n`))
            .catch(() => socket.end(`${JSON.stringify({ error: "attach-unavailable" })}\n`));
        } else if (
          request.command === "attach-authorize-spawn"
          && typeof request.sessionId === "string"
          && typeof request.handoffId === "string"
          && typeof request.spawnNonce === "string"
          && request.spawnNonce.length >= 16
          && request.spawnNonce.length <= 256
          && typeof request.wrapperPid === "number"
          && Number.isSafeInteger(request.wrapperPid)
          && request.wrapperPid > 0
          && handlers.onAttachAuthorizeSpawn
        ) {
          void Promise.resolve(handlers.onAttachAuthorizeSpawn(
            request.sessionId,
            request.handoffId,
            request.spawnNonce,
            request.wrapperPid,
          ))
            .then(() => socket.end(`${JSON.stringify({ ok: true })}\n`))
            .catch(() => socket.end(`${JSON.stringify({ error: "attach-lifecycle-failed" })}\n`));
        } else if (
          request.command === "attach-started"
          && typeof request.sessionId === "string"
          && typeof request.handoffId === "string"
          && typeof request.spawnNonce === "string"
          && request.spawnNonce.length >= 16
          && request.spawnNonce.length <= 256
          && typeof request.pid === "number"
          && Number.isSafeInteger(request.pid)
          && request.pid > 0
          && handlers.onAttachStarted
        ) {
          void Promise.resolve(handlers.onAttachStarted(
            request.sessionId,
            request.handoffId,
            request.spawnNonce,
            request.pid,
          ))
            .then(() => socket.end(`${JSON.stringify({ ok: true })}\n`))
            .catch(() => socket.end(`${JSON.stringify({ error: "attach-lifecycle-failed" })}\n`));
        } else if (
          request.command === "attach-exited"
          && typeof request.sessionId === "string"
          && typeof request.handoffId === "string"
          && (request.exitCode === null || (typeof request.exitCode === "number" && Number.isInteger(request.exitCode)))
          && handlers.onAttachExited
        ) {
          void Promise.resolve(handlers.onAttachExited(
            request.sessionId,
            request.handoffId,
            request.exitCode as number | null,
          ))
            .then(() => socket.end(`${JSON.stringify({ ok: true })}\n`))
            .catch(() => socket.end(`${JSON.stringify({ error: "attach-lifecycle-failed" })}\n`));
        } else if (
          request.command === "attach-failed"
          && typeof request.sessionId === "string"
          && typeof request.handoffId === "string"
          && typeof request.error === "string"
          && request.error.length <= 1_024
          && handlers.onAttachFailed
        ) {
          void Promise.resolve(handlers.onAttachFailed(request.sessionId, request.handoffId, request.error))
            .then(() => socket.end(`${JSON.stringify({ ok: true })}\n`))
            .catch(() => socket.end(`${JSON.stringify({ error: "attach-lifecycle-failed" })}\n`));
        } else {
          socket.end(`${JSON.stringify({ error: "unsupported-command" })}\n`);
        }
      } catch {
        socket.end(`${JSON.stringify({ error: "invalid-request" })}\n`);
      }
    });
  });
  let identity: Stats;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        try {
          chmodSync(path, SOCKET_MODE);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    identity = assertOwnerControlSocket(path, uid);
  } catch (error) {
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    try {
      const current = lstatSync(path);
      if (current.isSocket() && current.uid === uid) unlinkSync(path);
    } catch {
      // Best-effort cleanup of a socket that failed post-bind validation.
    }
    throw error;
  }
  server.once("close", () => {
    try {
      const current = lstatSync(path);
      if (current.isSocket() && current.uid === uid && sameFile(current, identity)) {
        unlinkSync(path);
      }
    } catch {
      // Shutdown must not fail because another process already removed it.
    }
  });
  return server;
}

export function requestBootstrapFromControlSocket(path: string): Promise<BootstrapTokenReply> {
  return requestOwnerControlSocket<BootstrapTokenReply>(path, { command: "issue-bootstrap" });
}

export function requestHooksReloadFromControlSocket(
  path: string,
): Promise<{ ok: true }> {
  return requestOwnerControlSocket<{ ok: true }>(path, {
    command: "reload-hooks",
  });
}

export function requestAttachFromControlSocket(
  path: string,
  sessionId: string,
): Promise<{ instruction: AttachInstruction }> {
  return requestOwnerControlSocket<{ instruction: AttachInstruction }>(path, {
    command: "attach",
    sessionId,
  });
}

export function requestAttachStartedFromControlSocket(
  path: string,
  sessionId: string,
  handoffId: string,
  spawnNonce: string,
  pid: number,
): Promise<{ ok: true }> {
  return requestOwnerControlSocket<{ ok: true }>(path, {
    command: "attach-started",
    sessionId,
    handoffId,
    spawnNonce,
    pid,
  });
}

export function requestAttachAuthorizeSpawnFromControlSocket(
  path: string,
  sessionId: string,
  handoffId: string,
  spawnNonce: string,
  wrapperPid: number,
): Promise<{ ok: true }> {
  return requestOwnerControlSocket<{ ok: true }>(path, {
    command: "attach-authorize-spawn",
    sessionId,
    handoffId,
    spawnNonce,
    wrapperPid,
  });
}

export function requestAttachExitedFromControlSocket(
  path: string,
  sessionId: string,
  handoffId: string,
  exitCode: number | null,
): Promise<{ ok: true }> {
  return requestOwnerControlSocket<{ ok: true }>(path, {
    command: "attach-exited",
    sessionId,
    handoffId,
    exitCode,
  });
}

export function requestAttachFailedFromControlSocket(
  path: string,
  sessionId: string,
  handoffId: string,
  error: string,
): Promise<{ ok: true }> {
  return requestOwnerControlSocket<{ ok: true }>(path, {
    command: "attach-failed",
    sessionId,
    handoffId,
    error: error.slice(0, 1_024),
  });
}

function requestOwnerControlSocket<T>(path: string, request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    let identity: Stats;
    try {
      identity = assertOwnerControlSocket(path);
    } catch (error) {
      reject(error);
      return;
    }
    const socket = createConnection(path);
    let response = Buffer.alloc(0);
    let replyIdentityValidated = false;
    socket.setTimeout(
      requestTimeoutMs(request.command),
      () => socket.destroy(new Error("control socket timed out")),
    );
    socket.once("connect", () => {
      try {
        const current = assertOwnerControlSocket(path);
        if (!sameFile(identity, current)) throw new Error("owner control socket changed during connect");
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (!replyIdentityValidated) {
        try {
          const current = assertOwnerControlSocket(path);
          if (!sameFile(identity, current)) throw new Error("owner control socket changed before reply");
          replyIdentityValidated = true;
        } catch (error) {
          socket.destroy(error as Error);
          return;
        }
      }
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_REQUEST_BYTES) socket.destroy(new Error("control response too large"));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(response.toString("utf8")) as T & { error?: string };
        if (parsed.error) {
          reject(new Error(parsed.error));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}
