import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import { digestHookBearerToken } from "../providers/hooks/auth.ts";
import { observeOnlyControl } from "../shared/session.ts";
import {
  setupHookApplyResponseSchema,
  setupReadModelSchema,
} from "../shared/setup.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";
const legacyClaudeToken = "legacy-claude-hook-token-with-more-than-thirty-two-characters";

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
    control: observeOnlyControl(),
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

function mutationHeaders(auth: Awaited<ReturnType<typeof authHeaders>>) {
  return {
    host,
    origin,
    cookie: auth.cookie,
    "x-csrf-token": auth.csrf,
    "content-type": "application/json",
  };
}

function installedClaudeToken(root: string): string {
  const settings = readFileSync(join(root, ".claude", "settings.json"), "utf8");
  const match = /Bearer ([^"\\\s]+)/u.exec(settings);
  assert.ok(match?.[1], "installed Claude settings contain a bearer token");
  return match[1];
}

test("setup previews and applies exact local hooks without exposing secrets", async (t) => {
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
    claudeHookAuthorizationRecords: [{
      id: "legacy-claude-hook",
      provider: "claude",
      tokenDigest: digestHookBearerToken(legacyClaudeToken),
      createdAt: "2026-08-04T00:00:00.000Z",
      settingsPath: join(root, ".claude", "legacy-settings.json"),
    }],
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
  assert.match(setup.hooks.claude.previewId ?? "", /^[0-9a-f-]{36}$/u);
  assert.ok(Number.isFinite(Date.parse(setup.hooks.claude.expiresAt ?? "")));
  assert.match(setup.hooks.claude.diff, /\[REDACTED\]/u);
  assert.doesNotMatch(first.body, /Bearer (?!\[REDACTED\])[A-Za-z0-9_-]{16,}/u);
  assert.match(setup.hooks.claude.command, /hooks install --provider claude/u);
  assert.match(setup.hooks.codex.command, /hooks install --provider codex/u);
  assert.equal(existsSync(join(root, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(root, ".codex", "hooks.json")), false);
  assert.equal(backend.database.listClaudeHookInstallRecords().length, 0);
  assert.equal(backend.database.listCodexHookInstallRecords().length, 0);
  const studio = setup.hosts.find(({ id }) => id === "studio");
  assert.equal(studio?.harnesses.codex.state, "missing");
  assert.equal(studio?.harnesses.claude.state, "present");

  const repeated = setupReadModelSchema.parse((await backend.app.inject({
    method: "GET",
    url: "/api/v1/setup",
    headers: { host, cookie: auth.cookie },
  })).json());
  assert.equal(repeated.hooks.claude.previewId, setup.hooks.claude.previewId);
  assert.equal(repeated.hooks.codex.previewId, setup.hooks.codex.previewId);

  const unauthenticated = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: { host, origin, "content-type": "application/json" },
    payload: {
      provider: "claude",
      previewId: setup.hooks.claude.previewId,
      confirmed: true,
    },
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

  const missingCsrf = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: {
      host,
      origin,
      cookie: auth.cookie,
      "content-type": "application/json",
    },
    payload: {
      provider: "claude",
      previewId: setup.hooks.claude.previewId,
      confirmed: true,
    },
  });
  assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);

  const unconfirmed = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: mutationHeaders(auth),
    payload: {
      provider: "claude",
      previewId: setup.hooks.claude.previewId,
      confirmed: false,
    },
  });
  assert.equal(unconfirmed.statusCode, 400, unconfirmed.body);

  const mismatched = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: mutationHeaders(auth),
    payload: {
      provider: "codex",
      previewId: setup.hooks.claude.previewId,
      confirmed: true,
    },
  });
  assert.equal(mismatched.statusCode, 409, mismatched.body);

  assert.equal(backend.database.listClaudeHookInstallRecords().length, 0);
  assert.equal(backend.database.listCodexHookInstallRecords().length, 0);
  assert.equal(existsSync(join(root, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(root, ".codex", "hooks.json")), false);

  const claudePayload = {
    provider: "claude" as const,
    previewId: setup.hooks.claude.previewId!,
    confirmed: true as const,
  };
  const [firstApply, concurrentReplay] = await Promise.all([
    backend.app.inject({
      method: "POST",
      url: "/api/v1/setup/hooks/apply",
      headers: mutationHeaders(auth),
      payload: claudePayload,
    }),
    backend.app.inject({
      method: "POST",
      url: "/api/v1/setup/hooks/apply",
      headers: mutationHeaders(auth),
      payload: claudePayload,
    }),
  ]);
  assert.equal(firstApply.statusCode, 200, firstApply.body);
  assert.equal(concurrentReplay.statusCode, 200, concurrentReplay.body);
  const outcomes = [firstApply, concurrentReplay].map((response) =>
    setupHookApplyResponseSchema.parse(response.json()).outcome
  );
  assert.deepEqual(new Set(outcomes), new Set(["applied", "already-applied"]));
  assert.equal(backend.database.listClaudeHookInstallRecords().length, 1);
  assert.equal(existsSync(join(root, ".claude", "settings.json")), true);

  const codexApply = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: mutationHeaders(auth),
    payload: {
      provider: "codex",
      previewId: setup.hooks.codex.previewId,
      confirmed: true,
    },
  });
  assert.equal(codexApply.statusCode, 200, codexApply.body);
  assert.equal(setupHookApplyResponseSchema.parse(codexApply.json()).outcome, "applied");
  assert.equal(backend.database.listCodexHookInstallRecords().length, 1);
  assert.equal(existsSync(join(root, ".codex", "hooks.json")), true);
  assert.equal(existsSync(join(
    root,
    "Library",
    "Application Support",
    "agent-manager",
    "hooks",
    "codex-user-hook.mjs",
  )), true);

  const loadedTokenReply = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host,
      authorization: `Bearer ${installedClaudeToken(root)}`,
      "content-type": "application/json",
    },
    payload: {
      session_id: "setup-reload-proof",
      transcript_path: join(root, "setup-reload-proof.jsonl"),
      cwd: root,
      prompt_id: "prompt-1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    },
  });
  assert.equal(loadedTokenReply.statusCode, 200, loadedTokenReply.body);

  const preservedInjectedTokenReply = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hooks/claude",
    headers: {
      host,
      authorization: `Bearer ${legacyClaudeToken}`,
      "content-type": "application/json",
    },
    payload: {
      session_id: "setup-legacy-reload-proof",
      transcript_path: join(root, "setup-legacy-reload-proof.jsonl"),
      cwd: root,
      prompt_id: "prompt-2",
      hook_event_name: "Stop",
      stop_hook_active: false,
    },
  });
  assert.equal(preservedInjectedTokenReply.statusCode, 200, preservedInjectedTokenReply.body);

  const current = await backend.app.inject({
    method: "GET",
    url: "/api/v1/setup",
    headers: { host, cookie: auth.cookie },
  });
  const installed = setupReadModelSchema.parse(current.json());
  assert.equal(installed.hooks.claude.state, "active");
  assert.equal(installed.hooks.claude.changed, false);
  assert.equal(installed.hooks.claude.previewId, null);
  assert.equal(installed.hooks.claude.expiresAt, null);
  assert.equal(installed.hooks.codex.changed, false);
  assert.equal(installed.hooks.codex.previewId, null);
  assert.equal(installed.hooks.codex.expiresAt, null);
  assert.equal(installed.hooks.codex.state, "untrusted");
});

