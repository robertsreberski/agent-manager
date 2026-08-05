import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Runtime } from "../core/types.ts";
import { sessionRecordSchema } from "../shared/wire.ts";

import {
  analyzeCodexEvents,
  codexClientInvocation,
  parseCodexOpenFiles,
  parseProcessTable,
  scanObservedSessions,
  selectLatestCodexDatabase,
} from "./observe.ts";

test("parses bounded process rows used only for observe-only correlation", () => {
  const processes = parseProcessTable(
    "  123  1 ttys001 S+ /opt/homebrew/bin/codex\n" +
    "  456  1 ?? S /usr/local/bin/claude --print\n",
  );
  assert.deepEqual(processes.map((process) => ({
    pid: process.pid,
    executable: process.executable,
  })), [
    { pid: 123, executable: "codex" },
    { pid: 456, executable: "claude" },
  ]);
});

test("recognizes user Codex clients without mistaking service processes for sessions", () => {
  const [wrapper, native, appServer, broker] = parseProcessTable(
    "  101  1 ttys001 S+ node /opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox\n" +
    "  102 101 ttys001 S+ /opt/codex/bin/codex resume 019fccc8-833f-75e3-bfcc-1c00ea3be4cd\n" +
    "  103  1 ?? S /opt/codex/bin/codex -c features.foo=true app-server --listen unix:///tmp/codex.sock\n" +
    "  104  1 ?? S node /tmp/codex/scripts/app-server-broker.mjs serve\n",
  );
  assert.deepEqual(codexClientInvocation(wrapper!), { resumeThreadId: null });
  assert.deepEqual(codexClientInvocation(native!), {
    resumeThreadId: "019fccc8-833f-75e3-bfcc-1c00ea3be4cd",
  });
  assert.equal(codexClientInvocation(appServer!), null);
  assert.equal(codexClientInvocation(broker!), null);
});

test("parses only the real lsof cwd record and exact rollout IDs", () => {
  assert.deepEqual(parseCodexOpenFiles(
    "p102\nfcwd\nn/workspace\nftxt\nn/opt/codex/bin/codex\nf17\n" +
    "n/home/me/.codex/sessions/rollout-2026-08-04T12-00-00-019fccc8-833f-75e3-bfcc-1c00ea3be4cd.jsonl\n",
  ), {
    cwd: "/workspace",
    threadIds: ["019fccc8-833f-75e3-bfcc-1c00ea3be4cd"],
  });
});

test("prefers the newest state database when schema versions tie", () => {
  assert.equal(selectLatestCodexDatabase([
    { path: "/stale/state_5.sqlite", version: 5, modifiedAtMs: 100 },
    { path: "/live/state_5.sqlite", version: 5, modifiedAtMs: 200 },
    { path: "/old/state_4.sqlite", version: 4, modifiedAtMs: 300 },
  ]), "/live/state_5.sqlite");
});

