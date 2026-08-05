import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  providerEffort,
  unknownEffort,
  unknownModel,
  unknownProfile,
  type SessionRecord,
} from "../core/types.ts";
import { baseRecord, iso, normalizedText } from "../discovery/observe-values.ts";
import { sessionRecordId } from "../shared/session.ts";

export interface ArchivedSessionPage {
  sessions: SessionRecord[];
  nextCursor: string | null;
  total: number;
}

export interface ArchivedSessionCatalog {
  list(input: { query: string; cursor: string | null; limit: number }): ArchivedSessionPage;
  get(managerSessionId: string): SessionRecord | null;
}

interface ArchiveCursor {
  updatedAtMs: number;
  id: string;
}

interface ArchiveRow {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  cwd: string;
  title: string | null;
  source: string | null;
  threadSource: string | null;
  model: string | null;
  effort: string | null;
}

const MAX_PAGE_SIZE = 50;

function sqliteColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
}

function encodeCursor(row: ArchiveRow): string {
  return Buffer.from(JSON.stringify([row.updatedAtMs, row.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): ArchiveCursor | null {
  if (value === null) return null;
  if (value.length === 0 || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Archived-session cursor is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Archived-session cursor is invalid");
  }
  if (
    !Array.isArray(decoded)
    || decoded.length !== 2
    || typeof decoded[0] !== "number"
    || !Number.isFinite(decoded[0])
    || decoded[0] < 0
    || typeof decoded[1] !== "string"
    || decoded[1].length === 0
    || decoded[1].length > 512
  ) throw new Error("Archived-session cursor is invalid");
  return { updatedAtMs: decoded[0], id: decoded[1] };
}

function literalLike(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function rowToSession(row: ArchiveRow, now: number): SessionRecord {
  return {
    ...baseRecord("codex", row.id, now),
    archived: true,
    name: row.title,
    cwd: row.cwd || null,
    kind: row.threadSource === "subagent" ? "subagent"
      : /exec|batch/iu.test(row.threadSource ?? row.source ?? "") ? "batch" : "interactive",
    status: "completed",
    providerStatus: "archived",
    startedAt: iso(row.createdAtMs, now),
    updatedAt: iso(row.updatedAtMs, now),
    statusSource: "provider-cli",
    source: row.threadSource ?? row.source,
    model: row.model ? {
      value: row.model,
      providerValue: row.model,
      source: "provider-cli",
      confidence: "exact",
    } : unknownModel(),
    effort: row.effort ? providerEffort("codex", row.effort, "provider-cli") : unknownEffort(),
    profile: unknownProfile(),
    // Archived records expose history and facts only. Mutation authorization
    // reads this empty capability list, never presentation state.
    control: {
      plane: "observe-only",
      authority: "none",
      capabilities: [],
      withheld: [],
      takeover: null,
    },
  };
}

function archiveRows(rows: Record<string, unknown>[]): ArchiveRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    createdAtMs: Number(row.created_ms ?? 0),
    updatedAtMs: Number(row.updated_ms ?? 0),
    cwd: String(row.cwd ?? ""),
    title: normalizedText(row.title),
    source: typeof row.source === "string" && row.source.trim() ? row.source : null,
    threadSource: typeof row.thread_source === "string" && row.thread_source.trim()
      ? row.thread_source
      : null,
    model: typeof row.model === "string" && row.model.trim() ? row.model : null,
    effort: typeof row.effort === "string" && row.effort.trim() ? row.effort : null,
  }));
}

/** Read-only, page-bounded catalog over Codex's own archived thread index. */
export class LocalCodexArchiveCatalog implements ArchivedSessionCatalog {
  readonly #codexHome: string;
  readonly #uid: number;
  readonly #now: () => number;

  constructor(options: { codexHome?: string; uid?: number; now?: () => number } = {}) {
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
    this.#now = options.now ?? Date.now;
  }

