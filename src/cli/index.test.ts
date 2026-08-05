import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultConfig, type AttachSpec } from "../ops/index.ts";
import type { AttachInstruction } from "../server/contracts.ts";
import { runCli, waitForStableService, type CliDependencies } from "./index.ts";

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

test("service health must remain stable after asynchronous startup work", async () => {
  let now = 0;
  let requests = 0;
  await waitForStableService(43_127, {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    timeoutMs: 2_000,
    stableMs: 300,
    pollMs: 100,
    request: async () => {
      requests += 1;
      if (requests === 2) throw new Error("startup worker crashed");
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(now, 500);
  assert.equal(requests, 6);
});

test("default health window tolerates one launchd throttle interval", async () => {
  let now = 0;
  await waitForStableService(43_127, {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    pollMs: 250,
    request: async () => {
      if (now < 11_000) throw new Error("launchd is throttling the replacement");
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(now, 12_500);
});

test("open gets a fresh owner-socket URL and does not launch a browser with --no-browser", async () => {
  const stdout = output();
  let opened = false;
  const exitCode = await runCli(["open", "--no-browser"], {
    stdout: stdout.writer,
    controlSocketPath: "/private/tmp/agent-manager-test/control.sock",
    async requestBootstrap(path) {
      assert.equal(path, "/private/tmp/agent-manager-test/control.sock");
      return {
        secret: "one-time-secret",
        expiresAt: Date.now() + 60_000,
        origin: "http://127.0.0.1:43222",
        bootstrapUrl: "http://127.0.0.1:43222/#bootstrap=one-time-secret",
      };
    },
    async openBrowser() {
      opened = true;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(opened, false);
  assert.equal(stdout.read(), "http://127.0.0.1:43222/#bootstrap=one-time-secret\n");
});

test("serve delegates the validated loopback address to the backend factory", async () => {
  const stdout = output();
  let received: { host: "127.0.0.1"; port: number } | null = null;
  const exitCode = await runCli(["serve", "--host", "127.0.0.1", "--port", "43222"], {
    stdout: stdout.writer,
    async startServer(options) {
      received = options;
      return { address: "http://127.0.0.1:43222" };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(received, { host: "127.0.0.1", port: 43_222 });
  assert.match(stdout.read(), /http:\/\/127\.0\.0\.1:43222/);
});

test("attach executes only the validated provider argv spec", async () => {
  const stdout = output();
  const stderr = output();
  let executed: AttachSpec | null = null;
  const instruction: AttachInstruction = {
    kind: "codex-remote",
    argv: [SERVICE_EXECUTABLES.codex, "resume", "thread-7", "--remote", "unix:///tmp/codex.sock"],
    cwd: process.cwd(),
    warning: "Native controller lease acquired.",
  };
  const exitCode = await runCli(["attach", "codex:thread-7"], {
    stdout: stdout.writer,
    stderr: stderr.writer,
    serviceExecutables: () => SERVICE_EXECUTABLES,
    async requestAttach(_path, id) {
      assert.equal(id, "codex:thread-7");
      return { instruction };
    },
    async executeAttach(spec) {
      executed = spec;
      return 7;
    },
  });

  assert.equal(exitCode, 7);
  assert.deepEqual(executed, {
    executable: "/trusted/bin/codex",
    args: ["resume", "thread-7", "--remote", "unix:///tmp/codex.sock"],
    cwd: process.cwd(),
  });
  assert.equal(stdout.read(), "");
  assert.equal(stderr.read(), "Native controller lease acquired.\n");
});

test("Codex attach falls back to an existing absolute current directory when its worktree was deleted", async (t) => {
  const stderr = output();
  const fallback = mkdtempSync(join(tmpdir(), "agent-manager-codex-attach-"));
  t.after(() => rmSync(fallback, { recursive: true, force: true }));
  const deletedWorktree = join(fallback, "deleted-worktree");
  let executed: AttachSpec | null = null;

  const exitCode = await runCli(["attach", "codex:thread-7"], {
    stderr: stderr.writer,
    currentDirectory: fallback,
    serviceExecutables: () => SERVICE_EXECUTABLES,
    async requestAttach() {
      return {
        instruction: {
          kind: "codex-remote",
          argv: [SERVICE_EXECUTABLES.codex, "resume", "thread-7", "--remote", "unix:///tmp/codex.sock"],
          cwd: deletedWorktree,
          warning: null,
        },
      };
    },
    async executeAttach(spec) {
      executed = spec;
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(executed, {
    executable: SERVICE_EXECUTABLES.codex,
    args: ["resume", "thread-7", "--remote", "unix:///tmp/codex.sock"],
    cwd: fallback,
  });
  assert.match(stderr.read(), /Codex session working directory .*deleted-worktree.* is unavailable/u);
  assert.match(stderr.read(), /pinned executable, thread ID, and shared App Server socket are unchanged/u);
});

test("Codex attach fails before spawn when neither instructed nor current directory is usable", async (t) => {
  const stderr = output();
  const temporary = mkdtempSync(join(tmpdir(), "agent-manager-codex-attach-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const deletedWorktree = join(temporary, "deleted-worktree");
  let executed = false;

  const exitCode = await runCli(["attach", "codex:thread-7"], {
    stderr: stderr.writer,
    currentDirectory: ".",
    serviceExecutables: () => SERVICE_EXECUTABLES,
    async requestAttach() {
      return {
        instruction: {
          kind: "codex-remote",
          argv: [SERVICE_EXECUTABLES.codex, "resume", "thread-7", "--remote", "unix:///tmp/codex.sock"],
          cwd: deletedWorktree,
          warning: null,
        },
      };
    },
    async executeAttach() {
      executed = true;
      return 0;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(executed, false);
  assert.match(stderr.read(), /current directory "\." is not an existing absolute directory/u);
});

test("deleted working-directory fallback is never applied to Claude or tmux", async (t) => {
  const fallback = mkdtempSync(join(tmpdir(), "agent-manager-native-attach-"));
  t.after(() => rmSync(fallback, { recursive: true, force: true }));
  const deletedWorktree = join(fallback, "deleted-worktree");

  await t.test("Claude keeps the exact provider working directory", async () => {
    const executed: AttachSpec[] = [];
    const exitCode = await runCli(["attach", "claude:session-7"], {
      currentDirectory: fallback,
      controlSocketPath: "/tmp/control.sock",
      serviceExecutables: () => SERVICE_EXECUTABLES,
      async requestAttach() {
        return {
          instruction: {
            kind: "claude-resume",
            argv: [SERVICE_EXECUTABLES.claude, "--resume", "session-7"],
            cwd: deletedWorktree,
            warning: null,
            handoffId: "handoff-7",
            spawnNonce: "spawn-nonce-00000007",
          },
        };
      },
      async requestAttachAuthorizeSpawn() {
        return { ok: true };
      },
      async executeLifecycleAttach(spec) {
        executed.push(spec);
        return 0;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(executed[0]?.cwd, deletedWorktree);
  });

  await t.test("tmux keeps the exact terminal working directory", async () => {
    const executed: AttachSpec[] = [];
    const exitCode = await runCli(["attach", "external:tmux"], {
      currentDirectory: fallback,
      serviceExecutables: () => SERVICE_EXECUTABLES,
      async requestAttach() {
        return {
          instruction: {
            kind: "tmux",
            argv: [SERVICE_EXECUTABLES.tmux, "attach-session", "-t", "agent-session"],
            cwd: deletedWorktree,
            warning: null,
          },
        };
      },
      async executeAttach(spec) {
        executed.push(spec);
        return 0;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(executed[0]?.cwd, deletedWorktree);
  });
});

test("Claude attach reports actual child lifecycle through the owner socket", async () => {
  const lifecycle: unknown[][] = [];
  let genericAttach = false;
  const exitCode = await runCli(["attach", "claude:session-7"], {
    serviceExecutables: () => SERVICE_EXECUTABLES,
    async requestAttach() {
      return {
        instruction: {
          kind: "claude-resume",
          argv: ["claude", "--resume", "session-7"],
          cwd: "/tmp/project",
          warning: null,
          handoffId: "handoff-7",
          spawnNonce: "spawn-nonce-00000007",
        },
      };
    },
    async executeAttach() {
      genericAttach = true;
      return 0;
    },
    async executeLifecycleAttach(_spec, hooks) {
      await hooks.started(777);
      await hooks.exited(4);
      return 4;
    },
    async requestAttachAuthorizeSpawn(...args) {
      lifecycle.push(["authorized", ...args]);
      return { ok: true };
    },
    async requestAttachStarted(...args) {
      lifecycle.push(["started", ...args]);
      return { ok: true };
    },
    async requestAttachExited(...args) {
      lifecycle.push(["exited", ...args]);
      return { ok: true };
    },
    async requestAttachFailed(...args) {
      lifecycle.push(["failed", ...args]);
      return { ok: true };
    },
    controlSocketPath: "/tmp/control.sock",
  });

  assert.equal(exitCode, 4);
  assert.equal(genericAttach, false);
  assert.deepEqual(lifecycle, [
    ["authorized", "/tmp/control.sock", "claude:session-7", "handoff-7", "spawn-nonce-00000007", process.pid],
    ["started", "/tmp/control.sock", "claude:session-7", "handoff-7", "spawn-nonce-00000007", 777],
    ["exited", "/tmp/control.sock", "claude:session-7", "handoff-7", 4],
  ]);
});

test("Claude attach fails closed when the backend omits lifecycle correlation", async () => {
  const stderr = output();
  let executed = false;
  const exitCode = await runCli(["attach", "claude:session-7"], {
    stderr: stderr.writer,
    serviceExecutables: () => SERVICE_EXECUTABLES,
    async requestAttach() {
      return {
        instruction: {
          kind: "claude-resume",
          argv: ["claude", "--resume", "session-7"],
          cwd: "/tmp/project",
          warning: null,
        },
      };
    },
    async executeLifecycleAttach() {
      executed = true;
      return 0;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(executed, false);
  assert.match(stderr.read(), /missing its ownership handoff id/);
});

test("attach refuses an arbitrary control-socket command without spawning it", async () => {
  const stderr = output();
  let executed = false;
  const exitCode = await runCli(["attach", "external:1"], {
    stderr: stderr.writer,
    serviceExecutables: () => SERVICE_EXECUTABLES,
    async requestAttach() {
      return {
        instruction: {
          kind: "tmux",
          argv: ["/bin/sh", "-c", "touch /tmp/should-not-exist"],
          cwd: null,
          warning: null,
        },
      };
    },
    async executeAttach() {
      executed = true;
      return 0;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(executed, false);
  assert.match(stderr.read(), /tmux executable/);
});

test("attach rejects browser-only manager proxies before resolving or spawning executables", async () => {
  const stderr = output();
  let executed = false;
  const exitCode = await runCli(["attach", "codex:thread-1"], {
    stderr: stderr.writer,
    serviceExecutables() {
      throw new Error("executable resolution must not run");
    },
    async requestAttach() {
      return {
        instruction: {
          kind: "manager-cli",
          argv: ["agent-manager", "attach", "codex:thread-1"],
          cwd: "/tmp/project",
          warning: null,
        },
      };
    },
    async executeAttach() {
      executed = true;
      return 0;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(executed, false);
  assert.match(stderr.read(), /browser-only/);
});

test("workspace, Tailscale, service, and doctor commands use injected operations", async () => {
  const stdout = output();
  const config = defaultConfig();
  let saves = 0;
  const persistedWorkspaces: string[] = [];
  const common: Partial<CliDependencies> = {
    stdout: stdout.writer,
    loadConfig: () => config,
    mutateConfig: (mutator) => {
      saves += 1;
      return mutator(config);
    },
    prepareServiceState: () => {},
    serviceExecutables: () => SERVICE_EXECUTABLES,
    persistWorkspace: (workspace) => { persistedWorkspaces.push(workspace.id); },
    removePersistedWorkspace: () => true,
  };

  assert.equal(await runCli(["workspace", "add", "/tmp/project"], {
    ...common,
    addWorkspace(target) {
      const workspace = { id: "ws_1", name: "project", path: "/tmp/project", hostId: "local" };
      target.workspaces.push(workspace);
      return workspace;
    },
  }), 0);
  assert.equal(saves, 1);
  assert.deepEqual(persistedWorkspaces, ["ws_1"]);

  assert.equal(await runCli(["tailscale", "install"], {
    ...common,
    installTailscale: () => ({
      identity: {
        login: "owner@example.com",
        displayName: "Owner",
        hostName: "workstation",
        dnsName: "workstation.example.ts.net",
      },
      currentProxy: "http://127.0.0.1:43127",
      portInUse: true,
      changed: true,
      url: "https://workstation.example.ts.net:9443/",
    }),
  }), 0);
  assert.equal(config.tailscale.allowedLogin, "owner@example.com");
  assert.equal(saves, 2);

  assert.equal(await runCli(["tailscale", "off"], {
    ...common,
    removeTailscale: () => ({ changed: true }),
  }), 0);
  assert.equal(config.tailscale.allowedLogin, null);
  assert.equal(config.tailscale.dnsName, null);
  assert.equal(saves, 3);

  assert.equal(await runCli(["service", "print"], {
    ...common,
    renderService: () => "<plist/>\n",
  }), 0);

  let reloaded = "";
  let healthPort = 0;
  assert.equal(await runCli(["service", "install"], {
    ...common,
    installService: () => "/tmp/agent-manager.plist",
    reloadService: (destination) => { reloaded = destination; },
    waitForService: async (port) => { healthPort = port; },
  }), 0);
  assert.equal(reloaded, "/tmp/agent-manager.plist");
  assert.equal(healthPort, config.backend.port);

  assert.equal(await runCli(["doctor", "--json"], {
    ...common,
    doctor: async () => ({ ok: true, generatedAt: "now", checks: [] }),
  }), 0);

  assert.match(stdout.read(), /workstation\.example\.ts\.net:9443/);
  assert.match(stdout.read(), /<plist\/>/);
});

test("SSH host commands persist configuration, install the node, and remove live discovery data", async () => {
  const stdout = output();
  const config = defaultConfig();
  const persisted: string[] = [];
  const removed: string[] = [];
  const installed: string[] = [];
  const common: Partial<CliDependencies> = {
    stdout: stdout.writer,
    loadConfig: () => config,
    mutateConfig: (mutator) => mutator(config),
    addSshHost(target, input) {
      const host = { id: "host_build", name: input.name, target: input.target };
      target.hosts.push(host);
      return host;
    },
    removeSshHost(target, id) {
      const index = target.hosts.findIndex((host) => host.id === id);
      if (index < 0) return false;
      target.hosts.splice(index, 1);
      return true;
    },
    persistHost: (host) => { persisted.push(host.id); },
    removePersistedHost: (id) => {
      removed.push(id);
      return true;
    },
    installRemoteNode: async (target) => {
      installed.push(target);
      return { serviceLabel: "local.agent-manager.cockpit" };
    },
  };

  assert.equal(await runCli(["host", "add", "Build Mac", "dev@build-mac"], common), 0);
  assert.deepEqual(persisted, ["host_build"]);
  assert.equal(await runCli(["host", "list"], common), 0);
  assert.equal(await runCli(["host", "install", "dev@build-mac"], common), 0);
  assert.deepEqual(installed, ["dev@build-mac"]);
  assert.equal(await runCli(["host", "remove", "host_build"], common), 0);
  assert.deepEqual(removed, ["host_build"]);
  assert.match(stdout.read(), /running cockpit will discover this host automatically/);
  assert.match(stdout.read(), /Installed and started local\.agent-manager\.cockpit/);
});

test("Claude hook CLI uses the configured loopback endpoint, explicit consent, and live reload", async () => {
  const stdout = output();
  const stderr = output();
  const config = defaultConfig();
  config.backend.port = 45_678;
  let reloaded = "";
  let confirmed = false;
  let received: unknown = null;
  const exitCode = await runCli([
    "hooks", "install", "--provider", "claude", "--scope", "project", "--yes",
  ], {
    stdout: stdout.writer,
    stderr: stderr.writer,
    loadConfig: () => config,
    homeDirectory: "/Users/test",
    currentDirectory: "/Users/test/project",
    controlSocketPath: "/private/tmp/agent-manager-test/control.sock",
    async operateClaudeHook(input, dependencies) {
      received = input;
      confirmed = await dependencies.confirm?.({} as never) ?? false;
      return {
        operation: "install",
        outcome: "unchanged",
        status: {
          state: "installed-unseen",
          settingsPath: "/Users/test/project/.claude/settings.local.json",
          configuration: null,
          lastSeenAt: null,
        },
        plan: null,
      };
    },
    async reloadHookAuthorizations(path) {
      reloaded = path;
      return { ok: true };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(confirmed, true);
  assert.deepEqual(received, {
    operation: "install",
    scope: "project",
    homeDirectory: "/Users/test",
    projectDirectory: "/Users/test/project",
    endpoint: "http://127.0.0.1:45678/api/v1/hooks/claude",
  });
  assert.equal(reloaded, "/private/tmp/agent-manager-test/control.sock");
  assert.match(stdout.read(), /installed-unseen/);
  assert.match(stderr.read(), /machine-local/);
});

test("Codex hook CLI installs the observation shim with explicit consent and live reload", async () => {
  const stdout = output();
  const config = defaultConfig();
  config.backend.port = 45_679;
  let reloaded = "";
  let received: unknown = null;
  let nodeExecutable = "";
  let trustProbe: [string, string] | null = null;
  const exitCode = await runCli([
    "hooks", "install", "--provider", "codex", "--yes",
  ], {
    stdout: stdout.writer,
    loadConfig: () => config,
    homeDirectory: "/Users/test",
    controlSocketPath: "/private/tmp/agent-manager-test/control.sock",
    async codexHookStatus(settingsPath, expectedCommand) {
      trustProbe = [settingsPath, expectedCommand];
      return {
        state: "awaiting-trust",
        reason: "trust the hook",
        installedEvents: [],
      };
    },
    async operateCodexHook(input, dependencies) {
      received = input;
      nodeExecutable = dependencies.nodeExecutable ?? "";
      assert.equal(
        (await dependencies.trustStatus?.("/Users/test/.codex/hooks.json", "'shim'"))?.state,
        "awaiting-trust",
      );
      assert.equal(await dependencies.confirm?.({} as never), true);
      return {
        operation: "install",
        outcome: "applied",
        status: {
          state: "awaiting-trust",
          settingsPath: "/Users/test/.codex/hooks.json",
          shimPath: "/Users/test/Library/Application Support/agent-manager/hooks/codex-user-hook.mjs",
          configuration: null,
          trust: null,
          lastSeenAt: null,
        },
        plan: null,
      };
    },
    async reloadHookAuthorizations(path) {
      reloaded = path;
      return { ok: true };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(nodeExecutable, process.execPath);
  assert.deepEqual(trustProbe, ["/Users/test/.codex/hooks.json", "'shim'"]);
  assert.deepEqual(received, {
    operation: "install",
    scope: "user",
    homeDirectory: "/Users/test",
    endpoint: "http://127.0.0.1:45679/api/v1/hooks/codex",
  });
  assert.equal(reloaded, "/private/tmp/agent-manager-test/control.sock");
  assert.match(stdout.read(), /awaiting-trust/);
  assert.match(stdout.read(), /Open \/hooks in Codex/);
});

test("hook status without a provider reports both harnesses", async () => {
  const stdout = output();
  const providers: string[] = [];
  const exitCode = await runCli(["hooks", "status"], {
    stdout: stdout.writer,
    async operateClaudeHook() {
      providers.push("claude");
      return {
        operation: "status",
        outcome: "inspected",
        status: {
          state: "absent",
          settingsPath: "/Users/test/.claude/settings.json",
          configuration: null,
          lastSeenAt: null,
        },
        plan: null,
      };
    },
    async operateCodexHook() {
      providers.push("codex");
      return {
        operation: "status",
        outcome: "inspected",
        status: {
          state: "absent",
          settingsPath: "/Users/test/.codex/hooks.json",
          shimPath: "/Users/test/Library/Application Support/agent-manager/hooks/codex-user-hook.mjs",
          configuration: null,
          trust: null,
          lastSeenAt: null,
        },
        plan: null,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(providers, ["claude", "codex"]);
  assert.match(stdout.read(), /Claude hooks \(user\): absent/);
  assert.match(stdout.read(), /Codex hooks \(user\): absent/);
});
