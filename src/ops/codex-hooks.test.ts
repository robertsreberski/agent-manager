import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CODEX_HOOK_EVENTS, type CodexHookStatus } from "../providers/codex/codex-hook.ts";
import {
  inspectCodexHookOperationalStatus,
  readCodexHookSource,
  runCodexHookOperation,
  type CodexHookInstallRecord,
} from "./codex-hooks.ts";

const TOKEN = "codex-operation-token-with-at-least-thirty-two-characters";
const ENDPOINT = "http://127.0.0.1:43127/api/v1/hooks/codex";

function trusted(command: string): CodexHookStatus {
  return {
    state: "trusted",
    reason: "trusted in disposable test",
    installedEvents: [...CODEX_HOOK_EVENTS],
  };
}

test("Codex hook operation preserves unrelated hooks and consent-gates idempotent install/uninstall", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "agent-manager-codex-hooks-"));
  const settingsDirectory = join(homeDirectory, ".codex");
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(join(settingsDirectory, "hooks.json"), `{
  "unrelated": { "keep": true },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/opt/existing-hook", "timeout": 10 }] }]
  }
}\n`);
  let record: CodexHookInstallRecord | null = null;
  let confirmed = false;
  let seenAt: string | null = null;
  const previews: string[] = [];
  const dependencies = {
    loadRecord: () => record,
    saveRecord: (next: CodexHookInstallRecord) => {
      record = structuredClone(next);
    },
    removeRecord: () => {
      record = null;
    },
    trustStatus: (_settingsPath: string, command: string) => trusted(command),
    lastSeenAt: () => seenAt,
    showPreview: (plan: { diff: string; shimNotice: string; secretShimAfter: string | null }) => {
      previews.push(`${plan.diff}\n${plan.shimNotice}`);
      assert.equal(`${plan.diff}\n${plan.shimNotice}`.includes(TOKEN), false);
      assert.ok(plan.secretShimAfter?.includes(TOKEN) ?? plan.secretShimAfter === null);
    },
    confirm: () => confirmed,
    generateBearerToken: () => TOKEN,
    randomUUID: () => "codex-install-id",
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    nodeExecutable: process.execPath,
  };
  const install = {
    operation: "install" as const,
    scope: "user" as const,
    homeDirectory,
    endpoint: ENDPOINT,
  };
  try {
    const cancelled = await runCodexHookOperation(install, dependencies);
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(record, null);

    confirmed = true;
    const installed = await runCodexHookOperation(install, dependencies);
    assert.equal(installed.outcome, "applied");
    assert.equal(installed.status.state, "installed-unseen");
    assert.ok(record);
    assert.equal(JSON.stringify(record).includes(TOKEN), false);
    const source = await readCodexHookSource({ scope: "user", homeDirectory });
    assert.match(source.settingsText, /\/opt\/existing-hook/u);
    assert.match(source.settingsText, /codex-user-hook\.mjs/u);
    assert.equal((await lstat(source.shimPath)).mode & 0o777, 0o700);
    assert.equal((await readFile(source.shimPath, "utf8")).includes(TOKEN), true);
    assert.equal(inspectCodexHookOperationalStatus({
      source,
      record,
      trust: trusted("installed command"),
      lastSeenAt: "2026-08-04T12:00:01.000Z",
    }).state, "active");
    assert.equal(inspectCodexHookOperationalStatus({
      source,
      record,
      trust: null,
      lastSeenAt: "2026-08-04T12:00:01.000Z",
    }).state, "awaiting-trust");
    assert.equal(inspectCodexHookOperationalStatus({
      source,
      record,
      trust: {
        state: "disabled",
        reason: "disabled by Codex",
        installedEvents: [...CODEX_HOOK_EVENTS],
      },
    }).state, "provider-disabled");

    // A failed database save must be recoverable without duplicating every
    // deterministic shim handler on the next install attempt.
    record = null;
    const recovered = await runCodexHookOperation(install, dependencies);
    assert.equal(recovered.outcome, "applied");
    const recoveredSource = await readCodexHookSource({ scope: "user", homeDirectory });
    assert.equal(
      recoveredSource.settingsText.match(/codex-user-hook\.mjs/gu)?.length,
      CODEX_HOOK_EVENTS.length,
    );

    const repeat = await runCodexHookOperation(install, dependencies);
    assert.equal(repeat.outcome, "unchanged");
    seenAt = "2026-08-04T12:00:01.000Z";
    const status = await runCodexHookOperation({
      operation: "status",
      scope: "user",
      homeDirectory,
    }, dependencies);
    assert.equal(status.status.state, "active");

    const removed = await runCodexHookOperation({
      operation: "uninstall",
      scope: "user",
      homeDirectory,
    }, dependencies);
    assert.equal(removed.outcome, "applied");
    assert.equal(removed.status.state, "absent");
    assert.equal(record, null);
    const after = await readFile(join(settingsDirectory, "hooks.json"), "utf8");
    assert.match(after, /\/opt\/existing-hook/u);
    assert.doesNotMatch(after, /codex-user-hook/u);
    await assert.rejects(lstat(source.shimPath), /ENOENT/u);
    assert.ok(previews.length >= 3);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
