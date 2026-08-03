import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  analyzeCodexObjects,
  buildListing,
  classifyCodexObjects,
  discoverClaude,
  discoverCodex,
  formatTable,
  mergeSessionRecords,
  normalizeProviderMode,
  parseArgs,
  parseDuration,
  parseProcessTable,
  parseTranscriptMetadata,
  prepareSessions,
  type CommandResult,
  type ProcessInfo,
  type Runtime,
  type SessionRecord,
} from "./agent-sessions.ts";
import {
  attachTmuxTerminals,
  matchSessionToTmuxPane,
  parseTmuxPanes,
} from "./src/core/tmux.ts";
import { readJsonlIncrementally } from "./src/core/jsonl.ts";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", status: 0, error: null };
}

function failed(message = "not available"): CommandResult {
  return { stdout: "", stderr: message, status: 1, error: null };
}

function runtime(
  homeDir: string,
  run: Runtime["run"],
  env: Runtime["env"] = {},
): Runtime {
  return { now: () => NOW, homeDir, env, run };
}

function processInfo(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 101,
    ppid: 1,
    startedAtMs: NOW - 60_000,
    tty: "ttys001",
    state: "S+",
    command: "/usr/local/bin/claude",
    executable: "claude",
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    provider: "codex",
    sessionId: "root",
    parentSessionId: null,
    rootSessionId: "root",
    depth: 0,
    name: "Root",
    cwd: "/workspace",
    kind: "interactive",
    lifecycle: "recent",
    status: "completed",
    providerStatus: "task_complete",
    waitingReason: null,
    pid: null,
    runtimePid: null,
    startedAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T11:00:00.000Z",
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
    statusSource: "rollout-events",
    source: "user",
    ownership: "external",
    runtimeAlive: false,
    mode: {
      value: "unknown",
      providerValue: null,
      source: "inferred",
      confidence: "heuristic",
    },
    activity: "completed",
    attention: [],
    effectiveAccess: {
      permissionMode: null,
      sandboxMode: null,
      fullHostAccess: false,
    },
    terminal: null,
    control: {
      plane: "observe-only",
      capabilities: [],
      managerOwned: false,
      writableLease: false,
    },
    generation: 0,
    ...overrides,
  };
}

function writeJsonLines(file: string, values: unknown[], mtimeMs = NOW): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
  const time = new Date(mtimeMs);
  utimesSync(file, time, time);
}

test("parses CLI defaults, durations, and filters", () => {
  assert.equal(parseDuration("15m"), 900);
  assert.equal(parseDuration("1.5h"), 5_400);
  assert.equal(parseDuration("0"), 0);
  assert.throws(() => parseDuration("later"), /Invalid duration/);

  const defaults = parseArgs([]);
  assert.equal(defaults.recentWindowSeconds, 900);
  assert.deepEqual([...defaults.providers], ["codex", "claude"]);
  assert.equal(defaults.includeChildren, false);

  const parsed = parseArgs([
    "--json",
    "--children",
    "--since=1.5h",
    "--provider",
    "codex",
    "--status=running,waiting",
  ]);
  assert.equal(parsed.json, true);
  assert.equal(parsed.includeChildren, true);
  assert.equal(parsed.recentWindowSeconds, 5_400);
  assert.deepEqual([...parsed.providers], ["codex"]);
  assert.deepEqual([...parsed.statuses ?? []], ["running", "waiting"]);
  assert.throws(() => parseArgs(["--provider", "other"]), /Invalid provider/);
});

test("parses the macOS process table shape", () => {
  const processes = parseProcessTable(
    "  123  1 Mon Aug  3 12:34:56 2026 ttys001 S+ /opt/homebrew/bin/claude --verbose\n",
  );
  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.pid, 123);
  assert.equal(processes[0]?.executable, "claude");
  assert.match(processes[0]?.command ?? "", /--verbose/);
});