test("Codex discovery publishes ultra and quarantines unknown raw effort values", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-effort-"));
  const sqliteDirectory = join(root, "sqlite");
  mkdirSync(sqliteDirectory);
  const database = new DatabaseSync(join(sqliteDirectory, "state_5.sqlite"));
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        reasoning_effort TEXT
      )
    `);
    const insert = database.prepare(
      "INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, reasoning_effort) VALUES (?, '', ?, ?, '/workspace', ?)",
    );
    insert.run("ultra-thread", now / 1_000, now / 1_000, "ultra");
    insert.run("unknown-thread", now / 1_000, now / 1_000, "bogusvalue");
  } finally {
    database.close();
  }

  try {
    const runtime: Runtime = {
      now: () => now,
      homeDir: root,
      env: { CODEX_HOME: root },
      run: () => ({ stdout: "", stderr: "", status: 0, error: null }),
    };
    const listing = scanObservedSessions({
      recentWindowSeconds: 60,
      providers: new Set(["codex"]),
    }, runtime);
    const sessions = new Map(listing.sessions.map((session) => [session.providerThreadId, session]));

    assert.deepEqual(sessions.get("ultra-thread")?.effort, {
      value: "ultra",
      providerValue: "ultra",
      source: "provider-cli",
      confidence: "exact",
    });
    assert.deepEqual(sessions.get("unknown-thread")?.effort, {
      value: null,
      providerValue: "bogusvalue",
      source: "provider-cli",
      confidence: "exact",
    });
    for (const session of listing.sessions) sessionRecordSchema.parse(session);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production observe scan attaches an exact official-CLI tmux match and makes stopped roots resumable", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-tmux-observe-"));
  const sqliteDirectory = join(root, "sqlite");
  mkdirSync(sqliteDirectory);
  const database = new DatabaseSync(join(sqliteDirectory, "state_5.sqlite"));
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const liveThread = "019fccc8-833f-75e3-bfcc-1c00ea3be4cd";
  const recentThread = "019fccc8-833f-75e3-bfcc-1c00ea3be4ce";
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cwd TEXT NOT NULL
      )
    `);
    const insert = database.prepare(
      "INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd) VALUES (?, '', ?, ?, '/workspace')",
    );
    insert.run(liveThread, now / 1_000, now / 1_000);
    insert.run(recentThread, now / 1_000, now / 1_000);
  } finally {
    database.close();
  }

  const tmuxCalls: Array<{ command: string; args: string[]; timeoutMs: number | undefined }> = [];
  try {
    const runtime: Runtime = {
      now: () => now,
      homeDir: root,
      env: {
        CODEX_HOME: root,
        AGENT_MANAGER_TMUX_EXECUTABLE: "/trusted/bin/tmux",
        AGENT_MANAGER_TMUX_SOCKETS: "official-cli",
      },
      run(command, args, timeoutMs) {
        if (command === "ps") {
          return {
            stdout:
              "  40  1 ttys001 S -zsh\n" +
              `  123 40 ttys001 S+ /trusted/bin/codex resume ${liveThread}\n`,
            stderr: "",
            status: 0,
            error: null,
          };
        }
        if (command.endsWith("/lsof") || command === "lsof") {
          return {
            stdout:
              "p123\nfcwd\nn/workspace\nf17\n" +
              `n${root}/sessions/rollout-2026-08-04T12-00-00-${liveThread}.jsonl\n`,
            stderr: "",
            status: 0,
            error: null,
          };
        }
        if (command === "/trusted/bin/tmux") {
          tmuxCalls.push({ command, args: [...args], timeoutMs });
          if (args[0] === "-L" && args[1] === "official-cli") {
            return {
              stdout: [
                "operator",
                "0",
                "main",
                "0",
                "%7",
                "40",
                "/dev/ttys001",
                "1",
              ].join("\u001f") + "\n",
              stderr: "",
              status: 0,
              error: null,
            };
          }
          return { stdout: "", stderr: "missing", status: 1, error: null };
        }
        throw new Error(`Unexpected production discovery command: ${command}`);
      },
    };
    const listing = scanObservedSessions({
      recentWindowSeconds: 60,
      providers: new Set(["codex"]),
    }, runtime);
    const sessions = new Map(listing.sessions.map((session) => [session.providerThreadId, session]));

    assert.deepEqual(sessions.get(liveThread)?.terminal, {
      attachAvailable: true,
      socketName: "official-cli",
      socketPath: null,
      session: "operator",
      window: "main",
      windowIndex: 0,
      paneIndex: 0,
      paneId: "%7",
      tty: "ttys001",
      attachedClients: 1,
    });
    assert.deepEqual(sessions.get(liveThread)?.control, {
      plane: "tmux-attach",
      authority: "foreign",
      coordination: {
        mode: "observe-only",
        nativeAttach: "none",
        responseResolution: "single-controller",
      },
      recovery: null,
      capabilities: ["preview", "attach"],
      withheld: [],
      takeover: null,
    });
    assert.equal(sessions.get(recentThread)?.terminal, null);
    assert.equal(sessions.get(recentThread)?.control.plane, "resume-only");
    assert.equal(sessions.get(recentThread)?.control.authority, "none");
    assert.deepEqual(sessions.get(recentThread)?.control.capabilities, ["resume"]);
    assert.ok(tmuxCalls.some((call) =>
      call.command === "/trusted/bin/tmux"
      && call.args[0] === "-L"
      && call.args[1] === "official-cli"
      && call.timeoutMs !== undefined
      && call.timeoutMs <= 750
    ));
    for (const session of listing.sessions) sessionRecordSchema.parse(session);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marks transcript-only request_user_input as heuristic and non-respondable", () => {
  const analysis = analyzeCodexEvents([
    { type: "event_msg", payload: { type: "task_started" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call-1",
      },
    },
  ], true);
  assert.equal(analysis.status, "waiting");
  assert.equal(analysis.attention[0]?.id, null);
  assert.equal(analysis.attention[0]?.confidence, "heuristic");
  assert.equal(analysis.attention[0]?.details?.respondable, false);

  const resolved = analyzeCodexEvents([
    ...[
      { type: "event_msg", payload: { type: "task_started" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call-1",
        },
      },
    ],
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1" },
    },
    { type: "event_msg", payload: { type: "task_complete" } },
  ], false);
  assert.equal(resolved.status, "completed");
  assert.deepEqual(resolved.attention, []);
});

