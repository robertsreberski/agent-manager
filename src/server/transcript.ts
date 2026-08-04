import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactActivityText } from "../activity/redaction.ts";
import type {
  Provider,
  SessionView,
} from "../core/types.ts";

export const TRANSCRIPT_LIMITS = Object.freeze({
  sourceBytes: 2 * 1024 * 1024,
  messageBytes: 64 * 1024,
  totalBytes: 512 * 1024,
  messages: 120,
});

type SessionIdentity = Pick<
  SessionView,
  "provider" | "providerThreadId" | "providerTreeId" | "parentId"
>;

export type TranscriptUnavailableReason = "not-found" | "unreadable" | "unsupported";
export type TranscriptSource = "codex-rollout" | "claude-transcript" | "provider-api";

export interface TranscriptAvailability {
  state: "available" | "unavailable";
  truncated: boolean;
  source: TranscriptSource | null;
  messageCount: number;
  reason: TranscriptUnavailableReason | null;
}

export interface TranscriptReadResult {
  messages: TranscriptMessage[];
  transcript: TranscriptAvailability;
}

export interface TranscriptSearchMatch {
  messageId: string;
  role: TranscriptMessage["role"];
  createdAt: string | null;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export interface TranscriptSearchResult {
  matches: TranscriptSearchMatch[];
  truncated: boolean;
}

/** Internal reader output. Conversation history is projected into ActivityItem. */
export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  createdAt: string | null;
  status: "running" | "complete" | "incomplete";
  label: string | null;
}

export interface SessionTranscriptReader {
  read(session: SessionIdentity): TranscriptReadResult;
  search?(
    session: SessionIdentity,
    query: string,
    limit?: number,
  ): TranscriptSearchResult;
}

export interface LocalTranscriptReaderOptions {
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  codexHome?: string;
  claudeHome?: string;
  /** Test seam; production always defaults to the effective process uid. */
  uid?: number;
}

interface RootInfo {
  lexical: string;
  canonical: string;
}

interface OpenTranscript {
  descriptor: number;
  stat: Stats;
  identity: string;
}

interface JsonlRecord {
  object: Record<string, unknown>;
  offset: number;
}

interface JsonlTail {
  records: JsonlRecord[];
  truncated: boolean;
}

interface FileWalkResult {
  matches: string[];
  exhausted: boolean;
}

interface ParsedMessages {
  messages: TranscriptMessage[];
  truncated: boolean;
}

class TranscriptReadFailure extends Error {
  readonly reason: TranscriptUnavailableReason;

