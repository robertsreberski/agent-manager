import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ConfigConflictError,
  ConfigLockTimeoutError,
  configLockPath,
  defaultConfig,
  ensurePrivateRuntimeDirectory,
  loadConfig,
  mutateConfig,
  resetOwnedState,
  saveConfig,
  withConfigLock,
  type AgentManagerPaths,
} from "./config.ts";

const execFileAsync = promisify(execFile);

function temporaryPaths(t: { after(callback: () => void): void }): AgentManagerPaths {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-config-test-"));
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

test("mutateConfig serializes interprocess reload-mutate-save transactions", async (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);
  const moduleUrl = new URL("./config.ts", import.meta.url).href;
  const script = `
    import { mutateConfig } from ${JSON.stringify(moduleUrl)};
    const paths = JSON.parse(process.env.AGENT_MANAGER_TEST_PATHS);
    const id = process.env.AGENT_MANAGER_TEST_WORKSPACE;
    mutateConfig((config) => {
      const holdUntil = Date.now() + 150;
      while (Date.now() < holdUntil) {}
      config.workspaces.push({ id, name: id, path: "/tmp/" + id, hostId: "local" });
    }, paths, { timeoutMs: 3000, pollIntervalMs: 5 });
  `;

  await Promise.all(["workspace-a", "workspace-b"].map(async (id) => {
    await execFileAsync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          AGENT_MANAGER_TEST_PATHS: JSON.stringify(paths),
          AGENT_MANAGER_TEST_WORKSPACE: id,
        },
      },
    );
  }));

  assert.deepEqual(
    new Set(loadConfig(paths).workspaces.map((workspace) => workspace.id)),
    new Set(["workspace-a", "workspace-b"]),
  );
  assert.equal(lstatSync(paths.configFile).mode & 0o777, 0o600);
});

test("a stale loaded config cannot restore a revoked Tailscale identity", (t) => {
  const paths = temporaryPaths(t);
  const initial = defaultConfig();
  initial.tailscale.allowedLogin = "owner@example.com";
  initial.tailscale.dnsName = "host.example.ts.net";
  saveConfig(initial, paths);

  const stale = loadConfig(paths);
  mutateConfig((config) => {
    config.tailscale.allowedLogin = null;
    config.tailscale.dnsName = null;
  }, paths);

  stale.workspaces.push({ id: "stale", name: "stale", path: "/tmp/stale", hostId: "local" });
  assert.throws(() => saveConfig(stale, paths), ConfigConflictError);
  assert.deepEqual(loadConfig(paths).tailscale, {
    httpsPort: 9_443,
    allowedLogin: null,
    dnsName: null,
  });
  assert.deepEqual(loadConfig(paths).workspaces, []);
});

test("mutateConfig CAS rejects a non-cooperating write during the transaction", (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);

  assert.throws(() => mutateConfig((config) => {
    const competing = defaultConfig();
    competing.tailscale.allowedLogin = "new-owner@example.com";
    competing.tailscale.dnsName = "new.example.ts.net";
    writeFileSync(paths.configFile, `${JSON.stringify(competing, null, 2)}\n`, { mode: 0o600 });
    config.workspaces.push({ id: "stale", name: "stale", path: "/tmp/stale", hostId: "local" });
  }, paths), ConfigConflictError);

  const finalConfig = loadConfig(paths);
  assert.equal(finalConfig.tailscale.allowedLogin, "new-owner@example.com");
  assert.equal(finalConfig.tailscale.dnsName, "new.example.ts.net");
  assert.deepEqual(finalConfig.workspaces, []);
});

test("config validation rejects partial or unsafe identity and invalid ports", (t) => {
  const paths = temporaryPaths(t);
  const partial = defaultConfig();
  partial.tailscale.allowedLogin = "owner@example.com";
  assert.throws(() => saveConfig(partial, paths), /configured together/);

  const unsafeLogin = defaultConfig();
  unsafeLogin.tailscale.allowedLogin = " owner@example.com";
  unsafeLogin.tailscale.dnsName = "host.example.ts.net";
  assert.throws(() => saveConfig(unsafeLogin, paths), /identity is invalid/);

  const unsafeDns = defaultConfig();
  unsafeDns.tailscale.allowedLogin = "owner@example.com";
  unsafeDns.tailscale.dnsName = "host.example.ts.net:9443";
  assert.throws(() => saveConfig(unsafeDns, paths), /identity is invalid/);

  const backendPort = defaultConfig();
  backendPort.backend.port = 65_536;
  assert.throws(() => saveConfig(backendPort, paths), /Backend port is invalid/);

  const tailscalePort = defaultConfig();
  tailscalePort.tailscale.httpsPort = 0;
  assert.throws(() => saveConfig(tailscalePort, paths), /HTTPS port is invalid/);
  assert.throws(() => lstatSync(paths.configFile), { code: "ENOENT" });
});

