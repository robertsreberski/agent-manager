import assert from "node:assert/strict";
import test from "node:test";

import { toolApprovalFacts } from "./approval-facts.ts";

test("preserves only pinned Claude tool facts and resolves against an exact cwd", () => {
  assert.deepEqual(toolApprovalFacts("Write", {
    file_path: "../shared/output.txt",
    // These look authoritative but are not part of FileWriteInput.
    network: false,
    deleteCount: 4,
  }, {
    cwd: "/work/app",
    canPersist: true,
  }), {
    command: null,
    paths: ["/work/shared/output.txt"],
    writes: ["../shared/output.txt"],
    network: null,
    canPersist: true,
    deleteCount: null,
  });
});

test("never parses shell text or manufactures missing approval facts", () => {
  assert.deepEqual(toolApprovalFacts("Bash", {
    command: "rm -rf /tmp/output && curl https://example.com",
  }, {
    cwd: "/work/app",
  }), {
    command: "rm -rf /tmp/output && curl https://example.com",
    paths: null,
    writes: [],
    network: null,
    canPersist: false,
    deleteCount: null,
  });
});

test("keeps an unresolved provider-relative path conservative", () => {
  const facts = toolApprovalFacts("Read", { file_path: "relative.txt" }, { cwd: null });
  assert.deepEqual(facts.paths, ["relative.txt"]);
  assert.deepEqual(facts.writes, []);
});

test("does not promote lookalike fields from custom or MCP tool inputs", () => {
  assert.deepEqual(toolApprovalFacts("mcp__files__mutate", {
    command: "rm everything",
    path: "/outside",
    file_path: "/outside/also",
    paths: ["/outside/array"],
    networkAccess: true,
    deletedFileCount: 999,
  }, {
    cwd: "/work/app",
  }), {
    command: null,
    paths: null,
    writes: [],
    network: null,
    canPersist: false,
    deleteCount: null,
  });
});

test("uses the SDK blockedPath fact without guessing its access mode", () => {
  assert.deepEqual(toolApprovalFacts("Bash", { command: "opaque" }, {
    cwd: "/work/app",
    blockedPath: "../private",
  }), {
    command: "opaque",
    paths: ["/work/private"],
    writes: [],
    network: null,
    canPersist: false,
    deleteCount: null,
  });
});