  constructor(reason: TranscriptUnavailableReason) {
    super(reason);
    this.name = "TranscriptReadFailure";
    this.reason = reason;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_WALK_ENTRIES = 50_000;
const MAX_CHAIN_RECORDS = 20_000;
const MACHINE_USER_PREFIX = /^<(?:task-notification|local-command-stdout|local-command-stderr|bash-stdout|ci-monitor-event)(?:>|\s)/i;
const SYNTHETIC_CODEX_USER_ENVELOPES = [
  /^<environment_context(?:\s[^>]*)?>[\s\S]*<\/environment_context>$/i,
  /^<recommended_plugins(?:\s[^>]*)?>[\s\S]*<\/recommended_plugins>$/i,
] as const;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function providerSource(provider: Provider): "codex-rollout" | "claude-transcript" {
  return provider === "codex" ? "codex-rollout" : "claude-transcript";
}

function unavailable(reason: TranscriptUnavailableReason): TranscriptReadResult {
  return {
    messages: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      messageCount: 0,
      reason,
    },
  };
}

function available(
  provider: Provider,
  messages: TranscriptMessage[],
  truncated: boolean,
): TranscriptReadResult {
  return {
    messages,
    transcript: {
      state: "available",
      truncated,
      source: providerSource(provider),
      messageCount: messages.length,
      reason: null,
    },
  };
}

function failure(reason: TranscriptUnavailableReason): never {
  throw new TranscriptReadFailure(reason);
}

function isConfined(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

function rootInfo(path: string, uid: number): RootInfo {
  const lexical = resolve(path);
  let canonical: string;
  let stat: Stats;
  try {
    canonical = realpathSync(lexical);
    stat = statSync(canonical);
  } catch {
    failure("not-found");
  }
  if (!stat.isDirectory() || stat.uid !== uid) failure("unreadable");
  return { lexical, canonical };
}

/** Rejects symlinks below the configured transcript root, including the leaf. */
function hasSymlinkBelowRoot(root: RootInfo, candidate: string): boolean {
  const absolute = resolve(candidate);
  const base = isConfined(root.lexical, absolute)
    ? root.lexical
    : isConfined(root.canonical, absolute)
      ? root.canonical
      : null;
  if (!base) return false;
  const remainder = relative(base, absolute);
  if (!remainder) return false;
  let cursor = base;
  for (const component of remainder.split(sep)) {
    cursor = join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function openTranscript(root: RootInfo, candidate: string, uid: number): OpenTranscript {
  if (!isAbsolute(candidate)) failure("unreadable");
  const absolute = resolve(candidate);
  if (hasSymlinkBelowRoot(root, absolute)) failure("unreadable");

  let canonical: string;
  let before: Stats;
  try {
    const lexical = lstatSync(absolute);
    if (lexical.isSymbolicLink()) failure("unreadable");
    canonical = realpathSync(absolute);
    if (!isConfined(root.canonical, canonical)) failure("unreadable");
    before = statSync(canonical);
  } catch (error) {
    if (error instanceof TranscriptReadFailure) throw error;
    failure("not-found");
  }
  if (!before.isFile() || before.uid !== uid) failure("unreadable");

  let descriptor: number;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    failure("unreadable");
  }
  try {
    const after = fstatSync(descriptor);
    if (
      !after.isFile() ||
      after.uid !== uid ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      failure("unreadable");
    }
    return {
      descriptor,
      stat: after,
      identity: `${String(after.dev)}:${String(after.ino)}`,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readAt(descriptor: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const count = readSync(descriptor, buffer, total, length - total, position + total);
    if (count === 0) break;
    total += count;
  }
  return buffer.subarray(0, total);
}

function parseJsonObject(buffer: Buffer): Record<string, unknown> | null {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 13) end -= 1;
  if (end === 0) return null;
  try {
    return objectValue(JSON.parse(fatalUtf8Decoder.decode(buffer.subarray(0, end))));
  } catch {
    return null;
  }
}

/**
 * Reads complete physical JSONL records from the newest bounded file window.
 * Newline scanning happens on bytes, so the decoder never starts inside a
 * multi-byte UTF-8 code point. Absolute byte offsets remain stable identifiers.
 */
function readJsonlTail(file: OpenTranscript): JsonlTail {
  const requestedStart = Math.max(0, file.stat.size - TRANSCRIPT_LIMITS.sourceBytes);
  const buffer = readAt(
    file.descriptor,
    requestedStart,
    Math.min(TRANSCRIPT_LIMITS.sourceBytes, file.stat.size),
  );
  let cursor = 0;
  let truncated = requestedStart > 0;
  if (requestedStart > 0) {
    const newline = buffer.indexOf(10);
    if (newline < 0) return { records: [], truncated: true };
    cursor = newline + 1;
  }

  const records: JsonlRecord[] = [];
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(10, cursor);
    const end = newline < 0 ? buffer.length : newline;
    const line = buffer.subarray(cursor, end);
    if (line.length > 0 && !(line.length === 1 && line[0] === 13)) {
      const object = parseJsonObject(line);
      if (object) records.push({ object, offset: requestedStart + cursor });
      else truncated = true;
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return { records, truncated };
}

function validHeaderSessionId(file: OpenTranscript, expectedId: string): boolean {
  const length = Math.min(file.stat.size, MAX_HEADER_BYTES);
  const buffer = readAt(file.descriptor, 0, length);
  const newline = buffer.indexOf(10);
  if (newline < 0) return true;
  const first = parseJsonObject(buffer.subarray(0, newline));
  if (first?.type !== "session_meta") return true;
  const payload = objectValue(first.payload);
  const actualId = stringValue(payload?.id);
  return actualId === null || actualId === expectedId;
}

function utf8Prefix(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

function capMessages(input: TranscriptMessage[]): ParsedMessages {
  let truncated = false;
  const perMessage = input.flatMap((message) => {
    const capped = utf8Prefix(message.text, TRANSCRIPT_LIMITS.messageBytes);
    truncated ||= capped.truncated;
    return capped.text.length > 0 ? [{ ...message, text: capped.text }] : [];
  });

  const retained: TranscriptMessage[] = [];
  let totalBytes = 0;
  for (let index = perMessage.length - 1; index >= 0; index -= 1) {
    const message = perMessage[index];
    if (!message) continue;
    const bytes = Buffer.byteLength(message.text, "utf8");
    if (
      retained.length >= TRANSCRIPT_LIMITS.messages ||
      totalBytes + bytes > TRANSCRIPT_LIMITS.totalBytes
    ) {
      truncated = true;
      continue;
    }
    totalBytes += bytes;
    retained.push(message);
  }
  retained.reverse();
  if (retained.length !== perMessage.length) truncated = true;
  return { messages: retained, truncated };
}

function stableMessageId(
  provider: Provider,
  providerId: string | null,
  fileIdentity: string,
  offset: number,
): string {
  return providerId
    ? `${provider}:${providerId}`
    : `${provider}:file:${fileIdentity}:${String(offset)}`;
}

function syntheticCodexUserContext(text: string): boolean {
  const candidate = text.trim();
  return SYNTHETIC_CODEX_USER_ENVELOPES.some((pattern) => pattern.test(candidate));
}

function codexMessages(tail: JsonlTail, fileIdentity: string): ParsedMessages {
  const messages: TranscriptMessage[] = [];
  const seenIds = new Set<string>();
  const seenAdjacent = new Set<string>();
  let previousKey: string | null = null;
  let truncated = tail.truncated;

  for (const record of tail.records) {
    const outer = record.object;
    if (outer.type !== "response_item") continue;
    const payload = objectValue(outer.payload);
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    if (!Array.isArray(payload.content)) continue;
    const expectedBlock = role === "user" ? "input_text" : "output_text";
    let parts = payload.content.flatMap((value) => {
      const block = objectValue(value);
      return block?.type === expectedBlock && typeof block.text === "string"
        ? [block.text]
        : [];
    });
    if (role === "user") {
      parts = parts.filter((part) => !syntheticCodexUserContext(part));
    }
    const text = parts.join("\n\n").trim();
    if (!text) continue;
    const providerId = stringValue(payload.id) ?? stringValue(outer.id);
    const id = stableMessageId("codex", providerId, fileIdentity, record.offset);
    if (seenIds.has(id)) continue;
    const adjacentKey = `${role}\u0000${timestamp(outer.timestamp) ?? ""}\u0000${text}`;
    if (previousKey === adjacentKey && seenAdjacent.has(adjacentKey)) continue;
    seenIds.add(id);
    seenAdjacent.clear();
    seenAdjacent.add(adjacentKey);
    previousKey = adjacentKey;
    messages.push({
      id,
      role,
      text,
      createdAt: timestamp(outer.timestamp),
      status: "complete",
      label: null,
    });
  }
  const capped = capMessages(messages);
  truncated ||= capped.truncated;
  return { messages: capped.messages, truncated };
}

function claudeAgentId(value: string): string {
  return value.startsWith("agent-") ? value.slice("agent-".length) : value;
}

function matchesClaudeIdentity(
  object: Record<string, unknown>,
  session: SessionIdentity,
  isChild: boolean,
): boolean {
  if (!stringValue(object.uuid)) return false;
  if (isChild) {
    const expected = claudeAgentId(session.providerThreadId);
    return object.isSidechain === true && stringValue(object.agentId) === expected;
  }
  return object.isSidechain !== true &&
    stringValue(object.agentId) === null &&
    stringValue(object.sessionId) === session.providerThreadId;
}

function claudeChain(
  tail: JsonlTail,
  session: SessionIdentity,
  isChild: boolean,
): { records: JsonlRecord[]; truncated: boolean } {
  const byUuid = new Map<string, JsonlRecord>();
  const agentIds = new Set<string>();
  let latest: JsonlRecord | null = null;
  for (const record of tail.records) {
    const uuid = stringValue(record.object.uuid);
    if (uuid) byUuid.set(uuid, record);
    const agentId = stringValue(record.object.agentId);
    if (agentId) agentIds.add(agentId);
    if (matchesClaudeIdentity(record.object, session, isChild)) latest = record;
  }
  if (isChild && agentIds.size > 1) failure("unsupported");
  if (!latest) failure("unsupported");

  const records: JsonlRecord[] = [];
  const visited = new Set<string>();
  let cursor: JsonlRecord | undefined = latest;
  let truncated = tail.truncated;
  while (cursor) {
    const uuid = stringValue(cursor.object.uuid);
    if (!uuid || visited.has(uuid)) {
      truncated = true;
      break;
    }
    visited.add(uuid);
    records.push(cursor);
    if (records.length >= MAX_CHAIN_RECORDS) {
      truncated = true;
      break;
    }
    const parentUuid = stringValue(cursor.object.parentUuid);
    if (!parentUuid) break;
    const parent = byUuid.get(parentUuid);
    if (!parent) {
      truncated = true;
      break;
    }
    cursor = parent;
  }
  records.reverse();
  return { records, truncated };
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = objectValue(value);
    return block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((value) => objectValue(value)?.type === "tool_result");
}

function machineClaudeUser(object: Record<string, unknown>, text: string): boolean {
  const origin = objectValue(object.origin);
  const message = objectValue(object.message);
  return origin?.kind === "task-notification" ||
    object.promptSource === "system" ||
    message?.promptSource === "system" ||
    MACHINE_USER_PREFIX.test(text.trimStart());
}

function claudeMessages(
  tail: JsonlTail,
  fileIdentity: string,
  session: SessionIdentity,
  isChild: boolean,
): ParsedMessages {
  const chain = claudeChain(tail, session, isChild);
  const messages: TranscriptMessage[] = [];
  const byId = new Map<string, { index: number; fragments: Set<string> }>();
  let truncated = chain.truncated;

  for (const record of chain.records) {
    const outer = record.object;
    if (!matchesClaudeIdentity(outer, session, isChild) || outer.isMeta === true) continue;
    const message = objectValue(outer.message);
    if (!message) continue;
    if (outer.type === "user" && message.role === "user") {
      if (hasToolResult(message.content)) continue;
      const text = textBlocks(message.content).join("\n\n").trim();
      if (!text || machineClaudeUser(outer, text)) continue;
      const providerId = stringValue(outer.uuid);
      const id = stableMessageId("claude", providerId, fileIdentity, record.offset);
      if (byId.has(id)) continue;
      byId.set(id, { index: messages.length, fragments: new Set([text]) });
      messages.push({
        id,
        role: "user",
        text,
        createdAt: timestamp(outer.timestamp),
        status: "complete",
        label: null,
      });
      continue;
    }
    if (outer.type !== "assistant" || message.role !== "assistant") continue;
    const parts = textBlocks(message.content).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const providerId = stringValue(message.id) ?? stringValue(outer.uuid);
    const id = stableMessageId("claude", providerId, fileIdentity, record.offset);
    const existing = byId.get(id);
    if (existing) {
      const target = messages[existing.index];
      if (!target) continue;
      const additions = parts.filter((part) => {
        if (existing.fragments.has(part)) return false;
        existing.fragments.add(part);
        return true;
      });
      if (additions.length > 0) target.text = `${target.text}\n\n${additions.join("\n\n")}`;
      continue;
    }
    const text = [...new Set(parts)].join("\n\n");
    byId.set(id, { index: messages.length, fragments: new Set(parts) });
    messages.push({
      id,
      role: "assistant",
      text,
      createdAt: timestamp(outer.timestamp),
      status: outer.isApiErrorMessage === true ? "incomplete" : "complete",
      label: null,
    });
  }
  const capped = capMessages(messages);
  truncated ||= capped.truncated;
  return { messages: capped.messages, truncated };
}

function stateDatabaseCandidates(codexHome: RootInfo, uid: number): string[] {
  const candidates: Array<{ path: string; root: boolean; version: number; mtimeMs: number }> = [];
  for (const directory of [codexHome.lexical, join(codexHome.lexical, "sqlite")]) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.name.match(/^state_(\d+)\.sqlite$/);
      if (!match || !entry.isFile()) continue;
      const path = join(directory, entry.name);
      try {
        const lexical = lstatSync(path);
        const canonical = realpathSync(path);
        const stat = statSync(canonical);
        if (
          lexical.isSymbolicLink() ||
          !stat.isFile() ||
          stat.uid !== uid ||
          !isConfined(codexHome.canonical, canonical)
        ) continue;
        candidates.push({
          path: canonical,
          root: resolve(directory) === codexHome.lexical,
          version: Number(match[1]),
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }
  return candidates
    .sort((first, second) =>
      Number(second.root) - Number(first.root) ||
      second.version - first.version ||
      second.mtimeMs - first.mtimeMs
    )
    .map((candidate) => candidate.path);
}

function rolloutFromDatabase(codexHome: RootInfo, uid: number, sessionId: string): string | null {
  for (const databaseFile of stateDatabaseCandidates(codexHome, uid)) {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databaseFile, { readOnly: true });
      database.exec("PRAGMA query_only = ON");
      const row = database
        .prepare("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1")
        .get(sessionId) as { rollout_path?: unknown } | undefined;
      if (typeof row?.rollout_path === "string" && row.rollout_path.length > 0) {
        return row.rollout_path;
      }
    } catch {
      // A corrupt/older state database is not a reason to expose its errors.
    } finally {
      database?.close();
    }
  }
  return null;
}

function walkMatchingFiles(root: RootInfo, predicate: (name: string) => boolean): FileWalkResult {
  const matches: string[] = [];
  const pending = [root.canonical];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_WALK_ENTRIES) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= MAX_WALK_ENTRIES) break;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (predicate(entry.name)) matches.push(path);
      } else if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && predicate(entry.name)) matches.push(path);
    }
  }
  return { matches, exhausted: pending.length > 0 || visited >= MAX_WALK_ENTRIES };
}

