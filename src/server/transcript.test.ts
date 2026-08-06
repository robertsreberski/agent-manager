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
import { ActivityHub } from "../activity/hub.ts";
import type { SessionView } from "../core/types.ts";
import { projectCodexNotification } from "../providers/codex/activity-projector.ts";
import { codexMessageCorrelationId } from "../providers/codex/activity-projector.ts";
import { SelectedTranscriptActivityObserver } from "./activity-observer.ts";
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
  assert.equal(result.items[0]?.correlationId, "message:user-provider-id");
});

test("Codex transcript separates a trailing memory citation from visible assistant text", () => {
  const fixture = codexFixture([
    codexMeta(),
    codexMessage("assistant", `Remembered answer.
<oai-mem-citation>
<citation_entries>
MEMORY.md:10-12|note=[workspace decision]
</citation_entries>
<rollout_ids>
019fcbd5-7a38-7c31-a5f7-e199f5b06f4e
</rollout_ids>
</oai-mem-citation>`, { id: "cited-message" }),
  ]);
  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());
  const message = result.items[0];
  assert.equal(message?.kind, "message");
  if (message?.kind !== "message") return;
  assert.equal(message.text, "Remembered answer.");
  assert.deepEqual(message.memoryCitation, {
    entries: [{ path: "MEMORY.md", lineStart: 10, lineEnd: 12, note: "workspace decision" }],
    rolloutIds: ["019fcbd5-7a38-7c31-a5f7-e199f5b06f4e"],
  });
});

test("Codex derives the same turn-scoped message identity as the App Server without merging repeated prompts", () => {
  const firstTurn = "turn-11111111-1111-4111-8111-111111111111";
  const secondTurn = "turn-22222222-2222-4222-8222-222222222222";
  const fixture = codexFixture([
    codexMeta(),
    {
      type: "event_msg",
      timestamp: "2026-08-03T10:00:00Z",
      payload: { type: "task_started", turn_id: firstTurn },
    },
    codexMessage("user", "<environment_context><cwd>/fixture</cwd></environment_context>"),
    {
      type: "turn_context",
      timestamp: "2026-08-03T10:00:01Z",
      payload: { turn_id: firstTurn, cwd: "/fixture" },
    },
    codexMessage("user", "Repeat this prompt"),
    codexMessage("assistant", "First progress", {
      id: "msg-commentary-first",
      phase: "commentary",
    }),
    codexMessage("assistant", "First final", {
      id: "msg-final-first",
      phase: "final_answer",
    }),
    {
      type: "event_msg",
      timestamp: "2026-08-03T10:00:04Z",
      payload: { type: "task_complete", turn_id: firstTurn },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-03T10:01:00Z",
      payload: { type: "task_started", turn_id: secondTurn },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-03T10:01:01Z",
      payload: { turn_id: secondTurn, cwd: "/fixture" },
    },
    codexMessage("user", "Repeat this prompt"),
    // Older rollouts did not always persist phase. task_complete still gives
    // the bounded reader an exact, safe final-message boundary.
    codexMessage("assistant", "Second final", { id: "msg-final-second" }),
    {
      type: "event_msg",
      timestamp: "2026-08-03T10:01:04Z",
      payload: { type: "task_complete", turn_id: secondTurn },
    },
  ]);

  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home })
    .read(codexSession());
  const messages = result.items.filter((item) => item.kind === "message");
  const firstUser = messages.find((item) => item.role === "user");
  const secondUser = messages.filter((item) => item.role === "user")[1];
  const commentary = messages.find((item) => item.text === "First progress");
  const firstFinal = messages.find((item) => item.text === "First final");
  const secondFinal = messages.find((item) => item.text === "Second final");
  assert.ok(firstUser && secondUser && commentary && firstFinal && secondFinal);

  /*
    The transcript reader and the App Server projector reconstruct the same
    conversation from different sources, so they must agree on message
    identity — that agreement is what lets an exact live item replace its
    inferred transcript twin instead of doubling it.
  */
  const exact = (
    role: "user" | "assistant",
    turnId: string,
    message: string,
  ): string => codexMessageCorrelationId(CODEX_ID, turnId, role, message);

  assert.equal(
    firstUser.correlationId,
    exact("user", firstTurn, "Repeat this prompt"),
  );
  assert.equal(
    firstFinal.correlationId,
    exact("assistant", firstTurn, "First final"),
  );
  assert.equal(
    secondFinal.correlationId,
    exact("assistant", secondTurn, "Second final"),
  );
  assert.notEqual(
    firstUser.correlationId,
    secondUser.correlationId,
    "the turn identity keeps identical prompts in separate turns distinct",
  );
  assert.equal(
    commentary.correlationId,
    "message:msg-commentary-first",
    "uncovered commentary retains the exact rollout/App Server item identity",
  );
});

