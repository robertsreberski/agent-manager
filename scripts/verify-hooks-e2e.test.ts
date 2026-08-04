import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionRecord } from "../src/core/types.ts";
import { digestHookBearerToken } from "../src/providers/hooks/auth.ts";
import { ManagerDatabase } from "../src/server/persistence.ts";
import { createAgentManagerServer } from "../src/server/server.ts";
import { sessionRecordId } from "../src/shared/session.ts";
import {
  CODEX_HOOK_TRUST_EXPECT_SCRIPT,
  claudeCliArguments,
  codexCliArguments,
  codexHookTrustArguments,
  copyRegularCredential,
  createIsolatedWorkspace,
  exerciseClaudeAllowAndDeny,
  hookE2eExitCode,
  isolatedEnvironment,
  parseClaudeAuthStatus,
  parseClaudeFinalResult,
  parseCodexThreadId,
  parseHookE2eArguments,
  removeIsolatedWorkspace,
  runCommand,
  type HookE2eResult,
} from "./verify-hooks-e2e.ts";

async function disposableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing disposable port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function externalClaudeSession(providerSessionId: string, cwd: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: sessionRecordId("local", "claude", providerSessionId),
    provider: "claude",
    providerThreadId: providerSessionId,
    providerTreeId: providerSessionId,
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "Disposable test",
    name: "External Claude permission test",
    cwd,
    kind: "batch",
    presence: "live",
    status: "running",
    providerStatus: "running",
    pid: null,
    runtimePid: null,
    startedAt: now,
    updatedAt: now,
    childSummary: {
      total: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    },
    statusSource: "hook",
    source: "hook",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    effort: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [] },
    workspaceIdentity: null,
    generation: 0,
  };
}

test("real hook E2E arguments select an exact provider and reject ambiguous input", () => {
  assert.deepEqual(parseHookE2eArguments([]), { provider: "all" });
  assert.deepEqual(parseHookE2eArguments(["--provider", "codex"]), { provider: "codex" });
  assert.deepEqual(parseHookE2eArguments(["--", "--provider", "codex"]), { provider: "codex" });
  assert.deepEqual(parseHookE2eArguments(["--provider", "claude"]), { provider: "claude" });
  assert.throws(() => parseHookE2eArguments(["--provider", "pi"]), /all, codex, or claude/u);
  assert.throws(
    () => parseHookE2eArguments(["--provider", "codex", "--provider", "claude"]),
    /only once/u,
  );
  assert.throws(() => parseHookE2eArguments(["--yes"]), /Unknown/u);
});

test("a skipped selected provider makes the completion gate non-green", () => {
  const result = (
    provider: "codex" | "claude",
    status: HookE2eResult["status"],
  ): HookE2eResult => ({ provider, status, summary: "fixture", evidence: [] });
  assert.equal(hookE2eExitCode([result("codex", "passed")]), 0);
  assert.equal(hookE2eExitCode([result("codex", "passed"), result("claude", "skipped")]), 2);
  assert.equal(hookE2eExitCode([result("codex", "failed"), result("claude", "skipped")]), 1);
  assert.equal(hookE2eExitCode([]), 1);
});

