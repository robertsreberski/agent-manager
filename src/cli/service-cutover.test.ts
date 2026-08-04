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
