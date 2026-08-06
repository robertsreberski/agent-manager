import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { digestHookBearerToken } from "./auth.ts";
import { ClaudeHookBridge } from "./claude-bridge.ts";
import { registerClaudeHookRoute } from "./claude-route.ts";

const TOKEN = "route-token-with-at-least-thirty-two-characters";

function stop() {
  return {
    session_id: "external-session",
    transcript_path: "/tmp/session.jsonl",
    cwd: "/workspace",
    prompt_id: "prompt-1",
    hook_event_name: "Stop",
    stop_hook_active: false,
  };
}

test("Fastify Claude hook route is loopback-only, bearer-authenticated, and empty-2xx", async () => {
  const activity: unknown[] = [];
  const bridge = new ClaudeHookBridge({
    authorizationRecords: [{
      id: "route-install",
      provider: "claude",
      tokenDigest: digestHookBearerToken(TOKEN),
      createdAt: "2026-08-04T12:00:00.000Z",
      settingsPath: "/tmp/.claude/settings.json",
    }],
    onActivity: (_providerSessionId, mutation) => activity.push(mutation),
  });
  const app = Fastify({ logger: false });
  registerClaudeHookRoute(app, bridge);

  const unknown = await app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: { host: "127.0.0.1:9843", authorization: "Bearer not-a-valid-long-token" },
    payload: stop(),
  });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.body, "");

  const hostileHost = await app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: { host: "example.com", authorization: `Bearer ${TOKEN}` },
    payload: stop(),
  });
  assert.equal(hostileHost.statusCode, 403);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: { host: "127.0.0.1:9843", authorization: `Bearer ${TOKEN}` },
    payload: stop(),
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body, "");
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(activity.length, 0, "routine Stop hooks stay off the activity timeline");

  bridge.shutdown();
  await app.close();
});