test("provider argv is noninteractive, disposable, and does not select remote/background modes", () => {
  const codex = codexCliArguments("/tmp/disposable-project", "CODEX_PROMPT");
  assert.deepEqual(codex.slice(0, 2), ["exec", "--ephemeral"]);
  assert.equal(codex.includes("--dangerously-bypass-hook-trust"), false);
  assert.ok(codex.includes("--skip-git-repo-check"));
  assert.ok(codex.includes("--ignore-rules"));
  assert.ok(codex.includes("read-only"));
  assert.ok(codex.includes("/tmp/disposable-project"));
  assert.equal(codex.includes("--remote"), false);
  assert.equal(codex.includes("--dangerously-bypass-approvals-and-sandbox"), false);

  const claude = claudeCliArguments({
    settingsPath: "/tmp/disposable-home/.claude/settings.json",
    sessionId: "00000000-0000-4000-8000-000000000001",
    prompt: "CLAUDE_PROMPT",
  });
  assert.deepEqual(claude.slice(0, 2), ["--print", "CLAUDE_PROMPT"]);
  assert.ok(claude.includes("--no-session-persistence"));
  assert.ok(claude.includes("--include-hook-events"));
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.ok(claude.includes("--settings"));
  assert.equal(claude[claude.indexOf("--setting-sources") + 1], "");
  assert.equal(claude.includes("--bare"), false, "bare mode would disable the hooks under test");
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "manual");
  assert.equal(claude[claude.indexOf("--tools") + 1], "Bash");
  assert.equal(claude.includes("dontAsk"), false);
  assert.equal(claude.includes("--background"), false);
  assert.equal(claude.includes("--remote-control"), false);

  const trust = codexHookTrustArguments(
    "/tmp/disposable-root/trust.exp",
    "/trusted/bin/codex",
    "/tmp/disposable-project",
  );
  assert.deepEqual(trust, [
    "-f",
    "/tmp/disposable-root/trust.exp",
    "/trusted/bin/codex",
    "/tmp/disposable-project",
  ]);
  assert.match(CODEX_HOOK_TRUST_EXPECT_SCRIPT, /Hooks\.\*need\.\*review/u);
  assert.match(CODEX_HOOK_TRUST_EXPECT_SCRIPT, /send -- "2\\r"/u);
  assert.match(CODEX_HOOK_TRUST_EXPECT_SCRIPT, /spawn_out\(slave,name\)/u);
  assert.match(CODEX_HOOK_TRUST_EXPECT_SCRIPT, /OpenAI\.\*Codex/u);
  assert.doesNotMatch(CODEX_HOOK_TRUST_EXPECT_SCRIPT, /dangerously-bypass-hook-trust/u);
});

test("provider output parsers require exact disposable identity/auth evidence", () => {
  assert.equal(parseCodexThreadId([
    JSON.stringify({ type: "item.completed", item: {} }),
    JSON.stringify({ type: "thread.started", thread_id: "thread-e2e" }),
  ].join("\n")), "thread-e2e");
  assert.equal(parseCodexThreadId("not-json\n{}\n"), null);
  assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "api_key",
    apiProvider: "firstParty",
  })), { loggedIn: true, authMethod: "api_key" });
  assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":false}'), {
    loggedIn: false,
    authMethod: null,
  });
  assert.equal(parseClaudeAuthStatus("not-json"), null);
  assert.equal(parseClaudeFinalResult([
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", result: "first" }),
    JSON.stringify({ type: "result", result: "AGENT_MANAGER_HOOK_E2E_CLAUDE" }),
  ].join("\n")), "AGENT_MANAGER_HOOK_E2E_CLAUDE");
  assert.equal(parseClaudeFinalResult("not-json\n{}"), null);
});

