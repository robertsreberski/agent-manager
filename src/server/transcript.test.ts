import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach } from "node:test";
import {
  LocalSessionTranscriptReader,
  TRANSCRIPT_LIMITS,
  type TranscriptItem,
  type TranscriptReadResult,
} from "./transcript.ts";

function messagesOf(result: TranscriptReadResult): Array<{ role: string; text: string }> {
  return result.items.flatMap((item) =>
    item.kind === "message" ? [{ role: item.role, text: item.text }] : []
  );
}

function textsOf(result: TranscriptReadResult): string[] {
  return result.items.flatMap((item) => (item.kind === "tool" ? [] : [item.text]));
}

function toolsOf(result: TranscriptReadResult): Extract<TranscriptItem, { kind: "tool" }>[] {
  return result.items.flatMap((item) => (item.kind === "tool" ? [item] : []));
}

const roots: string[] = [];
const CODEX_ID = "11111111-1111-1111-1111-111111111111";
const CLAUDE_ID = "22222222-2222-2222-2222-222222222222";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-transcript-"));
  roots.push(root);
  return root;
}

function jsonl(values: unknown[], trailingNewline = true): string {
  const text = values.map((value) => JSON.stringify(value)).join("\n");
  return trailingNewline ? `${text}\n` : text;
}

function codexFixture(
  values: unknown[],
  options: { sessionId?: string; databasePath?: string; trailingNewline?: boolean } = {},
): { home: string; file: string; sessionId: string } {
  const root = temporaryRoot();
  const home = join(root, ".codex");
  const sessions = join(home, "sessions", "2026", "08", "03");
  mkdirSync(sessions, { recursive: true });
  const sessionId = options.sessionId ?? CODEX_ID;
  const file = join(sessions, `rollout-2026-08-03T12-00-00-${sessionId}.jsonl`);
  writeFileSync(file, jsonl(values, options.trailingNewline ?? true));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
    .run(sessionId, options.databasePath ?? file);
  database.close();
  return { home, file, sessionId };
}

function codexSession(sessionId = CODEX_ID) {
  return {
    provider: "codex" as const,
    providerThreadId: sessionId,
    parentId: null,
    providerTreeId: sessionId,
  };
}

function codexMeta(id = CODEX_ID) {
  return { type: "session_meta", timestamp: "2026-08-03T10:00:00Z", payload: { id } };
}

function codexMessage(
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "response_item",
    timestamp: "2026-08-03T10:00:01Z",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      ...extra,
    },
  };
}

function claudeHome(): { home: string; projects: string } {
  const root = temporaryRoot();
  const home = join(root, ".claude");
  const projects = join(home, "projects");
  mkdirSync(projects, { recursive: true });
  return { home, projects };
}

function claudeRootSession(sessionId = CLAUDE_ID) {
  return {
    provider: "claude" as const,
    providerThreadId: sessionId,
    parentId: null,
    providerTreeId: sessionId,
  };
}

function claudeRow(input: {
  uuid: string;
  parentUuid?: string | null;
  type: "user" | "assistant";
  content: unknown;
  messageId?: string;
  sessionId?: string;
  agentId?: string;
  sidechain?: boolean;
  meta?: boolean;
  extra?: Record<string, unknown>;
}) {
  return {
    uuid: input.uuid,
    parentUuid: input.parentUuid ?? null,
    sessionId: input.sessionId ?? CLAUDE_ID,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    isSidechain: input.sidechain ?? false,
    ...(input.meta ? { isMeta: true } : {}),
    timestamp: "2026-08-03T11:00:00Z",
    type: input.type,
    message: {
      role: input.type,
      content: input.content,
      ...(input.messageId ? { id: input.messageId } : {}),
    },
    ...input.extra,
  };
}

