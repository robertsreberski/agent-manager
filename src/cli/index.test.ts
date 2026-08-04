import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, type AttachSpec } from "../ops/index.ts";
import type { AttachInstruction } from "../server/contracts.ts";
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

test("list preserves the original options and emits only the public JSON envelope", async () => {
  const stdout = output();
  const stderr = output();
  let receivedSince = -1;
  const exitCode = await runCli(["list", "--json", "--since", "2h", "--children"], {
    stdout: stdout.writer,
    stderr: stderr.writer,
    buildListing(options) {
      receivedSince = options.recentWindowSeconds;
      assert.equal(options.includeChildren, true);
      return {
        version: 2,
        generatedAt: "2026-08-03T12:00:00.000Z",
        recentWindowSeconds: options.recentWindowSeconds,
        sessions: [],
        diagnostics: [],
        selectedProviderCount: 2,
        successfulProviderCount: 2,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(receivedSince, 7_200);
  assert.deepEqual(JSON.parse(stdout.read()), {
    version: 2,
    generatedAt: "2026-08-03T12:00:00.000Z",
    recentWindowSeconds: 7_200,
    sessions: [],
    diagnostics: [],
  });
  assert.equal(stderr.read(), "");
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
    argv: ["/opt/homebrew/bin/codex", "resume", "thread-7", "--remote", "unix:///tmp/codex.sock"],
    cwd: "/tmp/project",
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
    cwd: "/tmp/project",
  });
  assert.equal(stdout.read(), "");
  assert.equal(stderr.read(), "Native controller lease acquired.\n");
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

test("workspace, Tailscale, service, doctor, and panic commands use injected operations", async () => {
  const stdout = output();
  const config = defaultConfig();
  let saves = 0;
  const persistedWorkspaces: string[] = [];
  let panic = false;
  let panicPersisted = false;
  const common: Partial<CliDependencies> = {
    stdout: stdout.writer,
    loadConfig: () => config,
    mutateConfig: (mutator) => {
      saves += 1;
      return mutator(config);
    },
    serviceExecutables: () => SERVICE_EXECUTABLES,
    engagePanicLock: () => {
      panicPersisted = true;
      return true;
    },
    releasePanicLock: () => {
      panicPersisted = false;
      return true;
    },
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

  assert.equal(await runCli(["doctor", "--json"], {
    ...common,
    doctor: async () => ({ ok: true, generatedAt: "now", checks: [] }),
  }), 0);

  assert.equal(await runCli(["panic-lock"], {
    ...common,
    requestPanicLock: async () => {
      panic = true;
      return { ok: true };
    },
  }), 0);
  assert.equal(panic, true);
  assert.equal(panicPersisted, true);
  assert.equal(await runCli(["panic-unlock"], common), 0);
  assert.equal(panicPersisted, false);
  assert.match(stdout.read(), /workstation\.example\.ts\.net:9443/);
  assert.match(stdout.read(), /<plist\/>/);
  assert.match(stdout.read(), /control plane locked/);
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

test("panic-lock reports the durable lock when live cleanup is incomplete", async () => {
  const stderr = output();
  let persisted = false;
  const exitCode = await runCli(["panic-lock"], {
    stderr: stderr.writer,
    engagePanicLock: () => {
      persisted = true;
      return true;
    },
    requestPanicLock: async () => {
      throw new Error("owner socket unavailable");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(persisted, true);
  assert.match(stderr.read(), /Persistent panic lock is engaged/);
  assert.match(stderr.read(), /cleanup was incomplete/);
  assert.match(stderr.read(), /owner socket unavailable/);
});