test("isolated environments replace provider homes and remove parent-session routing", async () => {
  const workspace = await createIsolatedWorkspace();
  try {
    const base = {
      PATH: process.env.PATH,
      HOME: "/Users/example",
      CODEX_HOME: "/Users/example/.codex",
      CODEX_THREAD_ID: "existing-thread",
      CODEX_REMOTE_URL: "ws://shared-daemon",
      CLAUDE_CONFIG_DIR: "/Users/example/.claude",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "existing-session",
      AGENT_MANAGER_SESSION_OWNER: "manager",
    } satisfies NodeJS.ProcessEnv;
    const codex = isolatedEnvironment(workspace, "codex", base);
    assert.equal(codex.HOME, workspace.home);
    assert.equal(codex.CODEX_HOME, workspace.codexHome);
    assert.equal(codex.TMPDIR, workspace.temporary);
    assert.equal(codex.CODEX_THREAD_ID, undefined);
    assert.equal(codex.CODEX_REMOTE_URL, undefined);
    assert.equal(codex.AGENT_MANAGER_SESSION_OWNER, undefined);

    const claude = isolatedEnvironment(workspace, "claude", base);
    assert.equal(claude.HOME, workspace.home);
    assert.equal(claude.CLAUDE_CONFIG_DIR, workspace.claudeConfig);
    assert.equal(claude.CLAUDECODE, undefined);
    assert.equal(claude.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(claude.AGENT_MANAGER_SESSION_OWNER, undefined);
  } finally {
    await removeIsolatedWorkspace(workspace);
  }
});

test("credential isolation copies only regular files at mode 0600 and rejects symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-manager-hooks-credential-test-"));
  try {
    const source = join(root, "source.json");
    const destination = join(root, "isolated", "auth.json");
    await writeFile(source, '{"credential":"fixture"}\n', { mode: 0o640 });
    await copyRegularCredential(source, destination);
    assert.equal(await readFile(destination, "utf8"), '{"credential":"fixture"}\n');
    assert.equal((await lstat(destination)).mode & 0o777, 0o600);

    const linked = join(root, "linked.json");
    await symlink(source, linked);
    await assert.rejects(
      copyRegularCredential(linked, join(root, "isolated", "linked-copy.json")),
      /regular non-symlink/u,
    );
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("command runner uses argv without a shell and bounds provider output", async () => {
  const workspace = await createIsolatedWorkspace();
  try {
    const output = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", "literal;$(touch should-not-run)"],
      {
        cwd: workspace.project,
        env: isolatedEnvironment(workspace, "codex", process.env),
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1_024,
      },
    );
    assert.equal(output.exitCode, 0);
    assert.equal(output.stdout, "literal;$(touch should-not-run)");
    assert.equal(output.timedOut, false);
    assert.equal(output.outputLimitExceeded, false);
    await assert.rejects(lstat(join(workspace.project, "should-not-run")), /ENOENT/u);

    const bounded = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      {
        cwd: workspace.project,
        env: isolatedEnvironment(workspace, "codex", process.env),
        timeoutMs: 5_000,
        maxOutputBytes: 64,
      },
    );
    assert.equal(Buffer.byteLength(bounded.stdout) + Buffer.byteLength(bounded.stderr) <= 64, true);
    assert.equal(bounded.outputLimitExceeded, true);
  } finally {
    await removeIsolatedWorkspace(workspace);
  }
});

test("authenticated Claude E2E path answers one real held allow and deny through cockpit actions", async () => {
  const workspace = await createIsolatedWorkspace();
  const token = "claude-hook-e2e-test-token-with-thirty-two-characters";
  const providerSessionId = "claude-hook-e2e-provider-session";
  const port = await disposableLoopbackPort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const endpoint = `${origin}/api/v1/hooks/claude`;
  const settingsPath = join(workspace.claudeConfig, "settings.json");
  const database = new ManagerDatabase();
  database.upsertClaudeHookInstallRecord({
    id: "claude-hook-e2e-test-install",
    provider: "claude",
    schemaVersion: 1,
    tokenDigest: digestHookBearerToken(token),
    createdAt: new Date().toISOString(),
    settingsPath,
    endpoint,
    createdHooksProperty: true,
  });
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port,
    publicOrigin: origin,
    hookEndpointOrigin: origin,
    allowedHosts: [`127.0.0.1:${String(port)}`],
    allowedOrigins: [origin],
    homeDirectory: workspace.home,
    database,
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    initialSessions: [externalClaudeSession(providerSessionId, workspace.project)],
  });
  await backend.listen();
  try {
    const result = await exerciseClaudeAllowAndDeny({
      backend,
      origin,
      providerSessionId,
      timeoutMs: 3_000,
      runProvider: async () => {
        const invoke = (index: number) => backend.app.inject({
          method: "POST",
          url: "/api/v1/hooks/claude",
          headers: {
            host: `127.0.0.1:${String(port)}`,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          payload: {
            session_id: providerSessionId,
            transcript_path: join(workspace.temporary, "transcript.jsonl"),
            cwd: workspace.project,
            prompt_id: "permission-turn",
            permission_mode: "manual",
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
            tool_input: { command: index === 1 ? "printf allow" : "printf deny" },
          },
        });
        const allow = await invoke(1);
        assert.equal(allow.statusCode, 200, allow.body);
        const deny = await invoke(2);
        assert.equal(deny.statusCode, 200, deny.body);
        return [allow.json(), deny.json()];
      },
    });
    assert.deepEqual(result.decisions, ["allow", "deny"]);
    assert.equal(new Set(result.requestIds).size, 2);
    assert.deepEqual(result.provider, [
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Denied by the disposable E2E cockpit",
          },
        },
      },
    ]);
  } finally {
    await backend.close();
    await removeIsolatedWorkspace(workspace);
  }
});