test("Codex retains and reconciles identical same-turn message occurrences end to end", () => {
  const turnId = "turn-identical-occurrences";
  const fixture = codexFixture([
    codexMeta(),
    {
      type: "event_msg",
      timestamp: "2026-08-03T10:00:00Z",
      payload: { type: "task_started", turn_id: turnId },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-03T10:00:01Z",
      payload: { turn_id: turnId, cwd: "/fixture" },
    },
    codexMessage("user", "Repeat exactly", { id: "user-occurrence-1" }),
    codexMessage("user", "Repeat exactly", { id: "user-occurrence-2" }),
  ]);
  const reader = new LocalSessionTranscriptReader({ codexHome: fixture.home });
  const read = reader.read(codexSession());
  const transcriptMessages = read.items.filter((item) => item.kind === "message");
  assert.deepEqual(
    transcriptMessages.map((item) => item.id),
    ["codex:user-occurrence-1", "codex:user-occurrence-2"],
  );
  assert.equal(transcriptMessages[0]?.correlationId, transcriptMessages[1]?.correlationId);

  const managerSessionId = `local:codex:${CODEX_ID}`;
  const hub = new ActivityHub({ streamEpoch: "identical-occurrences" });
  for (const itemId of ["user-occurrence-1", "user-occurrence-2"] as const) {
    const projection = projectCodexNotification({
      method: "item/completed",
      emittedAtMs: Date.parse("2026-08-03T10:00:02.000Z"),
      params: {
        threadId: CODEX_ID,
        turnId,
        item: {
          type: "userMessage",
          id: itemId,
          content: [{ type: "text", text: "Repeat exactly" }],
        },
      },
    });
    assert.ok(projection);
    for (const mutation of projection.mutations) {
      hub.ingest(managerSessionId, "codex", mutation);
    }
  }
  assert.equal(hub.snapshot(managerSessionId)?.items.length, 2);

  const session = {
    id: managerSessionId,
    provider: "codex",
    providerThreadId: CODEX_ID,
    providerTreeId: CODEX_ID,
    parentId: null,
    status: "running",
  } as SessionView;
  const observer = new SelectedTranscriptActivityObserver({ hub, reader });
  observer.seedOnce(session);
  assert.deepEqual(
    hub.snapshot(managerSessionId)?.items.map((item) => item.id),
    [
      `codex/item/${CODEX_ID}/${turnId}/user-occurrence-1`,
      `codex/item/${CODEX_ID}/${turnId}/user-occurrence-2`,
    ],
  );
  const hydratedSeq = hub.snapshot(managerSessionId)!.seq;
  observer.seedOnce(session);
  assert.equal(hub.snapshot(managerSessionId)!.seq, hydratedSeq);
  observer.dispose();
});

test("Codex reads archived transcripts only from the equally validated archive root", () => {
  const root = temporaryRoot();
  const home = join(root, ".codex");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const archived = join(home, "archived_sessions", "2026", "08", "03");
  mkdirSync(archived, { recursive: true });
  const file = join(archived, `rollout-archived-${CODEX_ID}.jsonl`);
  writeFileSync(file, jsonl([codexMeta(), codexMessage("assistant", "Archived history", { id: "archived-message" })]));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  database.prepare("INSERT INTO threads VALUES (?, ?)").run(CODEX_ID, file);
  database.close();

  const result = new LocalSessionTranscriptReader({ codexHome: home }).read(codexSession());
  assert.equal(result.transcript.state, "available");
  assert.deepEqual(messagesOf(result), [{ role: "assistant", text: "Archived history" }]);

  const symlinkRoot = temporaryRoot();
  const symlinkHome = join(symlinkRoot, ".codex");
  mkdirSync(join(symlinkHome, "sessions"), { recursive: true });
  const symlinkArchive = join(symlinkHome, "archived_sessions");
  mkdirSync(symlinkArchive, { recursive: true });
  const target = join(symlinkArchive, "target.jsonl");
  writeFileSync(target, jsonl([codexMeta()]));
  const linked = join(symlinkArchive, `rollout-${CODEX_ID}.jsonl`);
  symlinkSync(target, linked);
  const symlinkDb = new DatabaseSync(join(symlinkHome, "state_5.sqlite"));
  symlinkDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  symlinkDb.prepare("INSERT INTO threads VALUES (?, ?)").run(CODEX_ID, linked);
  symlinkDb.close();

  const rejected = new LocalSessionTranscriptReader({ codexHome: symlinkHome }).read(codexSession());
  assert.equal(rejected.transcript.reason, "unreadable");
});