function codexFile(
  codexHomePath: string,
  sessionId: string,
  uid: number,
): { root: RootInfo; file: OpenTranscript } {
  if (!UUID_PATTERN.test(sessionId)) failure("unsupported");
  const codexHome = rootInfo(codexHomePath, uid);
  const sessions = rootInfo(join(codexHome.lexical, "sessions"), uid);
  const databasePath = rolloutFromDatabase(codexHome, uid, sessionId);
  let candidate: string;
  if (databasePath !== null) {
    candidate = databasePath;
  } else {
    const walked = walkMatchingFiles(sessions, (name) =>
      name.endsWith(`${sessionId}.jsonl`) &&
      name.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]?.toLowerCase() === sessionId.toLowerCase()
    );
    if (walked.exhausted) failure("unsupported");
    const matches = walked.matches;
    if (matches.length === 0) failure("not-found");
    if (matches.length !== 1) failure("unsupported");
    candidate = matches[0] as string;
  }
  const pathId = basename(candidate).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  if (pathId?.toLowerCase() !== sessionId.toLowerCase()) failure("unsupported");
  const file = openTranscript(sessions, candidate, uid);
  try {
    if (validHeaderSessionId(file, sessionId)) return { root: sessions, file };
    failure("unsupported");
  } catch (error) {
    try {
      closeSync(file.descriptor);
    } catch {
      // Preserve the original generic read failure.
    }
    throw error;
  }
}

