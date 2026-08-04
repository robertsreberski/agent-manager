#!/usr/bin/env -S node --experimental-strip-types

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  SESSION_STATUSES,
  emptyChildSummary,
  observeOnlyControl,
  unknownAccess,
  unknownMode,
  type AdapterResult,
  type AttentionKind,
  type ChildSummary,
  type CommandResult,
  type Diagnostic,
  type EffectiveAccess,
  type EvidenceConfidence,
  type ListingResult,
  type ProcessInfo,
  type Provider,
  type Runtime,
  type SessionAttention,
  type SessionKind,
  type SessionLifecycle,
  type SessionMode,
  type SessionRecord,
  type SessionStatus,
} from "./src/core/types.ts";
import {
  attachTmuxTerminals,
  discoverTmuxPanes,
} from "./src/core/tmux.ts";

export * from "./src/core/types.ts";

interface InternalListingResult extends ListingResult {
  selectedProviderCount: number;
  successfulProviderCount: number;
}

export interface CliOptions {
  json: boolean;
  includeChildren: boolean;
  recentWindowSeconds: number;
  providers: Set<Provider>;
  statuses: Set<SessionStatus> | null;
  help: boolean;
}

interface JsonObject {
  [key: string]: unknown;
}

interface TranscriptMetadata {
  sessionId: string | null;
  agentId: string | null;
  cwd: string | null;
  name: string | null;
  slug: string | null;
  entrypoint: string | null;
  earliestTimestampMs: number | null;
  latestTimestampMs: number | null;
  lastStopReason: string | null;
  failed: boolean;
  mode: SessionMode;
  attention: SessionAttention[];
  effectiveAccess: EffectiveAccess;
}

interface CodexClassification {
  status: SessionStatus;
  providerStatus: string | null;
  waitingReason: SessionRecord["waitingReason"];
}

interface CodexDbRow {
  id: string;
  rolloutPath: string;
  createdAtMs: number;
  updatedAtMs: number;
  cwd: string;
  title: string | null;
  source: string | null;
  threadSource: string | null;
  agentNickname: string | null;
  agentRole: string | null;
}

const STATUS_VALUES = SESSION_STATUSES;
const CLAUDE_CHILD_LIVE_FRESHNESS_MS = 15 * 60_000;

const TERMINAL_CLAUDE_STATES = new Set([
  "done",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
]);

const systemRuntime: Runtime = {
  now: () => Date.now(),
  homeDir: homedir(),
  env: process.env,
  run(command, args, timeoutMs = 5_000) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
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

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeText(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function boundedSummary(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return normalizeText(direct)?.slice(0, 240) ?? null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const summary = boundedSummary(item);
      if (summary) return summary;
    }
    return null;
  }
  const object = asObject(value);
  if (!object) return null;
  for (const key of ["question", "prompt", "message", "reason", "description", "title", "text"]) {
    const summary = boundedSummary(object[key]);
    if (summary) return summary;
  }
  for (const key of ["questions", "input", "request"]) {
    const summary = boundedSummary(object[key]);
    if (summary) return summary;
  }
  return null;
}

function evidencePriority(confidence: EvidenceConfidence): number {
  return confidence === "exact" ? 3 : confidence === "inferred" ? 2 : 1;
}

export function normalizeProviderMode(
  providerValue: string | null,
  source: SessionMode["source"],
  confidence: EvidenceConfidence = "exact",
): SessionMode {
  if (!providerValue) return unknownMode();
  const normalized = providerValue.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const value = normalized === "plan" || normalized === "planning" || normalized === "planmode"
    ? "planning"
    : "execution";
  return { value, providerValue, source, confidence };
}

function modeFromObject(
  object: JsonObject,
  source: SessionMode["source"],
): SessionMode {
  const payload = asObject(object.payload);
  const collaborationMode = asObject(payload?.collaboration_mode) ?? asObject(payload?.collaborationMode);
  const providerValue =
    asString(collaborationMode?.mode) ??
    asString(payload?.permissionMode) ??
    asString(payload?.permission_mode) ??
    asString(object.permissionMode) ??
    asString(object.permission_mode) ??
    (object.type === "permission-mode" ? asString(object.mode) : null);
  return normalizeProviderMode(providerValue, source);
}

function mergeModes(first: SessionMode, second: SessionMode): SessionMode {
  if (first.value === "unknown") return second;
  if (second.value === "unknown") return first;
  const firstPriority = evidencePriority(first.confidence);
  const secondPriority = evidencePriority(second.confidence);
  return secondPriority > firstPriority ? second : first;
}

function accessFromValues(
  permissionMode: string | null,
  sandboxMode: string | null,
): EffectiveAccess {
  const permission = permissionMode?.toLowerCase() ?? "";
  const sandbox = sandboxMode?.toLowerCase() ?? "";
  const bypassPermissions =
    permission.includes("bypass") ||
    permission.includes("dangerously") ||
    (sandbox.includes("danger-full-access") && (permission === "never" || permission.includes("bypass")));
  return {
    accessMode: bypassPermissions
      ? "bypass-permissions"
      : sandbox.includes("danger-full-access")
        ? "unknown"
      : permissionMode || sandboxMode
        ? "sandboxed"
        : "unknown",
    permissionMode,
    sandboxMode,
  };
}

function accessFromObject(object: JsonObject): EffectiveAccess {
  const payload = asObject(object.payload);
  const sandboxPolicy = asObject(payload?.sandbox_policy) ?? asObject(payload?.sandboxPolicy);
  return accessFromValues(
    asString(payload?.approval_policy) ??
      asString(payload?.approvalPolicy) ??
      asString(payload?.permissionMode) ??
      asString(object.permissionMode) ??
      asString(object.permission_mode),
    asString(sandboxPolicy?.type) ??
      asString(payload?.sandbox_mode) ??
      asString(payload?.sandboxMode) ??
      asString(object.sandboxMode) ??
      asString(object.sandbox_mode),
  );
}

function accessFromCommand(command: string): EffectiveAccess {
  const bypassCodex = /(?:^|\s)--dangerously-bypass-approvals-and-sandbox(?:\s|$)/.test(command);
  const bypassClaude = /(?:^|\s)--dangerously-skip-permissions(?:\s|$)/.test(command);
  const permissionMode = command.match(/(?:^|\s)--permission-mode(?:=|\s+)([^\s]+)/)?.[1]
    ?? command.match(/(?:^|\s)--ask-for-approval(?:=|\s+)([^\s]+)/)?.[1]
    ?? (bypassCodex ? "bypass-approvals" : bypassClaude ? "bypassPermissions" : null);
  const sandboxMode = command.match(/(?:^|\s)--sandbox(?:=|\s+)([^\s]+)/)?.[1]
    ?? (bypassCodex ? "danger-full-access" : null);
  return accessFromValues(permissionMode, sandboxMode);
}

function mergeAccess(first: EffectiveAccess, second: EffectiveAccess): EffectiveAccess {
  const permissionMode = first.permissionMode ?? second.permissionMode;
  const sandboxMode = first.sandboxMode ?? second.sandboxMode;
  const dangerFullAccess = sandboxMode?.toLowerCase().includes("danger-full-access") ?? false;
  return {
    accessMode: first.accessMode === "bypass-permissions" || second.accessMode === "bypass-permissions"
      ? "bypass-permissions"
      : dangerFullAccess
        ? "unknown"
      : first.accessMode === "sandboxed" || second.accessMode === "sandboxed"
        ? "sandboxed"
        : "unknown",
    permissionMode,
    sandboxMode,
  };
}

function attentionId(object: JsonObject, fallback: string | null = null): string | null {
  const payload = asObject(object.payload);
  return asString(payload?.requestId) ??
    asString(payload?.request_id) ??
    asString(payload?.callId) ??
    asString(payload?.call_id) ??
    asString(payload?.id) ??
    asString(object.requestId) ??
    asString(object.request_id) ??
    asString(object.callId) ??
    asString(object.call_id) ??
    asString(object.id) ??
    fallback;
}

function dedupeAttention(items: SessionAttention[]): SessionAttention[] {
  const result = new Map<string, SessionAttention>();
  for (const item of items) {
    const key = `${item.id ?? ""}:${item.kind}:${item.summary ?? ""}`;
    const existing = result.get(key);
    if (!existing || evidencePriority(item.confidence) > evidencePriority(existing.confidence)) {
      result.set(key, item);
    }
  }
  return [...result.values()];
}

