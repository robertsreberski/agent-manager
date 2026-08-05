import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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

function insertArchived(database: DatabaseSync, id: string, title = id): void {
  database.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, cwd, title,
      source, thread_source, model, reasoning_effort, archived
    ) VALUES (?, '', 1700000000, 1700000000, '/workspace', ?,
      'cli', 'interactive', 'gpt-5.6', 'high', 1)
  `).run(id, title);
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

test("active identities are excluded before archive count and cursor pagination", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-active-"));
  const database = createDatabase(join(root, "state_1.sqlite"));
  try {
    for (let index = 0; index < 60; index += 1) {
      insertArchived(
        database,
        `archived-${String(index).padStart(2, "0")}`,
        index >= 58 ? "Collision result" : `Archived ${String(index)}`,
      );
    }
  } finally {
    database.close();
  }

  try {
    const catalog = new LocalCodexArchiveCatalog({ codexHome: root });
    const active = new Set([
      "local:codex:archived-59",
      "local:codex:archived-58",
      // Only local Codex manager identities participate in this boundary.
      "remote:codex:archived-57",
      "local:claude:archived-56",
      `local:codex:${"x".repeat(513)}`,
    ]);
    const first = catalog.list({
      query: "",
      cursor: null,
      limit: 50,
      excludeSessionIds: active,
    });
    assert.equal(first.total, 58);
    assert.equal(first.sessions.length, 50);
    assert.equal(first.sessions[0]?.providerThreadId, "archived-57");
    assert.equal(first.sessions.at(-1)?.providerThreadId, "archived-08");
    assert.ok(first.nextCursor);
    assert.ok(first.sessions.every((session) => !active.has(session.id)));

    const second = catalog.list({
      query: "",
      cursor: first.nextCursor,
      limit: 50,
      excludeSessionIds: active,
    });
    assert.equal(second.total, 58);
    assert.equal(second.sessions.length, 8);
    assert.equal(second.sessions.at(-1)?.providerThreadId, "archived-00");
    assert.equal(second.nextCursor, null);

    const searched = catalog.list({
      query: "Collision",
      cursor: null,
      limit: 50,
      excludeSessionIds: active,
    });
    assert.deepEqual(searched, { sessions: [], nextCursor: null, total: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct archive lookup fails closed on an active identity collision", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-direct-active-"));
  const database = createDatabase(join(root, "state_1.sqlite"));
  insertArchived(database, "collision", "Archived collision");
  database.close();
  let opened = false;

  try {
    const catalog = new LocalCodexArchiveCatalog({
      codexHome: root,
      beforeDatabaseOpen: () => { opened = true; },
    });
    assert.equal(
      catalog.get("local:codex:collision", new Set(["local:codex:collision"])),
      null,
    );
    assert.equal(opened, false, "an active collision is rejected before provider storage opens");
    assert.equal(catalog.get("local:codex:collision")?.name, "Archived collision");
    assert.equal(opened, true);
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

test("archived catalog rejects symlinked CODEX_HOME and sqlite roots", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-roots-"));
  const actualHome = join(root, "actual-home");
  mkdirSync(actualHome);
  const direct = createDatabase(join(actualHome, "state_1.sqlite"));
  insertArchived(direct, "direct");
  direct.close();
  const linkedHome = join(root, "linked-home");
  symlinkSync(actualHome, linkedHome);

  const sqliteHome = join(root, "sqlite-home");
  const actualSqlite = join(root, "actual-sqlite");
  mkdirSync(sqliteHome);
  mkdirSync(actualSqlite);
  const nested = createDatabase(join(actualSqlite, "state_2.sqlite"));
  insertArchived(nested, "nested");
  nested.close();
  symlinkSync(actualSqlite, join(sqliteHome, "sqlite"));

  try {
    for (const codexHome of [linkedHome, sqliteHome]) {
      const catalog = new LocalCodexArchiveCatalog({ codexHome });
      assert.deepEqual(catalog.list({ query: "", cursor: null, limit: 50 }), {
        sessions: [],
        nextCursor: null,
        total: 0,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archived catalog rejects roots and databases not owned by the effective uid seam", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-owner-"));
  const database = createDatabase(join(root, "state_1.sqlite"));
  insertArchived(database, "owned-by-real-user");
  database.close();
  try {
    const catalog = new LocalCodexArchiveCatalog({
      codexHome: root,
      uid: (process.getuid?.() ?? 0) + 1,
    });
    assert.equal(catalog.list({ query: "", cursor: null, limit: 50 }).total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("newer partial state does not mask the next valid database", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-fallback-"));
  const partial = new DatabaseSync(join(root, "state_100.sqlite"));
  partial.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL)");
  partial.close();
  const valid = createDatabase(join(root, "state_99.sqlite"));
  insertArchived(valid, "valid-older", "Valid older state");
  valid.close();
  try {
    const catalog = new LocalCodexArchiveCatalog({ codexHome: root });
    const page = catalog.list({ query: "", cursor: null, limit: 50 });
    assert.equal(page.total, 1);
    assert.equal(page.sessions[0]?.providerThreadId, "valid-older");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database replacement between validation and open is rejected before querying", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-archive-race-"));
  const newestPath = join(root, "state_2.sqlite");
  const newest = createDatabase(newestPath);
  insertArchived(newest, "trusted-newest");
  newest.close();
  const fallback = createDatabase(join(root, "state_1.sqlite"));
  insertArchived(fallback, "trusted-fallback");
  fallback.close();
  let replaced = false;
  try {
    const catalog = new LocalCodexArchiveCatalog({
      codexHome: root,
      beforeDatabaseOpen: (path) => {
        if (replaced || !path.endsWith("state_2.sqlite")) return;
        replaced = true;
        renameSync(newestPath, `${newestPath}.validated`);
        const replacement = createDatabase(newestPath);
        insertArchived(replacement, "untrusted-replacement");
        replacement.close();
      },
    });
    const page = catalog.list({ query: "", cursor: null, limit: 50 });
    assert.equal(replaced, true);
    assert.equal(page.total, 1);
    assert.equal(page.sessions[0]?.providerThreadId, "trusted-fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
