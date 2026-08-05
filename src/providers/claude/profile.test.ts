import assert from "node:assert/strict";
import test from "node:test";

import { profileForClaudePermissionMode } from "./profile.ts";

test("maps every canonical Claude permission mode to an execution profile", () => {
  assert.deepEqual([
    "plan",
    "acceptEdits",
    "bypassPermissions",
    "default",
    "dontAsk",
    "auto",
  ].map((mode) => profileForClaudePermissionMode(mode)), [
    "plan",
    "execute",
    "full-access",
    "ask-first",
    "ask-first",
    "ask-first",
  ]);
  assert.equal(profileForClaudePermissionMode("future-mode"), null);
});