function finalizeRecord(record: SessionRecord): SessionRecord {
  const attention = dedupeAttention(record.attention);
  const shouldWait = record.lifecycle === "live" && attention.length > 0;
  const status = shouldWait ? "waiting" : record.status;
  let waitingReason = record.waitingReason;
  if (shouldWait) {
    const kind = attention[0]?.kind;
    const derivedReason = kind === "question" || kind === "elicitation"
      ? "user-input"
      : kind === "blocked"
        ? "blocked"
        : "approval";
    if (!waitingReason || (waitingReason === "blocked" && derivedReason !== "blocked")) {
      waitingReason = derivedReason;
    }
  }
  return {
    ...record,
    runtimeAlive: record.runtimeAlive || record.lifecycle === "live",
    status,
    activity: status,
    waitingReason,
    attention,
  };
}

function toIso(value: number | null, fallback: number): string {
  const timestamp = value !== null && Number.isFinite(value) ? value : fallback;
  return new Date(timestamp).toISOString();
}

function maxIso(first: string, second: string): string {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs)) return second;
  if (!Number.isFinite(secondMs)) return first;
  return firstMs >= secondMs ? first : second;
}

function minNullableIso(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs)) return second;
  if (!Number.isFinite(secondMs)) return first;
  return firstMs <= secondMs ? first : second;
}