test("normalizes Codex lifecycle events", () => {
  const started = [
    { type: "session_meta", payload: { id: "one" } },
    { type: "event_msg", payload: { type: "task_started" } },
  ];
  assert.equal(classifyCodexObjects(started, "live").status, "running");

  const waiting = [
    ...started,
    { type: "event_msg", payload: { type: "request_permissions" } },
  ];
  assert.deepEqual(classifyCodexObjects(waiting, "live"), {
    status: "waiting",
    providerStatus: "request_permissions",
    waitingReason: "approval",
  });

  const complete = [
    ...started,
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  assert.equal(classifyCodexObjects(complete, "live").status, "idle");
  assert.equal(classifyCodexObjects(complete, "recent").status, "completed");
  assert.equal(
    classifyCodexObjects([{ type: "event_msg", payload: { type: "error" } }], "recent").status,
    "failed",
  );
});

test("tracks Codex mode, access, and unresolved requests independently", () => {
  const objects = [
    {
      type: "turn_context",
      payload: {
        collaboration_mode: { mode: "plan" },
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "request_user_input",
        call_id: "question-1",
        input: { question: "Which route?" },
      },
    },
    { type: "event_msg", payload: { type: "agent_message" } },
  ];
  const waiting = analyzeCodexObjects(objects, "live");
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.mode.value, "planning");
  assert.equal(waiting.mode.providerValue, "plan");
  assert.equal(waiting.effectiveAccess.fullHostAccess, true);
  assert.deepEqual(waiting.attention.map((item) => [item.id, item.kind]), [
    ["question-1", "question"],
  ]);

  const resolved = analyzeCodexObjects([
    ...objects,
    {
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "question-1", output: "A" },
    },
  ], "live");
  assert.equal(resolved.status, "running");
  assert.deepEqual(resolved.attention, []);
});

test("tracks unmatched Claude questions and exact mode changes", () => {
  const question = {
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "tool-1",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Deploy now?" }] },
      }],
    },
  };
  const pending = parseTranscriptMetadata([
    { type: "permission-mode", permissionMode: "plan" },
    question,
  ]);
  assert.equal(pending.mode.value, "planning");
  assert.equal(pending.attention[0]?.kind, "question");
  assert.equal(pending.attention[0]?.id, "tool-1");

  const resolved = parseTranscriptMetadata([
    { type: "permission-mode", permissionMode: "bypassPermissions" },
    question,
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Yes" }] },
    },
  ]);
  assert.equal(resolved.mode.value, "execution");
  assert.equal(resolved.effectiveAccess.fullHostAccess, true);
  assert.deepEqual(resolved.attention, []);

  const interrupted = parseTranscriptMetadata([
    question,
    { type: "user", message: { content: "Continue with a different task" } },
    { type: "assistant", message: { stop_reason: "end_turn", content: [] } },
  ]);
  assert.deepEqual(interrupted.attention, []);
});

test("merges evidence field by field without erasing an exact mode", () => {
  const providerRecord = session({
    lifecycle: "live",
    status: "running",
    activity: "running",
    statusSource: "provider-cli",
    mode: normalizeProviderMode(null, "provider-cli"),
    updatedAt: "2026-08-03T11:59:00.000Z",
  });
  const transcriptRecord = session({
    lifecycle: "recent",
    status: "completed",
    activity: "completed",
    statusSource: "transcript",
    mode: normalizeProviderMode("plan", "transcript"),
    effectiveAccess: {
      permissionMode: "bypassPermissions",
      sandboxMode: null,
      fullHostAccess: true,
    },
  });
  const merged = mergeSessionRecords(providerRecord, transcriptRecord);
  assert.equal(merged.status, "running");
  assert.equal(merged.mode.value, "planning");
  assert.equal(merged.effectiveAccess.fullHostAccess, true);
  assert.equal(merged.lifecycle, "live");
});

test("a later successful Claude response clears an earlier transient error", () => {
  const metadata = parseTranscriptMetadata([
    { type: "error", timestamp: "2026-08-03T11:00:00.000Z" },
    {
      type: "assistant",
      message: { stop_reason: "end_turn" },
      timestamp: "2026-08-03T11:01:00.000Z",
    },
  ]);
  assert.equal(metadata.failed, false);
  assert.equal(metadata.lastStopReason, "end_turn");
});

