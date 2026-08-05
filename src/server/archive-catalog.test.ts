import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LocalCodexArchiveCatalog } from "./archive-catalog.ts";

function createDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cwd TEXT,
      title TEXT,
      source TEXT,
      thread_source TEXT,
      model TEXT,
      reasoning_effort TEXT,
      archived INTEGER NOT NULL
    )
  `);
  return database;
}

test("archived Codex catalog is separate, searchable, and cursor-paginated at 50", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-"));
  const sqlite = join(root, "sqlite");
  mkdirSync(sqlite);
  const database = createDatabase(join(sqlite, "state_99.sqlite"));
  try {
    const insert = database.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, cwd, title,
        source, thread_source, model, reasoning_effort, archived
      ) VALUES (?, '', ?, ?, ?, ?, 'cli', 'interactive', 'gpt-5.6', 'high', ?)
    `);
    for (let index = 0; index < 60; index += 1) {
      insert.run(
        `archived-${String(index).padStart(2, "0")}`,
        1_600_000_000 + index,
        1_600_000_000 + index,
        index === 7 ? "/workspace/literal%folder" : `/workspace/repo-${index % 3}`,
        index === 12 ? "Needle title" : `Archived ${index}`,
        1,
      );
    }
    insert.run("active-thread", 1_700_000_000, 1_700_000_000, "/workspace/active", "Active", 0);
  } finally {
    database.close();
  }

  try {
    const catalog = new LocalCodexArchiveCatalog({
      codexHome: root,
      now: () => Date.parse("2026-08-05T12:00:00.000Z"),
    });
    const first = catalog.list({ query: "", cursor: null, limit: 500 });
    assert.equal(first.sessions.length, 50);
    assert.equal(first.total, 60);
    assert.ok(first.nextCursor);
    assert.equal(first.sessions[0]?.providerThreadId, "archived-59");
    assert.equal(first.sessions[0]?.archived, true);
    assert.deepEqual(first.sessions[0]?.control.capabilities, []);
    const second = catalog.list({ query: "", cursor: first.nextCursor, limit: 50 });
    assert.equal(second.sessions.length, 10);
    assert.equal(second.nextCursor, null);
    assert.equal(second.sessions.at(-1)?.providerThreadId, "archived-00");

    assert.equal(catalog.list({ query: "Needle", cursor: null, limit: 50 }).sessions[0]?.name, "Needle title");
    assert.equal(catalog.list({ query: "local:codex:archived-12", cursor: null, limit: 50 }).sessions[0]?.providerThreadId, "archived-12");
    assert.equal(catalog.list({ query: "literal%folder", cursor: null, limit: 50 }).sessions[0]?.providerThreadId, "archived-07");
    assert.equal(catalog.list({ query: "literal_folder", cursor: null, limit: 50 }).total, 0);
    assert.equal(catalog.get("local:codex:archived-12")?.name, "Needle title");
    assert.equal(catalog.get("local:codex:active-thread"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archived catalog refuses a symlinked provider database", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-link-"));
  const sqlite = join(root, "sqlite");
  mkdirSync(sqlite);
  const actual = join(root, "actual.sqlite");
  createDatabase(actual).close();
  symlinkSync(actual, join(sqlite, "state_1.sqlite"));
  try {
    const catalog = new LocalCodexArchiveCatalog({ codexHome: root });
    assert.deepEqual(catalog.list({ query: "", cursor: null, limit: 50 }), {
      sessions: [],
      nextCursor: null,
      total: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
