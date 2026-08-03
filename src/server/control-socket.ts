import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname } from "node:path";

import type { AuthManager } from "./auth.ts";
import type { AttachInstruction } from "./contracts.ts";

const MAX_REQUEST_BYTES = 1_024;
const DIRECTORY_MODE = 0o700;
const SOCKET_MODE = 0o600;

export interface BootstrapTokenReply {
  secret: string;
  expiresAt: number;
  origin: string;
  bootstrapUrl: string;
}

export interface OwnerControlSocketHandlers {
  auth: AuthManager;
  bootstrapOrigin: string;
  onPanicLock?: () => void | Promise<void>;
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
  isLocked?: () => boolean;
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

function socketIsActive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
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
    if (await socketIsActive(path)) throw new Error(`owner control socket is already active: ${path}`);
    removeSocketIfPresent(path, existing, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.setTimeout(2_000, () => socket.destroy());
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
        if (handlers.isLocked?.() && request.command !== "panic-lock") {
          socket.end(`${JSON.stringify({ error: "control-plane-locked" })}\n`);
          return;
        }
        if (request.command === "issue-bootstrap") {
          const issued = handlers.auth.issueBootstrapToken();
          socket.end(`${JSON.stringify({
            ...issued,
            origin: handlers.bootstrapOrigin,
            bootstrapUrl: `${handlers.bootstrapOrigin}/#bootstrap=${encodeURIComponent(issued.secret)}`,
          })}\n`);
        } else if (request.command === "panic-lock") {
          void Promise.resolve(handlers.onPanicLock?.())
            .then(() => socket.end(`${JSON.stringify({ ok: true })}\n`))
            .catch(() => socket.end(`${JSON.stringify({ error: "panic-lock-failed" })}\n`));
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

export function requestPanicLockFromControlSocket(path: string): Promise<{ ok: true }> {
  return requestOwnerControlSocket<{ ok: true }>(path, { command: "panic-lock" });
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
    socket.setTimeout(2_000, () => socket.destroy(new Error("control socket timed out")));
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