test("collapses descendants and promotes their live status to the root", () => {
  const records = [
    session(),
    session({
      sessionId: "child",
      parentSessionId: "root",
      name: "Child",
      kind: "subagent",
      lifecycle: "live",
      status: "waiting",
      providerStatus: "request_permissions",
      waitingReason: "approval",
      updatedAt: "2026-08-03T11:30:00.000Z",
    }),
    session({
      sessionId: "grandchild",
      parentSessionId: "child",
      name: "Grandchild",
      kind: "subagent",
      lifecycle: "live",
      status: "running",
      providerStatus: "task_started",
      updatedAt: "2026-08-03T11:45:00.000Z",
    }),
  ];

  const collapsed = prepareSessions(records, false, null);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]?.status, "waiting");
  assert.equal(collapsed[0]?.lifecycle, "live");
  assert.equal(collapsed[0]?.childSummary.total, 2);
  assert.equal(collapsed[0]?.childSummary.waiting, 1);
  assert.equal(collapsed[0]?.childSummary.running, 1);

  const expanded = prepareSessions(records, true, null);
  assert.deepEqual(expanded.map((record) => record.sessionId), ["root", "child", "grandchild"]);
  assert.equal(prepareSessions(records, false, new Set(["running"])).length, 1);
});

test("preserves child attention kind when collapsing hierarchy", () => {
  const root = session();
  const child = session({
    sessionId: "child-question",
    parentSessionId: "root",
    lifecycle: "live",
    status: "waiting",
    activity: "waiting",
    waitingReason: "user-input",
    attention: [{
      id: "question-2",
      kind: "question",
      summary: "Choose a target",
      source: "rollout-events",
      confidence: "exact",
    }],
  });
  const collapsed = prepareSessions([root, child], false, null);
  assert.equal(collapsed[0]?.attention[0]?.kind, "question");
  assert.equal(collapsed[0]?.waitingReason, "user-input");
});

test("matches tmux panes by exact process topology and rejects ambiguity", () => {
  const separator = "\u001f";
  const output = [
    ["fable", "3", "worker", "0", "%7", "10", "/dev/ttys004", "2"].join(separator),
  ].join("\n");
  const panes = parseTmuxPanes(output, "mobile-ssh", "/tmp/tmux-501/mobile-ssh");
  const processes = [
    processInfo({ pid: 10, ppid: 1, tty: "ttys004", command: "-zsh", executable: "zsh" }),
    processInfo({ pid: 20, ppid: 10, tty: "ttys004", command: "claude", executable: "claude" }),
  ];
  const record = session({
    provider: "claude",
    pid: 20,
    runtimePid: 20,
    lifecycle: "live",
    runtimeAlive: true,
  });
  assert.equal(matchSessionToTmuxPane(record, panes, processes)?.paneId, "%7");
  const attached = attachTmuxTerminals([record], panes, processes)[0];
  assert.equal(attached?.terminal?.socketName, "mobile-ssh");
  assert.deepEqual(attached?.control.capabilities, ["preview", "attach"]);

  const ambiguous = [
    ...panes,
    { ...panes[0]!, paneId: "%8", windowIndex: 4, window: "other" },
  ];
  assert.equal(matchSessionToTmuxPane(record, ambiguous, processes), null);

  const shared = attachTmuxTerminals([
    record,
    session({ sessionId: "same-runtime", provider: "claude", pid: 20, runtimePid: 20 }),
  ], panes, processes);
  assert.equal(shared[0]?.terminal, null);
  assert.equal(shared[1]?.terminal, null);
});

