import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  inspectPackedPackage,
  MAX_PACKED_PACKAGE_BYTES,
  PACKAGE_FILE_ALLOWLIST,
  REQUIRED_PACKED_FILES,
} from "../src/remote/package-policy.ts";

export { MAX_PACKED_PACKAGE_BYTES, REQUIRED_PACKED_FILES };

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export const EXPECTED_PACKAGE_FILES = PACKAGE_FILE_ALLOWLIST;
export const EXPECTED_DEPLOY_SCRIPT =
  "pnpm build && node dist/cli/index.js service install && node dist/cli/index.js open";

export const OBSOLETE_PRODUCT_FILES = [
  "agent-sessions.ts",
  "agent-sessions.test.ts",
  "src/ops/panic-lock.ts",
  "src/ops/panic-lock.test.ts",
  "web/src/components/launch-dialog.tsx",
  "web/src/components/launch-dialog.test.tsx",
  "web/src/components/session-sidebar.tsx",
  "web/src/components/session-sidebar.test.tsx",
] as const;

const FORBIDDEN_PRODUCT_LITERALS = new Set([
  "set-mode",
  "set-access",
  "planning",
  "execution",
  "[System] ",
]);
const FORBIDDEN_PUBLIC_FIELDS = new Set(["accessMode", "effectiveAccess", "hasSnapshot"]);
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_SOURCE = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export type CutoverViolationCode =
  | "obsolete-file"
  | "legacy-literal"
  | "legacy-public-field"
  | "tracked-dogfood"
  | "package-json"
  | "package-private"
  | "package-files"
  | "package-artifact"
  | "package-budget"
  | "deploy-script"
  | "release-script"
  | "release-artifact"
  | "tracked-files-unavailable";

export interface CutoverViolation {
  code: CutoverViolationCode;
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export interface CheckCutoverOptions {
  root?: string;
  /** Injectable for fixtures; the default reads the repository index with git ls-files. */
  trackedFiles?: readonly string[];
}

interface StringToken {
  value: string;
  start: number;
  end: number;
}

interface LexedSource {
  code: string;
  strings: StringToken[];
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function positionAt(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastLineStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
      lastLineStart = cursor + 1;
    }
  }
  return { line, column: index - lastLineStart + 1 };
}

function blankRange(mask: string[], source: string, start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (source.charCodeAt(index) !== 10 && source.charCodeAt(index) !== 13) mask[index] = " ";
  }
}

/**
 * Produce a same-length code mask with comments and string bodies removed while
 * retaining exact, unescaped string tokens for the old-literal gate.
 */
function lexSource(source: string): LexedSource {
  const mask = [...source];
  const strings: StringToken[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];

    if (char === "/" && next === "/") {
      const start = cursor;
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
      blankRange(mask, source, start, cursor);
      continue;
    }

    if (char === "/" && next === "*") {
      const start = cursor;
      cursor += 2;
      while (cursor < source.length && !(source[cursor] === "*" && source[cursor + 1] === "/")) {
        cursor += 1;
      }
      cursor = Math.min(source.length, cursor + 2);
      blankRange(mask, source, start, cursor);
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      const start = cursor;
      cursor += 1;
      let escaped = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") {
          escaped = true;
          cursor += 2;
          continue;
        }
        if (current === quote) {
          const end = cursor + 1;
          if (!escaped) strings.push({ value: source.slice(start + 1, cursor), start, end });
          cursor = end;
          blankRange(mask, source, start, end);
          break;
        }
        cursor += 1;
      }
      if (cursor >= source.length && source[source.length - 1] !== quote) {
        blankRange(mask, source, start, source.length);
      }
      continue;
    }

    cursor += 1;
  }

  return { code: mask.join(""), strings };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function productionSources(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(resolve(root, directory), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const child = portablePath(join(directory, entry.name));
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.test(child) && !TEST_SOURCE.test(child)) {
        files.push(child);
      }
    }
  }

  await walk("src");
  await walk("web/src");
  return files.sort();
}

