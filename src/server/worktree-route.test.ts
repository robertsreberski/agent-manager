import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { GitContextResponse, WorktreeCreationResponse } from "../shared/workspace.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43131";
const origin = "http://127.0.0.1:43131";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  }).trim();
}

function repositoryFixture(t: TestContext): { repo: string; plain: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-worktree-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const plain = join(root, "not-a-repo");
  mkdirSync(repo);
  mkdirSync(plain);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return { repo: realpathSync(repo), plain: realpathSync(plain) };
}

async function backendFixture(t: TestContext) {
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    editorLauncher: false,
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  assert.ok(cookie);
  const headers = {
    host,
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": response.json<{ csrfToken: string }>().csrfToken,
  };
  return { backend, headers };
}

test("git context reports repositories, plain folders and half-typed paths differently", async (t) => {
  const { repo, plain } = repositoryFixture(t);
  const { backend, headers } = await backendFixture(t);

  const repoResponse = await backend.app.inject({
    method: "GET",
    url: `/api/v1/hosts/local/git-context?path=${encodeURIComponent(repo)}`,
    headers,
  });
  assert.equal(repoResponse.statusCode, 200, repoResponse.body);
  const context = repoResponse.json<GitContextResponse>().context;
  assert.equal(context.status, "repo");
  if (context.status !== "repo") return;
  assert.equal(context.repoRoot, repo);
  assert.equal(context.repoName, "repo");
  assert.equal(context.defaultBranch, "main");
  assert.deepEqual(context.worktrees.map((worktree) => worktree.branch), ["main"]);
  assert.equal(context.worktrees[0]?.isMain, true);

  const plainResponse = await backend.app.inject({
    method: "GET",
    url: `/api/v1/hosts/local/git-context?path=${encodeURIComponent(plain)}`,
    headers,
  });
  assert.equal(plainResponse.statusCode, 200, plainResponse.body);
  assert.equal(plainResponse.json<GitContextResponse>().context.status, "not-a-repo");

  // Typing a path is the normal case; a partial one is not an error to report.
  const partial = await backend.app.inject({
    method: "GET",
    url: `/api/v1/hosts/local/git-context?path=${encodeURIComponent(`${repo}/does-not-exist-ye`)}`,
    headers,
  });
  assert.equal(partial.statusCode, 200, partial.body);
  assert.equal(partial.json<GitContextResponse>().context.status, "not-a-repo");

  const unknownHost = await backend.app.inject({
    method: "GET",
    url: "/api/v1/hosts/nowhere/git-context?path=%2Ftmp",
    headers,
  });
  assert.equal(unknownHost.statusCode, 404, unknownHost.body);
});

test("creating a worktree registers a workspace and refuses to replay a collision", async (t) => {
  const { repo, plain } = repositoryFixture(t);
  const { backend, headers } = await backendFixture(t);

  const created = await backend.app.inject({
    method: "POST",
    url: "/api/v1/worktrees",
    headers,
    payload: { hostId: "local", repoRoot: repo, name: "fix-auth" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json<WorktreeCreationResponse>();
  assert.equal(body.branch, "fix-auth");
  assert.equal(body.baseBranch, "main");
  assert.equal(body.workspace.path, join(repo, ".worktrees", "fix-auth"));
  assert.equal(body.workspace.label, "fix-auth");
  assert.equal(body.workspace.workspaceIdentity?.branch, "fix-auth");
  assert.equal(body.workspace.workspaceIdentity?.linked, true);
  assert.equal(existsSync(join(repo, ".worktrees", "fix-auth", "README.md")), true);

  const workspaces = await backend.app.inject({ method: "GET", url: "/api/v1/workspaces", headers });
  assert.equal(workspaces.statusCode, 200, workspaces.body);
  assert.deepEqual(
    workspaces.json<{ workspaces: { path: string }[] }>().workspaces.map((workspace) => workspace.path),
    [join(repo, ".worktrees", "fix-auth")],
  );

  // The worktree now exists; a retry is refused rather than recreated, and the
  // operator resolves it by selecting what the repository already has.
  const replay = await backend.app.inject({
    method: "POST",
    url: "/api/v1/worktrees",
    headers,
    payload: { hostId: "local", repoRoot: repo, name: "fix-auth" },
  });
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(replay.json<{ error: { code: string } }>().error.code, "WORKTREE_EXISTS");
  assert.equal(existsSync(join(repo, ".worktrees", "fix-auth")), true);

  const context = await backend.app.inject({
    method: "GET",
    url: `/api/v1/hosts/local/git-context?path=${encodeURIComponent(repo)}`,
    headers,
  });
  const listed = context.json<GitContextResponse>().context;
  assert.equal(listed.status, "repo");
  if (listed.status !== "repo") return;
  assert.deepEqual(listed.worktrees.map((worktree) => worktree.branch), ["main", "fix-auth"]);

  const notARepo = await backend.app.inject({
    method: "POST",
    url: "/api/v1/worktrees",
    headers,
    payload: { hostId: "local", repoRoot: plain, name: "nope" },
  });
  assert.equal(notARepo.statusCode, 400, notARepo.body);
  assert.equal(notARepo.json<{ error: { code: string } }>().error.code, "REPO_ROOT_INVALID");

  // A linked worktree is not an anchor for creating further worktrees.
  const fromLinked = await backend.app.inject({
    method: "POST",
    url: "/api/v1/worktrees",
    headers,
    payload: { hostId: "local", repoRoot: join(repo, ".worktrees", "fix-auth"), name: "nested" },
  });
  assert.equal(fromLinked.statusCode, 400, fromLinked.body);
  assert.equal(existsSync(join(repo, ".worktrees", "fix-auth", ".worktrees")), false);
});

test("worktree creation requires a session and refuses unusable names", async (t) => {
  const { repo } = repositoryFixture(t);
  const { backend, headers } = await backendFixture(t);

  const anonymous = await backend.app.inject({
    method: "POST",
    url: "/api/v1/worktrees",
    headers: { host, origin, "content-type": "application/json" },
    payload: { hostId: "local", repoRoot: repo, name: "anon" },
  });
  assert.ok(anonymous.statusCode >= 400, anonymous.body);
  assert.equal(existsSync(join(repo, ".worktrees")), false);

  for (const name of ["../escape", "-rf", "a/b", "work.lock", ""]) {
    const response = await backend.app.inject({
      method: "POST",
      url: "/api/v1/worktrees",
      headers,
      payload: { hostId: "local", repoRoot: repo, name },
    });
    assert.equal(response.statusCode, 400, `"${name}" must be refused: ${response.body}`);
  }
  assert.equal(existsSync(join(repo, ".worktrees")), false);
});
