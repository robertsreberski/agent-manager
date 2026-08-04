import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeHookBearer,
  createHookAuthorizationRecord,
  digestHookBearerToken,
  generateHookBearerToken,
} from "./auth.ts";

test("stores only bearer digests and authenticates exact Authorization headers", () => {
  const token = generateHookBearerToken();
  const record = createHookAuthorizationRecord({
    id: "install-1",
    token,
    createdAt: "2026-08-04T12:00:00.000Z",
    settingsPath: "/tmp/.claude/settings.json",
  });
  assert.match(record.tokenDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(record).includes(token), false);
  assert.equal(authorizeHookBearer(`Bearer ${token}`, [record])?.id, "install-1");
  assert.equal(authorizeHookBearer(`bearer ${token}`, [record]), null);
  assert.equal(authorizeHookBearer("Bearer definitely-not-the-token-00000000", [record]), null);
  assert.equal(digestHookBearerToken(token), record.tokenDigest);
});
