import assert from "node:assert/strict";
import test from "node:test";

import { digestCodexHookToken } from "./codex-hook-auth.ts";
import { CodexHookBridge } from "./codex-hook-bridge.ts";

const TOKEN = "codex-hook-test-token-with-at-least-thirty-two-characters";

function permission() {
  return {
    session_id: "external-thread",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/workspace",
    hook_event_name: "PermissionRequest",
    model: "gpt-5.6",
    permission_mode: "default",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    reason: "Needs repository access",
  };
}

test("Codex hook bridge authenticates, projects, and never claims response authority", () => {
  const activity: unknown[] = [];
  const seen: unknown[] = [];
  const bridge = new CodexHookBridge({
    authorizationRecords: [{
      id: "codex-install",
      provider: "codex",
      tokenDigest: digestCodexHookToken(TOKEN),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.codex/hooks.json",
      shimPath: "/tmp/codex-hook.mjs",
    }],
    now: () => new Date("2026-08-04T12:01:00.000Z"),
    onActivity: (sessionId, mutation) => activity.push({ sessionId, mutation }),
    onHookSeen: (event) => seen.push(event),
  });

  assert.deepEqual(bridge.handle({ authorization: `Bearer ${TOKEN}`, body: permission() }), {
    statusCode: 200,
    body: {},
  });
  assert.equal(activity.length, 1);
  const projected = activity[0] as { mutation: { type: string; item: Record<string, unknown> } };
  assert.equal(projected.mutation.type, "upsert");
  assert.equal(projected.mutation.item.kind, "attention");
  assert.equal(projected.mutation.item.respondable, false);
  assert.equal(projected.mutation.item.state, "waiting");
  assert.deepEqual(projected.mutation.item.approvalFacts, {
    command: "git status",
    paths: null,
    writes: [],
    network: null,
    canPersist: false,
    deleteCount: null,
  });
  assert.equal(seen.length, 1);

  assert.deepEqual(bridge.handle({ authorization: "Bearer wrong-token-with-enough-characters-000", body: permission() }), {
    statusCode: 401,
    body: null,
  });
  assert.deepEqual(bridge.handle({ authorization: `Bearer ${TOKEN}`, body: { nope: true } }), {
    statusCode: 400,
    body: null,
  });
});

test("authenticated hook execution is marked seen even when activity projection delivery fails", () => {
  const seen: unknown[] = [];
  const bridge = new CodexHookBridge({
    authorizationRecords: [{
      id: "codex-install",
      provider: "codex",
      tokenDigest: digestCodexHookToken(TOKEN),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.codex/hooks.json",
      shimPath: "/tmp/codex-hook.mjs",
    }],
    onHookSeen: (event) => seen.push(event),
    onActivity: () => {
      throw new Error("activity store unavailable");
    },
  });
  assert.equal(bridge.handle({ authorization: `Bearer ${TOKEN}`, body: permission() }).statusCode, 200);
  assert.equal(seen.length, 1);
});
