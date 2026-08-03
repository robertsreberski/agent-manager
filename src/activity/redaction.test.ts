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

test("redacts namespaced secret keys while leaving similarly named metadata visible", () => {
  const output = redactActivityJson({
    "x-api-key": "vendor-value",
    AWS_SECRET_ACCESS_KEY: "aws-secret-value",
    OPENAI_API_KEY: "openai-value",
    teamRefreshToken: "refresh-value",
    token_count: 42,
    tokenizer: "safe",
    public_key: "also-safe",
  });

  assert.deepEqual(output, {
    "x-api-key": REDACTED_ACTIVITY_VALUE,
    AWS_SECRET_ACCESS_KEY: REDACTED_ACTIVITY_VALUE,
    OPENAI_API_KEY: REDACTED_ACTIVITY_VALUE,
    teamRefreshToken: REDACTED_ACTIVITY_VALUE,
    token_count: 42,
    tokenizer: "safe",
    public_key: "also-safe",
  });
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

test("redacts prefixed secret assignments in headers, env output, and JSON text", () => {
  const redacted = redactActivityText([
    "x-api-key: vendor-secret-value",
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    "MY_APP_REFRESH_TOKEN='refresh-secret-value' SAFE_FIELD=visible",
    '{"vendorApiKey":"json-secret-value","token_count":2}',
  ].join("\n"));

  for (const secret of [
    "vendor-secret-value",
    "aws-secret-value",
    "refresh-secret-value",
    "json-secret-value",
  ]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.match(redacted, /SAFE_FIELD=visible/);
  assert.match(redacted, /"token_count":2/);
  assert.equal(redactActivityText('TOKEN="hello PASSWORD=nested"'), 'TOKEN="[REDACTED]"');
  assert.equal(
    redactActivityText('SAFE="hello PASSWORD=nested"'),
    'SAFE="hello PASSWORD=[REDACTED]"',
  );
});

test("strips unsafe terminal controls and bidi overrides but keeps layout whitespace", () => {
  assert.equal(
    stripUnsafeControlCharacters("left\u0000\u001b\u202E\u2066\tright\nnext"),
    "left\tright\nnext",
  );
});
