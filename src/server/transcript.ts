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
import {
  extractTrailingMemoryCitation,
  parseMemoryCitation,
  type ActivityJsonValue,
  type ActivityMemoryCitation,
} from "../activity/index.ts";
import { redactActivityText } from "../activity/redaction.ts";
import { codexMessageCorrelationId } from "../providers/codex/activity-projector.ts";
import type {
  Provider,
  SessionView,
} from "../core/types.ts";

export const TRANSCRIPT_LIMITS = Object.freeze({
  sourceBytes: 2 * 1024 * 1024,
  sourceHeadBytes: 256 * 1024,
  messageBytes: 64 * 1024,
  totalBytes: 512 * 1024,
  messages: 120,
  oldestMessageItems: 16,
  oldestMessageBytes: 128 * 1024,
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
  itemCount: number;
  reason: TranscriptUnavailableReason | null;
  /**
   * Two writers answered the same message, so this conversation has more than one
   * branch and the items below are only the most recently written one.
   *
   * A Claude transcript is a `uuid`/`parentUuid` DAG, and two clients sending at
   * once parent onto the same node — the well-formed two-branch shape
   * `--fork-session` produces. The reader walks one root-to-latest path, so
   * without this flag a fork is invisible: the rendered chain silently flips to
   * whichever branch appended last.
   */
  forked: boolean;
}

export interface TranscriptReadResult {
  items: TranscriptItem[];
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

export type TranscriptItemStatus = "running" | "complete" | "incomplete";

interface TranscriptItemBase {
  id: string;
  /** Exact provider identity shared with hook/API activity when one exists. */
  correlationId?: string | null;
  /** Exact provider prompt/turn identity when the transcript exposes it. */
  turnId: string | null;
  createdAt: string | null;
  status: TranscriptItemStatus;
}

/** Internal reader output. Conversation history is projected into ActivityItem. */
export interface TranscriptMessage extends TranscriptItemBase {
  kind: "message";
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  label: string | null;
  memoryCitation: ActivityMemoryCitation | null;
}

/**
 * A provider-written reasoning summary. Encrypted or opaque reasoning payloads
 * are never surfaced — only text the provider itself wrote in the clear.
 */
export interface TranscriptReasoning extends TranscriptItemBase {
  kind: "reasoning";
  text: string;
  label: string | null;
}

/**
 * One provider tool call, paired with its own result when the transcript
 * recorded one. `result === null` means the transcript has not paired an output
 * yet, never that the call returned nothing.
 */
export interface TranscriptToolCall extends TranscriptItemBase {
  kind: "tool";
  toolCallId: string;
  name: string;
  /** Exact provider argument spelling; an object only when the provider wrote one. */
  arguments: ActivityJsonValue | string | null;
  result: string | null;
  isError: boolean;
}

export type TranscriptItem = TranscriptMessage | TranscriptReasoning | TranscriptToolCall;

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
  stat: Stats;
  parent?: RootInfo;
}

interface OpenTranscript {
  descriptor: number;
  stat: Stats;
  identity: string;
}

interface JsonlRecord {
  object: Record<string, unknown>;
  offset: number;
  /** True when bounded reading skipped an unknown physical middle window. */
  gapBefore: boolean;
}

interface JsonlTail {
  records: JsonlRecord[];
  truncated: boolean;
}

interface FileWalkResult {
  matches: string[];
  exhausted: boolean;
}

interface ParsedItems {
  items: TranscriptItem[];
  truncated: boolean;
  forked?: boolean;
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
const MAX_CODEX_ROLLOUT_MEMO = 64;
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
    items: [],
    transcript: {
      state: "unavailable",
      truncated: false,
      source: null,
      itemCount: 0,
      reason,
      forked: false,
    },
  };
}