export function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}. Use values such as 15m, 1h, 1d, or 0.`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit === "d" ? 86_400 : unit === "h" ? 3_600 : unit === "m" ? 60 : 1;
  const seconds = Math.round(amount * multiplier);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(`Invalid duration: ${value}.`);
  }
  return seconds;
}

function optionValue(args: string[], index: number, option: string): [string, number] {
  const current = args[index];
  if (!current) throw new Error(`Missing value for ${option}.`);
  const equalsIndex = current.indexOf("=");
  if (equalsIndex >= 0) {
    const value = current.slice(equalsIndex + 1);
    if (!value) throw new Error(`Missing value for ${option}.`);
    return [value, index];
  }
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`Missing value for ${option}.`);
  return [next, index + 1];
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    includeChildren: false,
    recentWindowSeconds: 15 * 60,
    providers: new Set<Provider>(["codex", "claude"]),
    statuses: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--children") {
      options.includeChildren = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--since" || arg.startsWith("--since=")) {
      const [value, consumedIndex] = optionValue(args, index, "--since");
      options.recentWindowSeconds = parseDuration(value);
      index = consumedIndex;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const [value, consumedIndex] = optionValue(args, index, "--provider");
      const values = value.split(",").map((item) => item.trim().toLowerCase());
      if (values.includes("all")) {
        options.providers = new Set<Provider>(["codex", "claude"]);
      } else {
        const invalid = values.find((item) => item !== "codex" && item !== "claude");
        if (invalid || values.length === 0) {
          throw new Error(`Invalid provider: ${invalid ?? value}. Use codex, claude, or all.`);
        }
        options.providers = new Set(values as Provider[]);
      }
      index = consumedIndex;
    } else if (arg === "--status" || arg.startsWith("--status=")) {
      const [value, consumedIndex] = optionValue(args, index, "--status");
      const values = value.split(",").map((item) => item.trim().toLowerCase());
      const invalid = values.find((item) => !STATUS_VALUES.includes(item as SessionStatus));
      if (invalid || values.length === 0) {
        throw new Error(`Invalid status: ${invalid ?? value}. Use ${STATUS_VALUES.join(", ")}.`);
      }
      options.statuses = new Set(values as SessionStatus[]);
      index = consumedIndex;
    } else {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    }
  }

  return options;
}

export function parseProcessTable(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(\S+)\s+(\S+)\s+(.+)$/;

  for (const line of output.split("\n")) {
    const match = line.match(pattern);
    if (!match) continue;
    const pid = match[1] ?? "0";
    const ppid = match[2] ?? "0";
    const month = match[4] ?? "Jan";
    const day = match[5] ?? "1";
    const clock = match[6] ?? "00:00:00";
    const year = match[7] ?? "1970";
    const tty = match[8] ?? "?";
    const state = match[9] ?? "?";
    const command = match[10] ?? "";
    const firstToken = command.trim().split(/\s+/, 1)[0] ?? "";
    const startedAtMs = Date.parse(`${month} ${day}, ${year} ${clock}`);
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      tty,
      state,
      command,
      executable: basename(firstToken),
    });
  }
  return processes;
}

function loadProcessTable(runtime: Runtime): { processes: ProcessInfo[]; diagnostic: Diagnostic | null } {
  const result = runtime.run(
    existsSync("/bin/ps") ? "/bin/ps" : "ps",
    ["-axo", "pid=,ppid=,lstart=,tty=,stat=,command="],
    3_000,
  );
  if (result.status !== 0 || result.error) {
    return {
      processes: [],
      diagnostic: {
        provider: "system",
        level: "warning",
        message: `Could not read the process table: ${result.error?.message ?? (result.stderr.trim() || "unknown error")}`,
      },
    };
  }
  return { processes: parseProcessTable(result.stdout), diagnostic: null };
}

function commandIsClaude(processInfo: ProcessInfo): boolean {
  return processInfo.executable === "claude";
}

function commandIsCodex(processInfo: ProcessInfo): boolean {
  return processInfo.executable === "codex";
}

function parseLsofOutput(output: string): { cwd: string | null; paths: string[] } {
  let descriptor = "";
  let cwd: string | null = null;
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("f")) {
      descriptor = line.slice(1);
    } else if (line.startsWith("n")) {
      const value = line.slice(1);
      if (descriptor === "cwd") cwd = value;
      else if (value.startsWith("/")) paths.push(value);
    }
  }
  return { cwd, paths };
}

function jsonLinesFromEdges(file: string, firstBytes = 256 * 1024, lastBytes = 768 * 1024): JsonObject[] {
  let fileDescriptor: number | null = null;
  try {
    const size = statSync(file).size;
    fileDescriptor = openSync(file, "r");
    const sections: string[] = [];

    const firstLength = Math.min(size, firstBytes);
    if (firstLength > 0) {
      const firstBuffer = Buffer.alloc(firstLength);
      const bytesRead = readSync(fileDescriptor, firstBuffer, 0, firstLength, 0);
      sections.push(firstBuffer.subarray(0, bytesRead).toString("utf8"));
    }

    if (size > firstLength) {
      const offset = Math.max(firstLength, size - lastBytes);
      const lastLength = size - offset;
      const lastBuffer = Buffer.alloc(lastLength);
      const bytesRead = readSync(fileDescriptor, lastBuffer, 0, lastLength, offset);
      let text = lastBuffer.subarray(0, bytesRead).toString("utf8");
      if (offset > 0) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      }
      sections.push(text);
    }

    const objects: JsonObject[] = [];
    const seen = new Set<string>();
    for (const section of sections) {
      for (const line of section.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        try {
          const value = JSON.parse(trimmed);
          const object = asObject(value);
          if (object) objects.push(object);
        } catch {
          // Partial JSONL edge lines are expected and are ignored.
        }
      }
    }
    return objects;
  } catch {
    return [];
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
  }
}

function walkJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
    }
  }
  return files;
}

export function parseTranscriptMetadata(objects: JsonObject[]): TranscriptMetadata {
  let sessionId: string | null = null;
  let agentId: string | null = null;
  let cwd: string | null = null;
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  let slug: string | null = null;
  let entrypoint: string | null = null;
  let earliestTimestampMs: number | null = null;
  let latestTimestampMs: number | null = null;
  let lastStopReason: string | null = null;
  let failed = false;
  let mode = unknownMode();
  let effectiveAccess = unknownAccess();
  const pending = new Map<string, SessionAttention>();

  for (const object of objects) {
    sessionId = asString(object.sessionId) ?? sessionId;
    agentId = asString(object.agentId) ?? agentId;
    cwd = asString(object.cwd) ?? cwd;
    slug = asString(object.slug) ?? slug;
    entrypoint = asString(object.entrypoint) ?? entrypoint;
    if (object.type === "ai-title") aiTitle = asString(object.aiTitle) ?? aiTitle;
    if (object.type === "agent-name") agentName = asString(object.agentName) ?? agentName;

    const observedMode = modeFromObject(object, "transcript");
    if (observedMode.value !== "unknown") mode = observedMode;
    effectiveAccess = mergeAccess(accessFromObject(object), effectiveAccess);

    const timestamp = asString(object.timestamp);
    if (timestamp) {
      const timestampMs = Date.parse(timestamp);
      if (Number.isFinite(timestampMs)) {
        earliestTimestampMs = earliestTimestampMs === null ? timestampMs : Math.min(earliestTimestampMs, timestampMs);
        latestTimestampMs = latestTimestampMs === null ? timestampMs : Math.max(latestTimestampMs, timestampMs);
      }
    }

    const message = asObject(object.message);
    const stopReason = asString(message?.stop_reason);
    if (stopReason) {
      lastStopReason = stopReason;
      failed = false;
    }
    const failedEvent =
      object.isApiErrorMessage === true ||
      object.type === "error" ||
      object.subtype === "error" ||
      object.subtype === "api_error";
    if (failedEvent) {
      failed = true;
    }

    // Transcript requests are fallback evidence. A later user message,
    // terminal assistant boundary, or failure cancels any unmatched request
    // even when an interruption prevented a tool_result from being flushed.
    if (
      object.type === "user"
      || failedEvent
      || (object.type === "assistant" && stopReason !== null && stopReason !== "tool_use")
    ) {
      pending.clear();
    }

    const content = message?.content;
    if (Array.isArray(content)) {
      for (const value of content) {
        const block = asObject(value);
        if (!block) continue;
        const blockType = asString(block.type);
        if (blockType === "tool_use") {
          const name = asString(block.name);
          if (name !== "AskUserQuestion" && name !== "ExitPlanMode") continue;
          const id = asString(block.id) ?? `anonymous:${pending.size}`;
          pending.set(id, {
            id: asString(block.id),
            kind: name === "AskUserQuestion" ? "question" : "approval",
            summary: boundedSummary(block.input),
            source: "transcript",
            confidence: asString(block.id) ? "exact" : "inferred",
          });
        } else if (blockType === "tool_result") {
          const resolvedId = asString(block.tool_use_id);
          if (resolvedId) pending.delete(resolvedId);
        }
      }
    }
  }

  return {
    sessionId,
    agentId,
    cwd,
    name: normalizeText(agentName ?? aiTitle ?? slug),
    slug,
    entrypoint,
    earliestTimestampMs,
    latestTimestampMs,
    lastStopReason,
    failed,
    mode,
    attention: [...pending.values()],
    effectiveAccess,
  };
}

function baseRecord(
  provider: Provider,
  sessionId: string,
  nowMs: number,
): Pick<
  SessionRecord,
  | "provider"
  | "sessionId"
  | "rootSessionId"
  | "depth"
  | "childSummary"
  | "updatedAt"
  | "ownership"
  | "runtimeAlive"
  | "mode"
  | "activity"
  | "attention"
  | "effectiveAccess"
  | "terminal"
  | "control"
  | "generation"
> {
  return {
    provider,
    sessionId,
    rootSessionId: sessionId,
    depth: 0,
    childSummary: emptyChildSummary(),
    updatedAt: new Date(nowMs).toISOString(),
    ownership: "external",
    runtimeAlive: false,
    mode: unknownMode(),
    activity: "unknown",
    attention: [],
    effectiveAccess: unknownAccess(),
    terminal: null,
    control: observeOnlyControl(),
    generation: 0,
  };
}

function mapClaudeStatus(rawStatus: string | null, hasPid: boolean): {
  status: SessionStatus;
  waitingReason: SessionRecord["waitingReason"];
} {
  switch (rawStatus?.toLowerCase()) {
    case "busy":
    case "running":
    case "in_progress":
      return { status: "running", waitingReason: null };
    case "idle":
      return { status: "idle", waitingReason: null };
    case "blocked":
    case "pending":
    case "waiting":
      return { status: "waiting", waitingReason: "blocked" };
    case "failed":
      return { status: "failed", waitingReason: null };
    case "done":
    case "completed":
      return { status: "completed", waitingReason: null };
    case "cancelled":
    case "canceled":
    case "stopped":
      return { status: "interrupted", waitingReason: null };
    default:
      return { status: hasPid ? "running" : "unknown", waitingReason: null };
  }
}

function attentionKindFromText(value: string | null, fallback: AttentionKind): AttentionKind {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("question") || normalized.includes("user") || normalized.includes("input")) return "question";
  if (normalized.includes("permission")) return "permission";
  if (normalized.includes("sandbox")) return "sandbox";
  if (normalized.includes("elicitation")) return "elicitation";
  if (normalized.includes("approval") || normalized.includes("approve")) return "approval";
  return fallback;
}

function claudeAttentionFromObject(
  object: JsonObject,
  source: "provider-cli" | "live-registry",
): SessionAttention[] {
  const waitingFor = object.waitingFor ?? object.waiting_for;
  if (waitingFor !== undefined && waitingFor !== null && waitingFor !== false) {
    const values = Array.isArray(waitingFor) ? waitingFor : [waitingFor];
    return values.map((value, index) => {
      const request = asObject(value);
      const type = request
        ? asString(request.type) ?? asString(request.kind) ?? asString(request.toolName)
        : asString(value);
      const id = request
        ? asString(request.requestId) ?? asString(request.request_id) ?? asString(request.id)
        : null;
      return {
        id,
        kind: attentionKindFromText(type, "question"),
        summary: boundedSummary(value),
        source,
        confidence: id || request ? "exact" : "inferred",
      };
    });
  }

  const rawStatus = asString(object.status) ?? asString(object.state);
  if (rawStatus?.toLowerCase() === "blocked") {
    return [{
      id: null,
      kind: "blocked",
      summary: boundedSummary(object.blockedReason ?? object.reason),
      source,
      confidence: "heuristic",
    }];
  }
  return [];
}

function processAccess(record: SessionRecord, processMap: Map<number, ProcessInfo>): EffectiveAccess {
  const processInfo = (record.pid !== null ? processMap.get(record.pid) : null)
    ?? (record.runtimePid !== null ? processMap.get(record.runtimePid) : null)
    ?? null;
  return processInfo ? accessFromCommand(processInfo.command) : unknownAccess();
}

function parseClaudeRegistry(
  claudeHome: string,
  processMap: Map<number, ProcessInfo>,
  nowMs: number,
): SessionRecord[] {
  const registryDirectory = join(claudeHome, "sessions");
  if (!existsSync(registryDirectory)) return [];
  const records: SessionRecord[] = [];
  let entries;
  try {
    entries = readdirSync(registryDirectory, { withFileTypes: true });
  } catch {
    return records;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const object = asObject(JSON.parse(readFileSync(join(registryDirectory, entry.name), "utf8")));
      if (!object) continue;
      const pid = asNumber(object.pid);
      const sessionId = asString(object.sessionId);
      if (pid === null || !sessionId) continue;
      const processInfo = processMap.get(pid);
      if (!processInfo || !commandIsClaude(processInfo)) continue;

      const recordedStart = asString(object.procStart);
      if (recordedStart && processInfo.startedAtMs !== null) {
        const recordedStartMs = Date.parse(recordedStart);
        if (Number.isFinite(recordedStartMs) && Math.abs(recordedStartMs - processInfo.startedAtMs) > 2_000) continue;
      }

      const rawStatus = asString(object.status);
      const mapped = mapClaudeStatus(rawStatus, true);
      const entrypoint = asString(object.entrypoint);
      const commandLooksBatch = /(?:^|\s)(?:-p|--print)(?:\s|$)/.test(processInfo.command);
      const kind: SessionKind = entrypoint === "sdk-cli" || commandLooksBatch ? "batch" : "interactive";
      const startedAtMs = asNumber(object.startedAt) ?? processInfo.startedAtMs;
      const updatedAtMs = asNumber(object.updatedAt) ?? asNumber(object.statusUpdatedAt) ?? startedAtMs ?? nowMs;

      records.push({
        ...baseRecord("claude", sessionId, nowMs),
        parentSessionId: null,
        name: normalizeText(asString(object.name)),
        cwd: asString(object.cwd),
        kind,
        lifecycle: "live",
        status: mapped.status,
        providerStatus: rawStatus,
        waitingReason: mapped.waitingReason,
        pid,
        runtimePid: pid,
        startedAt: toIso(startedAtMs, nowMs),
        updatedAt: toIso(updatedAtMs, nowMs),
        statusSource: "live-registry",
        source: entrypoint,
        mode: modeFromObject(object, "live-registry"),
        attention: claudeAttentionFromObject(object, "live-registry"),
        effectiveAccess: mergeAccess(accessFromObject(object), accessFromCommand(processInfo.command)),
      });
    } catch {
      // Stale or partially-written registry files are ignored.
    }
  }
  return records;
}

function claudeTranscriptRecord(
  file: string,
  metadata: TranscriptMetadata,
  lifecycle: SessionLifecycle,
  nowMs: number,
  terminalState: JsonObject | null,
  parentSessionId: string | null,
): SessionRecord {
  const stat = statSync(file);
  const rawTerminalStatus = asString(terminalState?.state);
  let status: SessionStatus;
  let waitingReason: SessionRecord["waitingReason"] = null;
  if (lifecycle === "live") {
    if (metadata.failed) status = "failed";
    else if (metadata.lastStopReason === "end_turn") status = "idle";
    else status = "running";
  } else if (rawTerminalStatus) {
    const mapped = mapClaudeStatus(rawTerminalStatus, false);
    // Agent View can retain blocked rows long after their process exits. A
    // historical provider state is useful context, but it is not evidence of
    // a live pending question or approval.
    if (mapped.status === "waiting") {
      status = "unknown";
      waitingReason = null;
    } else {
      status = mapped.status;
      waitingReason = mapped.waitingReason;
    }
  } else if (metadata.failed) {
    status = "failed";
  } else if (metadata.lastStopReason === "end_turn") {
    status = "completed";
  } else {
    status = "interrupted";
  }

  const sessionId = parentSessionId
    ? metadata.agentId ?? basename(file, ".jsonl")
    : metadata.sessionId ?? basename(file, ".jsonl");
  const commandName = normalizeText(asString(terminalState?.name));
  const kind: SessionKind = parentSessionId
    ? "subagent"
    : metadata.entrypoint === "sdk-cli"
      ? "batch"
      : (asString(terminalState?.kind) as SessionKind | null) ?? "interactive";
  const startedAtMs = metadata.earliestTimestampMs ?? asNumber(terminalState?.startedAt);

  return {
    ...baseRecord("claude", sessionId, nowMs),
    parentSessionId,
    name: metadata.name ?? commandName,
    cwd: metadata.cwd ?? asString(terminalState?.cwd),
    kind,
    lifecycle,
    status,
    providerStatus: rawTerminalStatus ?? metadata.lastStopReason,
    waitingReason,
    pid: null,
    runtimePid: null,
    startedAt: startedAtMs === null ? null : toIso(startedAtMs, nowMs),
    updatedAt: toIso(Math.max(stat.mtimeMs, metadata.latestTimestampMs ?? 0), nowMs),
    statusSource: "transcript",
    source: metadata.entrypoint,
    mode: metadata.mode,
    attention: lifecycle === "live" ? metadata.attention : [],
    effectiveAccess: metadata.effectiveAccess,
  };
}

export function discoverClaude(
  runtime: Runtime,
  processes: ProcessInfo[],
  recentWindowSeconds: number,
): AdapterResult {
  const diagnostics: Diagnostic[] = [];
  const records: SessionRecord[] = [];
  const nowMs = runtime.now();
  const cutoffMs = nowMs - recentWindowSeconds * 1_000;
  const claudeHome = runtime.env.CLAUDE_CONFIG_DIR ?? join(runtime.homeDir, ".claude");
  const processMap = new Map(processes.map((item) => [item.pid, item]));
  let commandSucceeded = false;
  const activeIds = new Set<string>();
  const terminalById = new Map<string, JsonObject>();

  const commandResult = runtime.run("claude", ["agents", "--json", "--all"], 4_000);
  if (commandResult.status === 0 && !commandResult.error) {
    try {
      const payload = JSON.parse(commandResult.stdout);
      if (!Array.isArray(payload)) throw new Error("expected an array");
      commandSucceeded = true;
      for (const value of payload) {
        const object = asObject(value);
        if (!object) continue;
        const sessionId = asString(object.sessionId);
        if (!sessionId) continue;
        const pid = asNumber(object.pid);
        const rawStatus = asString(object.status) ?? asString(object.state);
        const state = asString(object.state)?.toLowerCase() ?? null;
        const startedAtMs = asNumber(object.startedAt);
        const processInfo = pid === null ? null : processMap.get(pid) ?? null;
        const processStartMatches = processInfo !== null && (
          startedAtMs === null
          || processInfo.startedAtMs === null
          || Math.abs(startedAtMs - processInfo.startedAtMs) <= 5_000
        );
        const processIsLive = processInfo !== null
          && commandIsClaude(processInfo)
          && processStartMatches;
        const providerSaysNonterminal = state !== null && !TERMINAL_CLAUDE_STATES.has(state);

        if (!processIsLive) {
          terminalById.set(sessionId, object);
          // CLI rows without a validated Claude PID are historical evidence,
          // even when Agent View still calls them blocked/working. Retain a
          // bounded recent breadcrumb without advertising live attention.
          if (providerSaysNonterminal && startedAtMs !== null && startedAtMs >= cutoffMs) {
            const rawKind = asString(object.kind);
            records.push({
              ...baseRecord("claude", sessionId, nowMs),
              parentSessionId: null,
              name: normalizeText(asString(object.name)),
              cwd: asString(object.cwd),
              kind: rawKind === "background" ? "background" : "unknown",
              lifecycle: "recent",
              status: "unknown",
              providerStatus: rawStatus,
              waitingReason: null,
              pid: null,
              runtimePid: null,
              startedAt: toIso(startedAtMs, nowMs),
              updatedAt: toIso(startedAtMs, nowMs),
              statusSource: "provider-cli",
              source: rawKind,
              mode: modeFromObject(object, "provider-cli"),
              attention: [],
              effectiveAccess: accessFromObject(object),
            });
          }
          continue;
        }

        activeIds.add(sessionId);
        const mapped = mapClaudeStatus(rawStatus, true);
        const commandLooksBatch = processInfo
          ? /(?:^|\s)(?:-p|--print)(?:\s|$)/.test(processInfo.command)
          : false;
        const rawKind = asString(object.kind);
        const kind: SessionKind = commandLooksBatch
          ? "batch"
          : rawKind === "background"
            ? "background"
            : rawKind === "interactive"
              ? "interactive"
              : "unknown";
        records.push({
          ...baseRecord("claude", sessionId, nowMs),
          parentSessionId: null,
          name: normalizeText(asString(object.name)),
          cwd: asString(object.cwd),
          kind,
          lifecycle: "live",
          status: mapped.status,
          providerStatus: rawStatus,
          waitingReason: mapped.waitingReason,
          pid: processIsLive ? pid : null,
          runtimePid: processIsLive ? pid : null,
          startedAt: startedAtMs === null ? null : toIso(startedAtMs, nowMs),
          updatedAt: startedAtMs === null ? new Date(nowMs).toISOString() : toIso(startedAtMs, nowMs),
          statusSource: "provider-cli",
          source: rawKind,
          mode: modeFromObject(object, "provider-cli"),
          attention: claudeAttentionFromObject(object, "provider-cli"),
          effectiveAccess: mergeAccess(
            accessFromObject(object),
            processInfo ? accessFromCommand(processInfo.command) : unknownAccess(),
          ),
        });
      }
    } catch (error) {
      diagnostics.push({
        provider: "claude",
        level: "warning",
        message: `Could not parse claude agents --json --all; using local registry fallback: ${(error as Error).message}`,
      });
    }
  } else {
    diagnostics.push({
      provider: "claude",
      level: "warning",
      message: `claude agents --json --all was unavailable; using local registry fallback: ${commandResult.error?.message ?? (commandResult.stderr.trim() || "command failed")}`,
    });
  }

  const registryRecords = parseClaudeRegistry(claudeHome, processMap, nowMs);
  for (const record of registryRecords) {
    records.push(record);
    activeIds.add(record.sessionId);
  }

  const projectsDirectory = join(claudeHome, "projects");
  const transcriptAccess = existsSync(projectsDirectory);
  for (const file of walkJsonlFiles(projectsDirectory)) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const parts = file.split(sep);
    const subagentsIndex = parts.lastIndexOf("subagents");
    const isChild = subagentsIndex >= 1;
    const parentSessionId = isChild ? parts[subagentsIndex - 1] ?? null : null;
    const fileSessionId = basename(file, ".jsonl");
    const topLevelActive = activeIds.has(fileSessionId);
    const parentActive = parentSessionId !== null && activeIds.has(parentSessionId);
    const recent = recentWindowSeconds > 0 && stat.mtimeMs >= cutoffMs;
    if (!recent && !topLevelActive && !parentActive) continue;

    const metadata = parseTranscriptMetadata(jsonLinesFromEdges(file));
    const childFresh = stat.mtimeMs >= nowMs - CLAUDE_CHILD_LIVE_FRESHNESS_MS;
    const childLooksActive = parentActive
      && childFresh
      && !metadata.failed
      && (metadata.lastStopReason === null || metadata.lastStopReason === "tool_use");
    const lifecycle: SessionLifecycle = isChild
      ? childLooksActive
        ? "live"
        : "recent"
      : activeIds.has(metadata.sessionId ?? fileSessionId)
        ? "live"
        : "recent";
    if (lifecycle === "recent" && !recent) continue;
    const terminalState = terminalById.get(metadata.sessionId ?? fileSessionId) ?? null;
    records.push(
      claudeTranscriptRecord(file, metadata, lifecycle, nowMs, terminalState, parentSessionId),
    );
  }

  const succeeded = commandSucceeded || existsSync(join(claudeHome, "sessions")) || transcriptAccess;
  if (!succeeded) {
    diagnostics.push({
      provider: "claude",
      level: "error",
      message: `No readable Claude session source was found under ${claudeHome}.`,
    });
  }
  return {
    sessions: records.map((record) => finalizeRecord({
      ...record,
      effectiveAccess: mergeAccess(record.effectiveAccess, processAccess(record, processMap)),
    })),
    diagnostics,
    succeeded,
  };
}

function codexEventType(object: JsonObject): { type: string | null; name: string | null } {
  if (object.type === "event_msg") {
    const payload = asObject(object.payload);
    return { type: asString(payload?.type), name: null };
  }
  if (object.type === "response_item") {
    const payload = asObject(object.payload);
    return { type: asString(payload?.type), name: asString(payload?.name) };
  }
  return { type: asString(object.type), name: null };
}

interface CodexAnalysis extends CodexClassification {
  mode: SessionMode;
  attention: SessionAttention[];
  effectiveAccess: EffectiveAccess;
}

function codexRequestKind(type: string, name: string | null): AttentionKind | null {
  if (type === "request_user_input" || (type === "custom_tool_call" && name === "request_user_input")) {
    return "question";
  }
  if (type === "elicitation_request") return "elicitation";
  if (type === "request_permissions") return "permission";
  if (type === "exec_approval_request" || type === "apply_patch_approval_request") return "approval";
  return null;
}

function codexResolutionId(object: JsonObject, type: string): string | null {
  const payload = asObject(object.payload);
  if (type === "custom_tool_call_output") {
    return asString(payload?.call_id) ?? asString(payload?.callId) ?? asString(payload?.tool_use_id);
  }
  if (
    type === "server_request_resolved" ||
    type === "request_resolved" ||
    type.endsWith("_approval_response") ||
    type === "permissions_response" ||
    type === "elicitation_response" ||
    type === "request_user_input_response"
  ) {
    return attentionId(object);
  }
  return null;
}

export function analyzeCodexObjects(
  objects: JsonObject[],
  lifecycle: SessionLifecycle,
): CodexAnalysis {
  let state: "running" | "waiting" | "completed" | "failed" | "interrupted" | "empty" = "empty";
  let providerStatus: string | null = null;
  let mode = unknownMode();
  let effectiveAccess = unknownAccess();
  const pending = new Map<string, SessionAttention>();

  for (const [index, object] of objects.entries()) {
    const event = codexEventType(object);
    if (!event.type) continue;
    const type = event.type;
    if (type === "token_count" || type.endsWith("_delta") || type === "turn_diff") continue;

    const observedMode = modeFromObject(object, "rollout-events");
    if (observedMode.value !== "unknown") mode = observedMode;
    effectiveAccess = mergeAccess(accessFromObject(object), effectiveAccess);

    const resolvedId = codexResolutionId(object, type);
    if (resolvedId) {
      pending.delete(resolvedId);
      if (pending.size === 0 && state === "waiting") {
        state = "running";
        providerStatus = type;
      }
    }

    const requestKind = codexRequestKind(type, event.name);
    if (requestKind) {
      const exactId = attentionId(object);
      const id = exactId ?? `anonymous:${type}:${index}`;
      pending.set(id, {
        id: exactId,
        kind: requestKind,
        summary: boundedSummary(asObject(object.payload) ?? object),
        source: "rollout-events",
        confidence: exactId ? "exact" : "inferred",
      });
      state = "waiting";
      providerStatus = type;
      continue;
    }

    if (type === "task_complete" || type === "turn_complete") {
      state = "completed";
      providerStatus = type;
      // A terminal turn cannot still be awaiting an in-turn response. Exact
      // response events normally remove these first; this handles old formats.
      pending.clear();
    } else if (type === "turn_aborted") {
      state = "interrupted";
      providerStatus = type;
      pending.clear();
    } else if (type === "error") {
      state = "failed";
      providerStatus = type;
      pending.clear();
    } else if (
      type === "session_meta" ||
      type === "inter_agent_communication_metadata" ||
      type === "turn_context"
    ) {
      if (type === "turn_context") {
        state = "running";
        providerStatus = type;
      }
    } else if (!resolvedId) {
      state = "running";
      providerStatus = type;
    }
  }

  const attention = [...pending.values()];
  const firstKind = attention[0]?.kind ?? null;
  const waitingReason: SessionRecord["waitingReason"] = firstKind === "question" || firstKind === "elicitation"
    ? "user-input"
    : firstKind
      ? "approval"
      : null;

  let classification: CodexClassification;
  if (lifecycle === "live") {
    if (attention.length > 0 || state === "waiting") {
      classification = { status: "waiting", providerStatus, waitingReason };
    } else if (state === "running") {
      classification = { status: "running", providerStatus, waitingReason: null };
    } else {
      classification = { status: "idle", providerStatus, waitingReason: null };
    }
  } else if (state === "completed") {
    classification = { status: "completed", providerStatus, waitingReason: null };
  } else if (state === "failed") {
    classification = { status: "failed", providerStatus, waitingReason: null };
  } else if (state === "interrupted" || state === "running" || state === "waiting") {
    classification = { status: "interrupted", providerStatus, waitingReason: null };
  } else {
    classification = { status: "unknown", providerStatus, waitingReason: null };
  }

  return { ...classification, mode, attention, effectiveAccess };
}

export function classifyCodexObjects(
  objects: JsonObject[],
  lifecycle: SessionLifecycle,
): CodexClassification {
  const { status, providerStatus, waitingReason } = analyzeCodexObjects(objects, lifecycle);
  return { status, providerStatus, waitingReason };
}

function codexSessionMeta(objects: JsonObject[]): {
  id: string | null;
  cwd: string | null;
  createdAtMs: number | null;
  source: string | null;
} {
  for (const object of objects) {
    if (object.type !== "session_meta") continue;
    const payload = asObject(object.payload);
    const timestamp = asString(payload?.timestamp);
    return {
      id: asString(payload?.id),
      cwd: asString(payload?.cwd),
      createdAtMs: timestamp ? Date.parse(timestamp) : null,
      source: asString(payload?.source) ?? asString(payload?.originator),
    };
  }
  return { id: null, cwd: null, createdAtMs: null, source: null };
}

function codexIdFromPath(file: string): string | null {
  return basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

function findCodexStateDatabase(codexHome: string): string | null {
  const candidates: Array<{ file: string; version: number; mtimeMs: number; root: boolean }> = [];
  for (const directory of [codexHome, join(codexHome, "sqlite")]) {
    if (!existsSync(directory)) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.name.match(/^state_(\d+)\.sqlite$/);
      if (!entry.isFile() || !match) continue;
      const file = join(directory, entry.name);
      candidates.push({
        file,
        version: Number(match[1]),
        mtimeMs: statSync(file).mtimeMs,
        root: directory === codexHome,
      });
    }
  }
  candidates.sort((first, second) =>
    Number(second.root) - Number(first.root) || second.version - first.version || second.mtimeMs - first.mtimeMs,
  );
  return candidates[0]?.file ?? null;
}

function sqliteTables(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function sqliteColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function selectColumn(columns: Set<string>, name: string, fallback = "NULL"): string {
  return columns.has(name) ? name : fallback;
}

function codexDbRow(raw: Record<string, unknown>): CodexDbRow {
  return {
    id: String(raw.id),
    rolloutPath: String(raw.rollout_path ?? ""),
    createdAtMs: Number(raw.created_at_ms_value ?? 0),
    updatedAtMs: Number(raw.updated_at_ms_value ?? 0),
    cwd: String(raw.cwd ?? ""),
    title: normalizeText(asString(raw.display_title)),
    source: asString(raw.source),
    threadSource: asString(raw.thread_source),
    agentNickname: asString(raw.agent_nickname),
    agentRole: asString(raw.agent_role),
  };
}

function queryCodexRows(
  databaseFile: string,
  cutoffMs: number,
  loadedIds: Set<string>,
): { rows: CodexDbRow[]; parentByChild: Map<string, string> } {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const tables = sqliteTables(database);
    if (!tables.has("threads")) throw new Error("threads table is missing");
    const columns = sqliteColumns(database, "threads");
    const createdExpression = columns.has("created_at_ms") && columns.has("created_at")
      ? "COALESCE(created_at_ms, created_at * 1000)"
      : columns.has("created_at_ms")
        ? "created_at_ms"
        : columns.has("created_at")
          ? "created_at * 1000"
          : "0";
    const updatedExpression = columns.has("updated_at_ms") && columns.has("updated_at")
      ? "COALESCE(updated_at_ms, updated_at * 1000)"
      : columns.has("updated_at_ms")
        ? "updated_at_ms"
        : columns.has("updated_at")
          ? "updated_at * 1000"
          : "0";
    const titleCandidates = ["name", "title", "preview", "first_user_message"]
      .filter((name) => columns.has(name))
      .map((name) => `NULLIF(${name}, '')`);
    const titleExpression = titleCandidates.length > 1
      ? `COALESCE(${titleCandidates.join(", ")})`
      : titleCandidates[0] ?? "NULL";
    const loadedPlaceholders = [...loadedIds].map(() => "?").join(", ");
    const loadedClause = loadedIds.size > 0 ? ` OR id IN (${loadedPlaceholders})` : "";
    const archivedClause = columns.has("archived") ? " AND archived = 0" : "";
    const projection = `
        id,
        ${selectColumn(columns, "rollout_path", "''")} AS rollout_path,
        ${createdExpression} AS created_at_ms_value,
        ${updatedExpression} AS updated_at_ms_value,
        ${selectColumn(columns, "cwd", "''")} AS cwd,
        ${titleExpression} AS display_title,
        ${selectColumn(columns, "source")} AS source,
        ${selectColumn(columns, "thread_source")} AS thread_source,
        ${selectColumn(columns, "agent_nickname")} AS agent_nickname,
        ${selectColumn(columns, "agent_role")} AS agent_role
    `;
    const sql = `
      SELECT ${projection}
      FROM threads
      WHERE (${updatedExpression} >= ?${loadedClause})${archivedClause}
      ORDER BY ${updatedExpression} DESC
    `;
    const rawRows = database.prepare(sql).all(cutoffMs, ...loadedIds) as Array<Record<string, unknown>>;

    const parentByChild = new Map<string, string>();
    if (tables.has("thread_spawn_edges")) {
      const edges = database
        .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")
        .all() as Array<{ parent_thread_id: string; child_thread_id: string }>;
      for (const edge of edges) parentByChild.set(edge.child_thread_id, edge.parent_thread_id);

      // A recent/live child can outlast its parent rollout. Hydrate that parent
      // (and any ancestors) so collapsed output retains its real title and cwd.
      const selectedIds = new Set(rawRows.map((row) => String(row.id)));
      const attemptedIds = new Set<string>();
      while (true) {
        const missingParentIds = [...selectedIds]
          .map((id) => parentByChild.get(id) ?? null)
          .filter((id): id is string => id !== null && !selectedIds.has(id) && !attemptedIds.has(id));
        if (missingParentIds.length === 0) break;
        for (const id of missingParentIds) attemptedIds.add(id);
        const placeholders = missingParentIds.map(() => "?").join(", ");
        const parentRows = database
          .prepare(`SELECT ${projection} FROM threads WHERE id IN (${placeholders})`)
          .all(...missingParentIds) as Array<Record<string, unknown>>;
        for (const row of parentRows) {
          const id = String(row.id);
          if (selectedIds.has(id)) continue;
          selectedIds.add(id);
          rawRows.push(row);
        }
      }
    }
    const rows = rawRows.map(codexDbRow);
    return { rows, parentByChild };
  } finally {
    database.close();
  }
}

function parentFromCodexSource(source: string | null): string | null {
  if (!source?.startsWith("{")) return null;
  try {
    const object = asObject(JSON.parse(source));
    const subagent = asObject(object?.subagent);
    const spawn = asObject(subagent?.thread_spawn);
    return asString(spawn?.parent_thread_id);
  } catch {
    return null;
  }
}

function codexKind(row: CodexDbRow, parentSessionId: string | null): SessionKind {
  if (parentSessionId || row.threadSource === "subagent") return "subagent";
  const source = row.threadSource ?? row.source ?? "";
  return /exec|batch|sdk/i.test(source) ? "batch" : "interactive";
}

function codexRecordFromRow(
  row: CodexDbRow,
  parentSessionId: string | null,
  loadedPathById: Map<string, { file: string; runtimePid: number }>,
  clientPidByCwd: Map<string, number | null>,
  nowMs: number,
): SessionRecord {
  const loaded = loadedPathById.get(row.id) ?? null;
  const lifecycle: SessionLifecycle = loaded ? "live" : "recent";
  const file = loaded?.file ?? row.rolloutPath;
  const objects = file && existsSync(file) ? jsonLinesFromEdges(file) : [];
  const classification = analyzeCodexObjects(objects, lifecycle);
  let updatedAtMs = row.updatedAtMs;
  if (file && existsSync(file)) {
    try {
      updatedAtMs = Math.max(updatedAtMs, statSync(file).mtimeMs);
    } catch {
      // The rollout may disappear between discovery and stat.
    }
  }
  const name = normalizeText(row.agentNickname ?? row.title);
  return {
    ...baseRecord("codex", row.id, nowMs),
    parentSessionId,
    name,
    cwd: row.cwd || null,
    kind: codexKind(row, parentSessionId),
    lifecycle,
    status: classification.status,
    providerStatus: classification.providerStatus,
    waitingReason: classification.waitingReason,
    pid: loaded && row.cwd ? clientPidByCwd.get(row.cwd) ?? null : null,
    runtimePid: loaded?.runtimePid ?? null,
    startedAt: row.createdAtMs > 0 ? toIso(row.createdAtMs, nowMs) : null,
    updatedAt: toIso(updatedAtMs, nowMs),
    statusSource: objects.length > 0 ? "rollout-events" : "inferred",
    source: row.threadSource ?? row.source,
    mode: classification.mode,
    attention: classification.attention,
    effectiveAccess: classification.effectiveAccess,
  };
}

function codexFallbackRecord(
  file: string,
  runtimePid: number | null,
  lifecycle: SessionLifecycle,
  nowMs: number,
): SessionRecord | null {
  const objects = jsonLinesFromEdges(file);
  const meta = codexSessionMeta(objects);
  const sessionId = meta.id ?? codexIdFromPath(file);
  if (!sessionId) return null;
  const classification = analyzeCodexObjects(objects, lifecycle);
  let updatedAtMs = nowMs;
  try {
    updatedAtMs = statSync(file).mtimeMs;
  } catch {
    // Use the current time when a just-closed rollout races discovery.
  }
  return {
    ...baseRecord("codex", sessionId, nowMs),
    parentSessionId: null,
    name: null,
    cwd: meta.cwd,
    kind: "unknown",
    lifecycle,
    status: classification.status,
    providerStatus: classification.providerStatus,
    waitingReason: classification.waitingReason,
    pid: null,
    runtimePid,
    startedAt: meta.createdAtMs === null ? null : toIso(meta.createdAtMs, nowMs),
    updatedAt: toIso(updatedAtMs, nowMs),
    statusSource: "rollout-events",
    source: meta.source,
    mode: classification.mode,
    attention: classification.attention,
    effectiveAccess: classification.effectiveAccess,
  };
}

export function discoverCodex(
  runtime: Runtime,
  processes: ProcessInfo[],
  recentWindowSeconds: number,
): AdapterResult {
  const diagnostics: Diagnostic[] = [];
  const records: SessionRecord[] = [];
  const nowMs = runtime.now();
  const cutoffMs = nowMs - recentWindowSeconds * 1_000;
  const codexHome = runtime.env.CODEX_HOME ?? join(runtime.homeDir, ".codex");
  const processMap = new Map(processes.map((item) => [item.pid, item]));
  const codexProcesses = processes.filter(commandIsCodex);
  const loadedPathById = new Map<string, { file: string; runtimePid: number }>();
  const clientCwds = new Map<string, number[]>();
  const lsofCommand = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  let anyLsofSucceeded = false;

  for (const processInfo of codexProcesses) {
    const result = runtime.run(lsofCommand, ["-n", "-P", "-a", "-p", String(processInfo.pid), "-Fn"], 4_000);
    if (result.status !== 0 || result.error) continue;
    anyLsofSucceeded = true;
    const lsof = parseLsofOutput(result.stdout);
    const isClient = !/(?:^|\s)app-server(?:\s|$)/.test(processInfo.command);
    if (isClient && lsof.cwd) {
      const pids = clientCwds.get(lsof.cwd) ?? [];
      pids.push(processInfo.pid);
      clientCwds.set(lsof.cwd, pids);
    }
    for (const file of lsof.paths) {
      if (!file.endsWith(".jsonl") || !file.includes(`${sep}sessions${sep}`)) continue;
      const id = codexIdFromPath(file);
      if (id) loadedPathById.set(id, { file, runtimePid: processInfo.pid });
    }
  }

  if (codexProcesses.length > 0 && !anyLsofSucceeded) {
    diagnostics.push({
      provider: "codex",
      level: "warning",
      message: "Codex processes were found, but their open rollout files could not be inspected with lsof.",
    });
  }

  const clientPidByCwd = new Map<string, number | null>();
  for (const [cwd, pids] of clientCwds) clientPidByCwd.set(cwd, pids.length === 1 ? pids[0] ?? null : null);

  const databaseFile = findCodexStateDatabase(codexHome);
  let databaseSucceeded = false;
  if (databaseFile) {
    try {
      const query = queryCodexRows(databaseFile, cutoffMs, new Set(loadedPathById.keys()));
      databaseSucceeded = true;
      for (const row of query.rows) {
        const parentSessionId = query.parentByChild.get(row.id) ?? parentFromCodexSource(row.source);
        records.push(
          codexRecordFromRow(row, parentSessionId, loadedPathById, clientPidByCwd, nowMs),
        );
      }
    } catch (error) {
      diagnostics.push({
        provider: "codex",
        level: "warning",
        message: `Could not read ${databaseFile} in read-only mode; using rollout fallback: ${(error as Error).message}`,
      });
    }
  }

  const knownIds = new Set(records.map((record) => record.sessionId));
  for (const [id, loaded] of loadedPathById) {
    if (knownIds.has(id)) continue;
    const record = codexFallbackRecord(loaded.file, loaded.runtimePid, "live", nowMs);
    if (record) records.push(record);
  }

  if (!databaseSucceeded && recentWindowSeconds > 0) {
    const sessionsDirectory = join(codexHome, "sessions");
    for (const file of walkJsonlFiles(sessionsDirectory)) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) continue;
      const id = codexIdFromPath(file);
      if (id && (knownIds.has(id) || loadedPathById.has(id))) continue;
      const record = codexFallbackRecord(file, null, "recent", nowMs);
      if (record) records.push(record);
    }
  }

  const succeeded = databaseSucceeded || codexProcesses.length > 0 || existsSync(join(codexHome, "sessions"));
  if (!succeeded) {
    diagnostics.push({
      provider: "codex",
      level: "error",
      message: `No readable Codex session source was found under ${codexHome}.`,
    });
  }
  return {
    sessions: records.map((record) => finalizeRecord({
      ...record,
      effectiveAccess: mergeAccess(record.effectiveAccess, processAccess(record, processMap)),
    })),
    diagnostics,
    succeeded,
  };
}

function statusSourcePriority(source: SessionRecord["statusSource"]): number {
  switch (source) {
    case "provider-cli": return 6;
    case "live-registry": return 5;
    case "rollout-events": return 4;
    case "transcript": return 3;
    case "process": return 2;
    case "inferred": return 1;
  }
}

function recordScore(record: SessionRecord): number {
  return (
    (record.lifecycle === "live" ? 100 : 0) +
    statusSourcePriority(record.statusSource) * 10 +
    (record.pid !== null ? 3 : 0) +
    (record.status !== "unknown" ? 1 : 0)
  );
}

function statusRecord(first: SessionRecord, second: SessionRecord): SessionRecord {
  if (first.status === "unknown" && second.status !== "unknown") return second;
  if (second.status === "unknown" && first.status !== "unknown") return first;
  const firstPriority = statusSourcePriority(first.statusSource);
  const secondPriority = statusSourcePriority(second.statusSource);
  if (firstPriority !== secondPriority) return firstPriority > secondPriority ? first : second;
  return Date.parse(first.updatedAt) >= Date.parse(second.updatedAt) ? first : second;
}

export function mergeSessionRecords(first: SessionRecord, second: SessionRecord): SessionRecord {
  const primary = recordScore(first) >= recordScore(second) ? first : second;
  const secondary = primary === first ? second : first;
  const statusEvidence = statusRecord(first, second);
  const lifecycle: SessionLifecycle = first.lifecycle === "live" || second.lifecycle === "live" ? "live" : "recent";
  const kind = primary.kind === "unknown"
    ? secondary.kind
    : primary.kind === "interactive" && secondary.kind === "batch"
      ? "batch"
      : primary.kind;
  const merged = {
    ...secondary,
    ...primary,
    lifecycle,
    kind,
    status: statusEvidence.status,
    activity: statusEvidence.status,
    providerStatus: statusEvidence.providerStatus,
    waitingReason: statusEvidence.waitingReason,
    statusSource: statusEvidence.statusSource,
    name: primary.name ?? secondary.name,
    cwd: primary.cwd ?? secondary.cwd,
    parentSessionId: primary.parentSessionId ?? secondary.parentSessionId,
    pid: primary.pid ?? secondary.pid,
    runtimePid: primary.runtimePid ?? secondary.runtimePid,
    startedAt: minNullableIso(primary.startedAt, secondary.startedAt),
    updatedAt: maxIso(primary.updatedAt, secondary.updatedAt),
    source: primary.source ?? secondary.source,
    ownership: first.ownership === "manager" || second.ownership === "manager" ? "manager" as const : "external" as const,
    runtimeAlive: first.runtimeAlive || second.runtimeAlive || lifecycle === "live",
    mode: mergeModes(primary.mode, secondary.mode),
    attention: statusEvidence.status === "waiting"
      ? dedupeAttention([...first.attention, ...second.attention])
      : dedupeAttention(statusEvidence.attention),
    effectiveAccess: mergeAccess(primary.effectiveAccess, secondary.effectiveAccess),
    terminal: primary.terminal ?? secondary.terminal,
    control: primary.control.plane !== "observe-only" ? primary.control : secondary.control,
    generation: Math.max(first.generation, second.generation),
    childSummary: emptyChildSummary(),
  };
  return finalizeRecord(merged);
}

function sessionKey(record: Pick<SessionRecord, "provider" | "sessionId">): string {
  return `${record.provider}:${record.sessionId}`;
}

function placeholderParent(child: SessionRecord, parentSessionId: string): SessionRecord {
  return {
    ...baseRecord(child.provider, parentSessionId, Date.parse(child.updatedAt)),
    parentSessionId: null,
    name: "(parent session)",
    cwd: child.cwd,
    kind: "interactive",
    lifecycle: child.lifecycle,
    status: "unknown",
    providerStatus: null,
    waitingReason: null,
    pid: null,
    runtimePid: child.runtimePid,
    startedAt: null,
    updatedAt: child.updatedAt,
    statusSource: "inferred",
    source: null,
  };
}

function resolveHierarchy(records: SessionRecord[]): SessionRecord[] {
  const map = new Map<string, SessionRecord>();
  for (const record of records) {
    const key = sessionKey(record);
    const existing = map.get(key);
    map.set(key, existing ? mergeSessionRecords(existing, record) : { ...record, childSummary: emptyChildSummary() });
  }

  for (const record of [...map.values()]) {
    if (!record.parentSessionId) continue;
    const key = `${record.provider}:${record.parentSessionId}`;
    if (!map.has(key)) map.set(key, placeholderParent(record, record.parentSessionId));
  }

  for (const record of map.values()) {
    let current = record;
    let depth = 0;
    const visited = new Set<string>([sessionKey(record)]);
    while (current.parentSessionId) {
      const key = `${current.provider}:${current.parentSessionId}`;
      if (visited.has(key)) break;
      visited.add(key);
      const parent = map.get(key);
      if (!parent) break;
      current = parent;
      depth += 1;
    }
    record.rootSessionId = current.sessionId;
    record.depth = depth;
  }

  const promoteFromChildren = (record: SessionRecord): void => {
    const hasLiveChild =
      record.childSummary.waiting + record.childSummary.running + record.childSummary.idle > 0;
    if (hasLiveChild) record.lifecycle = "live";
    if (record.childSummary.waiting > 0) {
      record.status = "waiting";
      record.activity = "waiting";
      record.providerStatus = "child:waiting";
      const childAttention = record.attention[0];
      record.waitingReason = childAttention?.kind === "question" || childAttention?.kind === "elicitation"
        ? "user-input"
        : childAttention?.kind === "blocked"
          ? "blocked"
          : "approval";
      record.statusSource = "inferred";
    } else if (record.childSummary.running > 0 && record.status !== "waiting") {
      record.status = "running";
      record.activity = "running";
      record.providerStatus = "child:running";
      record.waitingReason = null;
      record.statusSource = "inferred";
    } else if (
      record.childSummary.idle > 0 &&
      record.status !== "waiting" &&
      record.status !== "running"
    ) {
      record.status = "idle";
      record.activity = "idle";
      record.providerStatus = "child:idle";
      record.waitingReason = null;
      record.statusSource = "inferred";
    }
  };

  for (const record of map.values()) record.childSummary = emptyChildSummary();
  const deepestFirst = [...map.values()].sort((first, second) => second.depth - first.depth);
  for (const record of deepestFirst) {
    promoteFromChildren(record);
    if (!record.parentSessionId) continue;
    const parent = map.get(`${record.provider}:${record.parentSessionId}`);
    if (!parent) continue;
    parent.childSummary.total += 1 + record.childSummary.total;
    for (const status of STATUS_VALUES) {
      parent.childSummary[status] += record.childSummary[status];
    }
    parent.childSummary[record.status] += 1;
    parent.updatedAt = maxIso(parent.updatedAt, record.updatedAt);
    parent.startedAt = minNullableIso(parent.startedAt, record.startedAt);
    parent.attention = dedupeAttention([...parent.attention, ...record.attention]);
    parent.effectiveAccess = mergeAccess(parent.effectiveAccess, record.effectiveAccess);
  }
  return [...map.values()].map(finalizeRecord);
}

const STATUS_PRIORITY: Record<SessionStatus, number> = {
  waiting: 0,
  running: 1,
  idle: 2,
  failed: 3,
  interrupted: 4,
  completed: 5,
  unknown: 6,
};

function sessionPriority(record: SessionRecord): number {
  return (record.lifecycle === "recent" ? 20 : 0) + STATUS_PRIORITY[record.status];
}

function compareSessions(first: SessionRecord, second: SessionRecord): number {
  const firstRoot = first.rootSessionId;
  const secondRoot = second.rootSessionId;
  if (first.provider === second.provider && firstRoot === secondRoot) {
    return first.depth - second.depth || sessionPriority(first) - sessionPriority(second) || second.updatedAt.localeCompare(first.updatedAt);
  }
  return (
    sessionPriority(first) - sessionPriority(second) ||
    second.updatedAt.localeCompare(first.updatedAt) ||
    first.provider.localeCompare(second.provider) ||
    first.sessionId.localeCompare(second.sessionId)
  );
}

function rootMatchesStatuses(record: SessionRecord, statuses: Set<SessionStatus>): boolean {
  if (statuses.has(record.status)) return true;
  for (const status of statuses) {
    if (record.childSummary[status] > 0) return true;
  }
  return false;
}

export function prepareSessions(
  records: SessionRecord[],
  includeChildren: boolean,
  statuses: Set<SessionStatus> | null,
): SessionRecord[] {
  const hierarchical = resolveHierarchy(records);
  const roots = hierarchical.filter((record) => record.depth === 0);
  const allowedRoots = new Set(
    roots
      .filter((record) => !statuses || rootMatchesStatuses(record, statuses))
      .map((record) => `${record.provider}:${record.sessionId}`),
  );
  const filtered = hierarchical.filter((record) => {
    const rootKey = `${record.provider}:${record.rootSessionId}`;
    if (!allowedRoots.has(rootKey)) return false;
    if (!includeChildren) return record.depth === 0;
    if (!statuses || record.depth === 0) return true;
    return statuses.has(record.status);
  });
  const rootByKey = new Map(
    roots.map((record) => [`${record.provider}:${record.sessionId}`, record]),
  );
  return filtered.sort((first, second) => {
    const firstRoot = rootByKey.get(`${first.provider}:${first.rootSessionId}`) ?? first;
    const secondRoot = rootByKey.get(`${second.provider}:${second.rootSessionId}`) ?? second;
    const rootOrder = compareSessions(firstRoot, secondRoot);
    if (rootOrder !== 0) return rootOrder;
    return compareSessions(first, second);
  });
}

export function buildListing(options: CliOptions, runtime: Runtime = systemRuntime): InternalListingResult {
  const processResult = loadProcessTable(runtime);
  const diagnostics: Diagnostic[] = processResult.diagnostic ? [processResult.diagnostic] : [];
  const records: SessionRecord[] = [];
  let successfulProviderCount = 0;

  if (options.providers.has("codex")) {
    try {
      const result = discoverCodex(runtime, processResult.processes, options.recentWindowSeconds);
      records.push(...result.sessions);
      diagnostics.push(...result.diagnostics);
      if (result.succeeded) successfulProviderCount += 1;
    } catch (error) {
      diagnostics.push({
        provider: "codex",
        level: "error",
        message: `Codex discovery failed unexpectedly: ${(error as Error).message}`,
      });
    }
  }
  if (options.providers.has("claude")) {
    try {
      const result = discoverClaude(runtime, processResult.processes, options.recentWindowSeconds);
      records.push(...result.sessions);
      diagnostics.push(...result.diagnostics);
      if (result.succeeded) successfulProviderCount += 1;
    } catch (error) {
      diagnostics.push({
        provider: "claude",
        level: "error",
        message: `Claude discovery failed unexpectedly: ${(error as Error).message}`,
      });
    }
  }

  const selectedRecords = records.filter((record) => options.providers.has(record.provider));
  const tmux = discoverTmuxPanes(runtime);
  // Keep provider diagnostics in their historical order (and therefore last)
  // while still surfacing non-fatal tmux socket failures.
  diagnostics.unshift(...tmux.diagnostics);
  const recordsWithTerminals = attachTmuxTerminals(
    resolveHierarchy(selectedRecords),
    tmux.panes,
    processResult.processes,
  );
  return {
    version: 2,
    generatedAt: new Date(runtime.now()).toISOString(),
    recentWindowSeconds: options.recentWindowSeconds,
    sessions: prepareSessions(recordsWithTerminals, options.includeChildren, options.statuses),
    diagnostics,
    selectedProviderCount: options.providers.size,
    successfulProviderCount,
  };
}

function abbreviateHome(file: string | null, homeDirectory: string): string {
  if (!file) return "-";
  if (file === homeDirectory) return "~";
  if (file.startsWith(`${homeDirectory}${sep}`)) return `~${sep}${relative(homeDirectory, file)}`;
  return file;
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width, " ");
}

function ageLabel(updatedAt: string, nowMs: number): string {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return "?";
  const seconds = Math.max(0, Math.floor((nowMs - updatedMs) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function childLabel(summary: ChildSummary): string {
  if (summary.total === 0) return "-";
  const active = summary.running + summary.waiting + summary.idle;
  const ended = summary.completed + summary.failed + summary.interrupted;
  if (active > 0 && ended > 0) return `${active} live/${ended} end`;
  if (active > 0) return `${active} live`;
  if (ended > 0) return `${ended} ended`;
  return String(summary.total);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function formatTable(sessions: SessionRecord[], nowMs: number, homeDirectory: string, columns = 160): string {
  if (sessions.length === 0) return "No matching sessions.";
  const fixedWidth = 11 + 1 + 7 + 1 + 11 + 1 + 7 + 1 + 7 + 1 + 12 + 1;
  const cwdWidth = Math.max(20, Math.min(42, Math.floor((columns - fixedWidth) * 0.38)));
  const sessionWidth = Math.max(24, columns - fixedWidth - cwdWidth);
  const header = [
    pad("STATUS", 11),
    pad("AGENT", 7),
    pad("KIND", 11),
    pad("PID", 7),
    pad("UPDATED", 7),
    pad("CHILDREN", 12),
    pad("WORKDIR", cwdWidth),
    pad("SESSION", sessionWidth),
  ].join(" ");
  const rows = sessions.map((record) => {
    const title = record.name ?? "(untitled)";
    const prefix = record.depth > 0 ? `${"  ".repeat(Math.max(0, record.depth - 1))}↳ ` : "";
    const session = `${prefix}${title} [${shortId(record.sessionId)}]`;
    return [
      pad(record.status, 11),
      pad(record.provider, 7),
      pad(record.kind, 11),
      pad(record.pid === null ? "-" : String(record.pid), 7),
      pad(ageLabel(record.updatedAt, nowMs), 7),
      pad(childLabel(record.childSummary), 12),
      pad(abbreviateHome(record.cwd, homeDirectory), cwdWidth),
      pad(session, sessionWidth),
    ].join(" ");
  });
  return [header, "-".repeat(Math.min(columns, header.length)), ...rows].join("\n");
}

function helpText(): string {
  return `Usage: ./agent-sessions.ts [options]

