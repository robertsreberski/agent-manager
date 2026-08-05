import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionView } from "../shared/session.ts";
import { resolveEditorTarget } from "./editor.ts";

function targetSession(worktreePath: string): Pick<SessionView, "hostId" | "workspaceIdentity"> {
  return {
    hostId: "local",
    workspaceIdentity: {
      repoRoot: worktreePath,
      repoName: "fixture",
      worktreePath,
      linked: false,
      branch: "main",
      detached: false,
      dirtyCount: 1,
      ahead: 0,
      behind: 0, insertions: null, deletions: null,
    },
  };
}

test("resolves only an owned regular file inside the selected worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-editor-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "export {};\n");
    assert.equal(resolveEditorTarget(targetSession(root), "src/app.ts"), join(realpathSync(root), "src", "app.ts"));
    assert.throws(() => resolveEditorTarget(targetSession(root), "../outside.ts"), /escapes/);
    assert.throws(() => resolveEditorTarget(targetSession(root), "/tmp/outside.ts"), /unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects symlink components and deleted files", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-editor-"));
  const outside = mkdtempSync(join(tmpdir(), "agent-manager-editor-outside-"));
  try {
    writeFileSync(join(outside, "secret.ts"), "secret\n");
    symlinkSync(outside, join(root, "linked"));
    assert.throws(() => resolveEditorTarget(targetSession(root), "linked/secret.ts"), /unsafe/);
    assert.throws(() => resolveEditorTarget(targetSession(root), "missing.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