test("Codex reads ordered user/assistant response items and ignores provider internals", () => {
  const fixture = codexFixture([
    codexMeta(),
    { type: "event_msg", payload: { type: "agent_reasoning", text: "secret" } },
    codexMessage("user", "Hello", { id: "user-provider-id" }),
    {
      type: "response_item",
      payload: { type: "reasoning", role: "assistant", content: [{ type: "output_text", text: "hidden" }] },
    },
    {
      type: "response_item",
      payload: { type: "function_call", role: "assistant", content: [{ type: "output_text", text: "tool" }] },
    },
    codexMessage("assistant", "Hi there"),
  ]);
  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());

  assert.equal(result.transcript.state, "available");
  assert.equal(result.transcript.source, "codex-rollout");
  assert.equal(result.transcript.itemCount, 2);
  assert.equal(result.transcript.truncated, false);
  assert.deepEqual(messagesOf(result), [
    { role: "user", text: "Hello" },
    { role: "assistant", text: "Hi there" },
  ]);
  assert.equal(result.items[0]?.id, "codex:user-provider-id");
  assert.match(result.items[1]?.id ?? "", /^codex:file:\d+:\d+:\d+$/);
  assert.equal(result.items[0]?.createdAt, "2026-08-03T10:00:01.000Z");
});

test("Codex excludes injected context envelopes while preserving the actual user prompt", () => {
  const fixture = codexFixture([
    codexMeta(),
    codexMessage("user", "<environment_context>\n  <cwd>/fixture</cwd>\n</environment_context>"),
    codexMessage("user", "<recommended_plugins>\n  <plugin>fixture</plugin>\n</recommended_plugins>"),
    {
      type: "response_item",
      timestamp: "2026-08-03T10:00:02Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<environment_context>synthetic</environment_context>" },
          { type: "input_text", text: "The actual prompt" },
        ],
      },
    },
    codexMessage("user", "What does <environment_context> mean in this protocol?"),
    codexMessage("assistant", "Answer"),
  ]);

  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());
  assert.deepEqual(messagesOf(result), [
    { role: "user", text: "The actual prompt" },
    { role: "user", text: "What does <environment_context> mean in this protocol?" },
    { role: "assistant", text: "Answer" },
  ]);
});

test("selected-session search is literal, bounded, and redacts snippets", () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuv";
  const fixture = codexFixture([
    codexMeta(),
    codexMessage("user", `Find the literal [bracket] value and keep ${secret} private`, { id: "search-one" }),
    codexMessage("assistant", "The [bracket] value appears again", { id: "search-two" }),
  ]);
  const reader = new LocalSessionTranscriptReader({ codexHome: fixture.home });
  const result = reader.search(codexSession(), "[bracket]", 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.matches[0]?.messageId, "codex:search-one");
  assert.equal(result.matches[0]?.snippet.slice(
    result.matches[0]?.matchStart,
    result.matches[0]?.matchEnd,
  ), "[bracket]");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(reader.search(codexSession(), secret).matches.length, 0);
  assert.deepEqual(reader.search(codexSession(), "[").matches, []);
});

test("Codex tolerates malformed and partial JSONL while reporting omitted content", () => {
  const root = temporaryRoot();
  const home = join(root, ".codex");
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `rollout-${CODEX_ID}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify(codexMeta())}\nnot-json\n${JSON.stringify(codexMessage("assistant", "complete"))}\n{"type":`,
  );

  const result = new LocalSessionTranscriptReader({ codexHome: home }).read(codexSession());
  assert.equal(result.transcript.state, "available");
  assert.equal(result.transcript.truncated, true);
  assert.deepEqual(textsOf(result), ["complete"]);
});

test("Codex verifies the selected UUID against session metadata", () => {
  const fixture = codexFixture([codexMeta("99999999-9999-9999-9999-999999999999")]);
  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());
  assert.deepEqual(result, {
    items: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      itemCount: 0,
      reason: "unsupported",
    },
  });
});

