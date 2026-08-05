import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import { setupReadModelSchema } from "../shared/setup.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function discoveredSession(path: string): SessionView {
  return {
    id: "local:codex:observed-thread",
    provider: "codex",
    providerThreadId: "observed-thread",
    providerTreeId: "observed-thread",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Observed session",
    cwd: path,
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: 42,
    runtimePid: 42,
    startedAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:01.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "provider-cli",
    source: "fixture",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    effort: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
    workspaceIdentity: {
      repoRoot: path,
      repoName: "observed-repo",
      worktreePath: path,
      linked: false,
      branch: "main",
      detached: false,
      dirtyCount: null,
      ahead: null,
      behind: null, insertions: null, deletions: null,
    },
    generation: 1,
  };
}

async function authHeaders(backend: Awaited<ReturnType<typeof createAgentManagerServer>>) {
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie, csrf: (response.json() as { csrfToken: string }).csrfToken };
}

test("setup is read-only, persists visible repositories, and probes missing remote harnesses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-setup-"));
  const repo = join(root, "observed-repo");
  let codexProbe: [string, string] | null = null;
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 43_127,
    homeDirectory: root,
    discovery: false,
    staticDir: false,
    initialSessions: [discoveredSession(repo)],
    codexHookTrustStatus: async (settingsPath, expectedCommand) => {
      codexProbe = [settingsPath, expectedCommand];
      return {
        state: "absent",
        reason: "No matching command hook",
        installedEvents: [],
      };
    },
    setupHarnessProbe: async () => ({
      codex: { state: "missing", reason: "codex is not installed on this host." },
      claude: { state: "present", reason: null },
    }),
    setupRemoteHarnessProbe: async (hostId) => {
      assert.equal(hostId, "studio");
      return {
        codex: { state: "missing", reason: "codex is not installed on this host." },
        claude: { state: "present", reason: null },
      };
    },
    remotePollIntervalMs: 60_000,
    sshExecutable: "/usr/bin/false",
  });
  t.after(async () => {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  });
  backend.database.addHost({ id: "studio", label: "Studio", kind: "ssh", sshTarget: "studio.invalid" });
  const auth = await authHeaders(backend);

  const first = await backend.app.inject({
    method: "GET",
    url: "/api/v1/setup",
    headers: { host, cookie: auth.cookie },
  });
  assert.equal(first.statusCode, 200, first.body);
  const setup = setupReadModelSchema.parse(first.json());
  assert.deepEqual(setup.nearby.map(({ path, source }) => ({ path, source })), [{ path: repo, source: "discovered" }]);
  assert.equal(backend.database.listWorkspaces()[0]?.path, repo);
  assert.equal(setup.hooks.claude.state, "absent");
  assert.deepEqual(codexProbe, [
    join(root, ".codex", "hooks.json"),
    `'${join(root, "Library", "Application Support", "agent-manager", "hooks", "codex-user-hook.mjs")}'`,
  ]);
  assert.equal(setup.hooks.claude.changed, true);
  assert.equal(Object.hasOwn(setup.hooks.claude, "previewId"), false);
  assert.equal(Object.hasOwn(setup.hooks.claude, "expiresAt"), false);
  assert.match(setup.hooks.claude.diff, /"Authorization": "\[REDACTED\]"/u);
  assert.doesNotMatch(setup.hooks.claude.diff, /Bearer\s+\S+/u);
  assert.equal(existsSync(join(root, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(root, ".codex", "hooks.json")), false);
  assert.equal(backend.database.listClaudeHookInstallRecords().length, 0);
  assert.equal(backend.database.listCodexHookInstallRecords().length, 0);
  const studio = setup.hosts.find(({ id }) => id === "studio");
  assert.equal(studio?.harnesses.codex.state, "missing");
  assert.equal(studio?.harnesses.claude.state, "present");

  const removedApplyRoute = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: {
      host,
      origin,
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    },
    payload: {
      provider: "claude",
      previewId: "00000000-0000-4000-8000-000000000000",
      confirmed: true,
    },
  });
  assert.equal(removedApplyRoute.statusCode, 404, removedApplyRoute.body);
  assert.equal(backend.database.listClaudeHookInstallRecords().length, 0);
  assert.equal(backend.database.listCodexHookInstallRecords().length, 0);
  assert.equal(existsSync(join(root, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(root, ".codex", "hooks.json")), false);

  const current = await backend.app.inject({
    method: "GET",
    url: "/api/v1/setup",
    headers: { host, cookie: auth.cookie },
  });
  const stillReadOnly = setupReadModelSchema.parse(current.json());
  assert.equal(stillReadOnly.hooks.claude.state, "absent");
  assert.equal(stillReadOnly.hooks.claude.changed, true);
});
