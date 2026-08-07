import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  emptyChildSummary,
  providerEffort,
  unknownEffort,
  unknownModel,
  unknownProfile,
  type AdapterResult,
  type Diagnostic,
  type ExecutionProfile,
  type ListingResult,
  type ProcessInfo,
  type Provider,
  type Runtime,
  type SessionEffort,
  type SessionModel,
  type SessionAttention,
  type SessionProfile,
  type SessionRecord,
  type SessionSandbox,
  type SessionStatus,
} from "../core/types.ts";
import { attachTmuxTerminals, discoverTmuxPanes } from "../core/tmux.ts";
import { WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import { sessionRecordId, unknownSandbox } from "../shared/session.ts";
import {
  analyzeCodexRolloutFacts,
  codexFactType,
  codexProfileEvidence,
  codexSandboxEvidence,
  unrestrictedCodexApproval,
} from "../providers/codex/rollout-facts.ts";
import { discoverClaude } from "./claude-observer.ts";
import {
  baseRecord,
  iso,
  normalizedText,
  object,
  observedResumeControl,
  string,
  type JsonObject,
} from "./observe-values.ts";

const MAX_PROVIDER_ROWS = 750;
const MAX_PROCESSES = 4_096;
const MAX_TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MAX_CODEX_LIFECYCLE_CACHE = 1_024;

interface CodexLifecycleCacheEntry {
  dev: number;
  ino: number;
  size: number;
  event: JsonObject | null;
}

const codexLifecycleCache = new Map<string, CodexLifecycleCacheEntry>();

interface CodexRow {
  id: string;
  rolloutPath: string;
  createdAtMs: number;
  updatedAtMs: number;
  cwd: string;
  title: string | null;
  source: string | null;
  threadSource: string | null;
  model: string | null;
  effort: string | null;
  sandboxPolicy: string | null;
  approvalMode: string | null;
}

export interface ObserveScanOptions {
  recentWindowSeconds: number;
  providers?: ReadonlySet<Provider>;
}

const systemRuntime: Runtime = {
  now: () => Date.now(),
  homeDir: homedir(),
  env: process.env,
  run(command, args, timeoutMs = 5_000) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
      error: result.error ?? null,
    };
  },
};

export function parseProcessTable(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n").slice(0, MAX_PROCESSES)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const command = match[5] ?? "";
    const executablePath = command.trim().split(/\s+/u)[0] ?? "";
    processes.push({
      pid,
      ppid,
      startedAtMs: null,
      tty: match[3] ?? "?",
      state: match[4] ?? "?",
      command,
      executable: basename(executablePath),
    });
  }
  return processes;
}

function readProcesses(runtime: Runtime): { processes: ProcessInfo[]; diagnostic: Diagnostic | null } {
  const result = runtime.run("ps", ["-axo", "pid=,ppid=,tty=,state=,command="], 5_000);
  if (result.status !== 0 || result.error) {
    return {
      processes: [],
      diagnostic: {
        provider: "system",
        level: "warning",
        message: `Process discovery is unavailable: ${result.error?.message ?? (result.stderr.trim() || "ps failed")}`,
      },
    };
  }
  return { processes: parseProcessTable(result.stdout), diagnostic: null };
}

function commandWords(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [])
    .map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2"));
}

export function codexClientInvocation(
  process: ProcessInfo,
): { resumeThreadId: string | null } | null {
  const words = commandWords(process.command);
  const executable = basename(words[0] ?? "");
  const launcher = executable === "codex"
    ? 0
    : /^(?:node|nodejs)$/u.test(executable) && basename(words[1] ?? "") === "codex"
      ? 1
      : -1;
  if (launcher < 0) return null;

  const args = words.slice(launcher + 1);
  // These are service/tooling processes, not user sessions. Treating the private
  // app server as an independently-running CLI session would duplicate its threads.
  if (args.some((arg) => ["app-server", "mcp-server", "completion"].includes(arg))) {
    return null;
  }
  const resumeIndex = args.lastIndexOf("resume");
  const resumeThreadId = resumeIndex >= 0 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(args[resumeIndex + 1] ?? "")
    ? args[resumeIndex + 1] as string
    : null;
  return { resumeThreadId };
}

