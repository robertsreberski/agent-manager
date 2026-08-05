import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

import type { SessionRecord, WorkspaceIdentity } from "../shared/session.ts";

export type { WorkspaceIdentity } from "../shared/session.ts";

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export type GitCommandRunner = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number },
) => Promise<GitCommandResult>;

export interface WorkspaceIdentityResolverOptions {
  now?: () => number;
  runGit?: GitCommandRunner;
  commandTimeoutMs?: number;
  totalBudgetMs?: number;
  cheapTtlMs?: number;
  expensiveTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
}

export interface WorkspaceResolutionOptions {
  /** Selected workspaces refresh dirty/ahead/behind facts immediately. */
  selected?: boolean;
  /** Optional pass-wide deadline shared by resolveMany. */
  deadlineMs?: number;
}

interface CheapFacts {
  repoRoot: string;
  repoName: string;
  worktreePath: string;
  linked: boolean;
  branch: string | null;
  detached: boolean;
}

interface ExpensiveFacts {
  dirtyCount: number | null;
  ahead: number | null;
  behind: number | null;
  insertions: number | null;
  deletions: number | null;
}

interface PositiveCacheEntry {
  kind: "repo";
  cheap: CheapFacts;
  cheapAt: number;
  expensive: ExpensiveFacts;
  expensiveAt: number;
  touchedAt: number;
}

interface NegativeCacheEntry {
  kind: "not-repo";
  checkedAt: number;
  touchedAt: number;
}

type CacheEntry = PositiveCacheEntry | NegativeCacheEntry;

const DEFAULTS = Object.freeze({
  commandTimeoutMs: 2_000,
  totalBudgetMs: 2_500,
  cheapTtlMs: 15_000,
  expensiveTtlMs: 60_000,
  negativeTtlMs: 30_000,
  maxEntries: 1_024,
});

const FACT_OUTPUT_BYTES = 256 * 1_024;
const STATUS_OUTPUT_BYTES = 1 * 1_024 * 1_024;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function remaining(deadlineMs: number, now: () => number, cap: number): number {
  return Math.max(0, Math.min(cap, Math.floor(deadlineMs - now())));
}

function cleanLine(result: GitCommandResult): string | null {
  if (result.status !== 0 || result.timedOut || result.truncated) return null;
  const value = result.stdout.toString("utf8").trim();
  return value.length > 0 && !value.includes("\0") ? value : null;
}

function absoluteGitPath(path: string, worktreePath: string): string | null {
  if (path.includes("\0")) return null;
  const candidate = normalize(isAbsolute(path) ? path : resolve(worktreePath, path));
  return isAbsolute(candidate) ? candidate : null;
}

/**
 * The line counts out of `git diff --shortstat`.
 *
 * Git prints one line — "12 files changed, 312 insertions(+), 87 deletions(-)"
 * — and omits either clause when it is zero, so an absent clause is a real zero
 * rather than an unknown. An unparseable or missing line stays null, because
 * "no changed lines" and "we could not find out" must not look the same.
 */
function parseShortstat(line: string | null): { insertions: number | null; deletions: number | null } {
  if (line === null) return { insertions: null, deletions: null };
  const trimmed = line.trim();
  if (trimmed.length === 0) return { insertions: 0, deletions: 0 };
  if (!/^\d+ files? changed/u.test(trimmed)) return { insertions: null, deletions: null };
  const insertions = trimmed.match(/(\d+) insertions?\(\+\)/u);
  const deletions = trimmed.match(/(\d+) deletions?\(-\)/u);
  return {
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

function countPorcelainRecords(output: Buffer): number | null {
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  let count = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 3 || record[2] !== " ") return null;
    const x = record[0] ?? "";
    const y = record[1] ?? "";
    if (!" MADRCU?!".includes(x) || !" MADRCU?!".includes(y)) return null;
    count += 1;
    if (x === "R" || x === "C") {
      index += 1;
      if (index >= records.length) return null;
    }
  }
  return count;
}

export const runBoundedGit: GitCommandRunner = async (cwd, args, options) =>
  await new Promise<GitCommandResult>((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    });
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        status,
        timedOut,
        truncated,
      });
    };
    const collect = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const available = Math.max(0, options.maxOutputBytes - current);
      if (chunk.length > available) truncated = true;
      if (available > 0) chunks.push(chunk.subarray(0, available));
      return current + Math.min(chunk.length, available);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
      if (truncated && !child.killed) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
      if (truncated && !child.killed) child.kill("SIGKILL");
    });
    child.once("error", () => finish(null));
    child.once("exit", (status) => finish(status));
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGKILL");
      // The exit event normally settles. This guards a wedged process handle.
      setTimeout(() => finish(null), 100).unref();
    }, Math.max(1, options.timeoutMs));
    timer.unref();
  });