test("reads JSONL appends incrementally and resets after truncation", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-sessions-jsonl-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "events.jsonl");
  writeFileSync(file, '{"id":1}\n{"id":2}\n');

  const initial = readJsonlIncrementally<{ id: number }>(file, null, {
    parse: (value) => value as { id: number },
  });
  assert.deepEqual(initial.records.map((value) => value.id), [1, 2]);
  assert.equal(initial.caughtUp, true);

  appendFileSync(file, '{"id":3');
  const partial = readJsonlIncrementally<{ id: number }>(file, initial.cursor, {
    parse: (value) => value as { id: number },
  });
  assert.deepEqual(partial.records, []);
  appendFileSync(file, '}\n');
  const completed = readJsonlIncrementally<{ id: number }>(file, partial.cursor, {
    parse: (value) => value as { id: number },
  });
  assert.deepEqual(completed.records.map((value) => value.id), [3]);

  writeFileSync(file, '{"id":4}\n');
  const reset = readJsonlIncrementally<{ id: number }>(file, completed.cursor, {
    parse: (value) => value as { id: number },
  });
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.records.map((value) => value.id), [4]);
});

test("discovers Claude CLI sessions, recent transcripts, and subagents", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-sessions-claude-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const projects = join(home, ".claude", "projects", "-workspace");
  const activeId = "11111111-1111-4111-8111-111111111111";
  const endedId = "22222222-2222-4222-8222-222222222222";
  const blockedId = "33333333-3333-4333-8333-333333333333";
  const answerId = "55555555-5555-4555-8555-555555555555";
  const staleBlockedId = "66666666-6666-4666-8666-666666666666";
  const reusedPidId = "77777777-7777-4777-8777-777777777777";

  writeJsonLines(join(projects, `${activeId}.jsonl`), [
    { type: "user", sessionId: activeId, cwd: "/workspace", timestamp: "2026-08-03T11:58:00.000Z" },
    { type: "ai-title", aiTitle: "Active Claude work", timestamp: "2026-08-03T11:58:30.000Z" },
    { type: "assistant", message: { stop_reason: "tool_use" }, timestamp: "2026-08-03T11:59:30.000Z" },
  ], NOW - 30_000);
  writeJsonLines(join(projects, `${endedId}.jsonl`), [
    { type: "user", sessionId: endedId, cwd: "/workspace", timestamp: "2026-08-03T11:53:00.000Z" },
    { type: "ai-title", aiTitle: "Finished Claude work", timestamp: "2026-08-03T11:54:00.000Z" },
    { type: "assistant", message: { stop_reason: "end_turn" }, timestamp: "2026-08-03T11:55:00.000Z" },
  ], NOW - 5 * 60_000);
  writeJsonLines(join(projects, activeId, "subagents", "agent-child-a.jsonl"), [
    { type: "user", sessionId: activeId, agentId: "child-a", cwd: "/workspace", timestamp: "2026-08-03T11:59:00.000Z" },
    { type: "agent-name", agentName: "Fixture child", timestamp: "2026-08-03T11:59:10.000Z" },
    { type: "assistant", message: { stop_reason: "tool_use" }, timestamp: "2026-08-03T11:59:20.000Z" },
  ], NOW - 20_000);
  writeJsonLines(join(projects, activeId, "subagents", "agent-failed-old.jsonl"), [
    { type: "user", sessionId: activeId, agentId: "failed-old", cwd: "/workspace", timestamp: "2026-08-03T01:00:00.000Z" },
    { type: "error", subtype: "api_error", timestamp: "2026-08-03T01:01:00.000Z" },
  ], NOW - 10 * 60 * 60_000);

  const cli = JSON.stringify([
    { sessionId: activeId, pid: 101, status: "busy", kind: "interactive", cwd: "/workspace", startedAt: NOW - 120_000 },
    { sessionId: blockedId, state: "blocked", status: "blocked", kind: "background", name: "Blocked Claude work", cwd: "/workspace", startedAt: NOW - 300_000 },
    {
      sessionId: answerId,
      pid: 102,
      state: "blocked",
      status: "blocked",
      kind: "background",
      name: "Claude question",
      cwd: "/workspace",
      startedAt: NOW - 200_000,
      waitingFor: { type: "question", id: "claude-question-1", question: "Continue?" },
    },
    { sessionId: staleBlockedId, state: "blocked", status: "blocked", kind: "background", name: "Stale blocked row", cwd: "/workspace", startedAt: NOW - 40 * 24 * 60 * 60_000 },
    { sessionId: reusedPidId, pid: 103, status: "busy", kind: "interactive", cwd: "/workspace", startedAt: NOW - 600_000 },
    { sessionId: endedId, state: "done", status: "done", kind: "background", name: "Old command title", cwd: "/workspace", startedAt: NOW - 600_000 },
  ]);
  const fixtureRuntime = runtime(home, (command, args) =>
    basename(command) === "claude" && args.join(" ") === "agents --json --all"
      ? ok(cli)
      : failed(),
  );

  const result = discoverClaude(fixtureRuntime, [
    processInfo({ startedAtMs: NOW - 120_000 }),
    processInfo({ pid: 102, tty: "ttys002", startedAtMs: NOW - 200_000 }),
    processInfo({ pid: 103, tty: "ttys003", startedAtMs: NOW - 60_000 }),
  ], 900);
  assert.equal(result.succeeded, true);
  const prepared = prepareSessions(result.sessions, true, null);
  const active = prepared.find((record) => record.sessionId === activeId);
  const blocked = prepared.find((record) => record.sessionId === blockedId);
  const ended = prepared.find((record) => record.sessionId === endedId);
  const answer = prepared.find((record) => record.sessionId === answerId);
  const child = prepared.find((record) => record.sessionId === "child-a");
  assert.equal(active?.name, "Active Claude work");
  assert.equal(active?.status, "running");
  assert.equal(active?.pid, 101);
  assert.equal(active?.childSummary.running, 1);
  assert.equal(blocked?.lifecycle, "recent");
  assert.equal(blocked?.status, "unknown");
  assert.equal(blocked?.waitingReason, null);
  assert.deepEqual(blocked?.attention, []);
  assert.equal(answer?.lifecycle, "live");
  assert.equal(answer?.attention[0]?.kind, "question");
  assert.equal(answer?.attention[0]?.id, "claude-question-1");
  assert.equal(answer?.waitingReason, "user-input");
  assert.equal(prepared.some((record) => record.sessionId === staleBlockedId), false);
  assert.equal(prepared.some((record) => record.sessionId === reusedPidId), false);
  assert.equal(prepared.some((record) => record.sessionId === "failed-old"), false);
  assert.equal(ended?.status, "completed");
  assert.equal(ended?.lifecycle, "recent");
  assert.equal(child?.parentSessionId, activeId);
  assert.equal(child?.kind, "subagent");
});

