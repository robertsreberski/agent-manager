import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  normalizeProviderReasoningEffort,
  providerEffort,
  unknownEffort,
  unknownModel,
  unknownProfile,
  type AdapterResult,
  type Diagnostic,
  type ProcessInfo,
  type Runtime,
  type SessionControlPeer,
  type SessionRecord,
  type SessionStatus,
} from "../core/types.ts";
import { profileForClaudePermissionMode } from "../providers/claude/profile.ts";
import {
  baseRecord,
  iso,
  normalizedText,
  number,
  object,
  observedJoinControl,
  observedResumeControl,
  string,
  type JsonObject,
} from "./observe-values.ts";

const MAX_PROVIDER_ROWS = 750;
const MAX_TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const SAFE_CLAUDE_SESSION_ID = /^[a-zA-Z0-9_-]{1,256}$/u;

function commandIsClaude(process: ProcessInfo): boolean {
  const words = process.command.trim().split(/\s+/u);
  return process.executable === "claude" ||
    (/^(?:node|nodejs)$/u.test(basename(words[0] ?? "")) && basename(words[1] ?? "") === "claude");
}

function claudeProjectDirectory(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/gu, "-");
}

function transcriptCandidates(
  configDirectory: string,
  cwd: string,
  sessionId: string,
): string[] {
  if (!SAFE_CLAUDE_SESSION_ID.test(sessionId)) return [];
  const projectsDirectory = join(configDirectory, "projects");
  const preferred = join(projectsDirectory, claudeProjectDirectory(cwd), `${sessionId}.jsonl`);
  const candidates = [preferred];
  try {
    for (const entry of readdirSync(projectsDirectory, { withFileTypes: true }).slice(0, MAX_PROVIDER_ROWS)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(projectsDirectory, entry.name, `${sessionId}.jsonl`);
      if (candidate !== preferred) candidates.push(candidate);
    }
  } catch {
    // The preferred provider-owned path may still be readable.
  }
  return candidates.flatMap((path) => {
    try {
      const stat = lstatSync(path);
      return stat.isFile() ? [{ path, modifiedAt: stat.mtimeMs }] : [];
    } catch {
      return [];
    }
  }).sort((left, right) => right.modifiedAt - left.modifiedAt).map(({ path }) => path);
}

interface ClaudeTranscriptSettings {
  permissionMode: string | null;
  effort: string | null;
}

function transcriptSettings(path: string): ClaudeTranscriptSettings {
  let permissionMode: string | null = null;
  let effort: string | null = null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { permissionMode, effort };
    const size = stat.size;
    const length = Math.min(size, MAX_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (size > length) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const value = object(JSON.parse(line));
        if (permissionMode === null) {
          const mode = string(value?.permissionMode);
          if (profileForClaudePermissionMode(mode) !== null) permissionMode = mode;
        }
        if (
          effort === null
          && value?.type === "assistant"
          && value.isSidechain !== true
        ) {
          const candidate = string(value.effort);
          if (normalizeProviderReasoningEffort("claude", candidate) !== null) {
            effort = candidate;
          }
        }
        if (permissionMode !== null && effort !== null) break;
      } catch {
        // A partially-written final transcript row is not evidence.
      }
    }
  } catch {
    return { permissionMode, effort };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return { permissionMode, effort };
}

function latestTranscriptSettings(
  configDirectory: string,
  cwd: string,
  sessionId: string,
): ClaudeTranscriptSettings {
  const result: ClaudeTranscriptSettings = { permissionMode: null, effort: null };
  for (const path of transcriptCandidates(configDirectory, cwd, sessionId)) {
    const candidate = transcriptSettings(path);
    result.permissionMode ??= candidate.permissionMode;
    result.effort ??= candidate.effort;
    if (result.permissionMode !== null && result.effort !== null) break;
  }
  return result;
}

export function resolveClaudeTranscriptEffort(
  configDirectory: string,
  cwd: string,
  sessionId: string,
) {
  return normalizeProviderReasoningEffort(
    "claude",
    latestTranscriptSettings(configDirectory, cwd, sessionId).effort,
  );
}

function claudeStatus(value: unknown, live: boolean): SessionStatus {
  const state = string(value)?.toLowerCase() ?? "unknown";
  if (!live && ["blocked", "running", "working", "idle"].includes(state)) return "unknown";
  if (state === "blocked" || state === "waiting") return "waiting";
  if (state === "running" || state === "working") return "running";
  if (state === "idle") return "idle";
  if (state === "done" || state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "interrupted" || state === "cancelled" || state === "canceled") return "interrupted";
  return live ? "running" : "unknown";
}

