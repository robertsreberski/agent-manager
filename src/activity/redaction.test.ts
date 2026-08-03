import assert from "node:assert/strict";
import test from "node:test";

import {
  REDACTED_ACTIVITY_VALUE,
  redactActivityJson,
  redactActivityText,
  stripUnsafeControlCharacters,
} from "./redaction.ts";

test("redacts secret-shaped object keys recursively without mutating input", () => {
  const input = {
    safe: "visible",
    authorization: "Bearer should-never-render",
    nested: [{ api_key: "sk-proj-abcdefghijklmnopqrstuv", count: 2 }],
  };

  const output = redactActivityJson(input);

  assert.deepEqual(output, {
    safe: "visible",
    authorization: REDACTED_ACTIVITY_VALUE,
    nested: [{ api_key: REDACTED_ACTIVITY_VALUE, count: 2 }],
  });
  assert.equal(input.authorization, "Bearer should-never-render");
});

test("redacts common credential patterns from otherwise unstructured text", () => {
  const source = [
    "Authorization: Bearer abcdefghijklmnop",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv",
    "github=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "slack=xoxb-1234567890-abcdefghijkl",
    "aws=AKIAABCDEFGHIJKLMNOP",
    "password=hunter2",
    "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
  ].join("\n");

  const redacted = redactActivityText(source);

  for (const secret of [
    "abcdefghijklmnop",
    "sk-proj-",
    "ghp_",
    "xoxb-",
    "AKIAABCDEFGHIJKLMNOP",
    "hunter2",
    "private-material",
  ]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.ok(redacted.includes(REDACTED_ACTIVITY_VALUE));
});

test("strips unsafe terminal controls and bidi overrides but keeps layout whitespace", () => {
  assert.equal(
    stripUnsafeControlCharacters("left\u0000\u001b\u202E\u2066\tright\nnext"),
    "left\tright\nnext",
  );
});