List live and recently active local Codex and Claude sessions.

Options:
  --json                  Output the stable JSON envelope instead of a table
  --since <duration>      Include ended sessions updated within this window (default: 15m; 0 = live only)
  --provider <name>       codex, claude, all, or a comma-separated list (default: all)
  --status <statuses>     Filter by comma-separated normalized statuses
  --children              Expand nested subagents; parents show child counts by default
  -h, --help              Show this help

Statuses: ${STATUS_VALUES.join(", ")}`;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const listing = buildListing(options);
  if (options.json) {
    const publicListing: ListingResult = {
      version: listing.version,
      generatedAt: listing.generatedAt,
      recentWindowSeconds: listing.recentWindowSeconds,
      sessions: listing.sessions,
      diagnostics: listing.diagnostics,
    };
    process.stdout.write(`${JSON.stringify(publicListing, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(listing.sessions, Date.parse(listing.generatedAt), systemRuntime.homeDir, process.stdout.columns ?? 160)}\n`);
    for (const diagnostic of listing.diagnostics) {
      process.stderr.write(`${diagnostic.level} [${diagnostic.provider}] ${diagnostic.message}\n`);
    }
  }

  if (listing.selectedProviderCount > 0 && listing.successfulProviderCount === 0) {
    process.exitCode = 2;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  void main();
}
