import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAttachSpec } from "./attach.ts";
import {
  inspectTailscaleRoute,
  installTailscaleRoute,
  removeTailscaleRoute,
  type CommandOutput,
  type CommandRunner,
} from "./tailscale.ts";
import { installLaunchAgentFile, renderLaunchAgent } from "./launch-agent.ts";
import { addWorkspace, defaultConfig, removeWorkspace } from "./config.ts";

function decodeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function launchAgentProgramArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist);
  const contents = array?.[1];
  assert.ok(contents, "rendered plist must contain ProgramArguments");
  return [...contents.matchAll(/<string>([\s\S]*?)<\/string>/gu)]
    .map((match) => decodeXml(match[1] ?? ""));
}

function fixtureRunner(
  initialProxy: string | null = null,
  identity: { login: string; dnsName: string } = {
    login: "owner@example.com",
    dnsName: "workstation.example.ts.net",
  },
  additionalPathProxy: string | null = null,
): CommandRunner & { calls: string[][] } {
  let proxy = initialProxy;
  const calls: string[][] = [];
  return {
    calls,
    run(executable, args): CommandOutput {
      calls.push([executable, ...args]);
      if (args[0] === "status") {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { UserID: 7, HostName: "workstation", DNSName: `${identity.dnsName}.` },
            User: { "7": { LoginName: identity.login, DisplayName: "Owner" } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "status") {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: proxy || additionalPathProxy ? { "9443": { HTTPS: true } } : {},
            Web: proxy || additionalPathProxy
              ? {
                  [`${identity.dnsName}:9443`]: {
                    Handlers: {
                      ...(proxy ? { "/": { Proxy: proxy } } : {}),
                      ...(additionalPathProxy
                        ? { "/other": { Proxy: additionalPathProxy } }
                        : {}),
                    },
                  },
                }
              : {},
          }),
        };
      }
      if (args[0] === "serve" && args.includes("--bg")) {
        proxy = "http://127.0.0.1:43127";
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args.at(-1) === "off") {
        proxy = null;
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    },
  };
}

test("inspects, installs, and removes only the exact Agent Manager Tailscale route", () => {
  const runner = fixtureRunner();
  const before = inspectTailscaleRoute(runner);
  assert.equal(before.identity.login, "owner@example.com");
  assert.equal(before.portInUse, false);

  const installed = installTailscaleRoute(runner);
  assert.equal(installed.changed, true);
  assert.equal(installed.currentProxy, "http://127.0.0.1:43127");
  assert.equal(installed.url, "https://workstation.example.ts.net:9443/");

  assert.deepEqual(removeTailscaleRoute(runner, {
    expectedIdentity: {
      login: "owner@example.com",
      dnsName: "workstation.example.ts.net",
    },
  }), { changed: true });
  assert.equal(
    runner.calls.some((call) => call.join(" ").includes("serve --https=9443 --set-path=/ off")),
    true,
  );
  assert.equal(runner.calls.some((call) => call.includes("reset")), false);
});

test("refuses Tailscale removal when persisted device identity is absent or has drifted", () => {
  const runner = fixtureRunner(
    "http://127.0.0.1:43127",
    { login: "different@example.com", dnsName: "other-device.example.ts.net" },
  );
  assert.throws(() => removeTailscaleRoute(runner), /without its persisted login/);
  assert.throws(
    () => removeTailscaleRoute(runner, {
      expectedIdentity: {
        login: "owner@example.com",
        dnsName: "workstation.example.ts.net",
      },
    }),
    /identity drift/,
  );
  assert.equal(runner.calls.some((call) => call.at(-1) === "off"), false);
});

test("Tailscale removal verifies only the owned root handler and preserves other paths", () => {
  const runner = fixtureRunner(
    "http://127.0.0.1:43127",
    { login: "owner@example.com", dnsName: "workstation.example.ts.net" },
    "http://127.0.0.1:9999",
  );

  assert.deepEqual(removeTailscaleRoute(runner, {
    expectedIdentity: {
      login: "owner@example.com",
      dnsName: "workstation.example.ts.net",
    },
  }), { changed: true });

  const after = inspectTailscaleRoute(runner);
  assert.equal(after.currentProxy, null);
  assert.equal(after.portInUse, true);
});

test("refuses Tailscale collisions and Funnel-capable ports", () => {
  const runner = fixtureRunner("http://127.0.0.1:9999");
  assert.throws(() => installTailscaleRoute(runner), /Refusing to overwrite/);
  assert.throws(() => inspectTailscaleRoute(runner, { httpsPort: 8443 }), /Funnel/);
});

test("builds attach commands without a shell", () => {
  assert.deepEqual(
    buildAttachSpec({
      kind: "codex",
      threadId: "thread-1",
      socketPath: "/private/tmp/agent-manager/codex.sock",
      cwd: "/tmp/project",
      codexExecutable: "/opt/bin/codex",
    }),
    {
      executable: "/opt/bin/codex",
      args: [
        "resume",
        "thread-1",
        "--remote",
        "unix:///private/tmp/agent-manager/codex.sock",
      ],
      cwd: "/tmp/project",
    },
  );
  assert.throws(
    () => buildAttachSpec({
      kind: "claude",
      sessionId: "session-1",
      cwd: "/tmp/project",
      claudeExecutable: "/opt/bin/claude",
      handoffReady: false,
    }),
    /safely handed off/,
  );
});

