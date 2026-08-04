import assert from "node:assert/strict";
import test from "node:test";

import {
  selectedAttentionDetailsQuerySchema,
  selectedAttentionDetailsResponseSchema,
} from "./attention-detail.ts";

test("selected attention query accepts repeated exact IDs but rejects ambiguity and extras", () => {
  assert.deepEqual(selectedAttentionDetailsQuerySchema.parse({ requestId: "request-1" }), {
    requestId: ["request-1"],
  });
  assert.deepEqual(selectedAttentionDetailsQuerySchema.parse({
    requestId: ["request-1", "request-2"],
  }), {
    requestId: ["request-1", "request-2"],
  });
  assert.equal(selectedAttentionDetailsQuerySchema.safeParse({ requestId: [] }).success, false);
  assert.equal(selectedAttentionDetailsQuerySchema.safeParse({
    requestId: ["request-1", "request-1"],
  }).success, false);
  assert.equal(selectedAttentionDetailsQuerySchema.safeParse({
    requestId: "request-1",
    includeAll: true,
  }).success, false);
});

test("selected attention response is bounded, unique, and contains no generic payload escape hatch", () => {
  const value = {
    sessionId: "local:codex:thread-1",
    generation: 4,
    details: [{
      requestId: "request-1",
      kind: "question" as const,
      title: "Codex needs your answer",
      toolName: null,
      questions: [{ id: "surface", text: "Which surface?" }],
      truncated: false,
    }],
  };
  assert.deepEqual(selectedAttentionDetailsResponseSchema.parse(value), value);
  assert.equal(selectedAttentionDetailsResponseSchema.safeParse({
    ...value,
    details: [value.details[0], value.details[0]],
  }).success, false);
  assert.equal(selectedAttentionDetailsResponseSchema.safeParse({
    ...value,
    details: [{ ...value.details[0], summary: "unbounded provider input" }],
  }).success, false);
});
