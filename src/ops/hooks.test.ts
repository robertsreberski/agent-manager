import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseJsonc } from "./hooks-jsonc.ts";
import { CLAUDE_HOOK_EVENTS } from "../providers/hooks/claude-types.ts";
import {
  applyClaudeHookSettingsPlan,
  inspectClaudeHookInstall,
  inspectClaudeHookOperationalStatus,
  previewClaudeHookInstall,
  previewClaudeHookUninstall,
  readClaudeHookSettings,
  resolveClaudeHookSettingsPath,
  runClaudeHookOperation,
  type ClaudeHookInstallRecord,
} from "./hooks.ts";

const TOKEN = "test-token-with-at-least-thirty-two-characters-1234";

test("surgically installs, inspects, replaces, and removes Claude HTTP hooks", () => {
  const before = `{
  // unrelated user settings stay byte-identical
  "permissions": { "allow": ["Bash(ls:*)"] },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "echo existing" }]
      }
    ]
  },
  "mcpServers": { "local": { "command": "server" } }
}
`;
  const settingsPath = "/tmp/project/.claude/settings.local.json";
  const install = previewClaudeHookInstall({
    settingsPath,
    settingsText: before,
    settingsExisted: true,
    endpoint: "http://127.0.0.1:9843/api/v1/hooks/claude",
    bearerToken: TOKEN,
    installId: "install-1",
    now: new Date("2026-08-04T12:00:00.000Z"),
  });
  assert.equal(install.changed, true);
  assert.equal(install.diff.includes(TOKEN), false);
  assert.doesNotThrow(() => parseJsonc(install.after));
  assert.equal(inspectClaudeHookInstall(install.after, install.record).state, "current");
  assert.ok(install.after.includes('"command": "echo existing"'));
  assert.ok(install.after.includes('"mcpServers": { "local": { "command": "server" } }'));

  const idempotent = previewClaudeHookInstall({
    settingsPath,
    settingsText: install.after,
    settingsExisted: true,
    endpoint: install.record.endpoint,
    bearerToken: TOKEN,
    installId: install.record.id,
    now: new Date("2026-08-04T12:00:00.000Z"),
    previousRecord: install.record,
  });
  assert.equal(idempotent.changed, false);
  assert.equal(inspectClaudeHookInstall(idempotent.after, idempotent.record).state, "current");

  const handEdited = idempotent.after.replace(
    '"mcpServers": { "local": { "command": "server" } }',
    '"mcpServers": { "local": { "command": "server", "args": ["--safe"] } }',
  );
  const uninstall = previewClaudeHookUninstall({
    settingsPath,
    settingsText: handEdited,
    settingsExisted: true,
    record: idempotent.record,
  });
  assert.doesNotThrow(() => parseJsonc(uninstall.after));
  assert.equal(inspectClaudeHookInstall(uninstall.after, idempotent.record).state, "missing");
  assert.ok(uninstall.after.includes('"command": "echo existing"'));
  assert.ok(uninstall.after.includes('"args": ["--safe"]'));
});

test("requires consent and rejects concurrent settings edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manager-hooks-"));
  const settingsPath = join(directory, ".claude", "settings.json");
  const before = "{\n  \"theme\": \"dark\"\n}\n";
  const plan = previewClaudeHookInstall({
    settingsPath,
    settingsText: before,
    settingsExisted: true,
    endpoint: "http://127.0.0.1:9843/api/v1/hooks/claude",
    bearerToken: TOKEN,
    installId: "install-apply",
  });
  await assert.rejects(
    applyClaudeHookSettingsPlan(plan, { confirmed: false }),
    /explicit confirmation/,
  );

  await mkdir(join(directory, ".claude"), { recursive: true });
  await writeFile(settingsPath, before);
  await writeFile(settingsPath, before.replace("dark", "light"));
  await assert.rejects(
    applyClaudeHookSettingsPlan(plan, { confirmed: true }),
    /changed after preview/,
  );

  const fresh = previewClaudeHookInstall({
    settingsPath,
    settingsText: await readFile(settingsPath, "utf8"),
    settingsExisted: true,
    endpoint: "http://127.0.0.1:9843/api/v1/hooks/claude",
    bearerToken: TOKEN,
    installId: "install-apply",
  });
  await applyClaudeHookSettingsPlan(fresh, { confirmed: true });
  assert.equal(inspectClaudeHookInstall(await readFile(settingsPath, "utf8"), fresh.record).state, "current");
});

