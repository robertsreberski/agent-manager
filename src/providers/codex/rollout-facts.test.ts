import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCodexRolloutFacts } from "./rollout-facts.ts";

test("resolves active Codex rollout state and every execution setting", () => {
  const facts = analyzeCodexRolloutFacts([
    {
      type: "event_msg",
      timestamp: "2026-08-06T10:00:00Z",
      payload: { type: "task_started", turn_id: "turn-cli" },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-06T10:00:01Z",
      payload: {
        turn_id: "turn-cli",
        model: "gpt-5.6-sol",
        effort: "max",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access", network_access: true },
        collaboration_mode: { mode: "default" },
      },
    },
  ]);

  assert.equal(facts.status, "running");
  assert.equal(facts.providerStatus, "task_started");
  assert.equal(facts.activeTurnId, "turn-cli");
  assert.equal(facts.observedAt, "2026-08-06T10:00:01.000Z");
  assert.equal(facts.profile?.value, "full-access");
  assert.deepEqual(facts.sandbox?.value, {
    mode: "danger-full-access",
    networkAccess: true,
  });
  assert.equal(facts.model?.value, "gpt-5.6-sol");
  assert.equal(facts.effort?.value, "max");
});

test("does not let an older completion clear a newer observed Codex turn", () => {
  const facts = analyzeCodexRolloutFacts([
    {
      type: "event_msg",
      timestamp: "2026-08-06T10:00:00Z",
      payload: { type: "task_started", turn_id: "turn-old" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-06T10:00:02Z",
      payload: { type: "task_started", turn_id: "turn-new" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-06T10:00:03Z",
      payload: { type: "task_complete", turn_id: "turn-old" },
    },
  ]);

  assert.equal(facts.status, "running");
  assert.equal(facts.activeTurnId, "turn-new");
  assert.equal(facts.lifecycleTurnId, "turn-new");
});

test("matching Codex lifecycle completion resolves the observed turn to idle", () => {
  const facts = analyzeCodexRolloutFacts([
    {
      type: "event_msg",
      timestamp: "2026-08-06T10:00:00Z",
      payload: { type: "task_started", turn_id: "turn-cli" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-06T10:00:04Z",
      payload: { type: "task_complete", turn_id: "turn-cli" },
    },
  ]);

  assert.equal(facts.status, "idle");
  assert.equal(facts.providerStatus, "task_complete");
  assert.equal(facts.activeTurnId, null);
  assert.equal(facts.lifecycleTurnId, "turn-cli");
});