function claudeCandidates(
  projects: RootInfo,
  session: SessionIdentity,
  isChild: boolean,
): string[] {
  let projectEntries;
  try {
    projectEntries = readdirSync(projects.canonical, { withFileTypes: true });
  } catch {
    failure("unreadable");
  }
  const candidates: string[] = [];
  const childId = claudeAgentId(session.providerThreadId);
  const rootId = session.providerTreeId !== null && session.providerTreeId !== session.providerThreadId
    ? session.providerTreeId
    : null;
  for (const entry of projectEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const project = join(projects.canonical, entry.name);
    if (!isChild) {
      candidates.push(join(project, `${session.providerThreadId}.jsonl`));
      continue;
    }
    if (rootId) {
      candidates.push(join(project, rootId, "subagents", `agent-${childId}.jsonl`));
    }
  }
  return candidates.filter((path) => {
    try {
      const stat = lstatSync(path);
      return stat.isFile() || stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function claudeFile(
  claudeHomePath: string,
  session: SessionIdentity,
  uid: number,
): { file: OpenTranscript; isChild: boolean } {
  if (!SAFE_PROVIDER_ID.test(session.providerThreadId)) failure("unsupported");
  const isChild = session.parentId !== null
    || (session.providerTreeId !== null && session.providerTreeId !== session.providerThreadId);
  if (
    isChild &&
    session.providerTreeId !== null &&
    !SAFE_PROVIDER_ID.test(session.providerTreeId)
  ) failure("unsupported");
  const projects = rootInfo(join(claudeHomePath, "projects"), uid);
  const candidates = claudeCandidates(projects, session, isChild);
  if (candidates.length === 0) failure("not-found");
  if (candidates.length !== 1) failure("unsupported");
  return { file: openTranscript(projects, candidates[0] as string, uid), isChild };
}

export class LocalSessionTranscriptReader implements SessionTranscriptReader {
  readonly #codexHome: string;
  readonly #claudeHome: string;
  readonly #uid: number;

  constructor(options: LocalTranscriptReaderOptions = {}) {
    const home = options.homeDir ?? homedir();
    const env = options.env ?? process.env;
    this.#codexHome = options.codexHome ?? env.CODEX_HOME ?? join(home, ".codex");
    this.#claudeHome = options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
  }

  read(session: SessionIdentity): TranscriptReadResult {
    let file: OpenTranscript | null = null;
    try {
      if (session.provider === "codex") {
        file = codexFile(this.#codexHome, session.providerThreadId, this.#uid).file;
        const parsed = codexMessages(readJsonlTail(file), file.identity);
        return available("codex", parsed.messages, parsed.truncated);
      }
      const claude = claudeFile(this.#claudeHome, session, this.#uid);
      file = claude.file;
      const parsed = claudeMessages(
        readJsonlTail(file),
        file.identity,
        session,
        claude.isChild,
      );
      return available("claude", parsed.messages, parsed.truncated);
    } catch (error) {
      return unavailable(
        error instanceof TranscriptReadFailure ? error.reason : "unreadable",
      );
    } finally {
      if (file) closeSync(file.descriptor);
    }
  }

  search(
    session: SessionIdentity,
    query: string,
    limit = 20,
  ): TranscriptSearchResult {
    const needle = query.trim();
    if (needle.length < 2 || needle.length > 200 || needle.includes("\0")) {
      return { matches: [], truncated: false };
    }
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(50, Math.floor(limit)))
      : 20;
    const transcript = this.read(session);
    if (transcript.transcript.state !== "available") {
      return { matches: [], truncated: transcript.transcript.truncated };
    }
    const loweredNeedle = needle.toLocaleLowerCase("en-US");
    const matches: TranscriptSearchMatch[] = [];
    let exhausted = false;
    for (const message of transcript.messages) {
      const safeText = redactActivityText(message.text);
      const lowered = safeText.toLocaleLowerCase("en-US");
      let offset = 0;
      while (offset <= lowered.length) {
        const index = lowered.indexOf(loweredNeedle, offset);
        if (index < 0) break;
        if (matches.length >= boundedLimit) {
          exhausted = true;
          break;
        }
        const start = Math.max(0, index - 80);
        const end = Math.min(safeText.length, index + needle.length + 120);
        const prefix = start > 0 ? "…" : "";
        const suffix = end < safeText.length ? "…" : "";
        matches.push({
          messageId: message.id,
          role: message.role,
          createdAt: message.createdAt,
          snippet: `${prefix}${safeText.slice(start, end)}${suffix}`,
          matchStart: prefix.length + index - start,
          matchEnd: prefix.length + index - start + needle.length,
        });
        offset = index + Math.max(1, loweredNeedle.length);
      }
      if (exhausted) break;
    }
    return {
      matches,
      truncated: transcript.transcript.truncated || exhausted,
    };
  }
}

export function readSessionTranscript(
  session: SessionIdentity,
  options: LocalTranscriptReaderOptions = {},
): TranscriptReadResult {
  return new LocalSessionTranscriptReader(options).read(session);
}
