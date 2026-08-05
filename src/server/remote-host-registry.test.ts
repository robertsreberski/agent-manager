import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addSshHost,
  ConfigLockTimeoutError,
  configLockPath,
  defaultConfig,
  loadConfig,
  mutateConfig,
  saveConfig,
  type AgentManagerPaths,
} from "../ops/config.ts";
import { ConfigRemoteHostRegistry } from "./remote-host-registry.ts";

function temporaryPaths(t: { after(callback: () => void): void }): AgentManagerPaths {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-remote-host-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "data");
  const runtimeDirectory = join(root, "runtime");
  return {
    dataDirectory,
    configFile: join(dataDirectory, "config.json"),
    databaseFile: join(dataDirectory, "state.sqlite"),
    auditFile: join(dataDirectory, "audit.jsonl"),
    runtimeDirectory,
    codexSocket: join(runtimeDirectory, "codex.sock"),
  };
}

test("lists the current canonical config and maps host names to labels", (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);
  const registry = new ConfigRemoteHostRegistry(paths);

  assert.deepEqual(registry.list(), []);
  const addedElsewhere = mutateConfig(
    (config) => addSshHost(config, { name: "Build Mac", target: "builder@example.test" }),
    paths,
  );

  assert.deepEqual(registry.list(), [{
    id: addedElsewhere.id,
    label: "Build Mac",
    target: "builder@example.test",
  }]);
});

test("add is target-idempotent and returns the authoritative config record", (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);
  const registry = new ConfigRemoteHostRegistry(paths);

  const initial = registry.add({ label: "Studio", target: "studio.example.test" });
  const repeated = registry.add({ label: "Renamed in stale UI", target: "studio.example.test" });

  assert.deepEqual(repeated, initial);
  assert.deepEqual(registry.list(), [initial]);
  assert.equal(loadConfig(paths).hosts[0]?.name, "Studio");
});

test("add preserves concurrent config fields and remove cascades host workspaces", (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);
  const registry = new ConfigRemoteHostRegistry(paths, { timeoutMs: 1_000, pollIntervalMs: 2 });

  mutateConfig((config) => {
    config.tailscale.allowedLogin = "owner@example.test";
    config.tailscale.dnsName = "owner.example.test";
  }, paths);
  const host = registry.add({ label: "GPU", target: "gpu.example.test" });
  mutateConfig((config) => {
    config.workspaces.push({
      id: "remote-workspace",
      name: "Remote workspace",
      path: "/srv/project",
      hostId: host.id,
    });
  }, paths);

  assert.equal(registry.remove(host.id), true);
  assert.equal(registry.remove(host.id), false);
  const current = loadConfig(paths);
  assert.deepEqual(current.hosts, []);
  assert.deepEqual(current.workspaces, []);
  assert.equal(current.tailscale.allowedLogin, "owner@example.test");
  assert.equal(current.tailscale.dnsName, "owner.example.test");
});

test("write lock options are configurable and timeout errors remain available to callers", (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);
  const lockDirectory = configLockPath(paths);
  mkdirSync(lockDirectory, { mode: 0o700, recursive: true });
  const token = randomUUID();
  writeFileSync(join(lockDirectory, `claim-${token}.json`), `${JSON.stringify({
    pid: process.pid,
    token,
    createdAtMs: Date.now(),
    state: "waiting",
    ticket: "1",
  })}\n`, { mode: 0o600 });
  const registry = new ConfigRemoteHostRegistry(paths, {
    timeoutMs: 10,
    pollIntervalMs: 1,
  });

  assert.throws(
    () => registry.add({ label: "Blocked", target: "blocked.example.test" }),
    (error: unknown) => error instanceof ConfigLockTimeoutError && error.timeoutMs === 10,
  );
});
