import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { digestCodexHookToken } from "./codex-hook-auth.ts";
import { CodexHookBridge } from "./codex-hook-bridge.ts";
import { registerCodexHookRoute } from "./codex-hook-route.ts";

const TOKEN = "codex-route-token-with-at-least-thirty-two-characters";

function sessionStart() {
  return {
    session_id: "external-thread",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/workspace",
    hook_event_name: "SessionStart",
    model: "gpt-5.6",
  };
}

test("Fastify Codex hook route is loopback-only, bounded, no-store, and separately authenticated", async () => {
  const activity: unknown[] = [];
  const bridge = new CodexHookBridge({
    authorizationRecords: [{
      id: "route-install",
      provider: "codex",
      tokenDigest: digestCodexHookToken(TOKEN),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.codex/hooks.json",
      shimPath: "/tmp/codex-hook.mjs",
    }],
    onActivity: (_sessionId, mutation) => activity.push(mutation),
  });
  const app = Fastify({ logger: false });
  registerCodexHookRoute(app, bridge);

  const unknown = await app.inject({
    method: "POST",
    url: "/api/v1/hooks/codex",
    headers: { host: "127.0.0.1:43127", authorization: "Bearer not-a-valid-token-with-enough-characters" },
    payload: sessionStart(),
  });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.body, "");

  const hostile = await app.inject({
    method: "POST",
    url: "/api/v1/hooks/codex",
    headers: { host: "example.com", authorization: `Bearer ${TOKEN}` },
    payload: sessionStart(),
  });
  assert.equal(hostile.statusCode, 403);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/hooks/codex",
    headers: { host: "127.0.0.1:43127", authorization: `Bearer ${TOKEN}` },
    payload: sessionStart(),
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), {});
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(activity.length, 1);

  const oversized = await app.inject({
    method: "POST",
    url: "/api/v1/hooks/codex",
    headers: { host: "127.0.0.1:43127", authorization: `Bearer ${TOKEN}` },
    payload: { ...sessionStart(), padding: "x".repeat(1_048_576) },
  });
  assert.equal(oversized.statusCode, 413);
  await app.close();
});