test("Codex rejects symlinked CODEX_HOME, sessions, and archived_sessions roots", () => {
  const linkedHomeRoot = temporaryRoot();
  const actualHome = join(linkedHomeRoot, "actual-codex");
  const actualSessions = join(actualHome, "sessions");
  mkdirSync(actualSessions, { recursive: true });
  const actualFile = join(actualSessions, `rollout-${CODEX_ID}.jsonl`);
  writeFileSync(actualFile, jsonl([codexMeta()]));
  const actualDatabase = new DatabaseSync(join(actualHome, "state_1.sqlite"));
  actualDatabase.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  actualDatabase.prepare("INSERT INTO threads VALUES (?, ?)").run(CODEX_ID, actualFile);
  actualDatabase.close();
  const linkedHome = join(linkedHomeRoot, "linked-codex");
  symlinkSync(actualHome, linkedHome);
  assert.equal(
    new LocalSessionTranscriptReader({ codexHome: linkedHome }).read(codexSession()).transcript.reason,
    "unreadable",
  );

  for (const rootName of ["sessions", "archived_sessions"] as const) {
    const root = temporaryRoot();
    const home = join(root, ".codex");
    mkdirSync(home);
    const externalRoot = join(root, `actual-${rootName}`);
    mkdirSync(externalRoot);
    const file = join(externalRoot, `rollout-${CODEX_ID}.jsonl`);
    writeFileSync(file, jsonl([codexMeta()]));
    symlinkSync(externalRoot, join(home, rootName));
    const database = new DatabaseSync(join(home, "state_1.sqlite"));
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(CODEX_ID, file);
    database.close();
    assert.equal(
      new LocalSessionTranscriptReader({ codexHome: home }).read(codexSession()).transcript.reason,
      "unreadable",
    );
  }
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
      forked: false,
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
  // `u1` has two identity-matching children here, which is structurally a fork:
  // the abandoned branch is real history this chain does not show.
  assert.equal(result.transcript.forked, true);
  assert.deepEqual(
    result.items.flatMap((item) => (item.kind === "message" ? [{ id: item.id, role: item.role, text: item.text }] : [])),
    [
      { id: "claude:u1", role: "user", text: "Hello" },
      { id: "claude:a1:text:0", role: "assistant", text: "Visible answer" },
      { id: "claude:u2", role: "user", text: "Continue" },
      { id: "claude:a2:text:0", role: "assistant", text: "Done" },
    ],
  );
});

test("a linear Claude transcript reports no fork", () => {
  const fixture = claudeHome();
  const project = join(fixture.projects, "-fixture-project");
  mkdirSync(project);
  writeFileSync(join(project, `${CLAUDE_ID}.jsonl`), jsonl([
    claudeRow({ uuid: "u1", type: "user", content: "Hello" }),
    claudeRow({ uuid: "a1", parentUuid: "u1", type: "assistant", content: [{ type: "text", text: "Answer" }], messageId: "msg-one" }),
  ]));

  const result = new LocalSessionTranscriptReader({ claudeHome: fixture.home }).read(claudeRootSession());
  assert.equal(result.transcript.forked, false);
});

