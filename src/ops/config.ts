import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
}

export interface AgentManagerConfig {
  version: 1;
  backend: {
    host: "127.0.0.1";
    port: number;
  };
  tailscale: {
    httpsPort: number;
    allowedLogin: string | null;
    dnsName: string | null;
  };
  workspaces: WorkspaceConfig[];
}

export interface AgentManagerPaths {
  dataDirectory: string;
  configFile: string;
  databaseFile: string;
  auditFile: string;
  runtimeDirectory: string;
  codexSocket: string;
}

export interface ConfigLockOptions {
  /** Maximum time to wait for another process, in milliseconds. */
  timeoutMs?: number;
  /** Delay between acquisition attempts, in milliseconds. */
  pollIntervalMs?: number;
  /** Age after which an unreadable claim may be reclaimed; minimum 1 second. */
  staleAfterMs?: number;
}

export class ConfigConflictError extends Error {
  readonly code = "CONFIG_CONFLICT";
  readonly expectedRevision: string;
  readonly actualRevision: string;

  constructor(expectedRevision: string, actualRevision: string) {
    super("Agent Manager config changed while it was being updated; refusing a stale write");
    this.name = "ConfigConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class ConfigLockTimeoutError extends Error {
  readonly code = "CONFIG_LOCK_TIMEOUT";
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out waiting for the Agent Manager config lock after ${String(timeoutMs)}ms`);
    this.name = "ConfigLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

interface ConfigSnapshot {
  config: AgentManagerConfig;
  revision: string;
}

interface ConfigLockRecord {
  pid: number;
  token: string;
  createdAtMs: number;
  state: "choosing" | "waiting";
  ticket: string | null;
}

interface ConfigLockClaim {
  path: string;
  token: string;
  mtimeMs: number;
  record: ConfigLockRecord | null;
}

interface ConfigLockHandle {
  directoryPath: string;
  claimPath: string;
  token: string;
}

interface HeldConfigLock {
  depth: number;
  handle: ConfigLockHandle;
}

const MISSING_CONFIG_REVISION = "missing";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 20;
const DEFAULT_STALE_LOCK_MS = 30_000;
const MINIMUM_STALE_LOCK_MS = 1_000;
const CLAIM_NAME_PATTERN = /^claim-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const TICKET_PATTERN = /^[1-9][0-9]{0,39}$/u;
const loadedConfigRevisions = new WeakMap<AgentManagerConfig, string>();
const heldConfigLocks = new Map<string, HeldConfigLock>();
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function defaultPaths(homeDirectory = homedir(), uid = process.getuid?.() ?? 0): AgentManagerPaths {
  const dataDirectory = join(homeDirectory, "Library", "Application Support", "agent-manager");
  const runtimeDirectory = `/private/tmp/agent-manager-${uid}`;
  return {
    dataDirectory,
    configFile: join(dataDirectory, "config.json"),
    databaseFile: join(dataDirectory, "state.sqlite"),
    auditFile: join(dataDirectory, "audit.jsonl"),
    runtimeDirectory,
    codexSocket: join(runtimeDirectory, "codex.sock"),
  };
}

export function defaultConfig(): AgentManagerConfig {
  return {
    version: 1,
    backend: { host: "127.0.0.1", port: 43_127 },
    tailscale: { httpsPort: 9_443, allowedLogin: null, dnsName: null },
    workspaces: [],
  };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? "then" in value && typeof value.then === "function"
    : false;
}

function isSafeIdentityText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSafeDnsName(value: unknown): value is string {
  if (!isSafeIdentityText(value, 253)) return false;
  const labels = value.split(".");
  return labels.every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  );
}

function validateConfig(value: unknown): AgentManagerConfig {
  if (!value || typeof value !== "object") throw new Error("Agent Manager config must be an object");
  const config = value as Partial<AgentManagerConfig>;
  if (config.version !== 1) throw new Error("Unsupported Agent Manager config version");
  if (config.backend?.host !== "127.0.0.1") throw new Error("Backend host must be 127.0.0.1");
  if (
    !Number.isInteger(config.backend.port)
    || config.backend.port < 1
    || config.backend.port > 65_535
  ) throw new Error("Backend port is invalid");
  if (
    !Number.isInteger(config.tailscale?.httpsPort)
    || config.tailscale!.httpsPort < 1
    || config.tailscale!.httpsPort > 65_535
  ) throw new Error("Tailscale HTTPS port is invalid");
  const allowedLogin = config.tailscale!.allowedLogin;
  const dnsName = config.tailscale!.dnsName;
  if ((allowedLogin === null) !== (dnsName === null)) {
    throw new Error("Tailscale login and device DNS identity must be configured together");
  }
  if (
    (allowedLogin !== null && !isSafeIdentityText(allowedLogin, 320))
    || (dnsName !== null && !isSafeDnsName(dnsName))
  ) throw new Error("Tailscale identity is invalid");
  if (!Array.isArray(config.workspaces)) throw new Error("Workspaces must be an array");
  for (const workspace of config.workspaces) {
    if (!workspace.id || !workspace.name || !workspace.path) {
      throw new Error("Workspace entry is incomplete");
    }
  }
  return config as AgentManagerConfig;
}

function serializedConfig(config: AgentManagerConfig): string {
  validateConfig(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

function revisionForContents(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function readConfigContents(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function readConfigSnapshot(paths: AgentManagerPaths): ConfigSnapshot {
  const contents = readConfigContents(paths.configFile);
  const config = contents === null
    ? defaultConfig()
    : validateConfig(JSON.parse(contents) as unknown);
  const revision = contents === null ? MISSING_CONFIG_REVISION : revisionForContents(contents);
  loadedConfigRevisions.set(config, revision);
  return { config, revision };
}

export function loadConfig(paths: AgentManagerPaths = defaultPaths()): AgentManagerConfig {
  return readConfigSnapshot(paths).config;
}

function prepareConfigDirectory(paths: AgentManagerPaths): void {
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.dataDirectory, 0o700);
}

export function configLockPath(paths: AgentManagerPaths = defaultPaths()): string {
  return `${paths.configFile}.lock`;
}

function validatedDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.floor(value);
}

function lockSettings(options: ConfigLockOptions): Required<ConfigLockOptions> {
  const staleAfterMs = validatedDuration(
    options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS,
    "staleAfterMs",
  );
  if (staleAfterMs < MINIMUM_STALE_LOCK_MS) {
    throw new RangeError(`staleAfterMs must be at least ${String(MINIMUM_STALE_LOCK_MS)}ms`);
  }
  return {
    timeoutMs: validatedDuration(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "timeoutMs"),
    pollIntervalMs: validatedDuration(
      options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
      "pollIntervalMs",
    ),
    staleAfterMs,
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function assertPrivateLockDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Agent Manager config lock path is not a private directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Agent Manager config lock directory is not owned by the current user");
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error("Agent Manager config lock directory must have mode 0700");
  }
}

function ensureLockDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  assertPrivateLockDirectory(path);
}

function claimToken(name: string): string | null {
  return name.match(CLAIM_NAME_PATTERN)?.[1] ?? null;
}

function claimPath(directoryPath: string, token: string): string {
  return join(directoryPath, `claim-${token}.json`);
}

function validLockRecord(value: unknown, token: string): ConfigLockRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ConfigLockRecord>;
  if (
    !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || record.token !== token
    || typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)
  ) return null;
  if (record.state === "choosing" && record.ticket === null) {
    return record as ConfigLockRecord;
  }
  if (
    record.state === "waiting"
    && typeof record.ticket === "string"
    && TICKET_PATTERN.test(record.ticket)
  ) return record as ConfigLockRecord;
  return null;
}

function inspectClaim(path: string, token: string): ConfigLockClaim | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }

  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error(`Agent Manager config claim is not a file: ${path}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Agent Manager config claim is not owned by the current user");
    }
    if ((info.mode & 0o777) !== 0o600) {
      throw new Error("Agent Manager config claim must have mode 0600");
    }
    let record: ConfigLockRecord | null = null;
    try {
      record = validLockRecord(JSON.parse(readFileSync(descriptor, "utf8")) as unknown, token);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { path, token, mtimeMs: info.mtimeMs, record };
  } finally {
    closeSync(descriptor);
  }
}