test("Codex profile resolution prefers rollout context and maps safe database facts to execute", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-profile-"));
  const sqliteDirectory = join(root, "sqlite");
  mkdirSync(sqliteDirectory);
  const now = Date.parse("2026-08-05T12:00:00.000Z");
  const planRollout = join(root, "plan.jsonl");
  const fullRollout = join(root, "full.jsonl");
  writeFileSync(planRollout, `${JSON.stringify({
    type: "turn_context",
    payload: {
      approval_policy: "on-request",
      sandbox_policy: { type: "workspace-write" },
      collaboration_mode: { mode: "plan" },
    },
  })}\n`);
  writeFileSync(fullRollout, `${JSON.stringify({
    type: "turn_context",
    payload: {
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
      collaboration_mode: { mode: "plan" },
    },
  })}\n`);
  const database = new DatabaseSync(join(sqliteDirectory, "state_5.sqlite"));
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        sandbox_policy TEXT,
        approval_mode TEXT
      )
    `);
    const insert = database.prepare(
      "INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, sandbox_policy, approval_mode) VALUES (?, ?, ?, ?, '/workspace', ?, ?)",
    );
    insert.run("plan-thread", planRollout, now / 1_000, now / 1_000, '{"type":"workspace-write"}', "on-request");
    insert.run("full-thread", fullRollout, now / 1_000, now / 1_000, '{"type":"workspace-write"}', "on-request");
    insert.run("safe-db-thread", "", now / 1_000, now / 1_000, '{"type":"read-only"}', "never");
  } finally {
    database.close();
  }

  try {
    const runtime: Runtime = {
      now: () => now,
      homeDir: root,
      env: { CODEX_HOME: root },
      run: () => ({ stdout: "", stderr: "", status: 0, error: null }),
    };
    const sessions = new Map(scanObservedSessions({
      recentWindowSeconds: 60,
      providers: new Set(["codex"]),
    }, runtime).sessions.map((session) => [session.providerThreadId, session]));

    assert.equal(sessions.get("plan-thread")?.profile.value, "plan");
    assert.equal(sessions.get("plan-thread")?.profile.source, "rollout-events");
    assert.equal(sessions.get("full-thread")?.profile.value, "full-access");
    assert.equal(sessions.get("safe-db-thread")?.profile.value, "execute");
    assert.equal(sessions.get("safe-db-thread")?.profile.source, "provider-cli");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude profile resolution falls back to the latest transcript permission mode", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-claude-profile-"));
  // Matching by session identity remains reliable when Claude's project key no
  // longer matches the cwd reported by the provider registry.
  const projectDirectory = join(root, ".claude", "projects", "-moved-workspace");
  mkdirSync(projectDirectory, { recursive: true });
  const now = Date.parse("2026-08-05T12:00:00.000Z");
  const sessionId = "d88345c7-36b7-4804-990f-db05a32916d4";
  writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "user", permissionMode: "plan" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    JSON.stringify({ type: "user", permissionMode: "acceptEdits" }),
  ].join("\n"));

  try {
    const runtime: Runtime = {
      now: () => now,
      homeDir: root,
      env: {},
      run(command) {
        if (command === "ps") return { stdout: "", stderr: "", status: 0, error: null };
        if (command === "claude") {
          return {
            stdout: JSON.stringify([{
              sessionId,
              cwd: "/workspace",
              kind: "interactive",
              startedAt: now,
              state: "done",
            }]),
            stderr: "",
            status: 0,
            error: null,
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
    const [session] = scanObservedSessions({
      recentWindowSeconds: 60,
      providers: new Set(["claude"]),
    }, runtime).sessions;

    assert.deepEqual(session?.profile, {
      value: "execute",
      providerValue: "acceptEdits",
      source: "transcript",
      confidence: "inferred",
    });
    assert.equal(session?.control.plane, "resume-only");
    assert.equal(session?.control.authority, "none");
    assert.deepEqual(session?.control.capabilities, ["resume"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
