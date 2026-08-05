import {
  emptyChildSummary,
  observeOnlyControl,
  providerControlCoordination,
  unknownEffort,
  unknownModel,
  unknownProfile,
  unknownSandbox,
  type Provider,
  type SessionControl,
  type SessionRecord,
} from "../core/types.ts";
import { sessionRecordId } from "../shared/session.ts";

export interface JsonObject {
  [key: string]: unknown;
}

export function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizedText(value: unknown): string | null {
  return string(value)?.replace(/\s+/gu, " ").trim().slice(0, 240) ?? null;
}

export function iso(value: number, fallback: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : fallback;
  return new Date(safe).toISOString();
}

/**
 * An exact provider-indexed conversation may be resumed by Agent Manager even
 * when no provider process is currently loaded. This is still a read-only
 * projection: the server proves the provider-specific owner policy and commits
 * adoption before publishing any manager write capabilities.
 */
export function observedResumeControl(provider: Provider): SessionControl {
  return {
    plane: "resume-only",
    authority: "none",
    coordination: providerControlCoordination(provider),
    recovery: null,
    capabilities: ["resume"],
    withheld: [],
    takeover: null,
  };
}

export function baseRecord(
  provider: Provider,
  providerThreadId: string,
  nowMs: number,
): SessionRecord {
  return {
    id: sessionRecordId("local", provider, providerThreadId),
    provider,
    providerThreadId,
    providerTreeId: providerThreadId,
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: null,
    cwd: null,
    kind: "unknown",
    archived: false,
    presence: "recent",
    status: "unknown",
    providerStatus: null,
    pid: null,
    runtimePid: null,
    startedAt: null,
    updatedAt: iso(nowMs, nowMs),
    childSummary: emptyChildSummary(),
    todoProgress: null,
    statusSource: "inferred",
    source: null,
    profile: unknownProfile(),
    sandbox: unknownSandbox(),
    model: unknownModel(),
    effort: unknownEffort(),
    attention: [],
    terminal: null,
    control: observeOnlyControl(),
    workspaceIdentity: null,
    generation: 0,
  };
}