test("rejects an incompatible config until an explicit owned-state reset", (t) => {
  const paths = temporaryPaths(t);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `${JSON.stringify({
    version: 1,
    backend: { host: "127.0.0.1", port: 43_127 },
    tailscale: { httpsPort: 9_443, allowedLogin: null, dnsName: null },
    workspaces: [{ id: "legacy", name: "Legacy", path: "/tmp/legacy" }],
  })}\n`, { mode: 0o600 });

  assert.throws(() => loadConfig(paths), /Unsupported Agent Manager config version/);
  assert.deepEqual(resetOwnedState(paths), [paths.configFile]);
  assert.deepEqual(loadConfig(paths), defaultConfig());
});

test("rejects unknown fields in the current config epoch", (t) => {
  const paths = temporaryPaths(t);
  const config = { ...defaultConfig(), obsoleteMode: "planning" };
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  assert.throws(() => loadConfig(paths), /unknown or missing fields/);
});

test("resetOwnedState is bounded to private Agent Manager config and database files", (t) => {
  const paths = temporaryPaths(t);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, "old config", { mode: 0o600 });
  writeFileSync(paths.databaseFile, "old database", { mode: 0o600 });
  writeFileSync(`${paths.databaseFile}-wal`, "old wal", { mode: 0o600 });
  writeFileSync(paths.auditFile, "keep audit", { mode: 0o600 });
  const providerSettings = join(dirname(paths.dataDirectory), "provider-settings.json");
  writeFileSync(providerSettings, "keep provider", { mode: 0o600 });

  assert.deepEqual(resetOwnedState(paths), [
    paths.configFile,
    paths.databaseFile,
    `${paths.databaseFile}-wal`,
  ]);
  assert.throws(() => lstatSync(paths.configFile), { code: "ENOENT" });
  assert.throws(() => lstatSync(paths.databaseFile), { code: "ENOENT" });
  assert.equal(readFileSync(paths.auditFile, "utf8"), "keep audit");
  assert.equal(readFileSync(providerSettings, "utf8"), "keep provider");

  assert.throws(() => resetOwnedState({
    ...paths,
    configFile: providerSettings,
  }), /canonical owned state paths/);
});

test("withConfigLock times out on a live lock and reclaims an old malformed lock", (t) => {
  const paths = temporaryPaths(t);
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
  const lockPath = configLockPath(paths);
  mkdirSync(lockPath, { mode: 0o700 });
  const liveToken = "00000000-0000-4000-8000-000000000001";
  const liveClaim = join(lockPath, `claim-${liveToken}.json`);
  writeFileSync(liveClaim, `${JSON.stringify({
    pid: process.pid,
    token: liveToken,
    createdAtMs: Date.now(),
    state: "waiting",
    ticket: "1",
  })}\n`, { mode: 0o600 });

  assert.throws(
    () => withConfigLock(() => undefined, paths, { timeoutMs: 20, pollIntervalMs: 2 }),
    ConfigLockTimeoutError,
  );

  unlinkSync(liveClaim);
  const staleToken = "00000000-0000-4000-8000-000000000002";
  const staleClaim = join(lockPath, `claim-${staleToken}.json`);
  writeFileSync(staleClaim, "incomplete", { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  utimesSync(staleClaim, old, old);
  let ran = false;
  withConfigLock(() => {
    ran = true;
  }, paths, { timeoutMs: 100, pollIntervalMs: 2, staleAfterMs: 1_000 });
  assert.equal(ran, true);
  assert.deepEqual(readdirSync(lockPath), []);
});

test("multiple stale reclaimers cannot remove a newly acquired live claim", async (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);
  const lockPath = configLockPath(paths);
  const staleToken = "00000000-0000-4000-8000-000000000003";
  const staleClaim = join(lockPath, `claim-${staleToken}.json`);
  writeFileSync(staleClaim, "abandoned", { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  utimesSync(staleClaim, old, old);

  const moduleUrl = new URL("./config.ts", import.meta.url).href;
  const marker = join(dirname(paths.dataDirectory), "critical-section.marker");
  const startAt = Date.now() + 1_200;
  const script = `
    import { closeSync, openSync, unlinkSync } from "node:fs";
    import { mutateConfig } from ${JSON.stringify(moduleUrl)};
    const paths = JSON.parse(process.env.AGENT_MANAGER_TEST_PATHS);
    const marker = process.env.AGENT_MANAGER_TEST_MARKER;
    const id = process.env.AGENT_MANAGER_TEST_WORKSPACE;
    const startAt = Number(process.env.AGENT_MANAGER_TEST_START_AT);
    while (Date.now() < startAt) {}
    mutateConfig((config) => {
      let descriptor;
      try {
        descriptor = openSync(marker, "wx", 0o600);
      } catch (error) {
        throw new Error("config critical sections overlapped", { cause: error });
      }
      try {
        const holdUntil = Date.now() + 75;
        while (Date.now() < holdUntil) {}
        config.workspaces.push({ id, name: id, path: "/tmp/" + id, hostId: "local" });
      } finally {
        closeSync(descriptor);
        unlinkSync(marker);
      }
    }, paths, { timeoutMs: 10000, pollIntervalMs: 2, staleAfterMs: 1000 });
  `;
  const ids = Array.from({ length: 8 }, (_, index) => `reclaimer-${String(index)}`);
  await Promise.all(ids.map(async (id) => {
    await execFileAsync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          AGENT_MANAGER_TEST_PATHS: JSON.stringify(paths),
          AGENT_MANAGER_TEST_MARKER: marker,
          AGENT_MANAGER_TEST_START_AT: String(startAt),
          AGENT_MANAGER_TEST_WORKSPACE: id,
        },
      },
    );
  }));

  assert.deepEqual(
    new Set(loadConfig(paths).workspaces.map((workspace) => workspace.id)),
    new Set(ids),
  );
  assert.deepEqual(readdirSync(lockPath), []);
  assert.throws(() => lstatSync(marker), { code: "ENOENT" });
});

