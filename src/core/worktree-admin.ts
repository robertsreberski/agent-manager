import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validWorktreeName } from "../shared/workspace.ts";
import { runBoundedGit, type GitCommandResult, type GitCommandRunner } from "./worktree.ts";

/**
 * The one place in this codebase that writes to a repository.
 *
 * `worktree.ts` stays observation-only; everything here is reachable solely
 * through the operator's explicit "new worktree" choice on the draft screen.
 * The write surface is exactly `git worktree add -b` plus an append to
 * `info/exclude`: no checkout switching, no removal, no history rewriting.
 * Every subprocess is argv-only, bounded by time and output, and a name is
 * validated before any process is spawned.
 */

/** Directory under the repository root that holds manager-created worktrees. */
export const WORKTREE_DIRECTORY = ".worktrees";
/** The single line that keeps every created worktree out of `git status`. */
const EXCLUDE_LINE = `/${WORKTREE_DIRECTORY}/`;

const FACT_TIMEOUT_MS = 2_000;
const FACT_OUTPUT_BYTES = 256 * 1_024;
/** A checkout is not a two-second operation on a large repository. */
const CREATE_TIMEOUT_MS = 30_000;
const CREATE_OUTPUT_BYTES = 1 * 1_024 * 1_024;
const MAX_WORKTREES = 100;

export interface RepoWorktree {
  /** Absolute path of the worktree. */
  path: string;
  /** Null when the worktree is detached or bare. */
  branch: string | null;
  /** The repository's own checkout, which `git worktree list` reports first. */
  isMain: boolean;
  locked: boolean;
}

export type DefaultBranchSource = "origin-head" | "init-default" | "conventional" | "current";

export interface DefaultBranch {
  branch: string;
  source: DefaultBranchSource;
}

export type WorktreeCreationCode =
  | "NAME_INVALID"
  | "WORKTREE_EXISTS"
  | "BRANCH_EXISTS"
  | "BASE_UNAVAILABLE"
  | "GIT_FAILED"
  | "TIMEOUT";

export class WorktreeCreationError extends Error {
  readonly code: WorktreeCreationCode;

  constructor(code: WorktreeCreationCode, message: string) {
    super(message);
    this.name = "WorktreeCreationError";
    this.code = code;
  }
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  /** False when `info/exclude` already listed the directory or was unwritable. */
  excludeUpdated: boolean;
}

function ok(result: GitCommandResult): boolean {
  return result.status === 0 && !result.timedOut && !result.truncated;
}

function line(result: GitCommandResult): string | null {
  if (!ok(result)) return null;
  const value = result.stdout.toString("utf8").trim();
  return value.length > 0 && !value.includes("\0") ? value : null;
}

function stderrExcerpt(result: GitCommandResult): string {
  const text = result.stderr.toString("utf8").trim().split(/\r?\n/u)[0] ?? "";
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

async function fact(
  runGit: GitCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  return await runGit(cwd, args, {
    timeoutMs: FACT_TIMEOUT_MS,
    maxOutputBytes: FACT_OUTPUT_BYTES,
  });
}

function parseWorktreeRecords(output: string, separator: "\0" | "\n"): RepoWorktree[] {
  const worktrees: RepoWorktree[] = [];
  let current: { path: string; branch: string | null; locked: boolean; bare: boolean } | null = null;

  const flush = (): void => {
    if (current && !current.bare && worktrees.length < MAX_WORKTREES) {
      worktrees.push({
        path: current.path,
        branch: current.branch,
        isMain: worktrees.length === 0,
        locked: current.locked,
      });
    }
    current = null;
  };

  for (const record of output.split(separator)) {
    if (record === "") {
      // A blank record ends an entry in both porcelain forms.
      flush();
      continue;
    }
    const space = record.indexOf(" ");
    const key = space === -1 ? record : record.slice(0, space);
    const value = space === -1 ? "" : record.slice(space + 1);
    switch (key) {
      case "worktree":
        flush();
        current = { path: value, branch: null, locked: false, bare: false };
        break;
      case "branch":
        if (current) current.branch = value.startsWith("refs/heads/") ? value.slice(11) : value;
        break;
      case "locked":
        if (current) current.locked = true;
        break;
      case "bare":
        if (current) current.bare = true;
        break;
      default:
        break;
    }
  }
  flush();
  return worktrees;
}

/**
 * Every worktree of the repository, main checkout first.
 *
 * `-z` keeps paths unambiguous but only exists from Git 2.36, so an older Git
 * falls back to the newline form rather than reporting a repository with no
 * worktrees at all.
 */
export async function listRepoWorktrees(
  repoRoot: string,
  runGit: GitCommandRunner = runBoundedGit,
): Promise<RepoWorktree[]> {
  const zeroTerminated = await fact(runGit, repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (ok(zeroTerminated)) {
    return parseWorktreeRecords(zeroTerminated.stdout.toString("utf8"), "\0");
  }
  const newlineTerminated = await fact(runGit, repoRoot, ["worktree", "list", "--porcelain"]);
  if (!ok(newlineTerminated)) return [];
  return parseWorktreeRecords(newlineTerminated.stdout.toString("utf8"), "\n");
}

async function localBranchExists(
  runGit: GitCommandRunner,
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  return ok(await fact(runGit, repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]));
}

/**
 * The branch a new worktree should be based on.
 *
 * Each candidate is confirmed to exist as a local head before it is returned,
 * so a repository whose `origin/HEAD` names a branch that was never fetched
 * falls through to one that is actually checkoutable. Null means the repository
 * has nothing to branch from yet — an unborn HEAD, typically.
 */
export async function detectDefaultBranch(
  repoRoot: string,
  runGit: GitCommandRunner = runBoundedGit,
): Promise<DefaultBranch | null> {
  const originHead = line(await fact(runGit, repoRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]));
  if (originHead?.startsWith("origin/")) {
    const branch = originHead.slice("origin/".length);
    if (branch && await localBranchExists(runGit, repoRoot, branch)) {
      return { branch, source: "origin-head" };
    }
  }

  const configured = line(await fact(runGit, repoRoot, ["config", "--get", "init.defaultbranch"]));
  if (configured && await localBranchExists(runGit, repoRoot, configured)) {
    return { branch: configured, source: "init-default" };
  }

  for (const branch of ["main", "master"]) {
    if (await localBranchExists(runGit, repoRoot, branch)) {
      return { branch, source: "conventional" };
    }
  }

  const current = line(await fact(runGit, repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]));
  if (current && current !== "HEAD" && await localBranchExists(runGit, repoRoot, current)) {
    return { branch: current, source: "current" };
  }
  return null;
}