/**
 * Resolves repository facts without ever making discovery depend on Git.
 * Every subprocess is argv-only, bounded by output and time, and failures
 * degrade individual facts to null or the whole identity to null.
 */
export class WorkspaceIdentityResolver {
  readonly #now: () => number;
  readonly #runGit: GitCommandRunner;
  readonly #commandTimeoutMs: number;
  readonly #totalBudgetMs: number;
  readonly #cheapTtlMs: number;
  readonly #expensiveTtlMs: number;
  readonly #negativeTtlMs: number;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: WorkspaceIdentityResolverOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#runGit = options.runGit ?? runBoundedGit;
    this.#commandTimeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULTS.commandTimeoutMs);
    this.#totalBudgetMs = positiveInteger(options.totalBudgetMs, DEFAULTS.totalBudgetMs);
    this.#cheapTtlMs = positiveInteger(options.cheapTtlMs, DEFAULTS.cheapTtlMs);
    this.#expensiveTtlMs = positiveInteger(options.expensiveTtlMs, DEFAULTS.expensiveTtlMs);
    this.#negativeTtlMs = positiveInteger(options.negativeTtlMs, DEFAULTS.negativeTtlMs);
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULTS.maxEntries);
  }

  async resolve(
    cwd: string | null | undefined,
    options: WorkspaceResolutionOptions = {},
  ): Promise<WorkspaceIdentity | null> {
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0") || !isAbsolute(cwd)) {
      return null;
    }
    const key = normalize(cwd);
    const start = this.#now();
    const deadline = Math.min(options.deadlineMs ?? Infinity, start + this.#totalBudgetMs);
    const cached = this.#cache.get(key);
    if (cached) cached.touchedAt = start;
    if (cached?.kind === "not-repo" && start - cached.checkedAt < this.#negativeTtlMs) return null;

    let entry = cached?.kind === "repo" ? cached : null;
    if (!entry || start - entry.cheapAt >= this.#cheapTtlMs) {
      const cheap = await this.#resolveCheap(key, deadline);
      if (!cheap) {
        this.#cache.set(key, { kind: "not-repo", checkedAt: this.#now(), touchedAt: this.#now() });
        this.#evict();
        return null;
      }
      const worktreeCached = this.#cache.get(cheap.worktreePath);
      const reusable = worktreeCached?.kind === "repo"
        && worktreeCached.cheap.worktreePath === cheap.worktreePath
        ? worktreeCached
        : entry?.cheap.worktreePath === cheap.worktreePath
          ? entry
          : null;
      entry = {
        kind: "repo",
        cheap,
        cheapAt: this.#now(),
        expensive: reusable
          ? reusable.expensive
          : { dirtyCount: null, ahead: null, behind: null, insertions: null, deletions: null },
        expensiveAt: reusable?.expensiveAt ?? 0,
        touchedAt: this.#now(),
      };
      this.#cache.set(key, entry);
      this.#cache.set(cheap.worktreePath, entry);
    }

    const refreshExpensive = options.selected === true
      || this.#now() - entry.expensiveAt >= this.#expensiveTtlMs;
    if (refreshExpensive && remaining(deadline, this.#now, this.#commandTimeoutMs) > 0) {
      entry.expensive = await this.#resolveExpensive(entry.cheap.worktreePath, deadline);
      entry.expensiveAt = this.#now();
    }
    entry.touchedAt = this.#now();
    this.#evict();
    return structuredClone({ ...entry.cheap, ...entry.expensive });
  }

  /** Remote paths are facts supplied by their node and are never opened locally. */
  async resolveSession(
    session: Pick<SessionRecord, "hostId" | "cwd" | "workspaceIdentity">,
    options: WorkspaceResolutionOptions = {},
  ): Promise<WorkspaceIdentity | null> {
    if (session.hostId !== "local") return structuredClone(session.workspaceIdentity);
    return await this.resolve(session.cwd, options);
  }

  async resolveMany(
    cwds: readonly (string | null | undefined)[],
    options: Omit<WorkspaceResolutionOptions, "deadlineMs"> & { budgetMs?: number } = {},
  ): Promise<Map<string, WorkspaceIdentity | null>> {
    const deadline = this.#now() + positiveInteger(options.budgetMs, this.#totalBudgetMs);
    const result = new Map<string, WorkspaceIdentity | null>();
    for (const cwd of new Set(cwds.filter((value): value is string => typeof value === "string"))) {
      if (this.#now() >= deadline) {
        result.set(cwd, this.peek(cwd));
        continue;
      }
      result.set(cwd, await this.resolve(cwd, {
        deadlineMs: deadline,
        ...(options.selected === undefined ? {} : { selected: options.selected }),
      }));
    }
    return result;
  }

  peek(cwd: string): WorkspaceIdentity | null {
    const entry = this.#cache.get(normalize(cwd));
    return entry?.kind === "repo" ? structuredClone({ ...entry.cheap, ...entry.expensive }) : null;
  }

  invalidate(cwd?: string): void {
    if (cwd === undefined) this.#cache.clear();
    else this.#cache.delete(normalize(cwd));
  }

  async #command(
    cwd: string,
    args: readonly string[],
    deadline: number,
    maxOutputBytes = FACT_OUTPUT_BYTES,
  ): Promise<GitCommandResult | null> {
    const timeoutMs = remaining(deadline, this.#now, this.#commandTimeoutMs);
    if (timeoutMs < 1) return null;
    try {
      return await this.#runGit(cwd, args, { timeoutMs, maxOutputBytes });
    } catch {
      return null;
    }
  }

  async #resolveCheap(cwd: string, deadline: number): Promise<CheapFacts | null> {
    const worktreeResult = await this.#command(cwd, ["rev-parse", "--show-toplevel"], deadline);
    const worktreeRaw = worktreeResult ? cleanLine(worktreeResult) : null;
    if (!worktreeRaw) return null;
    const worktreePath = absoluteGitPath(worktreeRaw, cwd);
    if (!worktreePath) return null;

    const [commonResult, gitDirResult, branchResult, symbolicBranchResult] = await Promise.all([
      this.#command(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline),
      this.#command(worktreePath, ["rev-parse", "--path-format=absolute", "--git-dir"], deadline),
      this.#command(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], deadline),
      this.#command(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], deadline),
    ]);
    const commonRaw = commonResult ? cleanLine(commonResult) : null;
    const gitDirRaw = gitDirResult ? cleanLine(gitDirResult) : null;
    const branchRaw = branchResult ? cleanLine(branchResult) : null;
    const symbolicBranch = symbolicBranchResult ? cleanLine(symbolicBranchResult) : null;
    if (!commonRaw || !gitDirRaw) return null;
    if (
      (!branchResult || branchResult.timedOut || branchResult.truncated)
      && (!symbolicBranchResult || symbolicBranchResult.timedOut || symbolicBranchResult.truncated)
    ) return null;
    const commonDir = absoluteGitPath(commonRaw, worktreePath);
    const gitDir = absoluteGitPath(gitDirRaw, worktreePath);
    if (!commonDir || !gitDir) return null;
    const repoRoot = dirname(commonDir);
    const detached = branchRaw === "HEAD" || (branchRaw === null && symbolicBranch === null);
    const branch = detached ? null : symbolicBranch ?? branchRaw;
    return {
      repoRoot,
      repoName: basename(repoRoot) || repoRoot,
      worktreePath,
      linked: normalize(gitDir) !== normalize(commonDir),
      branch,
      detached,
    };
  }

  async #resolveExpensive(worktreePath: string, deadline: number): Promise<ExpensiveFacts> {
    const [statusResult, divergenceResult, diffstatResult] = await Promise.all([
      this.#command(
        worktreePath,
        ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        deadline,
        STATUS_OUTPUT_BYTES,
      ),
      this.#command(
        worktreePath,
        ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        deadline,
      ),
      /*
        "25 uncommitted" said how many files were in a non-clean state and
        nothing about how much had actually changed — a rename and a rewrite
        counted the same. `--shortstat` is the line side of that, and it is one
        summary line regardless of repository size.

        It measures *tracked* changes, where `dirtyCount` also counts untracked
        files, so the two are deliberately reported as separate facts rather
        than folded into one total that would be true of neither.
      */
      this.#command(
        worktreePath,
        ["diff", "--shortstat", "HEAD"],
        deadline,
      ),
    ]);
    const dirtyCount = statusResult
      && statusResult.status === 0
      && !statusResult.timedOut
      && !statusResult.truncated
      ? countPorcelainRecords(statusResult.stdout)
      : null;
    const divergence = divergenceResult ? cleanLine(divergenceResult) : null;
    const match = divergence?.match(/^(\d+)\s+(\d+)$/u) ?? null;
    const shortstat = diffstatResult ? cleanLine(diffstatResult) : null;
    return {
      dirtyCount,
      behind: match ? Number(match[1]) : null,
      ahead: match ? Number(match[2]) : null,
      ...parseShortstat(shortstat),
    };
  }

  #evict(): void {
    if (this.#cache.size <= this.#maxEntries) return;
    const oldest = [...this.#cache.entries()]
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
      .slice(0, this.#cache.size - this.#maxEntries);
    for (const [key] of oldest) this.#cache.delete(key);
  }
}
