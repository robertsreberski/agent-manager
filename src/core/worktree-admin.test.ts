import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createRepoWorktree,
  detectDefaultBranch,
  listRepoWorktrees,
  WorktreeCreationError,
} from "./worktree-admin.ts";
import { runBoundedGit, type GitCommandRunner } from "./worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  }).trim();
}

/** A main checkout whose path exercises spaces and quotes, as worktree.test.ts does. */
function repositoryFixture(t: TestContext, options: { commit?: boolean; branch?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-worktree-admin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "repo with spaces 'and-quotes");
  mkdirSync(main);
  git(main, ["init", `--initial-branch=${options.branch ?? "main"}`]);
  git(main, ["config", "user.email", "fixture@example.invalid"]);
  git(main, ["config", "user.name", "Fixture"]);
  if (options.commit !== false) {
    writeFileSync(join(main, "README.md"), "fixture\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
  }
  return realpathSync(main);
}

test("creates a worktree on a new branch from the default branch and excludes it", async (t) => {
  const repo = repositoryFixture(t);

  const created = await createRepoWorktree({ repoRoot: repo, name: "fix-auth" });

  assert.equal(created.path, join(repo, ".worktrees", "fix-auth"));
  assert.equal(created.branch, "fix-auth");
  assert.equal(created.baseBranch, "main");
  assert.equal(created.excludeUpdated, true);
  assert.equal(existsSync(join(created.path, "README.md")), true);
  assert.equal(git(created.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "fix-auth");
  assert.equal(
    git(repo, ["rev-parse", "fix-auth"]),
    git(repo, ["rev-parse", "main"]),
    "the new branch starts at the default branch",
  );
  assert.match(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.worktrees\/$/mu);
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the worktree directory is not untracked noise");

  const worktrees = await listRepoWorktrees(repo);
  assert.deepEqual(worktrees.map((worktree) => worktree.branch), ["main", "fix-auth"]);
  assert.equal(worktrees[0]?.isMain, true);
  assert.equal(worktrees[0]?.path, repo);
  assert.equal(worktrees[1]?.isMain, false);
  assert.equal(worktrees[1]?.path, created.path);

  // A second worktree must not duplicate the exclude entry.
  const second = await createRepoWorktree({ repoRoot: repo, name: "spike.2" });
  assert.equal(second.excludeUpdated, false);
  assert.equal(
    readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("/.worktrees/").length - 1,
    1,
  );
});

test("refuses a name that would collide with an existing worktree or branch", async (t) => {
  const repo = repositoryFixture(t);
  await createRepoWorktree({ repoRoot: repo, name: "taken" });

  await assert.rejects(
    createRepoWorktree({ repoRoot: repo, name: "taken" }),
    (error: WorktreeCreationError) => error.code === "WORKTREE_EXISTS",
  );

  git(repo, ["branch", "branch-only"]);
  await assert.rejects(
    createRepoWorktree({ repoRoot: repo, name: "branch-only" }),
    (error: WorktreeCreationError) => {
      assert.equal(error.code, "BRANCH_EXISTS");
      assert.match(error.message, /branch-only/u);
      return true;
    },
  );
  assert.equal(
    git(repo, ["rev-parse", "--verify", "branch-only"]).length > 0,
    true,
    "a refused creation never deletes the branch it collided with",
  );
});

test("rejects an unusable name before spawning any process", async (t) => {
  const repo = repositoryFixture(t);
  let spawned = 0;
  const runGit: GitCommandRunner = async (cwd, args, options) => {
    spawned += 1;
    return await runBoundedGit(cwd, args, options);
  };

  for (const name of ["", "..", "../escape", "-rf", "/absolute", "a/b", "x".repeat(65), "work.lock"]) {
    await assert.rejects(
      createRepoWorktree({ repoRoot: repo, name, runGit }),
      (error: WorktreeCreationError) => error.code === "NAME_INVALID",
      `"${name}" must be refused`,
    );
  }
  assert.equal(spawned, 0);
  assert.equal(existsSync(join(repo, ".worktrees")), false);
});

test("a repository with no commits has no base branch to create from", async (t) => {
  const repo = repositoryFixture(t, { commit: false });

  assert.equal(await detectDefaultBranch(repo), null);
  await assert.rejects(
    createRepoWorktree({ repoRoot: repo, name: "first" }),
    (error: WorktreeCreationError) => error.code === "BASE_UNAVAILABLE",
  );
});

test("the default branch prefers origin/HEAD, then init.defaultBranch, then convention", async (t) => {
  const repo = repositoryFixture(t, { branch: "trunk" });

  assert.deepEqual(await detectDefaultBranch(repo), { branch: "trunk", source: "current" });

  git(repo, ["config", "init.defaultbranch", "trunk"]);
  assert.deepEqual(await detectDefaultBranch(repo), { branch: "trunk", source: "init-default" });

  git(repo, ["branch", "main"]);
  git(repo, ["config", "--unset", "init.defaultbranch"]);
  assert.deepEqual(await detectDefaultBranch(repo), { branch: "main", source: "conventional" });

  git(repo, ["branch", "release"]);
  git(repo, ["remote", "add", "origin", repo]);
  git(repo, ["update-ref", "refs/remotes/origin/release", "release"]);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release"]);
  assert.deepEqual(await detectDefaultBranch(repo), { branch: "release", source: "origin-head" });

  // origin/HEAD naming a branch that was never fetched locally falls through.
  git(repo, ["update-ref", "refs/remotes/origin/never-fetched", "release"]);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/never-fetched"]);
  assert.deepEqual(await detectDefaultBranch(repo), { branch: "main", source: "conventional" });
});

test("a creation that outruns its budget reports a timeout rather than a git failure", async (t) => {
  const repo = repositoryFixture(t);
  const runGit: GitCommandRunner = async (cwd, args, options) => {
    if (args[0] === "worktree" && args[1] === "add") {
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, timedOut: true, truncated: false };
    }
    return await runBoundedGit(cwd, args, options);
  };

  await assert.rejects(
    createRepoWorktree({ repoRoot: repo, name: "slow", runGit }),
    (error: WorktreeCreationError) => error.code === "TIMEOUT",
  );
});

test("listing degrades to empty rather than guessing when git cannot answer", async (t) => {
  const repo = repositoryFixture(t);
  const runGit: GitCommandRunner = async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("fatal: not a git repository"),
    status: 128,
    timedOut: false,
    truncated: false,
  });

  assert.deepEqual(await listRepoWorktrees(repo, runGit), []);
});

test("listing survives a git without -z support and reports locked worktrees", async (t) => {
  const repo = repositoryFixture(t);
  await createRepoWorktree({ repoRoot: repo, name: "locked-one" });
  git(repo, ["worktree", "lock", join(repo, ".worktrees", "locked-one")]);

  const runGit: GitCommandRunner = async (cwd, args, options) => {
    if (args.includes("-z")) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("error: unknown switch `z'"), status: 129, timedOut: false, truncated: false };
    }
    return await runBoundedGit(cwd, args, options);
  };

  const worktrees = await listRepoWorktrees(repo, runGit);
  assert.deepEqual(worktrees.map((worktree) => worktree.branch), ["main", "locked-one"]);
  assert.equal(worktrees[1]?.locked, true);
});