test("renders a loopback-only LaunchAgent with exact executables", () => {
  const plist = renderLaunchAgent({
    executables: {
      node: "/opt/node & friends/node",
      codex: "/opt/codex/bin/codex",
      claude: "/opt/claude/bin/claude",
      tmux: "/opt/tmux/bin/tmux",
      tailscale: "/opt/tailscale/bin/tailscale",
    },
    cliEntrypoint: "/tmp/agent-manager/dist/cli/index.js",
    homeDirectory: "/Users/test",
    userName: "test",
    shell: "/bin/zsh",
    temporaryDirectory: "/private/tmp/test/",
    sshAuthSocket: "/private/tmp/test-ssh-agent.sock",
  });
  assert.deepEqual(launchAgentProgramArguments(plist), [
    "/usr/bin/env",
    "-i",
    "HOME=/Users/test",
    "USER=test",
    "LOGNAME=test",
    "TMPDIR=/private/tmp/test/",
    "SHELL=/bin/zsh",
    "SSH_AUTH_SOCK=/private/tmp/test-ssh-agent.sock",
    "PATH=/opt/node & friends:/opt/codex/bin:/opt/claude/bin:/opt/tmux/bin:/opt/tailscale/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "AGENT_MANAGER_CODEX_EXECUTABLE=/opt/codex/bin/codex",
    "AGENT_MANAGER_CLAUDE_EXECUTABLE=/opt/claude/bin/claude",
    "AGENT_MANAGER_TMUX_EXECUTABLE=/opt/tmux/bin/tmux",
    "AGENT_MANAGER_TAILSCALE_EXECUTABLE=/opt/tailscale/bin/tailscale",
    "/opt/node & friends/node",
    "/tmp/agent-manager/dist/cli/index.js",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "43127",
  ]);
  assert.doesNotMatch(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /<key>PathState<\/key>/);
  assert.match(plist, /<string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<string>43127<\/string>/);
});

test("starts Node with a clean allowlisted environment", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "agent-manager-clean-env-"));
  try {
    const probe = join(homeDirectory, "print-environment.mjs");
    writeFileSync(probe, "process.stdout.write(JSON.stringify(process.env));\n", "utf8");
    const plist = renderLaunchAgent({
      executables: {
        node: process.execPath,
        codex: "/opt/codex/bin/codex",
        claude: "/opt/claude/bin/claude",
        tmux: "/opt/tmux/bin/tmux",
        tailscale: "/opt/tailscale/bin/tailscale",
      },
      cliEntrypoint: probe,
      homeDirectory,
      userName: "test-user",
      shell: "/bin/zsh",
      temporaryDirectory: "/private/tmp/test-user/",
      sshAuthSocket: null,
    });
    const [executable, ...args] = launchAgentProgramArguments(plist);
    assert.ok(executable);
    const child = spawnSync(executable, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        TODOIST_API_TOKEN: "must-not-cross-launch-agent-boundary",
        OPENAI_API_KEY: "must-not-cross-launch-agent-boundary",
        ANTHROPIC_API_KEY: "must-not-cross-launch-agent-boundary",
        SSH_AUTH_SOCK: "/private/tmp/transient-per-login-agent.sock",
        UNRELATED_SECRET: "must-not-cross-launch-agent-boundary",
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const environment = JSON.parse(child.stdout) as Record<string, string>;
    assert.equal(environment.HOME, homeDirectory);
    assert.equal(environment.USER, "test-user");
    assert.equal(environment.LOGNAME, "test-user");
    assert.equal(environment.TMPDIR, "/private/tmp/test-user/");
    assert.equal(environment.SHELL, "/bin/zsh");
    assert.equal(environment.AGENT_MANAGER_CODEX_EXECUTABLE, "/opt/codex/bin/codex");
    assert.equal(environment.AGENT_MANAGER_CLAUDE_EXECUTABLE, "/opt/claude/bin/claude");
    assert.equal(environment.AGENT_MANAGER_TMUX_EXECUTABLE, "/opt/tmux/bin/tmux");
    assert.equal(environment.AGENT_MANAGER_TAILSCALE_EXECUTABLE, "/opt/tailscale/bin/tailscale");
    assert.equal(environment.TODOIST_API_TOKEN, undefined);
    assert.equal(environment.OPENAI_API_KEY, undefined);
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(environment.SSH_AUTH_SOCK, undefined);
    assert.equal(environment.UNRELATED_SECRET, undefined);
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("installs the LaunchAgent atomically as an owner-only file", () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "agent-manager-launch-agent-"));
  try {
    const destination = installLaunchAgentFile({
      executables: {
        node: "/opt/node/bin/node",
        codex: "/opt/codex/bin/codex",
        claude: "/opt/claude/bin/claude",
        tmux: "/opt/tmux/bin/tmux",
        tailscale: "/opt/tailscale/bin/tailscale",
      },
      cliEntrypoint: "/tmp/agent-manager/dist/cli/index.js",
      homeDirectory,
    });

    assert.equal(statSync(destination).mode & 0o777, 0o600);
    const installed = readFileSync(destination, "utf8");
    assert.match(installed, /local\.agent-manager\.cockpit/);
    assert.deepEqual(launchAgentProgramArguments(installed).slice(0, 2), [
      "/usr/bin/env",
      "-i",
    ]);
    assert.doesNotMatch(installed, /<key>EnvironmentVariables<\/key>/);
    assert.deepEqual(
      readdirSync(join(homeDirectory, "Library", "LaunchAgents")),
      ["local.agent-manager.cockpit.plist"],
    );
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("workspaces are server-known stable ids, not browser paths", () => {
  const config = defaultConfig();
  const workspace = addWorkspace(config, process.cwd());
  assert.match(workspace.id, /^ws_[a-f0-9]{16}$/);
  assert.equal(addWorkspace(config, process.cwd()).id, workspace.id);
  assert.equal(config.workspaces.length, 1);
  assert.equal(removeWorkspace(config, workspace.id), true);
  assert.equal(removeWorkspace(config, workspace.id), false);
});