test("never accepts managed-policy paths or non-loopback endpoints", () => {
  assert.throws(() => previewClaudeHookInstall({
    settingsPath: "/etc/claude-code/managed-settings.json",
    settingsText: "{}",
    settingsExisted: true,
    endpoint: "http://127.0.0.1:9843/api/v1/hooks/claude",
    bearerToken: TOKEN,
    installId: "unsafe",
  }), /Managed Claude policy/);
  assert.throws(() => previewClaudeHookInstall({
    settingsPath: "/tmp/.claude/settings.json",
    settingsText: "{}",
    settingsExisted: true,
    endpoint: "https://example.com/api/v1/hooks/claude",
    bearerToken: TOKEN,
    installId: "unsafe",
  }), /loopback HTTP/);
});

test("treats duplicate or hand-edited owned handlers as stale", () => {
  const settingsPath = "/tmp/.claude/settings.json";
  const install = previewClaudeHookInstall({
    settingsPath,
    settingsText: "{}\n",
    settingsExisted: true,
    endpoint: "http://127.0.0.1:9843/api/v1/hooks/claude",
    bearerToken: TOKEN,
    installId: "strict-install",
  });
  const edited = install.after.replace('"timeout": 480', '"timeout": 30');
  assert.equal(inspectClaudeHookInstall(edited, install.record).state, "stale");

  const parsed = JSON.parse(install.after) as {
    hooks: Record<string, Array<Record<string, unknown>>>;
  };
  parsed.hooks.SessionStart!.push(structuredClone(parsed.hooks.SessionStart![0]!));
  assert.equal(
    inspectClaudeHookInstall(JSON.stringify(parsed, null, 2), install.record).state,
    "stale",
  );
});

test("exposes deterministic user/project CLI scope and operational status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manager-hook-scope-"));
  const userPath = resolveClaudeHookSettingsPath({
    scope: "user",
    homeDirectory: directory,
  });
  const projectPath = resolveClaudeHookSettingsPath({
    scope: "project",
    homeDirectory: directory,
    projectDirectory: directory,
  });
  assert.equal(userPath, join(directory, ".claude", "settings.json"));
  assert.equal(projectPath, join(directory, ".claude", "settings.local.json"));
  const absent = await readClaudeHookSettings(userPath);
  assert.equal(absent.settingsExisted, false);
  assert.equal(inspectClaudeHookOperationalStatus({
    source: absent,
    record: null,
  }).state, "absent");

  const install = previewClaudeHookInstall({
    settingsPath: userPath,
    settingsText: absent.settingsText,
    settingsExisted: absent.settingsExisted,
    endpoint: "http://127.0.0.1:9843/api/v1/hooks/claude",
    bearerToken: TOKEN,
    installId: "scope-install",
    now: new Date("2026-08-04T12:00:00.000Z"),
  });
  const installed = {
    settingsPath: userPath,
    settingsText: install.after,
    settingsExisted: true,
  };
  assert.equal(inspectClaudeHookOperationalStatus({
    source: installed,
    record: install.record,
  }).state, "installed-unseen");
  assert.equal(inspectClaudeHookOperationalStatus({
    source: installed,
    record: install.record,
    lastSeenAt: "2026-08-04T12:00:01.000Z",
  }).state, "active");
  assert.equal(inspectClaudeHookOperationalStatus({
    source: {
      ...installed,
      settingsText: installed.settingsText.replace("{", "{\n  \"disableAllHooks\": true,"),
    },
    record: install.record,
  }).state, "provider-disabled");
});

