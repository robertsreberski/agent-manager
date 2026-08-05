import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  providerEffort,
  unknownEffort,
  unknownModel,
  unknownProfile,
  type SessionRecord,
} from "../core/types.ts";
import { baseRecord, iso, normalizedText } from "../discovery/observe-values.ts";
import { observeOnlyControl, sessionRecordId } from "../shared/session.ts";

export interface ArchivedSessionPage {
  sessions: SessionRecord[];
  nextCursor: string | null;
  total: number;
}

export interface ArchivedSessionCatalog {
  list(input: {
    query: string;
    cursor: string | null;
    limit: number;
    /** Active manager identities that must never leak back through the archive view. */
    excludeSessionIds?: ReadonlySet<string>;
  }): ArchivedSessionPage;
  get(managerSessionId: string, excludeSessionIds?: ReadonlySet<string>): SessionRecord | null;
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

interface TrustedDirectory {
  lexical: string;
  canonical: string;
  stat: Stats;
}

interface DatabaseCandidate {
  path: string;
  home: TrustedDirectory;
  parent: TrustedDirectory;
  stat: Stats;
  root: boolean;
  version: number;
  modifiedAtMs: number;
}

interface ArchiveShape {
  created: string;
  updated: string;
  cwd: string;
  title: string;
  source: string;
  threadSource: string;
  model: string;
  effort: string;
}

interface LocalCodexArchiveCatalogOptions {
  codexHome?: string;
  uid?: number;
  now?: () => number;
  /** Test seam for deterministic replacement-race coverage. */
  beforeDatabaseOpen?: (path: string) => void;
}

const MAX_PAGE_SIZE = 50;
const LOCAL_CODEX_PREFIX = "local:codex:";
const MAX_EXCLUDED_SESSION_IDS = 4_096;
const MAX_EXCLUDED_SESSION_BYTES = 512 * 1_024;

function excludedProviderIds(managerSessionIds: ReadonlySet<string> | undefined): Set<string> {
  const providerIds = new Set<string>();
  if (!managerSessionIds) return providerIds;
  let bytes = 0;
  for (const managerSessionId of managerSessionIds) {
    if (!managerSessionId.startsWith(LOCAL_CODEX_PREFIX)) continue;
    const providerSessionId = managerSessionId.slice(LOCAL_CODEX_PREFIX.length);
    if (providerSessionId.length === 0 || providerSessionId.length > 512) continue;
    bytes += Buffer.byteLength(providerSessionId, "utf8");
    if (
      providerIds.size >= MAX_EXCLUDED_SESSION_IDS
      || bytes > MAX_EXCLUDED_SESSION_BYTES
    ) throw new Error("Active-session archive exclusion is too large");
    providerIds.add(providerSessionId);
  }
  return providerIds;
}

function isConfined(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

function sameIdentity(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function trustedDirectory(
  path: string,
  uid: number,
  parent: TrustedDirectory | null = null,
): TrustedDirectory | null {
  const lexical = resolve(path);
  try {
    const lexicalStat = lstatSync(lexical);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isDirectory() || lexicalStat.uid !== uid) {
      return null;
    }
    const canonical = realpathSync(lexical);
    const stat = statSync(canonical);
    const after = lstatSync(lexical);
    if (
      !stat.isDirectory() ||
      stat.uid !== uid ||
      !sameIdentity(lexicalStat, stat) ||
      !sameIdentity(lexicalStat, after)
    ) return null;
    if (parent && (
      lexical === parent.lexical ||
      canonical === parent.canonical ||
      dirname(lexical) !== parent.lexical ||
      dirname(canonical) !== parent.canonical ||
      !isConfined(parent.lexical, lexical) ||
      !isConfined(parent.canonical, canonical)
    )) return null;
    return { lexical, canonical, stat };
  } catch {
    return null;
  }
}

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
    control: observeOnlyControl(),
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
  readonly #beforeDatabaseOpen: ((path: string) => void) | null;

  constructor(options: LocalCodexArchiveCatalogOptions = {}) {
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
    this.#now = options.now ?? Date.now;
    this.#beforeDatabaseOpen = options.beforeDatabaseOpen ?? null;
  }

  list(input: {
    query: string;
    cursor: string | null;
    limit: number;
    excludeSessionIds?: ReadonlySet<string>;
  }): ArchivedSessionPage {
    const cursor = decodeCursor(input.cursor);
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(input.limit)));
    const query = input.query.trim().slice(0, 200);
    const providerQuery = query.startsWith("local:codex:") ? query.slice("local:codex:".length) : query;
    const excluded = excludedProviderIds(input.excludeSessionIds);
    return this.#withDatabase((database, shape) => {
      const exclusion = excluded.size > 0
        ? " AND CAST(id AS TEXT) NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))"
        : "";
      const exclusionArguments = excluded.size > 0
        ? [JSON.stringify([...excluded])]
        : [];
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
      // Fetch enough rows to fill the requested page even when every excluded
      // collision sorts ahead of it. This keeps exclusion logically before
      // pagination without constructing an unbounded SQLite IN expression.
      const selected = archiveRows(database.prepare(`
        SELECT id, ${shape.created} AS created_ms, ${shape.updated} AS updated_ms,
          ${shape.cwd} AS cwd, ${shape.title} AS title,
          ${shape.source} AS source, ${shape.threadSource} AS thread_source,
          ${shape.model} AS model, ${shape.effort} AS effort
        FROM threads
        WHERE archived = 1${exclusion}${search}${after}
        ORDER BY ${shape.updated} DESC, id DESC
        LIMIT ?
      `).all(
        ...exclusionArguments,
        ...searchArguments,
        ...afterArguments,
        limit + 1,
      ) as Record<string, unknown>[]);
      const totalRow = database.prepare(`
        SELECT COUNT(*) AS total FROM threads
        WHERE archived = 1${exclusion}${search}
      `).get(...exclusionArguments, ...searchArguments) as { total?: number | bigint } | undefined;
      const pageRows = selected.slice(0, limit);
      return {
        sessions: pageRows.map((row) => rowToSession(row, this.#now())),
        nextCursor: selected.length > limit && pageRows.length > 0
          ? encodeCursor(pageRows[pageRows.length - 1]!)
          : null,
        total: Number(totalRow?.total ?? 0),
      };
    }, { sessions: [], nextCursor: null, total: 0 });
  }

  get(managerSessionId: string, excludeSessionIds?: ReadonlySet<string>): SessionRecord | null {
    if (!managerSessionId.startsWith(LOCAL_CODEX_PREFIX)) return null;
    const providerSessionId = managerSessionId.slice(LOCAL_CODEX_PREFIX.length);
    if (!providerSessionId || providerSessionId.length > 512) return null;
    // Resolve the active/archive collision before touching provider storage so
    // direct archive lookup fails closed even when the catalog is unavailable.
    if (excludedProviderIds(excludeSessionIds).has(providerSessionId)) return null;
    return this.#withDatabase((database, shape) => {
      const result = database.prepare(`
        SELECT id, ${shape.created} AS created_ms, ${shape.updated} AS updated_ms,
          ${shape.cwd} AS cwd, ${shape.title} AS title,
          ${shape.source} AS source, ${shape.threadSource} AS thread_source,
          ${shape.model} AS model, ${shape.effort} AS effort
        FROM threads WHERE archived = 1 AND id = ? LIMIT 1
      `).get(providerSessionId) as Record<string, unknown> | undefined;
      const row = result ? archiveRows([result])[0] : undefined;
      return row ? rowToSession(row, this.#now()) : null;
    }, null);
  }

  #databaseCandidates(): DatabaseCandidate[] {
    const home = trustedDirectory(this.#codexHome, this.#uid);
    if (!home) return [];
    const sqlitePath = join(home.lexical, "sqlite");
    let sqlite: TrustedDirectory | null = null;
    try {
      lstatSync(sqlitePath);
      sqlite = trustedDirectory(sqlitePath, this.#uid, home);
      // An existing but untrusted provider state root invalidates the catalog;
      // silently following it would make confinement dependent on readdir.
      if (!sqlite) return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
      // Codex may keep its state databases directly under CODEX_HOME.
    }
    const candidates: DatabaseCandidate[] = [];
    for (const directory of [home, sqlite].filter((value): value is TrustedDirectory => value !== null)) {
      let entries: string[];
      try {
        entries = readdirSync(directory.canonical);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const match = /^state_(\d+)\.sqlite$/u.exec(entry);
        if (!match) continue;
        const path = join(directory.canonical, entry);
        try {
          const lexical = lstatSync(path);
          const canonical = realpathSync(path);
          const stat = statSync(path);
          const after = lstatSync(path);
          if (
            lexical.isSymbolicLink() ||
            !lexical.isFile() ||
            !stat.isFile() ||
            lexical.uid !== this.#uid ||
            stat.uid !== this.#uid ||
            !sameIdentity(lexical, stat) ||
            !sameIdentity(lexical, after) ||
            dirname(canonical) !== directory.canonical ||
            !isConfined(home.canonical, canonical)
          ) continue;
          candidates.push({
            path,
            home,
            parent: directory,
            stat,
            root: directory.canonical === home.canonical,
            version: Number(match[1]),
            modifiedAtMs: stat.mtimeMs,
          });
        } catch {
          // The provider may rotate its state database during this bounded read.
        }
      }
    }
    return candidates.sort((first, second) =>
      second.version - first.version ||
      second.modifiedAtMs - first.modifiedAtMs ||
      Number(second.root) - Number(first.root)
    );
  }

  #candidateStillTrusted(candidate: DatabaseCandidate): boolean {
    try {
      const directoryStillTrusted = (expected: TrustedDirectory): boolean => {
        const current = lstatSync(expected.lexical);
        return !current.isSymbolicLink() &&
          current.isDirectory() &&
          current.uid === this.#uid &&
          sameIdentity(current, expected.stat);
      };
      const file = lstatSync(candidate.path);
      return directoryStillTrusted(candidate.home) &&
        directoryStillTrusted(candidate.parent) &&
        !file.isSymbolicLink() &&
        file.isFile() &&
        file.uid === this.#uid &&
        sameIdentity(file, candidate.stat);
    } catch {
      return false;
    }
  }

  #withDatabase<T>(
    read: (database: DatabaseSync, shape: ArchiveShape) => T,
    fallback: T,
  ): T {
    for (const candidate of this.#databaseCandidates()) {
      let database: DatabaseSync | null = null;
      try {
        if (!this.#candidateStillTrusted(candidate)) continue;
        this.#beforeDatabaseOpen?.(candidate.path);
        if (!this.#candidateStillTrusted(candidate)) continue;
        database = new DatabaseSync(candidate.path, { readOnly: true });
        // SQLite now owns an open handle. If the pathname identity changed at
        // any point around open, discard the handle before issuing a query.
        if (!this.#candidateStillTrusted(candidate)) continue;
        database.exec("PRAGMA query_only = ON");
        const shape = this.#shape(database);
        if (!shape) continue;
        return read(database, shape);
      } catch {
        // Newer provider state can be incomplete during migration/rotation.
        // Continue in deterministic priority order until a valid index opens.
      } finally {
        database?.close();
      }
    }
    return fallback;
  }

  #shape(database: DatabaseSync): ArchiveShape | null {
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