function available(
  provider: Provider,
  items: TranscriptItem[],
  truncated: boolean,
  forked = false,
): TranscriptReadResult {
  return {
    items,
    transcript: {
      state: "available",
      truncated,
      source: providerSource(provider),
      itemCount: items.length,
      reason: null,
      forked,
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
  let lexicalStat: Stats;
  let stat: Stats;
  try {
    lexicalStat = lstatSync(lexical);
    if (lexicalStat.isSymbolicLink()) failure("unreadable");
    canonical = realpathSync(lexical);
    stat = statSync(canonical);
  } catch (error) {
    if (error instanceof TranscriptReadFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    failure(code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "unreadable");
  }
  if (
    !lexicalStat.isDirectory() ||
    !stat.isDirectory() ||
    lexicalStat.uid !== uid ||
    stat.uid !== uid ||
    lexicalStat.dev !== stat.dev ||
    lexicalStat.ino !== stat.ino
  ) failure("unreadable");
  return { lexical, canonical, stat };
}

function childRootInfo(parent: RootInfo, path: string, uid: number): RootInfo {
  const child = rootInfo(path, uid);
  if (
    child.lexical === parent.lexical ||
    child.canonical === parent.canonical ||
    dirname(child.lexical) !== parent.lexical ||
    dirname(child.canonical) !== parent.canonical ||
    !isConfined(parent.lexical, child.lexical) ||
    !isConfined(parent.canonical, child.canonical)
  ) failure("unreadable");
  return { ...child, parent };
}

function rootStillTrusted(root: RootInfo, uid: number): boolean {
  try {
    const lexical = lstatSync(root.lexical);
    const canonical = realpathSync(root.lexical);
    return !lexical.isSymbolicLink() &&
      lexical.isDirectory() &&
      lexical.uid === uid &&
      lexical.dev === root.stat.dev &&
      lexical.ino === root.stat.ino &&
      canonical === root.canonical &&
      (root.parent === undefined || rootStillTrusted(root.parent, uid));
  } catch {
    return false;
  }
}

function optionalChildRootInfo(parent: RootInfo, path: string, uid: number): RootInfo | null {
  try {
    return childRootInfo(parent, path, uid);
  } catch (error) {
    if (error instanceof TranscriptReadFailure && error.reason === "not-found") return null;
    throw error;
  }
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
  if (!rootStillTrusted(root, uid)) failure("unreadable");
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
      after.ino !== before.ino ||
      !rootStillTrusted(root, uid)
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

function parseJsonlWindow(
  buffer: Buffer,
  requestedStart: number,
  discardLeadingPartial: boolean,
  reachesEnd: boolean,
  gapBefore: boolean,
): JsonlTail {
  let cursor = 0;
  let truncated = discardLeadingPartial || !reachesEnd;
  if (discardLeadingPartial) {
    const newline = buffer.indexOf(10);
    if (newline < 0) return { records: [], truncated: true };
    cursor = newline + 1;
  }

  const records: JsonlRecord[] = [];
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(10, cursor);
    if (newline < 0 && !reachesEnd) {
      truncated = true;
      break;
    }
    const end = newline < 0 ? buffer.length : newline;
    const line = buffer.subarray(cursor, end);
    if (line.length > 0 && !(line.length === 1 && line[0] === 13)) {
      const object = parseJsonObject(line);
      if (object) {
        records.push({
          object,
          offset: requestedStart + cursor,
          gapBefore: gapBefore && records.length === 0,
        });
      } else truncated = true;
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return { records, truncated };
}

/**
 * Reads complete physical JSONL records within one fixed byte budget. Large
 * provider files reserve a small oldest window for the opening conversation
 * and spend the remainder on newest activity. No skipped middle bytes are
 * decoded or inferred, and the first tail record carries an explicit gap so a
 * parser cannot accidentally extend a provider turn across unknown history.
 * Absolute byte offsets remain stable item identities.
 */
function readJsonlTail(file: OpenTranscript): JsonlTail {
  if (file.stat.size <= TRANSCRIPT_LIMITS.sourceBytes) {
    return parseJsonlWindow(
      readAt(file.descriptor, 0, file.stat.size),
      0,
      false,
      true,
      false,
    );
  }

  const headBytes = Math.min(
    TRANSCRIPT_LIMITS.sourceHeadBytes,
    TRANSCRIPT_LIMITS.sourceBytes,
  );
  const tailBytes = TRANSCRIPT_LIMITS.sourceBytes - headBytes;
  const tailStart = file.stat.size - tailBytes;
  const head = parseJsonlWindow(
    readAt(file.descriptor, 0, headBytes),
    0,
    false,
    false,
    false,
  );
  const tail = parseJsonlWindow(
    readAt(file.descriptor, tailStart, tailBytes),
    tailStart,
    true,
    true,
    true,
  );
  return {
    records: [...head.records, ...tail.records],
    truncated: true,
  };
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

function argumentsText(value: ActivityJsonValue | string | null): string {
  if (value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function capArguments(
  value: ActivityJsonValue | string | null,
): { value: ActivityJsonValue | string | null; truncated: boolean } {
  if (value === null) return { value: null, truncated: false };
  if (typeof value === "string") {
    const capped = utf8Prefix(value, TRANSCRIPT_LIMITS.messageBytes);
    return { value: capped.text, truncated: capped.truncated };
  }
  const serialized = argumentsText(value);
  if (Buffer.byteLength(serialized, "utf8") <= TRANSCRIPT_LIMITS.messageBytes) {
    return { value, truncated: false };
  }
  // A structure too large to carry degrades to its own bounded serialization
  // rather than being silently dropped or re-shaped into something smaller.
  return { value: utf8Prefix(serialized, TRANSCRIPT_LIMITS.messageBytes).text, truncated: true };
}

function itemBytes(item: TranscriptItem): number {
  return item.kind === "tool"
    ? Buffer.byteLength(argumentsText(item.arguments), "utf8")
      + Buffer.byteLength(item.result ?? "", "utf8")
    : Buffer.byteLength(item.text, "utf8");
}

function capItems(input: TranscriptItem[]): ParsedItems {
  let truncated = false;
  const perItem = input.flatMap((item): TranscriptItem[] => {
    if (item.kind === "tool") {
      const args = capArguments(item.arguments);
      const result = item.result === null
        ? null
        : utf8Prefix(item.result, TRANSCRIPT_LIMITS.messageBytes);
      truncated ||= args.truncated || (result?.truncated ?? false);
      return [{ ...item, arguments: args.value, result: result?.text ?? null }];
    }
    const capped = utf8Prefix(item.text, TRANSCRIPT_LIMITS.messageBytes);
    truncated ||= capped.truncated;
    if (capped.text.length === 0) return [];
    return [item.kind === "message"
      ? { ...item, text: capped.text }
      : { ...item, text: capped.text }];
  });

  // Reserve a small oldest-message lane before filling the remaining window
  // from the newest activity. A tool-heavy turn must not evict the opening
  // user/assistant exchange that identifies the conversation after restart.
  const retainedIndexes = new Set<number>();
  let totalBytes = 0;
  let oldestMessageBytes = 0;
  let oldestMessageItems = 0;
  for (let index = 0; index < perItem.length; index += 1) {
    const item = perItem[index];
    if (
      !item ||
      item.kind !== "message" ||
      (item.role !== "user" && item.role !== "assistant")
    ) continue;
    const bytes = itemBytes(item);
    if (
      oldestMessageItems >= TRANSCRIPT_LIMITS.oldestMessageItems ||
      oldestMessageBytes + bytes > TRANSCRIPT_LIMITS.oldestMessageBytes ||
      totalBytes + bytes > TRANSCRIPT_LIMITS.totalBytes
    ) continue;
    retainedIndexes.add(index);
    oldestMessageItems += 1;
    oldestMessageBytes += bytes;
    totalBytes += bytes;
  }

  for (let index = perItem.length - 1; index >= 0; index -= 1) {
    const item = perItem[index];
    if (!item || retainedIndexes.has(index)) continue;
    const bytes = itemBytes(item);
    if (
      retainedIndexes.size >= TRANSCRIPT_LIMITS.messages ||
      totalBytes + bytes > TRANSCRIPT_LIMITS.totalBytes
    ) {
      truncated = true;
      continue;
    }
    totalBytes += bytes;
    retainedIndexes.add(index);
  }
  const retained = [...retainedIndexes]
    .sort((left, right) => left - right)
    .flatMap((index) => perItem[index] ? [perItem[index]] : []);
  if (retained.length !== perItem.length) truncated = true;
  return { items: retained, truncated };
}

/**
 * A tool call that never received its output is only genuinely in flight when
 * it is the newest thing the transcript recorded. Anything older was abandoned,
 * and claiming otherwise would leave a dead session rendering as active.
 */
function settleToolCalls(items: TranscriptItem[]): TranscriptItem[] {
  const last = items.length - 1;
  return items.map((item, index) => (
    item.kind === "tool" && item.result === null && index !== last
      ? { ...item, status: "incomplete" as const }
      : item
  ));
}

function stableItemId(
  provider: Provider,
  providerId: string | null,
  fileIdentity: string,
  offset: number,
  namespace?: string,
): string {
  const prefix = namespace ? `${provider}:${namespace}` : provider;
  return providerId
    ? `${prefix}:${providerId}`
    : `${prefix}:file:${fileIdentity}:${String(offset)}`;
}

function correlationId(kind: "message" | "reasoning" | "tool", providerId: string | null): string | null {
  return providerId ? `${kind}:${providerId}` : null;
}

function syntheticCodexUserContext(text: string): boolean {
  const candidate = text.trim();
  return SYNTHETIC_CODEX_USER_ENVELOPES.some((pattern) => pattern.test(candidate));
}

/**
 * Codex writes the visible reasoning summary into `summary[].text`. The raw
 * chain of thought is only ever present as `encrypted_content`, which this
 * reader never touches — an opaque blob is not a fact about the session.
 */
function codexReasoningText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.summary)) return "";
  return payload.summary
    .flatMap((value) => {
      const block = objectValue(value);
      return typeof block?.text === "string" ? [block.text] : [];
    })
    .join("\n\n")
    .trim();
}

function codexArguments(payload: Record<string, unknown>): ActivityJsonValue | string | null {
  const encoded = payload.arguments;
  if (typeof encoded === "string") {
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (typeof parsed === "object" && parsed !== null) return parsed as ActivityJsonValue;
    } catch {
      // A non-JSON argument string is still the provider's exact spelling.
    }
    return encoded;
  }
  // Custom tools carry a free-form script, which is never JSON to begin with.
  return typeof payload.input === "string" ? payload.input : null;
}

function codexOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .flatMap((value) => {
        const block = objectValue(value);
        return typeof block?.text === "string" ? [block.text] : [];
      })
      .join("");
  }
  const record = objectValue(output);
  if (!record) return "";
  for (const key of ["output", "content", "text"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(record) ?? "";
}

function codexItems(
  tail: JsonlTail,
  fileIdentity: string,
  sessionId: string,
): ParsedItems {
  const items: TranscriptItem[] = [];
  const seenIds = new Set<string>();
  const seenAdjacent = new Set<string>();
  const toolIndex = new Map<string, number>();
  let previousKey: string | null = null;
  let truncated = tail.truncated;
  let activeTurnId: string | null = null;
  const turnByProviderId = new Map<string, string>();
  const citationByProviderId = new Map<string, ActivityMemoryCitation>();
  const assistantCandidates = new Map<string, number[]>();
  const canonicalAssistantTurns = new Set<string>();

  const finalizeTurn = (turnId: string): void => {
    const candidates = assistantCandidates.get(turnId) ?? [];
    if (canonicalAssistantTurns.has(turnId)) return;
    const index = candidates.at(-1);
    const item = index === undefined ? undefined : items[index];
    if (item?.kind !== "message" || item.role !== "assistant") return;
    item.correlationId = codexMessageCorrelationId(
      sessionId,
      turnId,
      "assistant",
      item.text,
    );
  };

  for (const record of tail.records) {
    if (record.gapBefore) {
      activeTurnId = null;
      turnByProviderId.clear();
      citationByProviderId.clear();
      previousKey = null;
      seenAdjacent.clear();
      toolIndex.clear();
    }
    const outer = record.object;
    const payload = objectValue(outer.payload);
    if (!payload) continue;

    if (outer.type === "event_msg") {
      const turnId = stringValue(payload.turn_id);
      if (payload.type === "task_started" && turnId) {
        activeTurnId = turnId;
      } else if (payload.type === "task_complete" && turnId) {
        finalizeTurn(turnId);
        if (activeTurnId === turnId) activeTurnId = null;
      } else if (payload.type === "turn_aborted" && turnId && activeTurnId === turnId) {
        activeTurnId = null;
      }
      const providerItem = objectValue(payload.item);
      if (turnId && providerItem) {
        for (const providerId of [
          stringValue(providerItem.id),
          stringValue(providerItem.call_id),
          stringValue(providerItem.tool_call_id),
        ]) {
          if (providerId) turnByProviderId.set(providerId, turnId);
        }
        const citation = parseMemoryCitation(
          providerItem.memory_citation ?? providerItem.memoryCitation,
        );
        const providerId = stringValue(providerItem.id);
        if (citation && providerId) citationByProviderId.set(providerId, citation);
      }
      continue;
    }

    if (outer.type === "turn_context") {
      const turnId = stringValue(payload.turn_id);
      if (turnId) activeTurnId = turnId;
      continue;
    }

    if (outer.type !== "response_item") continue;
    const createdAt = timestamp(outer.timestamp);

    if (payload.type === "reasoning") {
      const text = codexReasoningText(payload);
      if (!text) continue;
      const providerId = stringValue(payload.id);
      const id = stableItemId("codex", providerId, fileIdentity, record.offset, "reasoning");
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      items.push({
        kind: "reasoning",
        id,
        correlationId: providerId ? `reasoning:${providerId}:summary:0` : null,
        turnId: (providerId ? turnByProviderId.get(providerId) : null) ?? activeTurnId,
        text,
        createdAt,
        status: "complete",
        label: null,
      });
      continue;
    }

    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const name = stringValue(payload.name);
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (!name || !callId || toolIndex.has(callId)) continue;
      toolIndex.set(callId, items.length);
      items.push({
        kind: "tool",
        id: stableItemId("codex", callId, fileIdentity, record.offset, "tool"),
        correlationId: correlationId("tool", callId),
        turnId: turnByProviderId.get(callId)
          ?? (stringValue(payload.id) ? turnByProviderId.get(stringValue(payload.id)!) : undefined)
          ?? activeTurnId,
        toolCallId: callId,
        name,
        arguments: codexArguments(payload),
        result: null,
        isError: false,
        createdAt,
        status: "running",
      });
      continue;
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = stringValue(payload.call_id);
      const index = callId === null ? undefined : toolIndex.get(callId);
      const target = index === undefined ? undefined : items[index];
      if (target?.kind !== "tool") continue;
      target.result = codexOutputText(payload.output);
      target.isError = objectValue(payload.output)?.success === false;
      target.status = "complete";
      continue;
    }

    if (payload.type !== "message") continue;
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
    const extracted = extractTrailingMemoryCitation(parts.join("\n\n").trim());
    const text = extracted.text;
    if (!text) continue;
    const providerId = stringValue(payload.id) ?? stringValue(outer.id);
    const id = stableItemId("codex", providerId, fileIdentity, record.offset);
    if (seenIds.has(id)) continue;
    // A provider message id is an occurrence identity. Identical adjacent text
    // under two distinct ids is two real messages, even when Codex recorded the
    // same coarse timestamp for both. The conservative adjacency fallback is
    // reserved for legacy/id-less rollout rows only.
    const adjacentKey = providerId === null
      ? `${role}\u0000${createdAt ?? ""}\u0000${text}`
      : null;
    if (adjacentKey !== null && previousKey === adjacentKey && seenAdjacent.has(adjacentKey)) {
      continue;
    }
    seenIds.add(id);
    seenAdjacent.clear();
    if (adjacentKey !== null) seenAdjacent.add(adjacentKey);
    previousKey = adjacentKey;
    const passthrough = objectValue(payload.internal_chat_message_metadata_passthrough);
    const messageTurnId = (providerId ? turnByProviderId.get(providerId) : null)
      ?? stringValue(passthrough?.turn_id)
      ?? activeTurnId;
    const finalAssistant = messageTurnId !== null && role === "assistant" &&
      (payload.phase === "final_answer" || payload.phase === "final");
    items.push({
      kind: "message",
      id,
      correlationId: messageTurnId && role === "user"
        ? codexMessageCorrelationId(sessionId, messageTurnId, "user", text)
        : finalAssistant
        ? codexMessageCorrelationId(sessionId, messageTurnId, "assistant", text)
        : correlationId("message", providerId),
      turnId: messageTurnId,
      role,
      text,
      createdAt,
      status: "complete",
      label: null,
      memoryCitation: (providerId ? citationByProviderId.get(providerId) : null)
        ?? extracted.memoryCitation,
    });
    if (messageTurnId && role === "assistant") {
      const candidates = assistantCandidates.get(messageTurnId) ?? [];
      candidates.push(items.length - 1);
      assistantCandidates.set(messageTurnId, candidates);
      if (finalAssistant) canonicalAssistantTurns.add(messageTurnId);
    }
  }
  const capped = capItems(settleToolCalls(items));
  truncated ||= capped.truncated;
  // Codex rollouts are a flat event log with no parent pointers, so a fork is
  // not representable in one file and is never reported here.
  return { items: capped.items, truncated };
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
): { records: JsonlRecord[]; truncated: boolean; forked: boolean } {
  const agentIds = new Set<string>();
  for (const record of tail.records) {
    const agentId = stringValue(record.object.agentId);
    if (agentId) agentIds.add(agentId);
  }
  if (isChild && agentIds.size > 1) failure("unsupported");

  const segments: Array<{ records: JsonlRecord[]; gapBefore: boolean }> = [];
  for (const record of tail.records) {
    if (segments.length === 0 || record.gapBefore) {
      segments.push({ records: [], gapBefore: record.gapBefore });
    }
    segments.at(-1)?.records.push(record);
  }

  const records: JsonlRecord[] = [];
  const includedUuids = new Set<string>();
  let foundIdentity = false;
  let truncated = tail.truncated;
  let forked = false;

  for (const segment of segments) {
    const byUuid = new Map<string, JsonlRecord>();
    /*
      Sibling counts per parent, restricted to identity-matching records. A parent
      with more than one such child is a fork: two writers answered the same
      message. Only the chosen chain's parents are consulted, so an unrelated
      branch elsewhere in the file is not reported as this conversation forking.
    */
    const childCounts = new Map<string, number>();
    let latest: JsonlRecord | null = null;
    for (const record of segment.records) {
      const uuid = stringValue(record.object.uuid);
      if (uuid) {
        if (byUuid.has(uuid)) truncated = true;
        byUuid.set(uuid, record);
      }
      if (matchesClaudeIdentity(record.object, session, isChild)) {
        latest = record;
        const parentUuid = stringValue(record.object.parentUuid);
        if (parentUuid) childCounts.set(parentUuid, (childCounts.get(parentUuid) ?? 0) + 1);
      }
    }
    if (!latest) continue;
    foundIdentity = true;

    const segmentRecords: JsonlRecord[] = [];
    const visited = new Set<string>();
    let cursor: JsonlRecord | undefined = latest;
    while (cursor) {
      const uuid = stringValue(cursor.object.uuid);
      if (!uuid || visited.has(uuid)) {
        truncated = true;
        break;
      }
      visited.add(uuid);
      segmentRecords.push(cursor);
      if ((childCounts.get(uuid) ?? 0) > 1) forked = true;
      const parentUuid = stringValue(cursor.object.parentUuid);
      if (!parentUuid) break;
      const parent = byUuid.get(parentUuid);
      if (!parent) {
        truncated = true;
        break;
      }
      cursor = parent;
    }
    segmentRecords.reverse();

    let firstIncluded = true;
    for (const record of segmentRecords) {
      const uuid = stringValue(record.object.uuid);
      if (!uuid || includedUuids.has(uuid)) {
        truncated = true;
        continue;
      }
      includedUuids.add(uuid);
      records.push(segment.gapBefore && firstIncluded
        ? { ...record, gapBefore: true }
        : record);
      firstIncluded = false;
    }
  }

  if (!foundIdentity) failure("unsupported");
  if (records.length > MAX_CHAIN_RECORDS) {
    const oldestCount = Math.max(
      1,
      Math.floor(
        MAX_CHAIN_RECORDS *
          (TRANSCRIPT_LIMITS.sourceHeadBytes / TRANSCRIPT_LIMITS.sourceBytes),
      ),
    );
    const newestCount = MAX_CHAIN_RECORDS - oldestCount;
    const oldest = records.slice(0, oldestCount);
    const newest = records.slice(-newestCount);
    const firstNewest = newest[0];
    if (firstNewest) newest[0] = { ...firstNewest, gapBefore: true };
    records.splice(0, records.length, ...oldest, ...newest);
    truncated = true;
  }
  return { records, truncated, forked };
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

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = objectValue(value);
    return block ? [block] : [];
  });
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((value) => objectValue(value)?.type === "tool_result");
}

/** Flattens one `tool_result` block into the text a human would read. */
function claudeResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return contentBlocks(content)
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n\n");
}