test("Claude follows the latest parentUuid branch and renders only human-visible text", () => {
  const fixture = claudeHome();
  const project = join(fixture.projects, "-fixture-project");
  mkdirSync(project);
  writeFileSync(join(project, `${CLAUDE_ID}.jsonl`), jsonl([
    claudeRow({ uuid: "u1", type: "user", content: "Hello" }),
    claudeRow({ uuid: "old-a", parentUuid: "u1", type: "assistant", content: [{ type: "text", text: "Abandoned" }], messageId: "msg-old" }),
    claudeRow({ uuid: "old-u", parentUuid: "old-a", type: "user", content: "Old branch" }),
    claudeRow({ uuid: "thinking", parentUuid: "u1", type: "assistant", content: [{ type: "thinking", thinking: "private" }], messageId: "msg-one" }),
    claudeRow({ uuid: "a1", parentUuid: "thinking", type: "assistant", content: [{ type: "text", text: "Visible answer" }], messageId: "msg-one" }),
    claudeRow({ uuid: "a1-duplicate", parentUuid: "a1", type: "assistant", content: [{ type: "text", text: "Visible answer" }], messageId: "msg-one" }),
    claudeRow({ uuid: "tool", parentUuid: "a1-duplicate", type: "user", content: [{ type: "tool_result", content: "machine" }, { type: "text", text: "also hidden" }] }),
    claudeRow({ uuid: "u2", parentUuid: "tool", type: "user", content: [{ type: "text", text: "Continue" }, { type: "image", source: {} }] }),
    claudeRow({ uuid: "meta", parentUuid: "u2", type: "user", content: "Meta", meta: true }),
    claudeRow({ uuid: "notification", parentUuid: "meta", type: "user", content: "<task-notification>done</task-notification>" }),
    claudeRow({ uuid: "system", parentUuid: "notification", type: "user", content: "system prompt", extra: { promptSource: "system" } }),
    claudeRow({ uuid: "a2", parentUuid: "system", type: "assistant", content: [{ type: "text", text: "Done" }, { type: "tool_use", name: "Read" }], messageId: "msg-two" }),
  ]));

  const result = new LocalSessionTranscriptReader({ claudeHome: fixture.home }).read(claudeRootSession());
  assert.equal(result.transcript.state, "available");
  assert.equal(result.transcript.source, "claude-transcript");
  assert.deepEqual(
    result.items.flatMap((item) => (item.kind === "message" ? [{ id: item.id, role: item.role, text: item.text }] : [])),
    [
      { id: "claude:u1", role: "user", text: "Hello" },
      { id: "claude:msg-one", role: "assistant", text: "Visible answer" },
      { id: "claude:u2", role: "user", text: "Continue" },
      { id: "claude:msg-two", role: "assistant", text: "Done" },
    ],
  );
});

test("Claude resolves a nested individual subagent transcript and rejects parent hydration", () => {
  const fixture = claudeHome();
  const childId = "abc123";
  const project = join(fixture.projects, "-fixture-project");
  const subagents = join(project, CLAUDE_ID, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(project, `${CLAUDE_ID}.jsonl`), jsonl([
    claudeRow({ uuid: "parent", type: "user", content: "Parent message" }),
  ]));
  writeFileSync(join(subagents, `agent-${childId}.jsonl`), jsonl([
    claudeRow({ uuid: "child-u", type: "user", content: "Child task", agentId: childId, sidechain: true }),
    claudeRow({ uuid: "child-a", parentUuid: "child-u", type: "assistant", content: [{ type: "text", text: "Child result" }], messageId: "child-msg", agentId: childId, sidechain: true }),
  ]));

  const reader = new LocalSessionTranscriptReader({ claudeHome: fixture.home });
  const child = reader.read({
    provider: "claude",
    providerThreadId: childId,
    parentId: `local:claude:${CLAUDE_ID}`,
    providerTreeId: CLAUDE_ID,
  });
  assert.deepEqual(textsOf(child), ["Child task", "Child result"]);

  const parent = reader.read(claudeRootSession());
  assert.deepEqual(textsOf(parent), ["Parent message"]);
});

