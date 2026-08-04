import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type GitCommandRunner,
  runBoundedGit,
  WorkspaceIdentityResolver,
} from "./worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  }).trim();
}

function repositoryFixture(t: TestContext): {
  root: string;
  main: string;
  linked: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-worktree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "repo with spaces 'and-quotes");
  const linked = join(root, "-linked worktree");
  mkdirSync(main);
  git(main, ["init", "--initial-branch=main"]);
  git(main, ["config", "user.email", "fixture@example.invalid"]);
  git(main, ["config", "user.name", "Fixture"]);
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(main, ["add", "README.md"]);
  git(main, ["commit", "-m", "initial"]);
  git(main, ["worktree", "add", "-b", "feature/worktree", linked]);
  return { root, main: realpathSync(main), linked: realpathSync(linked) };
}

test("resolves main and linked worktrees with argv-safe paths and exact dirty facts", async (t) => {
  const fixture = repositoryFixture(t);
  const nested = join(fixture.linked, "nested directory");
  mkdirSync(nested);
  writeFileSync(join(fixture.linked, "one untracked.txt"), "one\n");
  writeFileSync(join(fixture.linked, "two 'quoted'.txt"), "two\n");

  let statusCalls = 0;
  const resolver = new WorkspaceIdentityResolver({
    runGit: async (cwd, args, options) => {
      if (args[0] === "status") statusCalls += 1;
      return await runBoundedGit(cwd, args, options);
    },
  });
  const linked = await resolver.resolve(nested, { selected: true });
  assert.deepEqual(linked, {
    repoRoot: fixture.main,
    repoName: "repo with spaces 'and-quotes",
    worktreePath: fixture.linked,
    linked: true,
    branch: "feature/worktree",
    detached: false,
    dirtyCount: 2,
    ahead: null,
    behind: null,
  });

  const main = await resolver.resolve(fixture.main, { selected: true });
  assert.equal(main?.repoRoot, fixture.main);
  assert.equal(main?.worktreePath, fixture.main);
  assert.equal(main?.linked, false);
  assert.equal(main?.branch, "main");

  const siblingNested = join(fixture.linked, "another nested directory");
  mkdirSync(siblingNested);
  assert.equal((await resolver.resolve(siblingNested))?.dirtyCount, 2);
  assert.equal(statusCalls, 2, "one expensive read per worktree, not per session cwd");
});

test("negative results and expensive facts are cached, while selection forces refresh", async (t) => {
  const fixture = repositoryFixture(t);
  const resolver = new WorkspaceIdentityResolver({
    cheapTtlMs: 60_000,
    expensiveTtlMs: 60_000,
    negativeTtlMs: 60_000,
  });

  const clean = await resolver.resolve(fixture.main);
  assert.equal(clean?.dirtyCount, 0);
  writeFileSync(join(fixture.main, "later.txt"), "dirty\n");
  assert.equal((await resolver.resolve(fixture.main))?.dirtyCount, 0);
  assert.equal((await resolver.resolve(fixture.main, { selected: true }))?.dirtyCount, 1);

  const outside = join(fixture.root, "not a repo");
  mkdirSync(outside);
  assert.equal(await resolver.resolve(outside), null);
  mkdirSync(join(outside, ".git"));
  assert.equal(await resolver.resolve(outside), null);
});

test("timeouts and oversized output degrade facts without escaping the pass budget", async () => {
  let now = 0;
  let calls = 0;
  const runGit: GitCommandRunner = async (_cwd, args, options) => {
    calls += 1;
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      now += options.timeoutMs;
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        timedOut: true,
        truncated: false,
      };
    }
    throw new Error("unexpected command");
  };
  const resolver = new WorkspaceIdentityResolver({
    now: () => now,
    runGit,
    commandTimeoutMs: 50,
    totalBudgetMs: 50,
  });
  const result = await resolver.resolveMany(["/first", "/second"], { budgetMs: 50 });
  assert.equal(result.get("/first"), null);
  assert.equal(result.get("/second"), null);
  assert.equal(calls, 1);
});

test("truncated status output is unknown rather than falsely clean", async () => {
  const outputs = new Map<string, string>([
    ["rev-parse --show-toplevel", "/repo"],
    ["rev-parse --path-format=absolute --git-common-dir", "/repo/.git"],
    ["rev-parse --path-format=absolute --git-dir", "/repo/.git"],
    ["rev-parse --abbrev-ref HEAD", "main"],
  ]);
  const runGit: GitCommandRunner = async (_cwd, args) => {
    const key = args.join(" ");
    if (args[0] === "status") {
      return {
        stdout: Buffer.from("?? partial"),
        stderr: Buffer.alloc(0),
        status: null,
        timedOut: false,
        truncated: true,
      };
    }
    if (args[0] === "rev-list") {
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("no upstream"),
        status: 128,
        timedOut: false,
        truncated: false,
      };
    }
    return {
      stdout: Buffer.from(`${outputs.get(key) ?? ""}\n`),
      stderr: Buffer.alloc(0),
      status: outputs.has(key) ? 0 : 1,
      timedOut: false,
      truncated: false,
    };
  };
  const resolver = new WorkspaceIdentityResolver({ runGit });
  const identity = await resolver.resolve("/repo", { selected: true });
  assert.equal(identity?.dirtyCount, null);
  assert.equal(identity?.ahead, null);
  assert.equal(identity?.behind, null);
});

test("never runs local git against a remote session path", async () => {
  let calls = 0;
  const resolver = new WorkspaceIdentityResolver({
    runGit: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  const remoteIdentity = {
    repoRoot: "/remote/repo",
    repoName: "repo",
    worktreePath: "/remote/repo-linked",
    linked: true,
    branch: "remote",
    detached: false,
    dirtyCount: null,
    ahead: null,
    behind: null,
  };
  assert.deepEqual(await resolver.resolveSession({
    hostId: "studio",
    cwd: "/remote/repo-linked",
    workspaceIdentity: remoteIdentity,
  }), remoteIdentity);
  assert.equal(calls, 0);
});
