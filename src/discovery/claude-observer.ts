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
  providerEffort,
  unknownEffort,
  unknownModel,
  unknownProfile,
  type AdapterResult,
  type Diagnostic,
  type ProcessInfo,
  type Runtime,
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

function transcriptPermissionMode(path: string): string | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return null;
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
        const mode = string(value?.permissionMode);
        if (profileForClaudePermissionMode(mode) !== null) return mode;
      } catch {
        // A partially-written final transcript row is not evidence.
      }
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return null;
}

function latestTranscriptPermissionMode(
  configDirectory: string,
  cwd: string,
  sessionId: string,
): string | null {
  for (const path of transcriptCandidates(configDirectory, cwd, sessionId)) {
    const mode = transcriptPermissionMode(path);
    if (mode !== null) return mode;
  }
  return null;
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

function validClaudeRegistry(
  runtime: Runtime,
  processes: ReadonlyMap<number, ProcessInfo>,
): Map<string, JsonObject> {
  const directory = join(runtime.env.CLAUDE_CONFIG_DIR ?? join(runtime.homeDir, ".claude"), "sessions");
  const result = new Map<string, JsonObject>();
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
      result.set(sessionId, value as JsonObject);
    } catch {
      // A partially-written or stale registry entry is not live evidence.
    }
  }
  return result;
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
    const liveValue = registry.get(id) ?? null;
    const live = liveValue !== null;
    const startedAt = number(value.startedAt) ?? number(liveValue?.startedAt) ?? now;
    if (!live && startedAt < cutoff) continue;
    const cwd = string(value.cwd) ?? string(liveValue?.cwd);
    const statusValue = liveValue?.status ?? value.state ?? value.status;
    const status = claudeStatus(statusValue, live);
    const directPermissionMode = string(liveValue?.permissionMode ?? value.permissionMode);
    const transcriptPermissionMode = directPermissionMode === null && cwd
      ? latestTranscriptPermissionMode(configDirectory, cwd, id)
      : null;
    const permissionMode = directPermissionMode ?? transcriptPermissionMode;
    const profileValue = profileForClaudePermissionMode(permissionMode);
    const effortValue = string(liveValue?.effort);
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
        ? providerEffort("claude", effortValue, "live-registry")
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
      ...(!live && cwd ? { control: observedResumeControl("claude") } : {}),
    });
  }
  for (const [id, value] of registry) {
    if (byId.has(id)) continue;
    const pid = number(value.pid);
    const status = claudeStatus(value.status, true);
    const effortValue = string(value.effort);
    byId.set(id, {
      ...baseRecord("claude", id, now),
      name: normalizedText(value.name),
      cwd: string(value.cwd),
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
        ? providerEffort("claude", effortValue, "live-registry")
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
    });
  }
  return {
    sessions: [...byId.values()],
    diagnostics,
    succeeded: result.status === 0 || registry.size > 0,
  };
}