function sourceViolations(path: string, source: string): CutoverViolation[] {
  const violations: CutoverViolation[] = [];
  const seen = new Set<string>();
  const { code, strings } = lexSource(source);

  const add = (
    violationCode: "legacy-literal" | "legacy-public-field",
    index: number,
    message: string,
  ): void => {
    const key = `${violationCode}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({
      code: violationCode,
      path,
      message,
      ...positionAt(source, index),
    });
  };

  for (const token of strings) {
    if (FORBIDDEN_PRODUCT_LITERALS.has(token.value) || token.value.startsWith("[Tool")) {
      add("legacy-literal", token.start, `obsolete product literal ${JSON.stringify(token.value)}`);
    }

    if (!FORBIDDEN_PUBLIC_FIELDS.has(token.value)) continue;
    const before = source.slice(0, token.start).trimEnd().at(-1);
    const after = source.slice(token.end).trimStart().at(0);
    if (after === ":" || (before === "[" && after === "]")) {
      add("legacy-public-field", token.start, `obsolete public field ${JSON.stringify(token.value)}`);
    }
  }

  const fieldPatterns = [
    /\.\s*(accessMode|effectiveAccess|hasSnapshot)\b/gu,
    /\b(accessMode|effectiveAccess|hasSnapshot)\b\s*\??\s*:/gu,
    /(?:\{|,)\s*(accessMode|effectiveAccess|hasSnapshot)\s*(?=,|\})/gu,
  ];
  for (const pattern of fieldPatterns) {
    for (const match of code.matchAll(pattern)) {
      const field = match[1];
      if (!field || match.index === undefined) continue;
      const fieldOffset = match[0].indexOf(field);
      add(
        "legacy-public-field",
        match.index + fieldOffset,
        `obsolete public field ${JSON.stringify(field)}`,
      );
    }
  }

  return violations;
}

function isReleaseScript(name: string, command: string): boolean {
  const lowerName = name.toLowerCase();
  const lifecycleNames = new Set([
    "publish",
    "prepublish",
    "prepublishonly",
    "postpublish",
    "prepare",
    "prepack",
    "postpack",
    "version",
    "preversion",
    "postversion",
    "release",
    "prerelease",
    "postrelease",
  ]);
  if (lifecycleNames.has(lowerName) || lowerName.startsWith("release:")) return true;

  return /\b(?:npm|pnpm)\s+publish\b|\byarn\s+npm\s+publish\b|\bgh\s+release\s+(?:create|upload)\b|\bgit\s+tag\b|\bchangeset\s+publish\b/u
    .test(command);
}

function releaseOnlyArtifact(path: string): boolean {
  return /^(?:CHANGELOG|CHANGES)(?:\.[^/]+)?$/iu.test(path)
    || /^\.changeset(?:\/|$)/u.test(path)
    || /^(?:\.releaserc(?:\..+)?|release\.config\.[^/]+)$/iu.test(path)
    || /^(?:release|releases)(?:\/|$)/iu.test(path)
    || /^\.github\/workflows\/[^/]*(?:release|publish|npm-publish)[^/]*\.ya?ml$/iu.test(path)
    || /^scripts\/(?:release|publish|version-bump|changelog|rollback-archive)(?:[._-]|$)/iu.test(path);
}

function packageViolations(contents: string): CutoverViolation[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    return [{ code: "package-json", path: "package.json", message: "package.json is not valid JSON" }];
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ code: "package-json", path: "package.json", message: "package.json must be an object" }];
  }

  const record = manifest as Record<string, unknown>;
  const violations: CutoverViolation[] = [];
  if (record.private !== true) {
    violations.push({
      code: "package-private",
      path: "package.json",
      message: "the personal-tool package must set private: true",
    });
  }

  const actualFiles = Array.isArray(record.files) && record.files.every((value) => typeof value === "string")
    ? [...record.files].sort()
    : null;
  const expectedFiles = [...EXPECTED_PACKAGE_FILES].sort();
  if (actualFiles === null || JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    violations.push({
      code: "package-files",
      path: "package.json",
      message: `files must be exactly ${JSON.stringify(EXPECTED_PACKAGE_FILES)}`,
    });
  }

  if (record.scripts && typeof record.scripts === "object" && !Array.isArray(record.scripts)) {
    const scripts = record.scripts as Record<string, unknown>;
    if (scripts.deploy !== EXPECTED_DEPLOY_SCRIPT) {
      violations.push({
        code: "deploy-script",
        path: "package.json#scripts.deploy",
        message: "deploy must build, install/reload and health-check the service, then open fresh auth",
      });
    }
    for (const [name, value] of Object.entries(scripts)) {
      if (name === "predeploy" || name === "postdeploy") {
        violations.push({
          code: "deploy-script",
          path: `package.json#scripts.${name}`,
          message: "deploy has one explicit path; hidden lifecycle hooks are prohibited",
        });
      }
      if (typeof value === "string" && isReleaseScript(name, value)) {
        violations.push({
          code: "release-script",
          path: `package.json#scripts.${name}`,
          message: "release/publish ceremony is not part of this personal tool",
        });
      }
    }
  } else {
    violations.push({
      code: "deploy-script",
      path: "package.json#scripts.deploy",
      message: "deploy script is missing",
    });
  }

  return violations;
}