test("two writers answering one message fork, and the newest branch is shown", () => {
  /*
    The shape a joined session produces when both surfaces send at once: two user
    messages parent onto the same assistant reply, which is the well-formed
    two-branch DAG `--fork-session` already produces. The reader walks one
    root-to-latest path, so append order decides which branch is rendered — and
    that flip is exactly what the fork flag exists to explain.
  */
  const rows = (webFirst: boolean) => {
    const terminal = [
      claudeRow({ uuid: "t-user", parentUuid: "a1", type: "user", content: "From the terminal" }),
      claudeRow({ uuid: "t-reply", parentUuid: "t-user", type: "assistant", content: [{ type: "text", text: "Terminal answer" }], messageId: "msg-terminal" }),
    ];
    const web = [
      claudeRow({ uuid: "w-user", parentUuid: "a1", type: "user", content: "From the web" }),
      claudeRow({ uuid: "w-reply", parentUuid: "w-user", type: "assistant", content: [{ type: "text", text: "Web answer" }], messageId: "msg-web" }),
    ];
    return [
      claudeRow({ uuid: "u1", type: "user", content: "Shared start" }),
      claudeRow({ uuid: "a1", parentUuid: "u1", type: "assistant", content: [{ type: "text", text: "Shared reply" }], messageId: "msg-shared" }),
      ...(webFirst ? [...web, ...terminal] : [...terminal, ...web]),
    ];
  };

  for (const webFirst of [true, false]) {
    const fixture = claudeHome();
    const project = join(fixture.projects, "-fixture-project");
    mkdirSync(project);
    writeFileSync(join(project, `${CLAUDE_ID}.jsonl`), jsonl(rows(webFirst)));

    const result = new LocalSessionTranscriptReader({ claudeHome: fixture.home }).read(claudeRootSession());
    assert.equal(result.transcript.forked, true, `fork must be reported (webFirst=${String(webFirst)})`);
    const texts = result.items.flatMap((item) => (item.kind === "message" ? [item.text] : []));
    // Whichever branch was written last is the one rendered; the other is absent.
    assert.deepEqual(
      texts,
      webFirst
        ? ["Shared start", "Shared reply", "From the terminal", "Terminal answer"]
        : ["Shared start", "Shared reply", "From the web", "Web answer"],
      `the last-written branch must win (webFirst=${String(webFirst)})`,
    );
  }
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
    ["reasoning", "claude:a1:thinking:0"],
    ["message", "claude:a1:text:1"],
    ["tool", "claude:tool:toolu_01"],
    ["tool", "claude:tool:toolu_02"],
    ["message", "claude:a3:text:0"],
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
  assert.equal(textsOf(countResult)[0], "message-0");
  assert.ok(textsOf(countResult).includes("message-15"));
  assert.equal(textsOf(countResult).includes("message-16"), false);
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

test("tool-heavy history reserves opening messages while retaining newest activity", () => {
  const values: unknown[] = [
    codexMeta(),
    codexMessage("user", "Opening prompt"),
    codexMessage("assistant", "Opening answer", { id: "opening-answer" }),
  ];
  for (let index = 0; index < 150; index += 1) {
    values.push({
      type: "response_item",
      timestamp: "2026-08-03T10:00:02Z",
      payload: {
        type: "reasoning",
        id: `reasoning-${String(index)}`,
        summary: [{ type: "summary_text", text: `reasoning-${String(index)}` }],
      },
    });
  }
  values.push(
    codexMessage("user", "Newest prompt"),
    codexMessage("assistant", "Newest answer", { id: "newest-answer" }),
  );
  const fixture = codexFixture(values);
  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());

  assert.equal(result.items.length, TRANSCRIPT_LIMITS.messages);
  assert.deepEqual(messagesOf(result), [
    { role: "user", text: "Opening prompt" },
    { role: "assistant", text: "Opening answer" },
    { role: "user", text: "Newest prompt" },
    { role: "assistant", text: "Newest answer" },
  ]);
  assert.equal(result.items.at(-1)?.id, "codex:newest-answer");
  assert.equal(result.transcript.truncated, true);
});

test("large Codex rollouts read bounded head and tail windows without joining turns across the gap", () => {
  const firstTurn = "turn-first";
  const latestTurn = "turn-latest";
  const fixture = codexFixture([], { trailingNewline: false });
  const opening = [
    codexMeta(),
    {
      type: "event_msg",
      payload: { type: "task_started", turn_id: firstTurn },
    },
    codexMessage("user", "Opening prompt"),
    codexMessage("assistant", "Opening answer", {
      id: "opening-final",
      phase: "final_answer",
    }),
    {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: firstTurn },
    },
  ].map((value) => JSON.stringify(value)).join("\n");
  const skippedMiddle = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "provider_internal",
      bytes: "x".repeat(TRANSCRIPT_LIMITS.sourceBytes + 128 * 1024),
    },
  });
  const newest = [
    {
      type: "event_msg",
      payload: { type: "task_started", turn_id: latestTurn },
    },
    codexMessage("user", "Newest prompt"),
    codexMessage("assistant", "Newest answer", {
      id: "newest-final",
      phase: "final_answer",
    }),
    {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: latestTurn },
    },
  ].map((value) => JSON.stringify(value)).join("\n");
  writeFileSync(fixture.file, `${opening}\n${skippedMiddle}\n${newest}\n`);

  const result = new LocalSessionTranscriptReader({ codexHome: fixture.home }).read(codexSession());
  const messages = result.items.filter((item) => item.kind === "message");
  assert.deepEqual(messages.map((item) => item.text), [
    "Opening prompt",
    "Opening answer",
    "Newest prompt",
    "Newest answer",
  ]);
  assert.equal(result.transcript.truncated, true);
  assert.match(messages[0]?.correlationId ?? "", new RegExp(`/${firstTurn}/user/`, "u"));
  assert.match(messages[2]?.correlationId ?? "", new RegExp(`/${latestTurn}/user/`, "u"));
});