test("a throwing mutator leaves the config and lock unchanged", (t) => {
  const paths = temporaryPaths(t);
  saveConfig(defaultConfig(), paths);
  assert.throws(() => mutateConfig((config) => {
    config.tailscale.dnsName = "must-not-commit.example.ts.net";
    throw new Error("stop");
  }, paths), /stop/);
  assert.equal(loadConfig(paths).tailscale.dnsName, null);
  assert.deepEqual(readdirSync(configLockPath(paths)), []);
});

test("ensurePrivateRuntimeDirectory creates and reverifies a 0700 boundary", (t) => {
  const paths = temporaryPaths(t);
  ensurePrivateRuntimeDirectory(paths);
  const runtime = lstatSync(paths.runtimeDirectory);
  assert.equal(runtime.isDirectory(), true);
  assert.equal(runtime.isSymbolicLink(), false);
  assert.equal(runtime.mode & 0o777, 0o700);
  if (typeof process.getuid === "function") assert.equal(runtime.uid, process.getuid());

  ensurePrivateRuntimeDirectory(paths);
  assert.equal(lstatSync(paths.runtimeDirectory).mode & 0o777, 0o700);
});

test("ensurePrivateRuntimeDirectory rejects symlinks, files, and unsafe modes", (t) => {
  const symlinkPaths = temporaryPaths(t);
  const target = join(symlinkPaths.dataDirectory, "runtime-target");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  symlinkSync(target, symlinkPaths.runtimeDirectory);
  assert.throws(() => ensurePrivateRuntimeDirectory(symlinkPaths), /not a real directory/);

  const filePaths = temporaryPaths(t);
  writeFileSync(filePaths.runtimeDirectory, "not a directory", { mode: 0o600 });
  assert.throws(() => ensurePrivateRuntimeDirectory(filePaths), /not a real directory/);

  const modePaths = temporaryPaths(t);
  mkdirSync(modePaths.runtimeDirectory, { mode: 0o700 });
  chmodSync(modePaths.runtimeDirectory, 0o750);
  assert.throws(() => ensurePrivateRuntimeDirectory(modePaths), /mode 0700/);
  assert.equal(lstatSync(modePaths.runtimeDirectory).mode & 0o777, 0o750);
});

test("ensurePrivateRuntimeDirectory rejects unsafe Codex socket parents", (t) => {
  const outsidePaths = temporaryPaths(t);
  outsidePaths.codexSocket = join(dirname(outsidePaths.runtimeDirectory), "outside.sock");
  assert.throws(() => ensurePrivateRuntimeDirectory(outsidePaths), /directly inside/);

  const linkedParentPaths = temporaryPaths(t);
  const realParent = join(linkedParentPaths.dataDirectory, "real-parent");
  const linkedParent = join(linkedParentPaths.dataDirectory, "linked-parent");
  mkdirSync(realParent, { recursive: true, mode: 0o700 });
  symlinkSync(realParent, linkedParent);
  linkedParentPaths.runtimeDirectory = join(linkedParent, "runtime");
  linkedParentPaths.codexSocket = join(linkedParentPaths.runtimeDirectory, "codex.sock");
  assert.throws(() => ensurePrivateRuntimeDirectory(linkedParentPaths), /Runtime parent.*not a real directory/);
});
