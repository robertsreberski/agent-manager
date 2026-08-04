import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceIdentityResolver } from "../core/worktree.ts";
import {
  resolveWorkspaceForHost,
  workspaceResolutionResponse,
} from "./workspaces.ts";

test("resolves a local workspace and returns its exact public identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-server-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo });
  const resolved = await resolveWorkspaceForHost({
    hostId: "local",
    hostKind: "local",
    path: repo,
    localResolver: new WorkspaceIdentityResolver(),
    remote: { resolveWorkspace: async () => { throw new Error("remote must not run"); } },
  });
  assert.equal(resolved.path, realpathSync(repo));
  assert.equal(resolved.remoteWorkspaceId, null);
  assert.equal(resolved.workspaceIdentity?.repoRoot, realpathSync(repo));
  assert.equal(resolved.workspaceIdentity?.branch, "main");

  const response = workspaceResolutionResponse({
    id: "workspace-1",
    label: resolved.label,
    path: resolved.path,
    hostId: "local",
    hostLabel: "This Mac",
    hostKind: "local",
    remoteWorkspaceId: null,
    createdAt: "2026-08-04T00:00:00.000Z",
  }, resolved.workspaceIdentity);
  assert.deepEqual(response.workspace.workspaceIdentity, resolved.workspaceIdentity);
  assert.deepEqual(Object.keys(response.workspace).sort(), [
    "createdAt",
    "hostId",
    "hostKind",
    "hostLabel",
    "id",
    "label",
    "path",
    "remoteWorkspaceId",
    "workspaceIdentity",
  ]);
});

test("delegates an SSH path to the remote node without invoking local Git", async () => {
  let localGitCalls = 0;
  let remoteCalls = 0;
  const remoteIdentity = {
    repoRoot: "/remote/repo",
    repoName: "repo",
    worktreePath: "/remote/repo-linked",
    linked: true,
    branch: "feature/remote",
    detached: false,
    dirtyCount: 4,
    ahead: 1,
    behind: 0,
  };
  const resolved = await resolveWorkspaceForHost({
    hostId: "studio",
    hostKind: "ssh",
    path: "/remote/repo-linked",
    localResolver: new WorkspaceIdentityResolver({
      runGit: async () => {
        localGitCalls += 1;
        throw new Error("local git must not run");
      },
    }),
    remote: {
      async resolveWorkspace(hostId, path) {
        remoteCalls += 1;
        assert.equal(hostId, "studio");
        assert.equal(path, "/remote/repo-linked");
        return {
          path,
          label: "repo-linked",
          remoteWorkspaceId: "remote-workspace-1",
          workspaceIdentity: remoteIdentity,
        };
      },
    },
  });
  assert.equal(remoteCalls, 1);
  assert.equal(localGitCalls, 0);
  assert.deepEqual(resolved.workspaceIdentity, remoteIdentity);
});
