import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanCodexHookTarget,
  defaultCodexHookCleanupTarget,
  removeAgentManagerCodexHooks,
  sweepRetiredCodexHooks,
} from "./codex-hooks-cleanup.ts";

const SHIM = "/Users/x/Library/Application Support/agent-manager/hooks/codex-user-hook.mjs";
const OURS = `"${SHIM}"`;

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codex-hook-cleanup-"));
}

test("removes only our handlers and leaves the operator's own hooks standing", () => {
  const before = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: SHIM, timeout: 5 }] },
        { hooks: [{ type: "command", command: "/usr/local/bin/my-own-hook", timeout: 10 }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: SHIM, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/notify", timeout: 3 }] }],
    },
  }, null, 2);
  const { text, removed } = removeAgentManagerCodexHooks(before);
  assert.equal(removed.length, 2);
  const after = JSON.parse(text) as { hooks: Record<string, unknown[]> };
  // Our SessionStart entry goes; theirs survives in the same event.
  assert.equal(after.hooks.SessionStart?.length, 1);
  assert.match(JSON.stringify(after.hooks.SessionStart), /my-own-hook/u);
  // The event we solely occupied is removed rather than left empty.
  assert.equal(after.hooks.PreToolUse, undefined);
  // An event we never touched is byte-identical.
  assert.match(JSON.stringify(after.hooks.Stop), /notify/u);
  assert.doesNotMatch(text, /agent-manager/u);
});

test("preserves comments and formatting in the surrounding JSONC", () => {
  const before = `{
  // The operator's own comment, which must survive.
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": ${OURS}, "timeout": 5 }] },
      { "hooks": [{ "type": "command", "command": "/opt/mine", "timeout": 9 }] }
    ]
  }
}
`;
  const { text, removed } = removeAgentManagerCodexHooks(before);
  assert.equal(removed.length, 1);
  assert.match(text, /The operator's own comment, which must survive/u);
  assert.match(text, /\/opt\/mine/u);
  assert.doesNotMatch(text, /agent-manager/u);
});

test("is idempotent and writes nothing when there is nothing of ours", () => {
  const clean = JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/opt/mine", timeout: 9 }] }] },
  }, null, 2);
  const first = removeAgentManagerCodexHooks(clean);
  assert.deepEqual(first.removed, []);
  // Byte-identical, so the caller can skip the write entirely.
  assert.equal(first.text, clean);
  const second = removeAgentManagerCodexHooks(first.text);
  assert.deepEqual(second.removed, []);
});

test("drops an emptied hooks object rather than leaving a husk", () => {
  const before = JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: SHIM, timeout: 5 }] }] },
  }, null, 2);
  const { text } = removeAgentManagerCodexHooks(before);
  assert.deepEqual(JSON.parse(text), {});
});

test("removes an orphaned install whose durable record was lost", () => {
  // No `command` argument: the database is gone, but hooks that still fire on
  // every Codex event must not be stranded.
  const before = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: SHIM, timeout: 5 }] }] },
  }, null, 2);
  const { removed } = removeAgentManagerCodexHooks(before, undefined);
  assert.deepEqual(removed, [SHIM]);
});

test("takes only the handler when the operator added fields to our matcher", () => {
  const before = JSON.stringify({
    hooks: {
      Stop: [{
        matcher: "operator-added",
        hooks: [{ type: "command", command: SHIM, timeout: 5 }],
      }],
    },
  }, null, 2);
  const { text, removed } = removeAgentManagerCodexHooks(before);
  assert.deepEqual(removed, [SHIM]);
  // Their field survives; only our handler is taken.
  assert.match(text, /operator-added/u);
  assert.doesNotMatch(text, /agent-manager/u);
});

test("cleans a real settings file and its shim, then stays quiet on a second run", async () => {
  const directory = await scratch();
  const settingsPath = join(directory, "hooks.json");
  const shimPath = join(directory, "codex-user-hook.mjs");
  await writeFile(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: shimPath, timeout: 5 }] },
        { hooks: [{ type: "command", command: "/opt/mine", timeout: 9 }] },
      ],
    },
  }, null, 2), { mode: 0o600 });
  await writeFile(shimPath, "#!/usr/bin/env node\n", { mode: 0o700 });

  const first = await cleanCodexHookTarget({ settingsPath, shimPath, command: shimPath });
  assert.equal(first.error, null);
  assert.deepEqual(first.removedCommands, [shimPath]);
  assert.deepEqual(first.removedShimPaths, [shimPath]);
  assert.equal(existsSync(shimPath), false);
  assert.match(await readFile(settingsPath, "utf8"), /\/opt\/mine/u);
  // The operator's file keeps its own permissions.
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);

  const second = await cleanCodexHookTarget({ settingsPath, shimPath, command: shimPath });
  assert.equal(second.error, null);
  assert.deepEqual(second.removedCommands, []);
  assert.deepEqual(second.removedShimPaths, []);
});

test("reports a missing file as nothing to do rather than an error", async () => {
  const directory = await scratch();
  const report = await cleanCodexHookTarget({
    settingsPath: join(directory, "absent.json"),
    shimPath: join(directory, "absent.mjs"),
  });
  assert.equal(report.error, null);
  assert.deepEqual(report.removedCommands, []);
});

test("surfaces a malformed settings file as an error instead of throwing", async () => {
  const directory = await scratch();
  const settingsPath = join(directory, "hooks.json");
  await writeFile(settingsPath, "{ this is not json");
  const report = await cleanCodexHookTarget({ settingsPath, shimPath: join(directory, "s.mjs") });
  assert.notEqual(report.error, null);
  // The operator's file is left exactly as they left it.
  assert.equal(await readFile(settingsPath, "utf8"), "{ this is not json");
});

test("sweeps recorded project targets alongside the user-scope default", async () => {
  const home = await scratch();
  await mkdir(join(home, ".codex"), { recursive: true });
  const userSettings = join(home, ".codex", "hooks.json");
  await writeFile(userSettings, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: SHIM, timeout: 5 }] }] },
  }, null, 2));

  const project = await scratch();
  const projectSettings = join(project, "hooks.json");
  const projectShim = join(project, "codex-project-abc-hook.mjs");
  await writeFile(projectSettings, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: projectShim, timeout: 5 }] }] },
  }, null, 2));
  await writeFile(projectShim, "#!/usr/bin/env node\n");

  const reports = await sweepRetiredCodexHooks({
    homeDirectory: home,
    recorded: [{ settingsPath: projectSettings, shimPath: projectShim, command: projectShim }],
  });
  const byPath = new Map(reports.map((report) => [report.settingsPath, report]));
  // The project file is only reachable through the durable record.
  assert.deepEqual(byPath.get(projectSettings)?.removedCommands, [projectShim]);
  assert.equal(existsSync(projectShim), false);
  // The user-scope path is swept whether or not a record survived.
  assert.deepEqual(byPath.get(userSettings)?.removedCommands, [SHIM]);
});

test("resolves the user-scope target the retired installer wrote", () => {
  const target = defaultCodexHookCleanupTarget("/Users/x");
  assert.equal(target.settingsPath, "/Users/x/.codex/hooks.json");
  assert.equal(target.shimPath, SHIM);
});