function writeNewClaim(path: string, record: ConfigLockRecord): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    try {
      unlinkSync(path);
    } catch (cleanupError) {
      if (!isErrno(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function rewriteClaim(path: string, record: ConfigLockRecord): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error("Agent Manager config claim changed type");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Agent Manager config claim changed owner");
    }
    if ((info.mode & 0o777) !== 0o600) {
      throw new Error("Agent Manager config claim changed mode");
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeUniqueClaim(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function activeClaims(directoryPath: string, staleAfterMs: number): ConfigLockClaim[] {
  const claims: ConfigLockClaim[] = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const token = claimToken(entry.name);
    if (!token) {
      throw new Error(`Agent Manager config lock directory contains an unexpected entry: ${entry.name}`);
    }
    const claim = inspectClaim(join(directoryPath, entry.name), token);
    if (!claim) continue;
    const abandoned = claim.record
      ? !processIsAlive(claim.record.pid)
      : Date.now() - claim.mtimeMs >= staleAfterMs;
    if (abandoned) {
      // Claim paths include a never-reused random token. Concurrent reclaimers
      // can only race to remove this generation; they cannot name a new owner.
      removeUniqueClaim(claim.path);
      continue;
    }
    claims.push(claim);
  }
  return claims;
}

function compareClaimPriority(
  leftTicket: string,
  leftToken: string,
  rightTicket: string,
  rightToken: string,
): number {
  const left = BigInt(leftTicket);
  const right = BigInt(rightTicket);
  if (left < right) return -1;
  if (left > right) return 1;
  if (leftToken < rightToken) return -1;
  if (leftToken > rightToken) return 1;
  return 0;
}

function createChoosingClaim(directoryPath: string): { claimPath: string; record: ConfigLockRecord } {
  while (true) {
    const token = randomUUID();
    const path = claimPath(directoryPath, token);
    const record: ConfigLockRecord = {
      pid: process.pid,
      token,
      createdAtMs: Date.now(),
      state: "choosing",
      ticket: null,
    };
    try {
      writeNewClaim(path, record);
      return { claimPath: path, record };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
}

function acquireConfigLock(
  directoryPath: string,
  options: Required<ConfigLockOptions>,
): ConfigLockHandle {
  ensureLockDirectory(directoryPath);
  const deadline = Date.now() + options.timeoutMs;
  const choosing = createChoosingClaim(directoryPath);
  const token = choosing.record.token;
  try {
    let maximumTicket = 0n;
    for (const claim of activeClaims(directoryPath, options.staleAfterMs)) {
      if (claim.record?.state === "waiting") {
        const ticket = BigInt(claim.record.ticket!);
        if (ticket > maximumTicket) maximumTicket = ticket;
      }
    }
    const ticket = String(maximumTicket + 1n);
    rewriteClaim(choosing.claimPath, { ...choosing.record, state: "waiting", ticket });

    while (true) {
      const claims = activeClaims(directoryPath, options.staleAfterMs);
      if (!claims.some((claim) => claim.token === token)) {
        throw new Error("Agent Manager config lock claim disappeared during acquisition");
      }
      const blocked = claims.some((claim) => {
        if (claim.token === token) return false;
        if (!claim.record || claim.record.state === "choosing") return true;
        return compareClaimPriority(
          claim.record.ticket!,
          claim.token,
          ticket,
          token,
        ) < 0;
      });
      if (!blocked) return { directoryPath, claimPath: choosing.claimPath, token };
      if (Date.now() >= deadline) {
        throw new ConfigLockTimeoutError(directoryPath, options.timeoutMs);
      }
      const remaining = Math.max(0, deadline - Date.now());
      const delay = Math.min(Math.max(1, options.pollIntervalMs), remaining);
      Atomics.wait(sleepCell, 0, 0, delay);
    }
  } catch (error) {
    removeUniqueClaim(choosing.claimPath);
    throw error;
  }
}

function releaseConfigLock(handle: ConfigLockHandle): void {
  const claim = inspectClaim(handle.claimPath, handle.token);
  if (
    !claim?.record
    || claim.record.pid !== process.pid
    || claim.record.state !== "waiting"
  ) throw new Error("Agent Manager config lock ownership was lost before release");
  // This exact UUID path is never reused, so release cannot unlink a later owner.
  unlinkSync(handle.claimPath);
}

/**
 * Run a synchronous operation while holding the owner-only interprocess config lock.
 * The lock path is a persistent 0700 directory; each contender uses a never-reused
 * UUID claim and bakery ticket. Nested synchronous calls are re-entrant. Async
 * callbacks are rejected so the claim cannot be released before their work completes.
 */
export function withConfigLock<T>(
  operation: () => T,
  paths: AgentManagerPaths = defaultPaths(),
  options: ConfigLockOptions = {},
): T {
  const path = configLockPath(paths);
  const held = heldConfigLocks.get(path);
  if (held) {
    held.depth += 1;
    try {
      const result = operation();
      if (isPromiseLike(result)) throw new TypeError("withConfigLock operation must be synchronous");
      return result;
    } finally {
      held.depth -= 1;
    }
  }

  prepareConfigDirectory(paths);
  const handle = acquireConfigLock(path, lockSettings(options));
  heldConfigLocks.set(path, { depth: 1, handle });
  try {
    const result = operation();
    if (isPromiseLike(result)) throw new TypeError("withConfigLock operation must be synchronous");
    return result;
  } finally {
    heldConfigLocks.delete(path);
    releaseConfigLock(handle);
  }
}

function writeConfigIfCurrent(
  config: AgentManagerConfig,
  paths: AgentManagerPaths,
  expectedRevision: string | undefined,
): void {
  const contents = serializedConfig(config);
  prepareConfigDirectory(paths);
  const temporary = `${paths.configFile}.${String(process.pid)}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    if (expectedRevision !== undefined) {
      const currentContents = readConfigContents(paths.configFile);
      const actualRevision = currentContents === null
        ? MISSING_CONFIG_REVISION
        : revisionForContents(currentContents);
      if (actualRevision !== expectedRevision) {
        throw new ConfigConflictError(expectedRevision, actualRevision);
      }
    }

    renameSync(temporary, paths.configFile);
    loadedConfigRevisions.set(config, revisionForContents(contents));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
}

/**
 * Persist a config under the interprocess lock. Config objects returned by
 * loadConfig carry an internal revision and are compare-and-swapped; a stale
 * object throws ConfigConflictError instead of overwriting a newer config.
 */
export function saveConfig(config: AgentManagerConfig, paths: AgentManagerPaths = defaultPaths()): void {
  withConfigLock(() => {
    writeConfigIfCurrent(config, paths, loadedConfigRevisions.get(config));
  }, paths);
}

/**
 * Atomically reload, synchronously mutate, validate, compare-and-swap, and save
 * the config while holding the interprocess lock. The mutator's return value is
 * returned to the caller; an unchanged config is not rewritten.
 */
export function mutateConfig<T>(
  mutator: (config: AgentManagerConfig) => T,
  paths: AgentManagerPaths = defaultPaths(),
  options: ConfigLockOptions = {},
): T {
  return withConfigLock(() => {
    const snapshot = readConfigSnapshot(paths);
    const before = serializedConfig(snapshot.config);
    const result = mutator(snapshot.config);
    if (isPromiseLike(result)) throw new TypeError("mutateConfig mutator must be synchronous");
    const after = serializedConfig(snapshot.config);
    if (after !== before) {
      writeConfigIfCurrent(snapshot.config, paths, snapshot.revision);
    }
    return result;
  }, paths, options);
}

function workspaceId(path: string): string {
  return `ws_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

export function addWorkspace(config: AgentManagerConfig, requestedPath: string): WorkspaceConfig {
  const path = realpathSync(requestedPath);
  if (!statSync(path).isDirectory()) throw new Error("Workspace path must be a directory");
  const existing = config.workspaces.find((workspace) => workspace.path === path);
  if (existing) return existing;
  const workspace = { id: workspaceId(path), name: basename(path), path };
  config.workspaces.push(workspace);
  config.workspaces.sort((left, right) => left.name.localeCompare(right.name));
  return workspace;
}

export function removeWorkspace(config: AgentManagerConfig, id: string): boolean {
  const index = config.workspaces.findIndex((workspace) => workspace.id === id);
  if (index < 0) return false;
  config.workspaces.splice(index, 1);
  return true;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function assertDirectory(path: string, label: string, requirePrivate: boolean): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${path}`);
  }
  if (requirePrivate) {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`${label} is not owned by the current user`);
    }
    if ((info.mode & 0o777) !== 0o700) {
      throw new Error(`${label} must have mode 0700`);
    }
  }
}

/**
 * Establish the private runtime boundary without following or repairing a
 * pre-existing unsafe path. The Codex socket must be a canonical direct child.
 */
export function ensurePrivateRuntimeDirectory(paths: AgentManagerPaths = defaultPaths()): void {
  if (!isAbsolute(paths.runtimeDirectory) || resolve(paths.runtimeDirectory) !== paths.runtimeDirectory) {
    throw new Error("Runtime directory must be an absolute canonical path");
  }
  if (!isAbsolute(paths.codexSocket) || resolve(paths.codexSocket) !== paths.codexSocket) {
    throw new Error("Codex socket must use an absolute canonical path");
  }
  if (dirname(paths.codexSocket) !== paths.runtimeDirectory) {
    throw new Error("Codex socket must live directly inside the private runtime directory");
  }

  const runtimeParent = dirname(paths.runtimeDirectory);
  assertDirectory(runtimeParent, "Runtime parent", false);

  const existing = lstatIfPresent(paths.runtimeDirectory);
  if (existing) {
    assertDirectory(paths.runtimeDirectory, "Runtime directory", true);
  } else {
    let createdByUs = false;
    try {
      mkdirSync(paths.runtimeDirectory, { mode: 0o700 });
      createdByUs = true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    if (!createdByUs) {
      assertDirectory(paths.runtimeDirectory, "Runtime directory", true);
    } else {
      assertDirectory(paths.runtimeDirectory, "Runtime directory", false);
      const descriptor = openSync(
        paths.runtimeDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fchmodSync(descriptor, 0o700);
        const created = fstatSync(descriptor);
        if (!created.isDirectory()) throw new Error("Runtime directory changed during creation");
        if (typeof process.getuid === "function" && created.uid !== process.getuid()) {
          throw new Error("Runtime directory is not owned by the current user");
        }
        if ((created.mode & 0o777) !== 0o700) {
          throw new Error("Runtime directory could not be secured to mode 0700");
        }
      } finally {
        closeSync(descriptor);
      }
    }
  }

  // Re-lstat both security-relevant names after creation. They intentionally
  // resolve to the same directory, but checking both closes future path drift.
  assertDirectory(paths.runtimeDirectory, "Runtime directory", true);
  assertDirectory(dirname(paths.codexSocket), "Codex socket parent", true);
}