function machineClaudeUser(object: Record<string, unknown>, text: string): boolean {
  const origin = objectValue(object.origin);
  const message = objectValue(object.message);
  return origin?.kind === "task-notification" ||
    object.promptSource === "system" ||
    message?.promptSource === "system" ||
    MACHINE_USER_PREFIX.test(text.trimStart());
}

/**
 * Walks one Claude assistant record's content blocks in the order the provider
 * wrote them, so a `thinking` block, a tool call and the answer keep their
 * recorded sequence. Claude streams one provider message through multiple JSONL
 * records; each visible text block keeps its record identity so text emitted
 * after a tool can never be merged back into a message above that tool.
 */
function claudeAssistantBlocks(
  outer: Record<string, unknown>,
  message: Record<string, unknown>,
  messageKey: string,
  providerMessageId: string | null,
  turnId: string | null,
  items: TranscriptItem[],
  seenItemIds: Set<string>,
  seenTextFragments: Map<string, Set<string>>,
  textItemsByProviderMessage: Map<string, number[]>,
  toolIndex: Map<string, number>,
): void {
  const createdAt = timestamp(outer.timestamp);
  const status = outer.isApiErrorMessage === true ? "incomplete" as const : "complete" as const;
  contentBlocks(message.content).forEach((block, index) => {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const text = block.thinking.trim();
      const id = `${messageKey}:thinking:${String(index)}`;
      if (!text || seenItemIds.has(id)) return;
      seenItemIds.add(id);
      items.push({
        kind: "reasoning",
        id,
        correlationId: providerMessageId
          ? `reasoning:${providerMessageId}:thinking:${String(index)}`
          : null,
        turnId,
        text,
        createdAt,
        status: "complete",
        label: null,
      });
      return;
    }
    if (block.type === "tool_use") {
      const name = stringValue(block.name);
      if (!name) return;
      const callId = stringValue(block.id) ?? `${messageKey}:${String(index)}`;
      if (toolIndex.has(callId)) return;
      toolIndex.set(callId, items.length);
      items.push({
        kind: "tool",
        id: `claude:tool:${callId}`,
        correlationId: correlationId("tool", callId),
        turnId,
        toolCallId: callId,
        name,
        arguments: (block.input ?? null) as ActivityJsonValue | null,
        result: null,
        isError: false,
        createdAt,
        status: "running",
      });
      return;
    }
    if (block.type !== "text" || typeof block.text !== "string") return;
    const text = block.text.trim();
    if (!text) return;
    const fragmentKey = providerMessageId ?? messageKey;
    const fragments = seenTextFragments.get(fragmentKey) ?? new Set<string>();
    if (fragments.has(text)) return;
    fragments.add(text);
    seenTextFragments.set(fragmentKey, fragments);
    const id = `${messageKey}:text:${String(index)}`;
    if (seenItemIds.has(id)) return;
    seenItemIds.add(id);
    const itemIndex = items.length;
    items.push({
      kind: "message",
      id,
      correlationId: null,
      turnId,
      role: "assistant",
      text,
      createdAt,
      status,
      label: null,
      memoryCitation: null,
    });
    if (providerMessageId) {
      const indexes = textItemsByProviderMessage.get(providerMessageId) ?? [];
      indexes.push(itemIndex);
      textItemsByProviderMessage.set(providerMessageId, indexes);
    }
  });
}