  list(input: { query: string; cursor: string | null; limit: number }): ArchivedSessionPage {
    const databasePath = this.#databasePath();
    if (!databasePath) return { sessions: [], nextCursor: null, total: 0 };
    const cursor = decodeCursor(input.cursor);
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(input.limit)));
    const query = input.query.trim().slice(0, 200);
    const providerQuery = query.startsWith("local:codex:") ? query.slice("local:codex:".length) : query;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const shape = this.#shape(database);
      if (!shape) return { sessions: [], nextCursor: null, total: 0 };
      const search = query.length > 0
        ? ` AND (LOWER(${shape.title}) LIKE LOWER(?) ESCAPE '\\'
          OR LOWER(CAST(id AS TEXT)) LIKE LOWER(?) ESCAPE '\\'
          OR LOWER(${shape.cwd}) LIKE LOWER(?) ESCAPE '\\')`
        : "";
      const searchArguments = query.length > 0
        ? [literalLike(query), literalLike(providerQuery), literalLike(query)]
        : [];
      const after = cursor
        ? ` AND (${shape.updated} < ? OR (${shape.updated} = ? AND id < ?))`
        : "";
      const afterArguments = cursor ? [cursor.updatedAtMs, cursor.updatedAtMs, cursor.id] : [];
      const selected = archiveRows(database.prepare(`
        SELECT id, ${shape.created} AS created_ms, ${shape.updated} AS updated_ms,
          ${shape.cwd} AS cwd, ${shape.title} AS title,
          ${shape.source} AS source, ${shape.threadSource} AS thread_source,
          ${shape.model} AS model, ${shape.effort} AS effort
        FROM threads
        WHERE archived = 1${search}${after}
        ORDER BY ${shape.updated} DESC, id DESC
        LIMIT ?
      `).all(...searchArguments, ...afterArguments, limit + 1) as Record<string, unknown>[]);
      const totalRow = database.prepare(`
        SELECT COUNT(*) AS total FROM threads WHERE archived = 1${search}
      `).get(...searchArguments) as { total?: number | bigint } | undefined;
      const pageRows = selected.slice(0, limit);
      return {
        sessions: pageRows.map((row) => rowToSession(row, this.#now())),
        nextCursor: selected.length > limit && pageRows.length > 0
          ? encodeCursor(pageRows[pageRows.length - 1]!)
          : null,
        total: Number(totalRow?.total ?? 0),
      };
    } finally {
      database.close();
    }
  }

  get(managerSessionId: string): SessionRecord | null {
    const prefix = "local:codex:";
    if (!managerSessionId.startsWith(prefix)) return null;
    const providerSessionId = managerSessionId.slice(prefix.length);
    if (!providerSessionId || providerSessionId.length > 512) return null;
    const databasePath = this.#databasePath();
    if (!databasePath) return null;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const shape = this.#shape(database);
      if (!shape) return null;
      const result = database.prepare(`
        SELECT id, ${shape.created} AS created_ms, ${shape.updated} AS updated_ms,
          ${shape.cwd} AS cwd, ${shape.title} AS title,
          ${shape.source} AS source, ${shape.threadSource} AS thread_source,
          ${shape.model} AS model, ${shape.effort} AS effort
        FROM threads WHERE archived = 1 AND id = ? LIMIT 1
      `).get(providerSessionId) as Record<string, unknown> | undefined;
      const row = result ? archiveRows([result])[0] : undefined;
      return row ? rowToSession(row, this.#now()) : null;
    } finally {
      database.close();
    }
  }

  #databasePath(): string | null {
    const candidates: Array<{ path: string; version: number; modifiedAtMs: number }> = [];
    for (const directory of [join(this.#codexHome, "sqlite"), this.#codexHome]) {
      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const match = /^state_(\d+)\.sqlite$/u.exec(entry);
        if (!match) continue;
        const path = join(directory, entry);
        try {
          const lexical = lstatSync(path);
          const stat = statSync(path);
          if (lexical.isSymbolicLink() || !stat.isFile() || stat.uid !== this.#uid) continue;
          candidates.push({ path, version: Number(match[1]), modifiedAtMs: stat.mtimeMs });
        } catch {
          // The provider may rotate its state database during this bounded read.
        }
      }
    }
    return candidates.reduce<(typeof candidates)[number] | null>((selected, candidate) =>
      !selected || candidate.version > selected.version
        || (candidate.version === selected.version && candidate.modifiedAtMs > selected.modifiedAtMs)
        ? candidate
        : selected, null)?.path ?? null;
  }

  #shape(database: DatabaseSync): {
    created: string;
    updated: string;
    cwd: string;
    title: string;
    source: string;
    threadSource: string;
    model: string;
    effort: string;
  } | null {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").all();
    if (tables.length !== 1) return null;
    const columns = sqliteColumns(database, "threads");
    if (!columns.has("id") || !columns.has("archived") || !columns.has("created_at") || !columns.has("updated_at")) {
      return null;
    }
    const column = (name: string, fallback = "NULL") => columns.has(name) ? name : fallback;
    return {
      created: columns.has("created_at_ms")
        ? "COALESCE(created_at_ms, created_at * 1000)"
        : "created_at * 1000",
      updated: columns.has("updated_at_ms")
        ? "COALESCE(updated_at_ms, updated_at * 1000)"
        : "updated_at * 1000",
      cwd: column("cwd", "''"),
      title: `COALESCE(NULLIF(${column("name")}, ''), NULLIF(${column("title")}, ''), NULLIF(${column("preview")}, ''), NULLIF(${column("first_user_message")}, ''))`,
      source: column("source"),
      threadSource: column("thread_source"),
      model: column("model"),
      effort: column("reasoning_effort"),
    };
  }
}

export const ARCHIVED_SESSION_PAGE_LIMIT = MAX_PAGE_SIZE;