export function packedPackageViolations(contents: string): CutoverViolation[] {
  return inspectPackedPackage(contents).violations.map((violation) => ({
    code: violation.kind === "budget" ? "package-budget" : "package-artifact",
    path: violation.path,
    message: violation.message,
  }));
}

export async function checkPackedPackage(root = repositoryRoot): Promise<CutoverViolation[]> {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: resolve(root), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    return packedPackageViolations(stdout);
  } catch (error) {
    return [{
      code: "package-artifact",
      path: "package.json",
      message: `npm pack failed: ${(error as Error).message}`,
    }];
  }
}

async function repositoryTrackedFiles(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "ls-files", "-z"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.split("\0").filter(Boolean).map(portablePath);
}

export async function checkCutover(options: CheckCutoverOptions = {}): Promise<CutoverViolation[]> {
  const root = resolve(options.root ?? repositoryRoot);
  const violations: CutoverViolation[] = [];
  const obsoleteFiles = new Set<string>();

  for (const obsoletePath of OBSOLETE_PRODUCT_FILES) {
    if (await pathExists(resolve(root, obsoletePath))) {
      obsoleteFiles.add(obsoletePath);
      violations.push({
        code: "obsolete-file",
        path: obsoletePath,
        message: "obsolete cutover file still exists",
      });
    }
  }

  for (const sourcePath of await productionSources(root)) {
    // One precise file-level failure is more useful than repeating every old
    // literal inside a file that must be deleted wholesale.
    if (obsoleteFiles.has(sourcePath)) continue;
    const source = await readFile(resolve(root, sourcePath), "utf8");
    violations.push(...sourceViolations(sourcePath, source));
  }

  try {
    const packageContents = await readFile(resolve(root, "package.json"), "utf8");
    violations.push(...packageViolations(packageContents));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    violations.push({ code: "package-json", path: "package.json", message: "package.json is missing" });
  }

  let trackedFiles: readonly string[];
  if (options.trackedFiles) {
    trackedFiles = options.trackedFiles;
  } else {
    try {
      trackedFiles = await repositoryTrackedFiles(root);
    } catch (error) {
      violations.push({
        code: "tracked-files-unavailable",
        path: ".git",
        message: `could not inspect tracked dogfood artifacts: ${(error as Error).message}`,
      });
      trackedFiles = [];
    }
  }

  for (const trackedPath of trackedFiles.map(portablePath)) {
    if (trackedPath === "dogfood-output" || trackedPath.startsWith("dogfood-output/")) {
      violations.push({
        code: "tracked-dogfood",
        path: trackedPath,
        message: "generated dogfood artifact is still tracked",
      });
    }
    if (releaseOnlyArtifact(trackedPath)) {
      violations.push({
        code: "release-artifact",
        path: trackedPath,
        message: "release-only ceremony is not part of this personal tool",
      });
    }
  }

  return violations.sort((left, right) =>
    left.path.localeCompare(right.path)
      || (left.line ?? 0) - (right.line ?? 0)
      || (left.column ?? 0) - (right.column ?? 0)
      || left.code.localeCompare(right.code));
}

export function formatCutoverViolation(violation: CutoverViolation): string {
  const position = violation.line
    ? `:${violation.line}${violation.column ? `:${violation.column}` : ""}`
    : "";
  return `${violation.path}${position} [${violation.code}] ${violation.message}`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const violations = [
    ...await checkCutover(),
    ...await checkPackedPackage(),
  ].sort((left, right) =>
    left.path.localeCompare(right.path)
      || (left.line ?? 0) - (right.line ?? 0)
      || (left.column ?? 0) - (right.column ?? 0)
      || left.code.localeCompare(right.code));
  if (violations.length === 0) {
    console.log("Cutover verification passed.");
  } else {
    console.error(`Cutover verification failed with ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`- ${formatCutoverViolation(violation)}`);
    process.exitCode = 1;
  }
}
