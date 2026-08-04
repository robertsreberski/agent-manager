import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import {
  providerEffort,
  unknownEffort,
  unknownModel,
  unknownProfile,
  type AdapterResult,
  type Diagnostic,
  type ExecutionProfile,
  type ProcessInfo,
  type Runtime,
  type SessionRecord,
  type SessionStatus,
} from "../core/types.ts";
import {
  baseRecord,
  iso,
  normalizedText,
  number,
  object,
  string,
  type JsonObject,
} from "./observe-values.ts";

const MAX_PROVIDER_ROWS = 750;

function commandIsClaude(process: ProcessInfo): boolean {
  const words = process.command.trim().split(/\s+/u);
  return process.executable === "claude" ||
    (/^(?:node|nodejs)$/u.test(basename(words[0] ?? "")) && basename(words[1] ?? "") === "claude");
}

function claudeProfile(value: unknown): ExecutionProfile | null {
  switch (value) {
    case "plan": return "plan";
    case "acceptEdits": return "execute";
    case "bypassPermissions": return "full-access";
    case "default": return "ask-first";
    default: return null;
  }
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
    const statusValue = liveValue?.status ?? value.state ?? value.status;
    const status = claudeStatus(statusValue, live);
    const profileValue = claudeProfile(liveValue?.permissionMode ?? value.permissionMode);
    const effortValue = string(liveValue?.effort);
    const pid = number(liveValue?.pid);
    byId.set(id, {
      ...baseRecord("claude", id, now),
      name: normalizedText(value.name ?? liveValue?.name),
      cwd: string(value.cwd) ?? string(liveValue?.cwd),
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
      profile: profileValue ? {
        value: profileValue,
        providerValue: string(liveValue?.permissionMode ?? value.permissionMode),
        source: live ? "live-registry" : "provider-cli",
        confidence: "exact",
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
