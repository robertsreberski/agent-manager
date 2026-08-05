import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workspaceFileCompletions } from "./workspaces.ts";

/*
  The composer's `@mention` is the first surface that reads directory names out
  of a worktree, so the bounds matter more than the feature: a repository is
  unbounded in depth and entry count, and a symlink is a way out of the
  worktree entirely.
*/

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-files-"));
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# app");
  writeFileSync(join(root, "src", "app.ts"), "export {};");
  writeFileSync(join(root, "src", "components", "Board.tsx"), "export {};");
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  writeFileSync(join(root, ".git", "config"), "[core]");
  return root;
}

test("returns workspace-relative paths and never an absolute one", () => {
  const root = workspace();
  try {
    const paths = workspaceFileCompletions(root, "");
    assert.ok(paths.includes("README.md"));
    assert.ok(paths.includes("src/app.ts"));
    // An absolute path would disclose where the operator keeps their work.
    assert.equal(paths.some((path) => path.startsWith("/")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips the directories nobody mentions", () => {
  const root = workspace();
  try {
    const paths = workspaceFileCompletions(root, "");
    assert.equal(paths.some((path) => path.startsWith("node_modules/")), false);
    assert.equal(paths.some((path) => path.startsWith(".git/")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches anywhere in the path, shortest first", () => {
  const root = workspace();
  try {
    assert.deepEqual(workspaceFileCompletions(root, "board"), ["src/components/Board.tsx"]);
    assert.deepEqual(workspaceFileCompletions(root, "app"), ["src/app.ts"]);
    assert.deepEqual(workspaceFileCompletions(root, "nothing-here"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not follow a symlink out of the worktree", () => {
  const root = workspace();
  const outside = mkdtempSync(join(tmpdir(), "agent-manager-outside-"));
  try {
    writeFileSync(join(outside, "secrets.env"), "TOKEN=1");
    symlinkSync(outside, join(root, "escape"), "dir");
    symlinkSync(join(outside, "secrets.env"), join(root, "linked.env"), "file");

    const paths = workspaceFileCompletions(root, "");
    assert.equal(paths.some((path) => path.includes("secrets")), false);
    assert.equal(paths.includes("linked.env"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("bounds the result count and survives a path that is not a directory", () => {
  const root = workspace();
  try {
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(root, "src", `generated-${index}.ts`), "export {};");
    }
    assert.equal(workspaceFileCompletions(root, "generated", 5).length, 5);
    assert.deepEqual(workspaceFileCompletions(join(root, "README.md"), ""), []);
    assert.deepEqual(workspaceFileCompletions(join(root, "missing"), ""), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
