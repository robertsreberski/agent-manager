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
} from "./transcript.ts";

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
    sessionId,
    parentSessionId: null,
    rootSessionId: sessionId,
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
    sessionId,
    parentSessionId: null,
    rootSessionId: sessionId,
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
  assert.equal(result.transcript.messageCount, 2);
  assert.equal(result.transcript.truncated, false);
  assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Hello" },
    { role: "assistant", text: "Hi there" },
  ]);
  assert.equal(result.messages[0]?.id, "codex:user-provider-id");
  assert.match(result.messages[1]?.id ?? "", /^codex:file:\d+:\d+:\d+$/);
  assert.equal(result.messages[0]?.createdAt, "2026-08-03T10:00:01.000Z");
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
  assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "The actual prompt" },
    { role: "user", text: "What does <environment_context> mean in this protocol?" },
    { role: "assistant", text: "Answer" },
  ]);
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
  assert.deepEqual(result.messages.map((message) => message.text), ["complete"]);
});

test("Codex verifies the selected UUID against session metadata", () => {
  const fixture = codexFixture([codexMeta("99999999-9999-9999-9999-999999999999")]);
  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());
  assert.deepEqual(result, {
    messages: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      messageCount: 0,
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
  assert.deepEqual(result.messages.map(({ id, role, text }) => ({ id, role, text })), [
    { id: "claude:u1", role: "user", text: "Hello" },
    { id: "claude:msg-one", role: "assistant", text: "Visible answer" },
    { id: "claude:u2", role: "user", text: "Continue" },
    { id: "claude:msg-two", role: "assistant", text: "Done" },
  ]);
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
    sessionId: childId,
    parentSessionId: CLAUDE_ID,
    rootSessionId: CLAUDE_ID,
  });
  assert.deepEqual(child.messages.map((message) => message.text), ["Child task", "Child result"]);

  const parent = reader.read(claudeRootSession());
  assert.deepEqual(parent.messages.map((message) => message.text), ["Parent message"]);
});

test("Claude resolves the legacy project-root individual agent file but never a workflow journal", () => {
  const fixture = claudeHome();
  const childId = "legacy123";
  const project = join(fixture.projects, "-fixture-project");
  mkdirSync(join(project, CLAUDE_ID, "subagents", "workflows", "wf"), { recursive: true });
  writeFileSync(join(project, `agent-${childId}.jsonl`), jsonl([
    claudeRow({ uuid: "legacy", type: "assistant", content: [{ type: "text", text: "Legacy child" }], messageId: "legacy-msg", agentId: childId, sidechain: true }),
  ]));
  writeFileSync(join(project, CLAUDE_ID, "subagents", "workflows", "wf", "journal.jsonl"), jsonl([
    claudeRow({ uuid: "journal-one", type: "assistant", content: [{ type: "text", text: "Journal one" }], messageId: "journal-one", agentId: "missing", sidechain: true }),
    claudeRow({ uuid: "journal-two", parentUuid: "journal-one", type: "assistant", content: [{ type: "text", text: "Journal two" }], messageId: "journal-two", agentId: "other", sidechain: true }),
  ]));

  const reader = new LocalSessionTranscriptReader({ claudeHome: fixture.home });
  const child = reader.read({
    provider: "claude",
    sessionId: childId,
    parentSessionId: CLAUDE_ID,
    rootSessionId: CLAUDE_ID,
  });
  assert.deepEqual(child.messages.map((message) => message.text), ["Legacy child"]);
  const journalOnly = reader.read({
    provider: "claude",
    sessionId: "missing",
    parentSessionId: CLAUDE_ID,
    rootSessionId: CLAUDE_ID,
  });
  assert.equal(journalOnly.transcript.state, "unavailable");
  assert.equal(journalOnly.transcript.reason, "not-found");
});

test("message count, per-message UTF-8, and aggregate byte caps retain the newest content", () => {
  const countValues: unknown[] = [codexMeta()];
  for (let index = 0; index < 125; index += 1) {
    countValues.push(codexMessage("assistant", `message-${String(index)}`, { id: `m-${String(index)}` }));
  }
  const countFixture = codexFixture(countValues);
  const countResult = new LocalSessionTranscriptReader({ codexHome: countFixture.home }).read(codexSession());
  assert.equal(countResult.messages.length, TRANSCRIPT_LIMITS.messages);
  assert.equal(countResult.messages[0]?.text, "message-5");
  assert.equal(countResult.messages.at(-1)?.text, "message-124");
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
  assert.ok(byteResult.messages.length < 10);
  assert.ok(byteResult.messages.every((message) =>
    Buffer.byteLength(message.text, "utf8") <= TRANSCRIPT_LIMITS.messageBytes
  ));
  const cappedLong = byteResult.messages.find((message) => message.id === "codex:long");
  assert.equal(Buffer.byteLength(cappedLong?.text ?? "", "utf8"), TRANSCRIPT_LIMITS.messageBytes - 1);
  assert.equal(cappedLong?.text.endsWith("suffix"), false);
  assert.ok(byteResult.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text, "utf8"), 0) <= TRANSCRIPT_LIMITS.totalBytes);
  assert.ok(byteResult.messages.every((message) => !message.text.includes("�")));
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
  assert.deepEqual(result.messages.map((message) => message.text), ["Newest 🙂"]);
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
