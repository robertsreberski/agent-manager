import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export const PLAN_FILE_LIMITS = Object.freeze({
  bytes: 256 * 1_024,
});

export type PlanFileUnavailableReason =
  | "outside-allowed-roots"
  | "not-found"
  | "unreadable";

export type PlanFileReadResult =
  | { state: "available"; markdown: string; truncated: boolean }
  | { state: "unavailable"; reason: PlanFileUnavailableReason };

export interface PlanFileReader {
  read(path: string): PlanFileReadResult;
}

export interface LocalPlanFileReaderOptions {
  /** Replaces the production roots; intended for an explicit deployment or tests. */
  allowedRoots?: readonly string[];
  homeDirectory?: string;
  runtimeDirectory?: string;
  uid?: number;
  /** May lower, but never raise, the product byte cap. */
  maxBytes?: number;
}

interface RootInfo {
  lexical: string;
  canonical: string;
}

interface OpenPlanFile {
  descriptor: number;
  stat: Stats;
}

class PlanFileFailure extends Error {
  readonly reason: PlanFileUnavailableReason;

  constructor(reason: PlanFileUnavailableReason) {
    super(reason);
    this.name = "PlanFileFailure";
    this.reason = reason;
  }
}

function failure(reason: PlanFileUnavailableReason): never {
  throw new PlanFileFailure(reason);
}

function isConfined(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (
    remainder !== ".."
    && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder)
  );
}

/** Checks every existing component, including the configured root and leaf. */
function hasSymlinkComponent(path: string): boolean {
  const absolute = resolve(path);
  const filesystemRoot = parse(absolute).root;
  const remainder = relative(filesystemRoot, absolute);
  let cursor = filesystemRoot;
  for (const component of remainder.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function inspectRoot(path: string, uid: number): RootInfo {
  if (hasSymlinkComponent(path)) failure("unreadable");
  try {
    const lexical = resolve(path);
    const canonical = realpathSync(lexical);
    const stat = statSync(canonical);
    if (!stat.isDirectory() || stat.uid !== uid) failure("unreadable");
    return { lexical, canonical };
  } catch (error) {
    if (error instanceof PlanFileFailure) throw error;
    failure("not-found");
  }
}

function openPlanFile(root: RootInfo, path: string, uid: number): OpenPlanFile {
  const absolute = resolve(path);
  if (!isConfined(root.lexical, absolute) || hasSymlinkComponent(absolute)) {
    failure("unreadable");
  }

  let canonical: string;
  let before: Stats;
  try {
    const lexical = lstatSync(absolute);
    if (lexical.isSymbolicLink()) failure("unreadable");
    canonical = realpathSync(absolute);
    if (!isConfined(root.canonical, canonical)) failure("unreadable");
    before = statSync(canonical);
  } catch (error) {
    if (error instanceof PlanFileFailure) throw error;
    failure("not-found");
  }
  if (!before.isFile() || before.uid !== uid) failure("unreadable");

  let descriptor: number;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    failure("unreadable");
  }
  try {
    const after = fstatSync(descriptor);
    if (
      !after.isFile()
      || after.uid !== uid
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) failure("unreadable");
    return { descriptor, stat: after };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readBytes(descriptor: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, buffer, offset, length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function decodeMarkdown(file: OpenPlanFile, maxBytes: number): {
  markdown: string;
  truncated: boolean;
} {
  const truncated = file.stat.size > maxBytes;
  const buffer = readBytes(
    file.descriptor,
    Math.min(file.stat.size, maxBytes + 3),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (!truncated) {
    try {
      return { markdown: decoder.decode(buffer), truncated: false };
    } catch {
      failure("unreadable");
    }
  }

  const end = Math.min(maxBytes, buffer.length);
  for (let boundary = end; boundary >= Math.max(0, end - 3); boundary -= 1) {
    try {
      return {
        markdown: decoder.decode(buffer.subarray(0, boundary)),
        truncated: true,
      };
    } catch {
      // A UTF-8 code point can cross the byte boundary by at most three bytes.
    }
  }
  failure("unreadable");
}

export class LocalPlanFileReader implements PlanFileReader {
  readonly #allowedRoots: readonly string[];
  readonly #uid: number;
  readonly #maxBytes: number;

  constructor(options: LocalPlanFileReaderOptions = {}) {
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
    const home = options.homeDirectory ?? homedir();
    const runtime = options.runtimeDirectory ?? `/private/tmp/agent-manager-${String(this.#uid)}`;
    const roots = options.allowedRoots ?? [
      join(home, ".claude", "plans"),
      join(runtime, "plans"),
    ];
    this.#allowedRoots = roots.map((root) => {
      if (!isAbsolute(root) || root.includes("\0")) {
        throw new Error("plan-file roots must be absolute paths");
      }
      return resolve(root);
    });
    const requested = options.maxBytes ?? PLAN_FILE_LIMITS.bytes;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new RangeError("plan-file byte limit must be a positive integer");
    }
    this.#maxBytes = Math.min(requested, PLAN_FILE_LIMITS.bytes);
  }

  read(path: string): PlanFileReadResult {
    if (!isAbsolute(path) || path.includes("\0")) {
      return { state: "unavailable", reason: "outside-allowed-roots" };
    }
    const absolute = resolve(path);
    let attempted = false;
    let reason: PlanFileUnavailableReason = "outside-allowed-roots";

    for (const configuredRoot of this.#allowedRoots) {
      if (!isConfined(configuredRoot, absolute)) continue;
      attempted = true;
      let file: OpenPlanFile | null = null;
      try {
        const root = inspectRoot(configuredRoot, this.#uid);
        file = openPlanFile(root, absolute, this.#uid);
        return { state: "available", ...decodeMarkdown(file, this.#maxBytes) };
      } catch (error) {
        reason = error instanceof PlanFileFailure ? error.reason : "unreadable";
      } finally {
        if (file) closeSync(file.descriptor);
      }
    }
    return {
      state: "unavailable",
      reason: attempted ? reason : "outside-allowed-roots",
    };
  }
}