/**
 * Live registry entries grouped by conversation.
 *
 * This was `Map<sessionId, JsonObject>`, so a joined session — two live
 * processes writing one conversation — silently collapsed to whichever entry
 * `readdirSync` happened to yield last, and the published pid, status, model and
 * effort came from an arbitrary one of the two. Every writer is kept now, and
 * callers choose deliberately which one speaks for the session.
 */
function validClaudeRegistry(
  runtime: Runtime,
  processes: ReadonlyMap<number, ProcessInfo>,
): Map<string, JsonObject[]> {
  const directory = join(runtime.env.CLAUDE_CONFIG_DIR ?? join(runtime.homeDir, ".claude"), "sessions");
  const result = new Map<string, JsonObject[]>();
  let entries: string[];
  try {
    entries = readdirSync(directory).filter((name) => name.endsWith(".json")).slice(0, MAX_PROVIDER_ROWS);
  } catch {
    return result;
  }
  for (const entry of entries) {
    try {
      const value = object(JSON.parse(readFileSync(join(directory, entry), "utf8")));
      const pid = number(value?.pid);
      const sessionId = string(value?.sessionId);
      if (pid === null || !sessionId) continue;
      const process = processes.get(pid);
      if (!process || !commandIsClaude(process)) continue;
      const writers = result.get(sessionId);
      if (writers) writers.push(value as JsonObject);
      else result.set(sessionId, [value as JsonObject]);
    } catch {
      // A partially-written or stale registry entry is not live evidence.
    }
  }
  return result;
}

/**
 * Which live writer speaks for the session's published facts.
 *
 * The operator's own terminal, when there is one: that is the surface they are
 * looking at, so its status and settings are the ones that should not surprise
 * them. `entrypoint` is an environment passthrough rather than something the CLI
 * derives, so this is a presentation preference and never a trust decision.
 */
function primaryClaudeWriter(writers: readonly JsonObject[]): JsonObject | null {
  return writers.find((writer) => writer.entrypoint === "cli") ?? writers[0] ?? null;
}

/** Live writers as published peer facts. Observational, never authorization. */
function claudePeers(writers: readonly JsonObject[], now: number): SessionControlPeer[] {
  const peers: SessionControlPeer[] = [];
  for (const writer of writers) {
    const pid = number(writer.pid);
    if (pid === null || pid <= 0 || peers.some((peer) => peer.pid === pid)) continue;
    peers.push({
      kind: writer.entrypoint === "cli" ? "native" : "manager",
      pid,
      startedAt: iso(number(writer.startedAt) ?? now, now),
    });
  }
  return peers;
}