test("rejects a Claude registry entry when its PID has been reused", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-sessions-stale-pid-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = join(home, ".claude", "sessions", "101.json");
  mkdirSync(join(registry, ".."), { recursive: true });
  writeFileSync(registry, JSON.stringify({
    pid: 101,
    sessionId: "44444444-4444-4444-8444-444444444444",
    procStart: "2026-08-03T10:00:00.000Z",
    startedAt: NOW - 2 * 60 * 60_000,
    cwd: "/workspace",
    status: "busy",
  }));

  const fixtureRuntime = runtime(home, () => failed("Claude CLI unavailable"));
  const result = discoverClaude(fixtureRuntime, [processInfo()], 0);
  assert.equal(result.succeeded, true);
  assert.equal(result.sessions.length, 0);
});

test("discovers Codex open rollouts, recent rows, and hydrates parents", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-sessions-codex-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = join(home, ".codex");
  const sessionsDir = join(codexHome, "sessions", "2026", "08", "03");
  mkdirSync(sessionsDir, { recursive: true });
  const rootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const recentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const rootFile = join(sessionsDir, `rollout-root-${rootId}.jsonl`);
  const childFile = join(sessionsDir, `rollout-child-${childId}.jsonl`);
  const recentFile = join(sessionsDir, `rollout-recent-${recentId}.jsonl`);
  writeJsonLines(rootFile, [
    { type: "session_meta", payload: { id: rootId, cwd: "/workspace", timestamp: "2026-08-03T08:00:00.000Z", source: "user" } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ], NOW - 3 * 60 * 60_000);
  writeJsonLines(childFile, [
    { type: "session_meta", payload: { id: childId, cwd: "/workspace", timestamp: "2026-08-03T11:00:00.000Z", source: "subagent" } },
    { type: "event_msg", payload: { type: "task_started" } },
  ], NOW - 20_000);
  writeJsonLines(recentFile, [
    { type: "session_meta", payload: { id: recentId, cwd: "/other", timestamp: "2026-08-03T11:50:00.000Z", source: "user" } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ], NOW - 5 * 60_000);

  const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      cwd TEXT,
      title TEXT,
      source TEXT,
      thread_source TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      archived INTEGER DEFAULT 0
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT,
      child_thread_id TEXT
    );
  `);
  const insert = database.prepare(`
    INSERT INTO threads
      (id, rollout_path, created_at, updated_at, cwd, title, source, thread_source, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  insert.run(rootId, rootFile, Math.floor((NOW - 4 * 60 * 60_000) / 1_000), Math.floor((NOW - 3 * 60 * 60_000) / 1_000), "/workspace", "Hydrated root", "user", "user");
  insert.run(childId, childFile, Math.floor((NOW - 60 * 60_000) / 1_000), Math.floor((NOW - 60 * 60_000) / 1_000), "/workspace", "Live child", "subagent", "subagent");
  insert.run(recentId, recentFile, Math.floor((NOW - 10 * 60_000) / 1_000), Math.floor((NOW - 5 * 60_000) / 1_000), "/other", "Recently finished", "user", "user");
  database.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)").run(rootId, childId);
  database.close();

  const lsof = `p201\nfcwd\nn/workspace\nf10\nn${childFile}\n`;
  const fixtureRuntime = runtime(home, (command) =>
    basename(command) === "lsof" ? ok(lsof) : failed(),
  );
  const codexProcess = processInfo({
    pid: 201,
    command: "/usr/local/bin/codex app-server",
    executable: "codex",
  });

  const result = discoverCodex(fixtureRuntime, [codexProcess], 900);
  assert.equal(result.succeeded, true);
  const expanded = prepareSessions(result.sessions, true, null);
  const root = expanded.find((record) => record.sessionId === rootId);
  const child = expanded.find((record) => record.sessionId === childId);
  const recent = expanded.find((record) => record.sessionId === recentId);
  assert.ok(root, JSON.stringify({ sessions: expanded, diagnostics: result.diagnostics }, null, 2));
  assert.equal(root?.name, "Hydrated root");
  assert.equal(root?.lifecycle, "live");
  assert.equal(root?.status, "running");
  assert.equal(root?.childSummary.running, 1);
  assert.equal(child?.parentSessionId, rootId);
  assert.equal(child?.runtimePid, 201);
  assert.equal(child?.status, "running");
  assert.equal(recent?.lifecycle, "recent");
  assert.equal(recent?.status, "completed");

  const table = formatTable(prepareSessions(result.sessions, false, null), NOW, home, 140);
  assert.match(table, /Hydrated root/);
  assert.match(table, /1 live/);
  assert.match(table, /Recently finished/);
});

test("contains an unexpected provider failure and returns a diagnostic", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-sessions-provider-failure-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fixtureRuntime = runtime(home, (command) => {
    if (basename(command) === "ps") return ok("");
    if (basename(command) === "claude") throw new Error("fixture explosion");
    return failed();
  });
  const listing = buildListing(parseArgs(["--provider", "claude"]), fixtureRuntime);
  assert.equal(listing.successfulProviderCount, 0);
  assert.equal(listing.sessions.length, 0);
  assert.match(listing.diagnostics.at(-1)?.message ?? "", /fixture explosion/);
});