/**
 * Appends the worktree directory to `info/exclude` so created worktrees never
 * show up as untracked changes. One directory-level entry covers every future
 * worktree, and re-running is a no-op. Best effort: a repository the operator
 * cannot write metadata for still gets its worktree.
 */
function excludeWorktreeDirectory(gitCommonDir: string): boolean {
  try {
    const infoDirectory = join(gitCommonDir, "info");
    const excludeFile = join(infoDirectory, "exclude");
    if (existsSync(excludeFile)) {
      const existing = readFileSync(excludeFile, "utf8");
      if (existing.split(/\r?\n/u).some((entry) => entry.trim() === EXCLUDE_LINE)) return false;
      const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      appendFileSync(excludeFile, `${separator}${EXCLUDE_LINE}\n`);
      return true;
    }
    mkdirSync(infoDirectory, { recursive: true });
    appendFileSync(excludeFile, `${EXCLUDE_LINE}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates `<repoRoot>/.worktrees/<name>` on a new branch named after it, based
 * on the repository's default branch.
 *
 * Collisions are refused rather than resolved: a directory or branch that
 * already exists is the operator's to reuse or rename, and this never deletes
 * either. `repoRoot` must already be a canonical main-checkout root — the
 * caller establishes that.
 */
export async function createRepoWorktree(options: {
  repoRoot: string;
  name: string;
  runGit?: GitCommandRunner;
  timeoutMs?: number;
}): Promise<CreatedWorktree> {
  const { repoRoot, name } = options;
  const runGit = options.runGit ?? runBoundedGit;

  // Before anything is spawned: an invalid name never reaches a subprocess.
  if (!validWorktreeName(name)) {
    throw new WorktreeCreationError("NAME_INVALID", `"${name}" is not a usable worktree name`);
  }

  const base = await detectDefaultBranch(repoRoot, runGit);
  if (!base) {
    throw new WorktreeCreationError(
      "BASE_UNAVAILABLE",
      "this repository has no branch to base a worktree on yet",
    );
  }

  const target = join(repoRoot, WORKTREE_DIRECTORY, name);
  if (existsSync(target)) {
    throw new WorktreeCreationError("WORKTREE_EXISTS", `${target} already exists`);
  }
  if (await localBranchExists(runGit, repoRoot, name)) {
    throw new WorktreeCreationError(
      "BRANCH_EXISTS",
      `branch "${name}" already exists; choose another name or delete that branch`,
    );
  }

  mkdirSync(dirname(target), { recursive: true });
  const added = await runGit(repoRoot, ["worktree", "add", "-b", name, "--", target, base.branch], {
    timeoutMs: options.timeoutMs ?? CREATE_TIMEOUT_MS,
    maxOutputBytes: CREATE_OUTPUT_BYTES,
  });
  if (added.timedOut) {
    throw new WorktreeCreationError("TIMEOUT", "git did not finish creating the worktree in time");
  }
  if (!ok(added)) {
    const detail = stderrExcerpt(added);
    throw new WorktreeCreationError(
      "GIT_FAILED",
      detail ? `git could not create the worktree: ${detail}` : "git could not create the worktree",
    );
  }

  const commonDir = line(await fact(runGit, repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]));
  const excludeUpdated = commonDir ? excludeWorktreeDirectory(commonDir) : false;

  return { path: target, branch: name, baseBranch: base.branch, excludeUpdated };
}