function loadedCodexThreads(
  runtime: Runtime,
  processes: ProcessInfo[],
): Map<string, { pid: number; cwd: string | null }> {
  const loaded = new Map<string, { pid: number; cwd: string | null }>();
  const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  const clients = processes.flatMap((process) => {
    const invocation = codexClientInvocation(process);
    return invocation ? [{ invocation, process }] : [];
  }).sort((a, b) => {
    const aInteractive = a.process.tty !== "??" && a.process.tty !== "?" ? 1 : 0;
    const bInteractive = b.process.tty !== "??" && b.process.tty !== "?" ? 1 : 0;
    return bInteractive - aInteractive || b.process.pid - a.process.pid;
  }).slice(0, 128);
  for (const { invocation, process } of clients) {
    if (invocation.resumeThreadId) {
      loaded.set(invocation.resumeThreadId, { pid: process.pid, cwd: null });
    }
    const result = runtime.run(lsof, ["-n", "-P", "-a", "-p", String(process.pid), "-Fn"], 3_000);
    if (result.status !== 0 || result.error) continue;
    const openFiles = parseCodexOpenFiles(result.stdout);
    const ids = new Set(openFiles.threadIds);
    if (invocation.resumeThreadId) ids.add(invocation.resumeThreadId);
    for (const id of ids) {
      loaded.set(id, { pid: process.pid, cwd: openFiles.cwd });
    }
  }
  return loaded;
}

export function parseCodexOpenFiles(
  output: string,
): { cwd: string | null; threadIds: string[] } {
  let descriptor: string | null = null;
  let cwd: string | null = null;
  const threadIds = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.startsWith("f")) {
      descriptor = line.slice(1);
      continue;
    }
    if (!line.startsWith("n") || line.length < 2) continue;
    const path = line.slice(1);
    if (descriptor === "cwd") cwd = path;
    const match = path.match(/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu);
    if (match?.[1]) threadIds.add(match[1]);
  }
  return { cwd, threadIds: [...threadIds] };
}

interface CodexDatabaseCandidate {
  path: string;
  version: number;
  modifiedAtMs: number;
}

export function selectLatestCodexDatabase(
  candidates: readonly CodexDatabaseCandidate[],
): string | null {
  return candidates.reduce<CodexDatabaseCandidate | null>((selected, candidate) => {
    if (!selected || candidate.version > selected.version ||
        (candidate.version === selected.version && candidate.modifiedAtMs > selected.modifiedAtMs)) {
      return candidate;
    }
    return selected;
  }, null)?.path ?? null;
}

function latestCodexDatabase(codexHome: string): string | null {
  const directories = [join(codexHome, "sqlite"), codexHome];
  const candidates: CodexDatabaseCandidate[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^state_(\d+)\.sqlite$/u.exec(entry);
      if (!match) continue;
      const version = Number(match[1]);
      const path = join(directory, entry);
      try {
        candidates.push({ version, path, modifiedAtMs: statSync(path).mtimeMs });
      } catch {
        // The state DB may rotate while discovery is running.
      }
    }
  }
  return selectLatestCodexDatabase(candidates);
}

function sqliteColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function queryCodexRows(
  databasePath: string,
  cutoffMs: number,
  loadedIds: ReadonlySet<string>,
): { rows: CodexRow[]; parentByChild: Map<string, string> } {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const columns = sqliteColumns(database, "threads");
    const column = (name: string, fallback = "NULL") => columns.has(name) ? name : fallback;
    const created = columns.has("created_at_ms")
      ? "COALESCE(created_at_ms, created_at * 1000)"
      : "created_at * 1000";
    const updated = columns.has("updated_at_ms")
      ? "COALESCE(updated_at_ms, updated_at * 1000)"
      : "updated_at * 1000";
    const ids = [...loadedIds].slice(0, 128);
    const placeholders = ids.map(() => "?").join(",");
    const loadedClause = ids.length > 0 ? ` OR id IN (${placeholders})` : "";
    const rows = database.prepare(`
      SELECT id, ${column("rollout_path", "''")} AS rollout_path,
        ${created} AS created_ms, ${updated} AS updated_ms,
        ${column("cwd", "''")} AS cwd,
        COALESCE(NULLIF(${column("name", "NULL")}, ''), NULLIF(${column("title", "NULL")}, ''),
          NULLIF(${column("preview", "NULL")}, ''), NULLIF(${column("first_user_message", "NULL")}, '')) AS title,
        ${column("source")} AS source, ${column("thread_source")} AS thread_source,
        ${column("model")} AS model, ${column("reasoning_effort")} AS effort,
        ${column("sandbox_policy")} AS sandbox_policy,
        ${column("approval_mode")} AS approval_mode
      FROM threads
      WHERE (${updated} >= ?${loadedClause})${columns.has("archived") ? " AND archived = 0" : ""}
      ORDER BY ${updated} DESC LIMIT ${MAX_PROVIDER_ROWS}
    `).all(cutoffMs, ...ids) as JsonObject[];
    const parentByChild = new Map<string, string>();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    if (tables.some((table) => table.name === "thread_spawn_edges")) {
      const edges = database.prepare(
        `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges LIMIT ${MAX_PROVIDER_ROWS * 4}`,
      ).all() as Array<{ parent_thread_id: string; child_thread_id: string }>;
      for (const edge of edges) parentByChild.set(edge.child_thread_id, edge.parent_thread_id);
    }
    return {
      rows: rows.map((row) => ({
        id: String(row.id),
        rolloutPath: String(row.rollout_path ?? ""),
        createdAtMs: Number(row.created_ms ?? 0),
        updatedAtMs: Number(row.updated_ms ?? 0),
        cwd: String(row.cwd ?? ""),
        title: normalizedText(row.title),
        source: string(row.source),
        threadSource: string(row.thread_source),
        model: string(row.model),
        effort: string(row.effort),
        sandboxPolicy: string(row.sandbox_policy),
        approvalMode: string(row.approval_mode),
      })),
      parentByChild,
    };
  } finally {
    database.close();
  }
}

function queryCodexProfileRows(
  databasePath: string,
  threadIds: readonly string[],
): CodexRow[] {
  const ids = [...new Set(threadIds.filter((id) => id.length > 0 && id.length <= 512))]
    .slice(0, 128);
  if (ids.length === 0) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const columns = sqliteColumns(database, "threads");
    const column = (name: string, fallback = "NULL") => columns.has(name) ? name : fallback;
    const placeholders = ids.map(() => "?").join(",");
    const rows = database.prepare(`
      SELECT id,
        ${column("rollout_path", "''")} AS rollout_path,
        ${column("sandbox_policy")} AS sandbox_policy,
        ${column("approval_mode")} AS approval_mode
      FROM threads
      WHERE id IN (${placeholders})${columns.has("archived") ? " AND archived = 0" : ""}
    `).all(...ids) as JsonObject[];
    return rows.map((row) => ({
      id: String(row.id),
      rolloutPath: String(row.rollout_path ?? ""),
      createdAtMs: 0,
      updatedAtMs: 0,
      cwd: "",
      title: null,
      source: null,
      threadSource: null,
      model: null,
      effort: null,
      sandboxPolicy: string(row.sandbox_policy),
      approvalMode: string(row.approval_mode),
    }));
  } finally {
    database.close();
  }
}

