import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import {
  CONFIG_SCHEMA_VERSION,
  defaultConfig,
  defaultPaths,
  loadConfig,
  resetOwnedState,
  saveConfig,
  type AgentManagerConfig,
  type AgentManagerPaths,
} from "../ops/index.ts";
import {
  DATABASE_SCHEMA_VERSION,
  ManagerDatabase,
} from "../server/persistence.ts";
import { runCli, type CliDependencies } from "./index.ts";

const SERVICE_EXECUTABLES = {
  node: "/trusted/bin/node",
  codex: "/trusted/bin/codex",
  claude: "/trusted/bin/claude",
  tmux: "/trusted/bin/tmux",
  tailscale: "/trusted/bin/tailscale",
} as const;

function output() {
  let value = "";
  return {
    writer: { write(chunk: string) { value += chunk; } },
    read: () => value,
  };
}

function temporaryPaths(t: TestContext): { home: string; paths: AgentManagerPaths } {
  const home = mkdtempSync(join(tmpdir(), "agent-manager-service-cutover-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, paths: defaultPaths(home, 50_123) };
}

function createCurrentState(paths: AgentManagerPaths): AgentManagerConfig {
  const config = loadConfig(paths);
  saveConfig(config, paths);
  const database = new ManagerDatabase(paths.databaseFile);
  database.close();
  return config;
}

function probeDatabase(paths: AgentManagerPaths): void {
  const database = new ManagerDatabase(paths.databaseFile);
  database.close();
}

function serviceDependencies(
  home: string,
  paths: AgentManagerPaths,
  events: string[],
  stdout = output(),
  stderr = output(),
): { overrides: Partial<CliDependencies>; stdout: ReturnType<typeof output>; stderr: ReturnType<typeof output> } {
  return {
    stdout,
    stderr,
    overrides: {
      stdout: stdout.writer,
      stderr: stderr.writer,
      homeDirectory: home,
      cliEntrypoint: "/opt/agent-manager/dist/cli/index.js",
      serviceExecutables: () => SERVICE_EXECUTABLES,
      loadConfig: () => loadConfig(paths),
      prepareServiceState: () => { events.push("prepare"); probeDatabase(paths); },
      stopService: () => { events.push("stop"); },
      resetOwnedState: () => { events.push("reset"); return resetOwnedState(paths); },
      recreateOwnedState: () => { events.push("recreate"); return createCurrentState(paths); },
      installService: () => { events.push("install"); return join(home, "Library", "LaunchAgents", "local.agent-manager.cockpit.plist"); },
      reloadService: () => { events.push("reload"); },
      waitForService: async () => { events.push("healthy"); },
    },
  };
}

function writePreservedMarkers(paths: AgentManagerPaths): string[] {
  const markers = [
    paths.auditFile,
    join(paths.dataDirectory, "provider-hooks.json"),
    join(paths.dataDirectory, "transcripts", "session.jsonl"),
    join(paths.dataDirectory, "tmux", "pane.txt"),
  ];
  for (const marker of markers) {
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, `preserve:${marker}\n`, { mode: 0o600 });
  }
  return markers;
}

function assertCurrentState(paths: AgentManagerPaths): void {
  assert.equal(loadConfig(paths).version, CONFIG_SCHEMA_VERSION);
  const database = new DatabaseSync(paths.databaseFile);
  try {
    const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, DATABASE_SCHEMA_VERSION);
  } finally {
    database.close();
  }
  assert.equal(statSync(paths.configFile).mode & 0o777, 0o600);
  assert.equal(statSync(paths.databaseFile).mode & 0o777, 0o600);
}

test("service install cold-cuts an old config, preserves non-owned surfaces, and converges idempotently", async (t) => {
  const { home, paths } = temporaryPaths(t);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `${JSON.stringify({ ...defaultConfig(), version: 2 })}\n`, { mode: 0o600 });
  writeFileSync(paths.databaseFile, "old database", { mode: 0o600 });
  writeFileSync(`${paths.databaseFile}-wal`, "old wal", { mode: 0o600 });
  writeFileSync(`${paths.databaseFile}-shm`, "old shm", { mode: 0o600 });
  const markers = writePreservedMarkers(paths);
  const events: string[] = [];
  const fixture = serviceDependencies(home, paths, events);

  assert.equal(await runCli(["service", "install"], fixture.overrides), 0);
  assert.deepEqual(events, ["stop", "reset", "recreate", "install", "reload", "healthy"]);
  assertCurrentState(paths);
  for (const marker of markers) assert.match(readFileSync(marker, "utf8"), /^preserve:/u);
  assert.match(fixture.stdout.read(), /Recreated incompatible Agent Manager config and database state/u);

  events.length = 0;
  assert.equal(await runCli(["service", "install"], fixture.overrides), 0);
  assert.deepEqual(events, ["prepare", "install", "reload", "healthy"]);
  assertCurrentState(paths);
  for (const marker of markers) assert.match(readFileSync(marker, "utf8"), /^preserve:/u);
});