test("runs the complete consent-gated CLI install/status/uninstall lifecycle", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "agent-manager-hook-command-"));
  let record: ClaudeHookInstallRecord | null = null;
  let confirmed = false;
  const previews: string[] = [];
  const dependencies = {
    loadRecord: () => record,
    saveRecord: (next: ClaudeHookInstallRecord) => {
      record = structuredClone(next);
    },
    removeRecord: () => {
      record = null;
    },
    showPreview: (plan: { diff: string }) => {
      previews.push(plan.diff);
    },
    confirm: () => confirmed,
    randomUUID: () => "cli-install-id",
    generateBearerToken: () => TOKEN,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
  };
  const installInput = {
    operation: "install" as const,
    scope: "user" as const,
    homeDirectory,
    endpoint: "http://127.0.0.1:43127/api/v1/hooks/claude",
  };

  const cancelled = await runClaudeHookOperation(installInput, dependencies);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(record, null);
  assert.equal(previews[0]?.includes(TOKEN), false);

  confirmed = true;
  const installed = await runClaudeHookOperation(installInput, dependencies);
  assert.equal(installed.outcome, "applied");
  assert.equal(installed.status.state, "installed-unseen");
  assert.ok(record);
  assert.equal(JSON.stringify(record).includes(TOKEN), false);

  const repeat = await runClaudeHookOperation(installInput, dependencies);
  assert.equal(repeat.outcome, "unchanged");
  const status = await runClaudeHookOperation({
    operation: "status",
    scope: "user",
    homeDirectory,
  }, dependencies);
  assert.equal(status.status.state, "installed-unseen");

  const removed = await runClaudeHookOperation({
    operation: "uninstall",
    scope: "user",
    homeDirectory,
  }, dependencies);
  assert.equal(removed.outcome, "applied");
  assert.equal(removed.status.state, "absent");
  assert.equal(record, null);
});

test("recovers an orphaned settings install after database save failure and cold reset", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "agent-manager-hook-recovery-"));
  const settingsDirectory = join(homeDirectory, ".claude");
  const settingsPath = join(settingsDirectory, "settings.json");
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(settingsPath, `{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "/opt/unrelated-hook" }]
    }]
  }
}\n`);
  const input = {
    operation: "install" as const,
    scope: "user" as const,
    homeDirectory,
    endpoint: "http://127.0.0.1:43127/api/v1/hooks/claude",
  };
  try {
    await assert.rejects(runClaudeHookOperation(input, {
      loadRecord: () => null,
      saveRecord: () => {
        throw new Error("simulated database save failure");
      },
      removeRecord: () => undefined,
      showPreview: () => undefined,
      confirm: () => true,
      randomUUID: () => "orphan-install",
      generateBearerToken: () => "orphan-token-with-at-least-thirty-two-characters",
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    }), /simulated database save failure/u);

    const orphaned = await readFile(settingsPath, "utf8");
    assert.equal(
      orphaned.match(/"X-Agent-Manager-Install": "orphan-install"/gu)?.length,
      CLAUDE_HOOK_EVENTS.length,
    );
    assert.match(orphaned, /"command": "\/opt\/unrelated-hook"/u);

    let recoveredRecord: ClaudeHookInstallRecord | null = null;
    const recovered = await runClaudeHookOperation(input, {
      loadRecord: () => recoveredRecord,
      saveRecord: (record) => {
        recoveredRecord = structuredClone(record);
      },
      removeRecord: () => {
        recoveredRecord = null;
      },
      showPreview: () => undefined,
      confirm: () => true,
      randomUUID: () => "recovered-install",
      generateBearerToken: () => "recovered-token-with-at-least-thirty-two-characters",
      now: () => new Date("2026-08-04T12:01:00.000Z"),
    });
    assert.equal(recovered.outcome, "applied");
    assert.ok(recoveredRecord);
    const after = await readFile(settingsPath, "utf8");
    assert.equal(after.includes("orphan-install"), false);
    assert.equal(
      after.match(/"X-Agent-Manager-Install": "recovered-install"/gu)?.length,
      CLAUDE_HOOK_EVENTS.length,
    );
    assert.match(after, /"command": "\/opt\/unrelated-hook"/u);

    const repeat = await runClaudeHookOperation(input, {
      loadRecord: () => recoveredRecord,
      saveRecord: (record) => {
        recoveredRecord = structuredClone(record);
      },
      removeRecord: () => {
        recoveredRecord = null;
      },
      showPreview: () => undefined,
      confirm: () => true,
      generateBearerToken: () => {
        throw new Error("idempotent recovery must reuse the installed token");
      },
    });
    assert.equal(repeat.outcome, "unchanged");
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