test("Claude exposes thinking blocks and paired tool_use/tool_result as transcript items", () => {
  const fixture = claudeHome();
  const project = join(fixture.projects, "-fixture-project");
  mkdirSync(project);
  writeFileSync(join(project, `${CLAUDE_ID}.jsonl`), jsonl([
    claudeRow({ uuid: "u1", type: "user", content: "Audit the reader" }),
    claudeRow({
      uuid: "a1",
      parentUuid: "u1",
      type: "assistant",
      messageId: "msg-one",
      content: [
        { type: "thinking", thinking: "Read the transcript reader first.", signature: "sig" },
        { type: "text", text: "Reading it now." },
        { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/repo/src/server/transcript.ts", limit: 200 } },
      ],
    }),
    claudeRow({
      uuid: "r1",
      parentUuid: "a1",
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", is_error: false, content: [{ type: "text", text: "export const TRANSCRIPT_LIMITS" }] }],
    }),
    claudeRow({
      uuid: "a2",
      parentUuid: "r1",
      type: "assistant",
      messageId: "msg-two",
      content: [
        { type: "tool_use", id: "toolu_02", name: "Bash", input: { command: "rg -n TRANSCRIPT_LIMITS" } },
      ],
    }),
    claudeRow({
      uuid: "r2",
      parentUuid: "a2",
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_02", is_error: true, content: "rg: command not found" }],
    }),
    claudeRow({ uuid: "a3", parentUuid: "r2", type: "assistant", messageId: "msg-three", content: [{ type: "text", text: "The limits are frozen." }] }),
  ]));

  const result = new LocalSessionTranscriptReader({ claudeHome: fixture.home }).read(claudeRootSession());
  assert.equal(result.transcript.state, "available");
  assert.deepEqual(result.items.map((item) => [item.kind, item.id]), [
    ["message", "claude:u1"],
    ["reasoning", "claude:msg-one:thinking:0"],
    ["message", "claude:msg-one"],
    ["tool", "claude:tool:toolu_01"],
    ["tool", "claude:tool:toolu_02"],
    ["message", "claude:msg-three"],
  ]);

  const reasoning = result.items[1];
  assert.equal(reasoning?.kind === "reasoning" ? reasoning.text : null, "Read the transcript reader first.");

  const tools = toolsOf(result);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.toolCallId, tool.status, tool.isError]), [
    ["Read", "toolu_01", "complete", false],
    ["Bash", "toolu_02", "complete", true],
  ]);
  assert.deepEqual(tools[0]?.arguments, { file_path: "/repo/src/server/transcript.ts", limit: 200 });
  assert.equal(tools[0]?.result, "export const TRANSCRIPT_LIMITS");
  assert.equal(tools[1]?.result, "rg: command not found");
});

test("an unanswered Claude tool call is only in flight while it is the newest record", () => {
  const fixture = claudeHome();
  const project = join(fixture.projects, "-fixture-project");
  mkdirSync(project);
  writeFileSync(join(project, `${CLAUDE_ID}.jsonl`), jsonl([
    claudeRow({ uuid: "u1", type: "user", content: "Go" }),
    claudeRow({ uuid: "a1", parentUuid: "u1", type: "assistant", messageId: "msg-one", content: [{ type: "tool_use", id: "toolu_abandoned", name: "Bash", input: { command: "sleep 1" } }] }),
    claudeRow({ uuid: "a2", parentUuid: "a1", type: "assistant", messageId: "msg-two", content: [{ type: "text", text: "Moving on." }] }),
    claudeRow({ uuid: "a3", parentUuid: "a2", type: "assistant", messageId: "msg-three", content: [{ type: "tool_use", id: "toolu_live", name: "Bash", input: { command: "pnpm test" } }] }),
  ]));

  const result = new LocalSessionTranscriptReader({ claudeHome: fixture.home }).read(claudeRootSession());
  assert.deepEqual(toolsOf(result).map((tool) => [tool.toolCallId, tool.status, tool.result]), [
    ["toolu_abandoned", "incomplete", null],
    ["toolu_live", "running", null],
  ]);
});