function readJsonlTail(path: string): JsonObject[] {
  let descriptor: number | null = null;
  try {
    const size = statSync(path).size;
    descriptor = openSync(path, "r");
    const length = Math.min(size, MAX_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
    let text = buffer.toString("utf8");
    if (size > length) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const value = object(JSON.parse(line));
        return value ? [value] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function codexLifecycleType(event: JsonObject): string | null {
  if (event.type !== "event_msg") return null;
  const type = string(object(event.payload)?.type);
  return type === "task_started" || type === "task_complete" || type === "turn_aborted"
    ? type
    : null;
}

function parseJsonObjectLine(line: Buffer): JsonObject | null {
  try {
    return object(JSON.parse(line.toString("utf8").replace(/\r$/u, "")));
  } catch {
    return null;
  }
}

/** Finds the latest durable turn transition without treating a tail window as state. */
function readLatestCodexLifecycle(path: string, size: number): JsonObject | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    let end = size;
    let suffix = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - MAX_TRANSCRIPT_TAIL_BYTES);
      const chunk = Buffer.alloc(end - start);
      readSync(descriptor, chunk, 0, chunk.length, start);
      const combined = Buffer.concat([chunk, suffix]);
      let cursor = combined.length;
      while (cursor > 0) {
        const newline = combined.lastIndexOf(0x0a, cursor - 1);
        if (newline < 0) {
          suffix = combined.subarray(0, cursor);
          break;
        }
        const line = combined.subarray(newline + 1, cursor);
        cursor = newline;
        if (line.length === 0) continue;
        const event = parseJsonObjectLine(line);
        if (event && codexLifecycleType(event)) return event;
      }
      if (start === 0) {
        const event = suffix.length > 0 ? parseJsonObjectLine(suffix) : null;
        return event && codexLifecycleType(event) ? event : null;
      }
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Scans only bytes appended since the cached observation, with bounded carry. */
function readLatestCodexLifecycleSince(
  path: string,
  start: number,
  end: number,
  fallback: JsonObject | null,
): JsonObject | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    let offset = Math.max(0, start - MAX_TRANSCRIPT_TAIL_BYTES);
    let carry = Buffer.alloc(0);
    let latest = fallback;
    while (offset < end) {
      const length = Math.min(MAX_TRANSCRIPT_TAIL_BYTES, end - offset);
      const chunk = Buffer.alloc(length);
      const bytesRead = readSync(descriptor, chunk, 0, length, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const combined = carry.length > 0
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        const event = parseJsonObjectLine(combined.subarray(lineStart, index));
        if (event && codexLifecycleType(event)) latest = event;
        lineStart = index + 1;
      }
      carry = combined.subarray(lineStart);
      if (carry.length > MAX_TRANSCRIPT_TAIL_BYTES) {
        carry = carry.subarray(carry.length - MAX_TRANSCRIPT_TAIL_BYTES);
      }
    }
    const event = carry.length > 0 ? parseJsonObjectLine(carry) : null;
    return event && codexLifecycleType(event) ? event : latest;
  } catch {
    return fallback;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readCodexObservation(path: string): JsonObject[] {
  const tail = readJsonlTail(path);
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(path);
  } catch {
    return tail;
  }
  const inTail = [...tail].reverse().find((event) => codexLifecycleType(event) !== null) ?? null;
  const cached = codexLifecycleCache.get(path);
  const sameFile = cached?.dev === info.dev && cached.ino === info.ino && info.size >= cached.size;
  const lifecycle = inTail ?? (
    sameFile
      ? info.size === cached.size
        ? cached.event
        : readLatestCodexLifecycleSince(path, cached.size, info.size, cached.event)
      : readLatestCodexLifecycle(path, info.size)
  );
  codexLifecycleCache.delete(path);
  codexLifecycleCache.set(path, { dev: info.dev, ino: info.ino, size: info.size, event: lifecycle });
  while (codexLifecycleCache.size > MAX_CODEX_LIFECYCLE_CACHE) {
    const oldest = codexLifecycleCache.keys().next().value as string | undefined;
    if (!oldest) break;
    codexLifecycleCache.delete(oldest);
  }
  return lifecycle && !inTail ? [lifecycle, ...tail] : tail;
}

export function analyzeCodexEvents(
  events: readonly JsonObject[],
  live: boolean,
): {
  status: SessionStatus;
  providerStatus: string | null;
  attention: SessionAttention[];
  profile: SessionProfile | null;
  sandbox: SessionSandbox | null;
  model: SessionModel | null;
  effort: SessionEffort | null;
} {
  const rollout = analyzeCodexRolloutFacts(events);
  let status: SessionStatus = rollout.status === "unknown"
    ? live ? "running" : "unknown"
    : rollout.status === "idle" && !live
      ? "completed"
      : rollout.status;
  const pendingQuestions = new Map<string, string | null>();
  for (const event of events) {
    const payload = object(event.payload);
    if (event.type !== "response_item" || !payload) continue;
    if (payload.type === "function_call" && payload.name === "request_user_input") {
      const callId = string(payload.call_id) ?? string(payload.id);
      if (callId) pendingQuestions.set(callId, "Codex appears to be waiting for input");
    }
    if (payload.type === "function_call_output") {
      const callId = string(payload.call_id);
      if (callId) pendingQuestions.delete(callId);
    }
  }
  const attention = [...pendingQuestions.values()].map((summary): SessionAttention => ({
    id: null,
    kind: "question",
    summary,
    source: "transcript",
    confidence: "heuristic",
    details: {
      title: "Inferred from transcript",
      questions: null,
      toolName: "request_user_input",
      inputSummary: null,
      respondable: false,
    },
  }));
  if (attention.length > 0 && live) status = "waiting";
  return {
    status,
    providerStatus: rollout.providerStatus,
    attention,
    profile: rollout.profile,
    sandbox: rollout.sandbox,
    model: rollout.model,
    effort: rollout.effort,
  };
}

/**
 * The profile is the approval axis only. A thread that never asks is
 * `full-access` however its sandbox is set, and a danger sandbox no longer
 * implies the profile: an observed CLI running wide open under on-request
 * approval truthfully reads as `execute` with a full-access sandbox.
 */
function codexSandboxFromRow(row: CodexRow): SessionSandbox | null {
  return codexSandboxEvidence(codexFactType(row.sandboxPolicy), null, "provider-cli");
}

function codexProfile(row: CodexRow): SessionProfile | null {
  const sandbox = codexFactType(row.sandboxPolicy);
  const approval = row.approvalMode?.toLowerCase() ?? null;
  const facts = [["approval", approval], ["sandbox", sandbox]] as const;
  if (unrestrictedCodexApproval(approval)) {
    return codexProfileEvidence("full-access", "provider-cli", facts);
  }
  return approval || sandbox ? codexProfileEvidence("execute", "provider-cli", facts) : null;
}

/**
 * Resolve only the persisted managed thread IDs that need a durable profile.
 * Unlike discovery this does not inspect processes, tmux, or a recent window.
 */
export function resolveCodexExecutionProfiles(
  threadIds: readonly string[],
  codexHome: string,
): ReadonlyMap<string, ExecutionProfile> {
  const database = latestCodexDatabase(codexHome);
  if (!database) return new Map();
  try {
    const resolved = new Map<string, ExecutionProfile>();
    for (const row of queryCodexProfileRows(database, threadIds)) {
      const analysis = analyzeCodexEvents(
        row.rolloutPath ? readCodexObservation(row.rolloutPath) : [],
        false,
      );
      const profile = analysis.profile ?? codexProfile(row);
      if (profile?.value) resolved.set(row.id, profile.value);
    }
    return resolved;
  } catch {
    // Startup repair has a conservative `plan` fallback. A provider database
    // rotation or future schema must not make Agent Manager itself unavailable.
    return new Map();
  }
}

function rootOf(id: string, parentByChild: ReadonlyMap<string, string>): string {
  const seen = new Set([id]);
  let current = id;
  while (parentByChild.has(current)) {
    const parent = parentByChild.get(current) as string;
    if (seen.has(parent)) break;
    seen.add(parent);
    current = parent;
  }
  return current;
}

function discoverCodex(
  runtime: Runtime,
  processes: ProcessInfo[],
  recentWindowSeconds: number,
): AdapterResult {
  const diagnostics: Diagnostic[] = [];
  const codexHome = runtime.env.CODEX_HOME ?? join(runtime.homeDir, ".codex");
  const loaded = loadedCodexThreads(runtime, processes);
  const database = latestCodexDatabase(codexHome);
  if (!database) {
    return {
      sessions: [],
      diagnostics: [{ provider: "codex", level: "error", message: "Codex state database was not found" }],
      succeeded: false,
    };
  }
  try {
    const now = runtime.now();
    const cutoff = now - recentWindowSeconds * 1_000;
    const queried = queryCodexRows(database, cutoff, new Set(loaded.keys()));
    const sessions = queried.rows.map((row): SessionRecord => {
      const active = loaded.get(row.id) ?? null;
      const analysis = analyzeCodexEvents(
        row.rolloutPath ? readCodexObservation(row.rolloutPath) : [],
        active !== null,
      );
      const profile = analysis.profile ?? codexProfile(row);
      const sandbox = analysis.sandbox ?? codexSandboxFromRow(row);
      const parent = queried.parentByChild.get(row.id) ?? null;
      const cwd = row.cwd || active?.cwd || null;
      return {
        ...baseRecord("codex", row.id, now),
        providerTreeId: rootOf(row.id, queried.parentByChild),
        parentId: parent ? sessionRecordId("local", "codex", parent) : null,
        name: row.title,
        cwd,
        kind: parent || row.threadSource === "subagent" ? "subagent"
          : /exec|batch/iu.test(row.threadSource ?? row.source ?? "") ? "batch" : "interactive",
        presence: active ? "live" : "recent",
        status: analysis.status,
        providerStatus: analysis.providerStatus,
        pid: active?.pid ?? null,
        runtimePid: active?.pid ?? null,
        startedAt: iso(row.createdAtMs, now),
        updatedAt: iso(row.updatedAtMs, now),
        statusSource: row.rolloutPath ? "rollout-events" : "inferred",
        source: row.threadSource ?? row.source,
        profile: profile ?? unknownProfile(),
        sandbox: sandbox ?? unknownSandbox(),
        model: analysis.model ?? (row.model ? {
          value: row.model,
          providerValue: row.model,
          source: "provider-cli",
          confidence: "exact",
        } : unknownModel()),
        effort: analysis.effort ?? (row.effort
          ? providerEffort("codex", row.effort, "provider-cli")
          : unknownEffort()),
        attention: analysis.attention,
        ...(parent === null && cwd && active === null
          ? { control: observedResumeControl("codex") }
          : {}),
      };
    });
    return { sessions, diagnostics, succeeded: true };
  } catch (error) {
    diagnostics.push({
      provider: "codex",
      level: "error",
      message: `Codex observe-only discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { sessions: [], diagnostics, succeeded: false };
  }
}

function hydrateHierarchy(sessions: SessionRecord[]): SessionRecord[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    if (!session.parentId) continue;
    const list = children.get(session.parentId) ?? [];
    list.push(session);
    children.set(session.parentId, list);
  }
  const depth = (session: SessionRecord): number => {
    const seen = new Set([session.id]);
    let current = session;
    let value = 0;
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = byId.get(current.parentId) as SessionRecord;
      value += 1;
    }
    return value;
  };
  return sessions.map((session) => {
    const descendants: SessionRecord[] = [];
    const queue = [...(children.get(session.id) ?? [])];
    while (queue.length > 0) {
      const child = queue.shift() as SessionRecord;
      descendants.push(child);
      queue.push(...(children.get(child.id) ?? []));
    }
    const summary = emptyChildSummary();
    summary.total = descendants.length;
    for (const child of descendants) summary[child.status] += 1;
    return { ...session, depth: depth(session), childSummary: summary };
  });
}

export function scanObservedSessions(
  options: ObserveScanOptions,
  runtime: Runtime = systemRuntime,
): ListingResult {
  const selected = options.providers ?? new Set<Provider>(["codex", "claude"]);
  const processResult = readProcesses(runtime);
  const diagnostics = processResult.diagnostic ? [processResult.diagnostic] : [];
  let sessions: SessionRecord[] = [];
  if (selected.has("codex")) {
    const result = discoverCodex(runtime, processResult.processes, options.recentWindowSeconds);
    sessions.push(...result.sessions);
    diagnostics.push(...result.diagnostics);
  }
  if (selected.has("claude")) {
    const result = discoverClaude(runtime, processResult.processes, options.recentWindowSeconds);
    sessions.push(...result.sessions);
    diagnostics.push(...result.diagnostics);
  }

  // tmux is a local evidence plane, not a provider or hook capability. Probe it
  // only when this scan found a local process identity that can be correlated
  // exactly; recent transcript/database rows and remote records must remain
  // observe-only. discoverTmuxPanes owns the bounded socket/probe budget and
  // uses the executable and socket roots pinned in this worker's Runtime.
  if (sessions.some((session) =>
    session.hostId === "local" && (session.pid !== null || session.runtimePid !== null)
  )) {
    const tmux = discoverTmuxPanes(runtime);
    sessions = attachTmuxTerminals(sessions, tmux.panes, processResult.processes);
    diagnostics.push(...tmux.diagnostics);
  }
  return {
    schemaVersion: WIRE_SCHEMA_VERSION,
    generatedAt: new Date(runtime.now()).toISOString(),
    recentWindowSeconds: options.recentWindowSeconds,
    sessions: hydrateHierarchy(sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    diagnostics,
  };
}