export function discoverClaude(
  runtime: Runtime,
  processes: ProcessInfo[],
  recentWindowSeconds: number,
): AdapterResult {
  const diagnostics: Diagnostic[] = [];
  const now = runtime.now();
  const cutoff = now - recentWindowSeconds * 1_000;
  const processMap = new Map(processes.map((process) => [process.pid, process]));
  const registry = validClaudeRegistry(runtime, processMap);
  const configDirectory = runtime.env.CLAUDE_CONFIG_DIR ?? join(runtime.homeDir, ".claude");
  const byId = new Map<string, SessionRecord>();
  const result = runtime.run("claude", ["agents", "--json", "--all"], 5_000);
  let values: unknown[] = [];
  if (result.status === 0 && !result.error) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      values = parsed.slice(0, MAX_PROVIDER_ROWS);
    } catch (error) {
      diagnostics.push({ provider: "claude", level: "warning", message: `Claude agent list was malformed: ${String(error)}` });
    }
  } else {
    diagnostics.push({
      provider: "claude",
      level: "warning",
      message: `Claude agent list is unavailable: ${result.error?.message ?? (result.stderr.trim() || "command failed")}`,
    });
  }
  for (const raw of values) {
    const value = object(raw);
    const id = string(value?.sessionId);
    if (!value || !id) continue;
    const writers = registry.get(id) ?? [];
    const liveValue = primaryClaudeWriter(writers);
    const live = liveValue !== null;
    const startedAt = number(value.startedAt) ?? number(liveValue?.startedAt) ?? now;
    if (!live && startedAt < cutoff) continue;
    const cwd = string(value.cwd) ?? string(liveValue?.cwd);
    const statusValue = liveValue?.status ?? value.state ?? value.status;
    const status = claudeStatus(statusValue, live);
    const directPermissionMode = string(liveValue?.permissionMode ?? value.permissionMode);
    const directEffort = string(liveValue?.effort);
    const transcriptSettings = cwd && (directPermissionMode === null || directEffort === null)
      ? latestTranscriptSettings(configDirectory, cwd, id)
      : { permissionMode: null, effort: null };
    const transcriptPermissionMode = directPermissionMode === null
      ? transcriptSettings.permissionMode
      : null;
    const permissionMode = directPermissionMode ?? transcriptPermissionMode;
    const profileValue = profileForClaudePermissionMode(permissionMode);
    const effortValue = directEffort ?? transcriptSettings.effort;
    const pid = number(liveValue?.pid);
    byId.set(id, {
      ...baseRecord("claude", id, now),
      name: normalizedText(value.name ?? liveValue?.name),
      cwd,
      kind: value.kind === "background" ? "background" : "interactive",
      presence: live ? "live" : "recent",
      status,
      providerStatus: string(statusValue),
      pid,
      runtimePid: pid,
      startedAt: iso(startedAt, now),
      updatedAt: iso(number(liveValue?.updatedAt) ?? startedAt, now),
      statusSource: live ? "live-registry" : "provider-cli",
      source: string(value.kind),
      profile: permissionMode ? {
        value: profileValue,
        providerValue: permissionMode,
        source: transcriptPermissionMode ? "transcript" : live ? "live-registry" : "provider-cli",
        confidence: transcriptPermissionMode ? "inferred" : "exact",
      } : unknownProfile(),
      model: string(liveValue?.model) ? {
        value: string(liveValue?.model),
        providerValue: string(liveValue?.model),
        source: "live-registry",
        confidence: "exact",
      } : unknownModel(),
      effort: effortValue
        ? providerEffort(
            "claude",
            effortValue,
            directEffort !== null ? "live-registry" : "transcript",
          )
        : unknownEffort(),
      attention: status === "waiting" ? [{
        id: null,
        kind: "blocked",
        summary: "Claude appears blocked — inferred from provider state",
        source: live ? "live-registry" : "provider-cli",
        confidence: "heuristic",
        details: {
          title: "Inferred from provider state",
          questions: null,
          toolName: null,
          inputSummary: null,
          respondable: false,
        },
      }] : [],
      /*
        A dormant conversation is resumable; a live one is now joinable. Only
        the second is new: a live external Claude session used to publish
        observe-only, which is what made the cockpit refuse every write and offer
        to stop the operator's process as the remedy.
      */
      ...(cwd
        ? {
            control: live
              ? observedJoinControl(claudePeers(writers, now))
              : observedResumeControl("claude"),
          }
        : {}),
    });
  }
  /*
    Live writers `claude agents` did not list. Grouping the registry by
    conversation is what keeps a joined session one card here: Agent Manager's
    own SDK child resumes the same `sessionId` as the terminal it joined, so both
    entries land in one group rather than producing a second board card for our
    own process.
  */
  for (const [id, writers] of registry) {
    if (byId.has(id)) continue;
    const value = primaryClaudeWriter(writers);
    if (!value) continue;
    const pid = number(value.pid);
    const cwd = string(value.cwd);
    const status = claudeStatus(value.status, true);
    const directEffort = string(value.effort);
    const transcriptEffort = directEffort === null && cwd
      ? latestTranscriptSettings(configDirectory, cwd, id).effort
      : null;
    const effortValue = directEffort ?? transcriptEffort;
    byId.set(id, {
      ...baseRecord("claude", id, now),
      name: normalizedText(value.name),
      cwd,
      kind: value.entrypoint === "sdk-cli" ? "batch" : "interactive",
      presence: "live",
      status,
      providerStatus: string(value.status),
      pid,
      runtimePid: pid,
      startedAt: iso(number(value.startedAt) ?? now, now),
      updatedAt: iso(number(value.updatedAt) ?? now, now),
      statusSource: "live-registry",
      source: string(value.entrypoint),
      effort: effortValue
        ? providerEffort(
            "claude",
            effortValue,
            directEffort !== null ? "live-registry" : "transcript",
          )
        : unknownEffort(),
      attention: status === "waiting" ? [{
        id: null,
        kind: "blocked",
        summary: "Claude appears blocked — inferred from live registry",
        source: "live-registry",
        confidence: "heuristic",
        details: {
          title: "Inferred from live registry",
          questions: null,
          toolName: null,
          inputSummary: null,
          respondable: false,
        },
      }] : [],
      ...(cwd ? { control: observedJoinControl(claudePeers(writers, now)) } : {}),
    });
  }
  return {
    sessions: [...byId.values()],
    diagnostics,
    succeeded: result.status === 0 || registry.size > 0,
  };
}