function claudeItems(
  tail: JsonlTail,
  fileIdentity: string,
  session: SessionIdentity,
  isChild: boolean,
): ParsedItems {
  const chain = claudeChain(tail, session, isChild);
  const items: TranscriptItem[] = [];
  const seenItemIds = new Set<string>();
  const seenTextFragments = new Map<string, Set<string>>();
  const textItemsByProviderMessage = new Map<string, number[]>();
  const toolIndex = new Map<string, number>();
  let activeTurnId: string | null = null;
  let truncated = chain.truncated;
  const forked = chain.forked;

  for (const record of chain.records) {
    // A result can only complete a tool call when both records belong to one
    // observed parent chain. Never infer that relationship across skipped
    // source bytes, even when an identifier happens to match.
    if (record.gapBefore) {
      toolIndex.clear();
      activeTurnId = null;
    }
    const outer = record.object;
    if (!matchesClaudeIdentity(outer, session, isChild) || outer.isMeta === true) continue;
    const message = objectValue(outer.message);
    if (!message) continue;
    const rowPromptId = stringValue(outer.promptId) ?? stringValue(outer.prompt_id);
    if (rowPromptId) activeTurnId = rowPromptId;
    if (outer.type === "user" && message.role === "user") {
      if (hasToolResult(message.content)) {
        for (const block of contentBlocks(message.content)) {
          const callId = block.type === "tool_result" ? stringValue(block.tool_use_id) : null;
          const index = callId === null ? undefined : toolIndex.get(callId);
          const target = index === undefined ? undefined : items[index];
          if (target?.kind !== "tool") continue;
          target.result = claudeResultText(block.content);
          target.isError = block.is_error === true;
          target.status = "complete";
        }
        continue;
      }
      const text = textBlocks(message.content).join("\n\n").trim();
      if (!text || machineClaudeUser(outer, text)) continue;
      const providerId = stringValue(outer.uuid);
      const promptId = rowPromptId;
      const id = stableItemId("claude", providerId, fileIdentity, record.offset);
      if (seenItemIds.has(id)) continue;
      seenItemIds.add(id);
      activeTurnId = promptId ?? providerId ?? activeTurnId;
      items.push({
        kind: "message",
        id,
        correlationId: correlationId("message", promptId ?? providerId),
        turnId: activeTurnId,
        role: "user",
        text,
        createdAt: timestamp(outer.timestamp),
        status: "complete",
        label: null,
        memoryCitation: null,
      });
      continue;
    }
    if (outer.type !== "assistant" || message.role !== "assistant") continue;
    const providerId = stringValue(message.id) ?? stringValue(outer.uuid);
    const recordId = stringValue(outer.uuid);
    const messageKey = stableItemId("claude", recordId, fileIdentity, record.offset);
    claudeAssistantBlocks(
      outer,
      message,
      messageKey,
      providerId,
      activeTurnId,
      items,
      seenItemIds,
      seenTextFragments,
      textItemsByProviderMessage,
      toolIndex,
    );
  }
  for (const [providerMessageId, indexes] of textItemsByProviderMessage) {
    const last = indexes.at(-1);
    const item = last === undefined ? undefined : items[last];
    if (item?.kind === "message") item.correlationId = correlationId("message", providerMessageId);
  }
  const capped = capItems(settleToolCalls(items));
  truncated ||= capped.truncated;
  return { items: capped.items, truncated, forked };
}

