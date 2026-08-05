import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionSchema,
  requiredCapability,
  sessionActionSchema,
} from "./contracts.ts";

const expectedState = {
  expectedGeneration: 1,
  expectedProviderTurnId: "turn-1",
  idempotencyKey: "contract-test-key",
};

test("uses one execution profile for creation and live updates", () => {
  assert.deepEqual(createSessionSchema.parse({
    provider: "codex",
    workspaceId: "workspace-1",
    initialMessage: "Start",
    profile: "full-access",
    idempotencyKey: "create-contract-key",
  }), {
    provider: "codex",
    workspaceId: "workspace-1",
    initialMessage: "Start",
    profile: "full-access",
    // Full access is the approval axis; the sandbox is an unrelated choice
    // the adapter defaults conservatively when none was requested.
    sandbox: null,
    model: null,
    effort: null,
    idempotencyKey: "create-contract-key",
  });

  assert.equal(requiredCapability(sessionActionSchema.parse({
    type: "set-profile",
    profile: "ask-first",
    ...expectedState,
  })), "set-profile");

  assert.throws(() => createSessionSchema.parse({
    provider: "codex",
    workspaceId: "workspace-1",
    initialMessage: "Start",
    mode: "planning",
    accessMode: "sandboxed",
    idempotencyKey: "old-create-contract-key",
  }));

  assert.equal(createSessionSchema.parse({
    provider: "codex",
    workspaceId: "workspace-1",
    initialMessage: "Start",
    effort: "ultra",
    idempotencyKey: "codex-ultra-create",
  }).effort, "ultra");
  for (const effort of ["minimal", "ultra"] as const) {
    assert.throws(() => createSessionSchema.parse({
      provider: "claude",
      workspaceId: "workspace-1",
      initialMessage: "Start",
      effort,
      idempotencyKey: `claude-${effort}-create`,
    }), new RegExp(`Claude does not support ${effort} effort`, "u"));
  }
});

test("carries the Codex sandbox as its own setting with one canonical spelling", () => {
  assert.equal(createSessionSchema.parse({
    provider: "codex",
    workspaceId: "workspace-1",
    initialMessage: "Start",
    sandbox: { mode: "workspace-write", networkAccess: true },
    idempotencyKey: "sandbox-create-key",
  }).sandbox?.networkAccess, true);

  // Read-only cannot reach the network and full access always can, so the
  // other spellings of those two policies are refused rather than normalized.
  for (const sandbox of [
    { mode: "read-only", networkAccess: true },
    { mode: "danger-full-access", networkAccess: false },
  ]) {
    assert.throws(() => createSessionSchema.parse({
      provider: "codex",
      workspaceId: "workspace-1",
      initialMessage: "Start",
      sandbox,
      idempotencyKey: "sandbox-noncanonical",
    }), /network access must match its mode/u);
  }

  assert.throws(() => createSessionSchema.parse({
    provider: "claude",
    workspaceId: "workspace-1",
    initialMessage: "Start",
    sandbox: { mode: "read-only", networkAccess: false },
    idempotencyKey: "claude-sandbox-create",
  }), /Claude has no sandbox setting/u);

  assert.equal(requiredCapability(sessionActionSchema.parse({
    type: "set-sandbox",
    sandbox: { mode: "danger-full-access", networkAccess: true },
    ...expectedState,
  })), "set-sandbox");
});

test("maps every session action to its exact capability", () => {
  const cases = [
    [{ type: "send", delivery: "queue", text: "next", ...expectedState }, "queue"],
    [{ type: "send", delivery: "steer", text: "now", ...expectedState }, "steer"],
    [{ type: "interrupt", ...expectedState }, "interrupt"],
    [{ type: "set-model", model: "gpt-5.6", ...expectedState }, "set-model"],
    [{ type: "set-effort", effort: "high", ...expectedState }, "set-effort"],
    [{ type: "remove-queued", messageId: "message-1", ...expectedState }, "remove-queued"],
    [{ type: "end", ...expectedState }, "end"],
    [{ type: "archive", ...expectedState }, "archive"],
    [{ type: "delete", ...expectedState }, "delete"],
    [{ type: "resume", ...expectedState }, "resume"],
    [{ type: "open-editor", relativePath: "src/index.ts", line: 4, ...expectedState }, "open-editor"],
  ] as const;

  for (const [input, capability] of cases) {
    assert.equal(requiredCapability(sessionActionSchema.parse(input)), capability);
  }

  assert.equal(sessionActionSchema.parse({
    type: "set-effort",
    effort: "ultra",
    ...expectedState,
  }).type, "set-effort");
});

test("accepts explicit persistent approval only on allow decisions", () => {
  const parsed = sessionActionSchema.parse({
    type: "respond",
    requestId: "approval-1",
    response: { kind: "decision", decision: "allow", persist: true },
    ...expectedState,
  });
  assert.equal(parsed.type, "respond");
  if (parsed.type !== "respond") throw new Error("expected a respond action");
  assert.deepEqual(parsed.response, {
    kind: "decision",
    decision: "allow",
    persist: true,
  });
  assert.throws(() => sessionActionSchema.parse({
    type: "respond",
    requestId: "approval-1",
    response: { kind: "decision", decision: "deny", persist: true },
    ...expectedState,
  }), /persistence can only accompany an allow decision/);
});

test("binds graceful-stop confirmation to a server-issued takeover id", () => {
  assert.deepEqual(sessionActionSchema.parse({
    type: "take-control",
    method: "graceful-stop",
    takeoverId: "takeover-1",
    ...expectedState,
  }), {
    type: "take-control",
    method: "graceful-stop",
    takeoverId: "takeover-1",
    ...expectedState,
  });
  assert.throws(() => sessionActionSchema.parse({
    type: "take-control",
    method: "guided-exit",
    takeoverId: "takeover-1",
    ...expectedState,
  }), /guided takeover does not accept/u);
});

test("open-editor accepts only a normalized file identity, never an executable", () => {
  assert.deepEqual(sessionActionSchema.parse({
    type: "open-editor",
    relativePath: "src/index.ts",
    line: 4,
    column: 2,
    ...expectedState,
  }), {
    type: "open-editor",
    relativePath: "src/index.ts",
    line: 4,
    column: 2,
    ...expectedState,
  });
  assert.throws(() => sessionActionSchema.parse({
    type: "open-editor",
    relativePath: "src/index.ts",
    executable: "/usr/bin/code",
    ...expectedState,
  }));
});