test("service install cold-cuts an old database before installing the current service", async (t) => {
  const { home, paths } = temporaryPaths(t);
  const config = loadConfig(paths);
  saveConfig(config, paths);
  const oldDatabase = new DatabaseSync(paths.databaseFile);
  oldDatabase.exec(`PRAGMA user_version = ${String(DATABASE_SCHEMA_VERSION - 1)}`);
  oldDatabase.close();
  const markers = writePreservedMarkers(paths);
  const events: string[] = [];
  const fixture = serviceDependencies(home, paths, events);

  assert.equal(await runCli(["service", "install"], fixture.overrides), 0);
  assert.deepEqual(events, ["prepare", "stop", "reset", "recreate", "install", "reload", "healthy"]);
  assertCurrentState(paths);
  for (const marker of markers) assert.match(readFileSync(marker, "utf8"), /^preserve:/u);
});

test("service install fails closed on an unknown config error", async (t) => {
  const { home, paths } = temporaryPaths(t);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, "{ malformed", { mode: 0o600 });
  const events: string[] = [];
  const fixture = serviceDependencies(home, paths, events);

  assert.equal(await runCli(["service", "install"], fixture.overrides), 1);
  assert.deepEqual(events, []);
  assert.equal(readFileSync(paths.configFile, "utf8"), "{ malformed");
  assert.notEqual(fixture.stderr.read(), "");
});

/** A handler shaped like one we installed, whose durable record the reset removed. */
function writeOrphanedClaudeHook(home: string, installId: string): string {
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, `${JSON.stringify({
    theme: "dark",
    hooks: {
      Stop: [{
        hooks: [{
          type: "http",
          url: "http://127.0.0.1:43127/api/v1/hooks/claude",
          timeout: 15,
          headers: {
            Authorization: "Bearer stale-token-from-before-the-reset",
            "X-Agent-Manager-Install": installId,
            "X-Agent-Manager-Owner": "$AGENT_MANAGER_SESSION_OWNER",
          },
          allowedEnvVars: ["AGENT_MANAGER_SESSION_OWNER"],
        }],
      }],
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return settingsPath;
}

test("a cold cutover reissues the token of a hook handler it orphaned", async (t) => {
  const { home, paths } = temporaryPaths(t);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `${JSON.stringify({ ...defaultConfig(), version: 2 })}\n`, { mode: 0o600 });
  writeFileSync(paths.databaseFile, "old database", { mode: 0o600 });
  const settingsPath = writeOrphanedClaudeHook(home, "11111111-2222-3333-4444-555555555555");
  const before = readFileSync(settingsPath, "utf8");
  const events: string[] = [];
  const fixture = serviceDependencies(home, paths, events);

  assert.equal(await runCli(["service", "install"], fixture.overrides), 0);

  /*
    The whole point: the operator does nothing, and the handler that was about to
    answer 401 on every turn has a token the recreated database knows.
  */
  assert.match(fixture.stdout.read(), /Reissued the Claude hook token/u);
  const after = readFileSync(settingsPath, "utf8");
  assert.notEqual(before, after);
  assert.doesNotMatch(after, /stale-token-from-before-the-reset/u);
  /*
    Every handler carries one fresh token. This reuses the ordinary installer, so
    the handler set also converges on the current build's events rather than
    staying the stale subset — which is what you want after a schema cutover, and
    is why the message says reissued rather than claiming a surgical token swap.
  */
  const tokens = new Set([...after.matchAll(/"Authorization": "Bearer ([A-Za-z0-9_-]+)"/gu)].map((m) => m[1]));
  assert.equal(tokens.size, 1, "one token across every handler");
  assert.ok((tokens.values().next().value ?? "").length >= 16);
  const installedEvents = Object.keys(JSON.parse(after).hooks);
  assert.ok(installedEvents.includes("Stop"), "the event the operator already had survives");
  assert.ok(installedEvents.length > 1, "the handler set converges on the current build");
  // The operator's unrelated settings are untouched.
  assert.equal(JSON.parse(after).theme, "dark");

  const database = new DatabaseSync(paths.databaseFile, { readOnly: true });
  try {
    const rows = database.prepare("select settings_path from claude_hook_installs").all();
    assert.equal(rows.length, 1, "the reissued install must be durable before the service starts");
    assert.equal(rows[0]?.settings_path, settingsPath);
  } finally {
    database.close();
  }
});

test("a cold cutover installs no hook where the operator never had one", async (t) => {
  const { home, paths } = temporaryPaths(t);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `${JSON.stringify({ ...defaultConfig(), version: 2 })}\n`, { mode: 0o600 });
  writeFileSync(paths.databaseFile, "old database", { mode: 0o600 });
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  // Someone else's hook, plus unrelated settings. Neither is ours to rewrite.
  const untouched = `${JSON.stringify({
    theme: "light",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/not-ours" }] }] },
  }, null, 2)}\n`;
  writeFileSync(settingsPath, untouched, { mode: 0o600 });
  const fixture = serviceDependencies(home, paths, []);

  assert.equal(await runCli(["service", "install"], fixture.overrides), 0);

  assert.doesNotMatch(fixture.stdout.read(), /Reissued the Claude hook token/u);
  assert.equal(readFileSync(settingsPath, "utf8"), untouched, "a foreign handler is never rewritten");
  const database = new DatabaseSync(paths.databaseFile, { readOnly: true });
  try {
    assert.deepEqual(database.prepare("select * from claude_hook_installs").all(), []);
  } finally {
    database.close();
  }
});