function stateDatabaseCandidates(codexHome: RootInfo, uid: number): string[] {
  const candidates: Array<{ path: string; root: boolean; version: number; mtimeMs: number }> = [];
  const sqlite = optionalChildRootInfo(codexHome, join(codexHome.lexical, "sqlite"), uid);
  for (const directory of [codexHome, sqlite].filter((value): value is RootInfo => value !== null)) {
    let entries;
    try {
      entries = readdirSync(directory.canonical, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.name.match(/^state_(\d+)\.sqlite$/);
      if (!match || !entry.isFile()) continue;
      const path = join(directory.canonical, entry.name);
      try {
        const lexical = lstatSync(path);
        const canonical = realpathSync(path);
        const stat = statSync(canonical);
        if (
          lexical.isSymbolicLink() ||
          !stat.isFile() ||
          lexical.uid !== uid ||
          stat.uid !== uid ||
          lexical.dev !== stat.dev ||
          lexical.ino !== stat.ino ||
          dirname(canonical) !== directory.canonical ||
          !isConfined(codexHome.canonical, canonical)
        ) continue;
        candidates.push({
          path: canonical,
          root: directory.canonical === codexHome.canonical,
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
  /*
    A path this same reader already resolved and validated for this session.
    Resolution is the expensive half — it opens a fresh state database, and can
    fall back to walking up to MAX_WALK_ENTRIES directory entries — while the
    selected session is re-read on a sub-second cadence for as long as its
    drawer is open. A hint is never trusted: it takes the identical confinement
    and header checks below, and a hint that fails any of them falls through to
    full resolution rather than failing the read.
  */
  hint?: string | undefined,
): { root: RootInfo; file: OpenTranscript; path: string } {
  if (!UUID_PATTERN.test(sessionId)) failure("unsupported");
  const codexHome = rootInfo(codexHomePath, uid);
  const roots = [
    optionalChildRootInfo(codexHome, join(codexHome.lexical, "sessions"), uid),
    optionalChildRootInfo(codexHome, join(codexHome.lexical, "archived_sessions"), uid),
  ].filter((root): root is RootInfo => root !== null);
  if (roots.length === 0) failure("not-found");
  if (hint !== undefined) {
    try {
      return codexFileFromCandidate(roots, sessionId, uid, hint);
    } catch {
      // A rotated, archived, or deleted rollout simply re-resolves below.
    }
  }
  const databasePath = rolloutFromDatabase(codexHome, uid, sessionId);
  let candidate: string;
  if (databasePath !== null) {
    candidate = databasePath;
  } else {
    const walked = roots.map((root) => walkMatchingFiles(root, (name) =>
      name.endsWith(`${sessionId}.jsonl`) &&
      name.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]?.toLowerCase() === sessionId.toLowerCase()
    ));
    if (walked.some((result) => result.exhausted)) failure("unsupported");
    const matches = walked.flatMap((result) => result.matches);
    if (matches.length === 0) failure("not-found");
    if (matches.length !== 1) failure("unsupported");
    candidate = matches[0] as string;
  }
  return codexFileFromCandidate(roots, sessionId, uid, candidate);
}

/** Confinement, filename identity, and header identity for one candidate path. */
function codexFileFromCandidate(
  roots: readonly RootInfo[],
  sessionId: string,
  uid: number,
  candidate: string,
): { root: RootInfo; file: OpenTranscript; path: string } {
  const pathId = basename(candidate).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  if (pathId?.toLowerCase() !== sessionId.toLowerCase()) failure("unsupported");
  const absoluteCandidate = resolve(candidate);
  const root = roots.find((candidateRoot) =>
    isConfined(candidateRoot.lexical, absoluteCandidate)
    || isConfined(candidateRoot.canonical, absoluteCandidate)
  );
  if (!root) failure("unreadable");
  const file = openTranscript(root, candidate, uid);
  try {
    if (validHeaderSessionId(file, sessionId)) return { root, file, path: absoluteCandidate };
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
  /*
    Rollout paths this reader has already resolved and validated, so a selected
    session polled every few hundred milliseconds stops re-opening a state
    database — and re-walking the sessions tree when that database has no row —
    on every tick. Bounded, because a long-lived manager sees many sessions.

    Only the path is remembered. Every read still re-opens the file and
    re-checks confinement and header identity, so a stale entry costs one failed
    open and then re-resolves.
  */
  readonly #codexRollouts = new Map<string, string>();

  constructor(options: LocalTranscriptReaderOptions = {}) {
    const home = options.homeDir ?? homedir();
    const env = options.env ?? process.env;
    this.#codexHome = options.codexHome ?? env.CODEX_HOME ?? join(home, ".codex");
    this.#claudeHome = options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
  }

  /** Keep the newest MAX_CODEX_ROLLOUT_MEMO entries, evicting oldest first. */
  #rememberCodexRollout(sessionId: string, path: string): void {
    if (this.#codexRollouts.get(sessionId) === path) return;
    this.#codexRollouts.delete(sessionId);
    this.#codexRollouts.set(sessionId, path);
    while (this.#codexRollouts.size > MAX_CODEX_ROLLOUT_MEMO) {
      const oldest = this.#codexRollouts.keys().next();
      if (oldest.done) break;
      this.#codexRollouts.delete(oldest.value);
    }
  }

  read(session: SessionIdentity): TranscriptReadResult {
    let file: OpenTranscript | null = null;
    try {
      if (session.provider === "codex") {
        const resolved = codexFile(
          this.#codexHome,
          session.providerThreadId,
          this.#uid,
          this.#codexRollouts.get(session.providerThreadId),
        );
        file = resolved.file;
        this.#rememberCodexRollout(session.providerThreadId, resolved.path);
        const parsed = codexItems(
          readJsonlTail(file),
          file.identity,
          session.providerThreadId,
        );
        return available("codex", parsed.items, parsed.truncated);
      }
      const claude = claudeFile(this.#claudeHome, session, this.#uid);
      file = claude.file;
      const parsed = claudeItems(
        readJsonlTail(file),
        file.identity,
        session,
        claude.isChild,
      );
      return available("claude", parsed.items, parsed.truncated, parsed.forked ?? false);
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
    // Search stays a conversation search. Tool arguments and results are
    // rendered in the thread but are not part of this route's contract.
    for (const message of transcript.items) {
      if (message.kind !== "message") continue;
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