test("large Claude transcripts retain independent opening and newest chains across a skipped middle", () => {
  const fixture = claudeHome();
  const project = join(fixture.projects, "-fixture-project");
  mkdirSync(project);
  const file = join(project, `${CLAUDE_ID}.jsonl`);
  const opening = [
    claudeRow({ uuid: "opening-u", type: "user", content: "Opening prompt" }),
    claudeRow({
      uuid: "opening-a",
      parentUuid: "opening-u",
      type: "assistant",
      content: [
        { type: "text", text: "Opening answer" },
        { type: "tool_use", id: "head-tool", name: "Read", input: { file: "old" } },
      ],
      messageId: "opening-answer",
    }),
  ];
  const skippedMiddle = claudeRow({
    uuid: "middle-parent",
    parentUuid: "opening-a",
    type: "user",
    content: "x".repeat(TRANSCRIPT_LIMITS.sourceBytes + 128 * 1024),
    meta: true,
  });
  const newest = [
    claudeRow({
      uuid: "tail-result",
      parentUuid: "middle-parent",
      type: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "head-tool",
        content: "must not bridge the unread gap",
      }],
    }),
    claudeRow({
      uuid: "newest-u",
      parentUuid: "tail-result",
      type: "user",
      content: "Newest prompt",
    }),
    claudeRow({
      uuid: "newest-a",
      parentUuid: "newest-u",
      type: "assistant",
      content: [{ type: "text", text: "Newest answer" }],
      messageId: "newest-answer",
    }),
  ];
  writeFileSync(file, jsonl([...opening, skippedMiddle, ...newest]));

  const result = new LocalSessionTranscriptReader({ claudeHome: fixture.home })
    .read(claudeRootSession());

  assert.deepEqual(messagesOf(result), [
    { role: "user", text: "Opening prompt" },
    { role: "assistant", text: "Opening answer" },
    { role: "user", text: "Newest prompt" },
    { role: "assistant", text: "Newest answer" },
  ]);
  assert.equal(result.transcript.truncated, true);
  assert.equal(new Set(result.items.map((item) => item.id)).size, result.items.length);
  assert.deepEqual(
    toolsOf(result).map((item) => ({ id: item.id, result: item.result, status: item.status })),
    [{ id: "claude:tool:head-tool", result: null, status: "incomplete" }],
  );
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

test("a repeated Codex read reuses its resolved rollout instead of re-opening the state database", () => {
  const fixture = codexFixture([codexMeta(), codexMessage("assistant", "First")]);
  const reader = new LocalSessionTranscriptReader({ codexHome: fixture.home });
  assert.equal(reader.read(codexSession()).transcript.state, "available");

  /*
    Removing the state database proves the second read never consulted it. The
    selected session is polled on a sub-second cadence, so resolving through a
    fresh DatabaseSync every tick was the dominant cost of an idle drawer.
  */
  rmSync(join(fixture.home, "state_5.sqlite"), { force: true });
  const second = reader.read(codexSession());
  assert.equal(second.transcript.state, "available");
  assert.equal(second.items.filter((item) => item.kind === "message").length, 1);
});

test("a rolled-away Codex rollout re-resolves rather than failing the read", () => {
  const fixture = codexFixture([codexMeta(), codexMessage("assistant", "First")]);
  const reader = new LocalSessionTranscriptReader({ codexHome: fixture.home });
  assert.equal(reader.read(codexSession()).transcript.state, "available");

  // Same session, same identity, new path: the remembered hint is now wrong.
  const moved = join(fixture.home, "sessions", "2026", "08", "04");
  mkdirSync(moved, { recursive: true });
  const movedFile = join(moved, `rollout-2026-08-04T12-00-00-${fixture.sessionId}.jsonl`);
  writeFileSync(movedFile, jsonl([codexMeta(), codexMessage("assistant", "Moved")], true));
  rmSync(fixture.file, { force: true });
  const database = new DatabaseSync(join(fixture.home, "state_5.sqlite"));
  database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(movedFile, fixture.sessionId);
  database.close();

  const second = reader.read(codexSession());
  assert.equal(second.transcript.state, "available");
  const messages = second.items.filter((item) => item.kind === "message");
  assert.equal(messages.length, 1);
  assert.match(JSON.stringify(messages[0]), /Moved/u);
});
