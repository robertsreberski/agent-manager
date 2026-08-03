import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import { defaultPaths, type AgentManagerPaths } from "./config.ts";

const DIRECTORY_MODE = 0o700;
const SENTINEL_MODE = 0o600;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Panic locking requires an operating-system user id");
  }
  return process.getuid();
}

function assertPrivateDirectory(path: string, uid = currentUid()): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Panic-lock directory must be a real directory: ${path}`);
  }
  if (stat.uid !== uid || (stat.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`Panic-lock directory must be owned by the current user with mode 0700: ${path}`);
  }
}

function ensurePrivateDirectory(path: string): void {
  try {
    assertPrivateDirectory(path);
    return;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  assertPrivateDirectory(path);
}

function assertSentinel(path: string, uid = currentUid()): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Panic-lock sentinel must be a regular file: ${path}`);
  }
  if (stat.uid !== uid || (stat.mode & 0o777) !== SENTINEL_MODE) {
    throw new Error(`Panic-lock sentinel must be owned by the current user with mode 0600: ${path}`);
  }
  return stat;
}

export function panicLockPath(paths: AgentManagerPaths = defaultPaths()): string {
  return join(paths.dataDirectory, "panic.lock");
}

/** Persist the fail-closed launchd sentinel. Returns false when already engaged. */
export function engagePanicLock(paths: AgentManagerPaths = defaultPaths()): boolean {
  ensurePrivateDirectory(paths.dataDirectory);
  const path = panicLockPath(paths);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      SENTINEL_MODE,
    );
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      assertSentinel(path);
      return false;
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ engagedAt: new Date().toISOString() })}\n`, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    try {
      unlinkSync(path);
    } catch {
      // Preserve the creation failure.
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
  assertSentinel(path);
  return true;
}

export function releasePanicLock(paths: AgentManagerPaths = defaultPaths()): boolean {
  const path = panicLockPath(paths);
  try {
    assertPrivateDirectory(paths.dataDirectory);
    assertSentinel(path);
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export function assertPanicUnlocked(paths: AgentManagerPaths = defaultPaths()): void {
  const path = panicLockPath(paths);
  try {
    assertPrivateDirectory(paths.dataDirectory);
    assertSentinel(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(
    `Agent Manager panic lock is engaged at ${path}; run agent-manager panic-unlock to resume`,
  );
}