test("Codex exposes reasoning summaries and paired tool calls without leaking encrypted content", () => {
  const fixture = codexFixture([
    codexMeta(),
    codexMessage("user", "Look around"),
    {
      type: "response_item",
      timestamp: "2026-08-03T10:00:02Z",
      payload: { type: "reasoning", id: "rs_encrypted", summary: [], encrypted_content: "gAAAAABsecretblob" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-03T10:00:03Z",
      payload: { type: "reasoning", id: "rs_visible", summary: [{ type: "summary_text", text: "Listing the workspace." }], encrypted_content: "gAAAAABsecretblob" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-03T10:00:04Z",
      payload: { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_shell", name: "exec", input: "await tools.exec_command({ cmd: \"ls -la\" })" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-03T10:00:05Z",
      payload: { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_shell", output: [{ type: "input_text", text: "Script completed\n" }, { type: "input_text", text: "README.md\n" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-08-03T10:00:06Z",
      payload: { type: "function_call", id: "fc_1", name: "list_agents", namespace: "collaboration", arguments: "{\"scope\":\"root\"}", call_id: "call_fn" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-03T10:00:07Z",
      payload: { type: "function_call_output", call_id: "call_fn", output: "{\"agents\":[]}" },
    },
    codexMessage("assistant", "One repository, no agents."),
  ]);

  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());
  assert.deepEqual(result.items.map((item) => item.kind), [
    "message",
    "reasoning",
    "tool",
    "tool",
    "message",
  ]);
  assert.deepEqual(result.items.slice(1, 4).map((item) => item.id), [
    "codex:reasoning:rs_visible",
    "codex:tool:call_shell",
    "codex:tool:call_fn",
  ]);
  assert.equal(JSON.stringify(result).includes("gAAAAAB"), false);

  const reasoning = result.items[1];
  assert.equal(reasoning?.kind === "reasoning" ? reasoning.text : null, "Listing the workspace.");

  const tools = toolsOf(result);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.status, tool.isError]), [
    ["exec", "complete", false],
    ["list_agents", "complete", false],
  ]);
  assert.equal(tools[0]?.arguments, 'await tools.exec_command({ cmd: "ls -la" })');
  assert.equal(tools[0]?.result, "Script completed\nREADME.md\n");
  assert.deepEqual(tools[1]?.arguments, { scope: "root" });
  assert.equal(tools[1]?.result, '{"agents":[]}');
});

test("message count, per-message UTF-8, and aggregate byte caps retain the newest content", () => {
  const countValues: unknown[] = [codexMeta()];
  for (let index = 0; index < 125; index += 1) {
    countValues.push(codexMessage("assistant", `message-${String(index)}`, { id: `m-${String(index)}` }));
  }
  const countFixture = codexFixture(countValues);
  const countResult = new LocalSessionTranscriptReader({ codexHome: countFixture.home }).read(codexSession());
  assert.equal(countResult.items.length, TRANSCRIPT_LIMITS.messages);
  assert.equal(textsOf(countResult)[0], "message-5");
  assert.equal(textsOf(countResult).at(-1), "message-124");
  assert.equal(countResult.transcript.truncated, true);

  const longText = `${"x".repeat(TRANSCRIPT_LIMITS.messageBytes - 1)}🙂suffix`;
  const byteFixture = codexFixture([
    codexMeta(),
    ...Array.from({ length: 9 }, (_, index) =>
      codexMessage("assistant", String(index).repeat(60 * 1024), { id: `bulk-${String(index)}` })
    ),
    codexMessage("assistant", longText, { id: "long" }),
  ]);
  const byteResult = new LocalSessionTranscriptReader({ codexHome: byteFixture.home }).read(codexSession());
  assert.equal(byteResult.transcript.truncated, true);
  assert.ok(byteResult.items.length < 10);
  assert.ok(textsOf(byteResult).every((text) =>
    Buffer.byteLength(text, "utf8") <= TRANSCRIPT_LIMITS.messageBytes
  ));
  const cappedLong = byteResult.items.find((item) => item.id === "codex:long");
  const cappedLongText = cappedLong?.kind === "message" ? cappedLong.text : "";
  assert.equal(Buffer.byteLength(cappedLongText, "utf8"), TRANSCRIPT_LIMITS.messageBytes - 1);
  assert.equal(cappedLongText.endsWith("suffix"), false);
  assert.ok(textsOf(byteResult).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0) <= TRANSCRIPT_LIMITS.totalBytes);
  assert.ok(textsOf(byteResult).every((text) => !text.includes("�")));
});

test("physical source tail is bounded and discards a leading partial UTF-8 line safely", () => {
  const hugeIgnoredLine = JSON.stringify({
    type: "event_msg",
    payload: { type: "tool_output", value: "🙂".repeat(TRANSCRIPT_LIMITS.sourceBytes / 2 + 100) },
  });
  const fixture = codexFixture([], { trailingNewline: false });
  writeFileSync(
    fixture.file,
    `${hugeIgnoredLine}\n${JSON.stringify(codexMessage("assistant", "Newest 🙂", { id: "newest" }))}\n`,
  );
  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());
  assert.equal(result.transcript.truncated, true);
  assert.deepEqual(textsOf(result), ["Newest 🙂"]);
});

test("symlinks, rollout path escapes, ownership mismatch, and ambiguous Claude ids fail closed", () => {
  const symlinkRoot = temporaryRoot();
  const symlinkHome = join(symlinkRoot, ".codex");
  const sessions = join(symlinkHome, "sessions");
  mkdirSync(sessions, { recursive: true });
  const target = join(sessions, "target.jsonl");
  writeFileSync(target, jsonl([codexMeta()]));
  const linked = join(sessions, `rollout-${CODEX_ID}.jsonl`);
  symlinkSync(target, linked);
  const symlinkDb = new DatabaseSync(join(symlinkHome, "state_5.sqlite"));
  symlinkDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  symlinkDb.prepare("INSERT INTO threads VALUES (?, ?)").run(CODEX_ID, linked);
  symlinkDb.close();
  const symlinkResult = new LocalSessionTranscriptReader({ codexHome: symlinkHome }).read(codexSession());
  assert.equal(symlinkResult.transcript.reason, "unreadable");

  const escapeRoot = temporaryRoot();
  const escapeHome = join(escapeRoot, ".codex");
  mkdirSync(join(escapeHome, "sessions"), { recursive: true });
  const outside = join(escapeRoot, `rollout-${CODEX_ID}.jsonl`);
  writeFileSync(outside, jsonl([codexMeta()]));
  const escapeDb = new DatabaseSync(join(escapeHome, "state_5.sqlite"));
  escapeDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  escapeDb.prepare("INSERT INTO threads VALUES (?, ?)").run(CODEX_ID, outside);
  escapeDb.close();
  const escapeResult = new LocalSessionTranscriptReader({ codexHome: escapeHome }).read(codexSession());
  assert.equal(escapeResult.transcript.reason, "unreadable");

  const ownerFixture = codexFixture([codexMeta()]);
  const wrongUid = (process.getuid?.() ?? 0) + 1;
  const ownerResult = new LocalSessionTranscriptReader({ codexHome: ownerFixture.home, uid: wrongUid }).read(codexSession());
  assert.equal(ownerResult.transcript.reason, "unreadable");

  const claude = claudeHome();
  for (const projectName of ["one", "two"]) {
    const project = join(claude.projects, projectName);
    mkdirSync(project);
    writeFileSync(join(project, `${CLAUDE_ID}.jsonl`), jsonl([
      claudeRow({ uuid: projectName, type: "user", content: projectName }),
    ]));
  }
  const ambiguous = new LocalSessionTranscriptReader({ claudeHome: claude.home }).read(claudeRootSession());
  assert.equal(ambiguous.transcript.reason, "unsupported");
  assert.equal("path" in ambiguous.transcript, false);
  assert.equal("error" in ambiguous.transcript, false);
});