test("setup rejects expired and stale exact hook previews", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-setup-stale-"));
  let now = Date.parse("2026-08-05T12:00:00.000Z");
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 43_127,
    homeDirectory: root,
    discovery: false,
    staticDir: false,
    setupHookNow: () => new Date(now),
    setupHookPreviewTtlMs: 1_000,
    setupHarnessProbe: async () => ({
      codex: { state: "present", reason: null },
      claude: { state: "present", reason: null },
    }),
  });
  t.after(async () => {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  });
  const auth = await authHeaders(backend);

  const initial = setupReadModelSchema.parse((await backend.app.inject({
    method: "GET",
    url: "/api/v1/setup",
    headers: { host, cookie: auth.cookie },
  })).json());
  now += 1_001;
  const expired = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: mutationHeaders(auth),
    payload: {
      provider: "claude",
      previewId: initial.hooks.claude.previewId,
      confirmed: true,
    },
  });
  assert.equal(expired.statusCode, 410, expired.body);
  assert.equal(backend.database.listClaudeHookInstallRecords().length, 0);
  assert.equal(existsSync(join(root, ".claude", "settings.json")), false);

  const refreshed = setupReadModelSchema.parse((await backend.app.inject({
    method: "GET",
    url: "/api/v1/setup",
    headers: { host, cookie: auth.cookie },
  })).json());
  assert.notEqual(refreshed.hooks.claude.previewId, initial.hooks.claude.previewId);
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), "{\n  \"env\": {}\n}\n", "utf8");
  const stale = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: mutationHeaders(auth),
    payload: {
      provider: "claude",
      previewId: refreshed.hooks.claude.previewId,
      confirmed: true,
    },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.match(stale.body, /SETUP_HOOK_PREVIEW_STALE/u);
  assert.equal(backend.database.listClaudeHookInstallRecords().length, 0);

  const shimPath = join(
    root,
    "Library",
    "Application Support",
    "agent-manager",
    "hooks",
    "codex-user-hook.mjs",
  );
  mkdirSync(join(shimPath, ".."), { recursive: true });
  writeFileSync(shimPath, "// external edit after preview\n", "utf8");
  const staleCodex = await backend.app.inject({
    method: "POST",
    url: "/api/v1/setup/hooks/apply",
    headers: mutationHeaders(auth),
    payload: {
      provider: "codex",
      previewId: refreshed.hooks.codex.previewId,
      confirmed: true,
    },
  });
  assert.equal(staleCodex.statusCode, 409, staleCodex.body);
  assert.equal(backend.database.listCodexHookInstallRecords().length, 0);
  assert.equal(readFileSync(shimPath, "utf8"), "// external edit after preview\n");
});
