import {
  providerEffort,
  sandboxPolicy,
  type ExecutionProfile,
  type SessionEffort,
  type SessionModel,
  type SessionProfile,
  type SessionSandbox,
  type SessionStatus,
} from "../../shared/session.ts";

type JsonObject = Record<string, unknown>;

export interface CodexRolloutFacts {
  status: Extract<SessionStatus, "running" | "idle" | "interrupted" | "unknown">;
  providerStatus: "task_started" | "task_complete" | "turn_aborted" | "turn_context" | null;
  /** Observed rollout identity only. It must never be published as an exact provider turn ID. */
  activeTurnId: string | null;
  /** Turn named by the latest accepted lifecycle/context record, including completion. */
  lifecycleTurnId: string | null;
  observedAt: string | null;
  profile: SessionProfile | null;
  sandbox: SessionSandbox | null;
  model: SessionModel | null;
  effort: SessionEffort | null;
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function codexFactType(value: unknown): string | null {
  const direct = string(value);
  if (direct) {
    try {
      return codexFactType(JSON.parse(direct)) ?? direct.toLowerCase();
    } catch {
      return direct.toLowerCase();
    }
  }
  return string(object(value)?.type)?.toLowerCase() ?? null;
}

function collaborationMode(value: unknown): string | null {
  return string(object(value)?.mode)?.toLowerCase() ?? string(value)?.toLowerCase() ?? null;
}

export function unrestrictedCodexApproval(...values: Array<string | null>): boolean {
  return values.some((value) => value === "never" || value === "disabled");
}

export function codexProfileEvidence(
  value: ExecutionProfile,
  source: SessionProfile["source"],
  facts: ReadonlyArray<readonly [string, string | null]>,
): SessionProfile {
  return {
    value,
    providerValue: facts.flatMap(([name, fact]) => fact ? [`${name}=${fact}`] : []).join("; ") || null,
    source,
    confidence: "inferred",
  };
}

export function codexSandboxEvidence(
  raw: string | null,
  networkAccess: boolean | null,
  source: SessionSandbox["source"],
): SessionSandbox | null {
  const mode = raw === "danger-full-access" || raw === "dangerfullaccess"
    ? "danger-full-access"
    : raw === "workspace-write" || raw === "workspacewrite"
      ? "workspace-write"
      : raw === "read-only" || raw === "readonly"
        ? "read-only"
        : null;
  if (mode === null) return null;
  return {
    value: sandboxPolicy(mode, networkAccess === true),
    providerValue: networkAccess === null ? raw : `${raw ?? mode}; network=${String(networkAccess)}`,
    source,
    confidence: "exact",
  };
}

function profileFromTurnContext(payload: JsonObject): SessionProfile | null {
  const approval = string(payload.approval_policy)?.toLowerCase() ?? null;
  const sandbox = codexFactType(payload.sandbox_policy);
  const permission = codexFactType(payload.permission_profile);
  const collaboration = collaborationMode(payload.collaboration_mode);
  const facts = [
    ["approval", approval],
    ["sandbox", sandbox],
    ["permission", permission],
    ["collaboration", collaboration],
  ] as const;
  if (unrestrictedCodexApproval(approval, permission)) {
    return codexProfileEvidence("full-access", "rollout-events", facts);
  }
  if (collaboration === "plan") return codexProfileEvidence("plan", "rollout-events", facts);
  if (collaboration === "default" || approval || sandbox || permission) {
    return codexProfileEvidence("execute", "rollout-events", facts);
  }
  return null;
}

function sandboxFromTurnContext(payload: JsonObject): SessionSandbox | null {
  const policy = object(payload.sandbox_policy);
  const network = typeof policy?.network_access === "boolean" ? policy.network_access : null;
  return codexSandboxEvidence(codexFactType(payload.sandbox_policy), network, "rollout-events");
}

function modelFromTurnContext(payload: JsonObject): SessionModel | null {
  const collaboration = object(payload.collaboration_mode);
  const settings = object(collaboration?.settings);
  const value = string(payload.model) ?? string(settings?.model);
  return value ? {
    value,
    providerValue: value,
    source: "rollout-events",
    confidence: "exact",
  } : null;
}

function effortFromTurnContext(payload: JsonObject): SessionEffort | null {
  const collaboration = object(payload.collaboration_mode);
  const settings = object(collaboration?.settings);
  const value = string(payload.effort) ?? string(settings?.reasoning_effort);
  return value ? providerEffort("codex", value, "rollout-events") : null;
}

/**
 * Reduce provider-owned rollout records into the facts safe to use for
 * cross-client observation. The returned turn identity is deliberately
 * observational: callers may use it to reject stale lifecycle rows, but never
 * to authorize steer, interrupt, or request responses.
 */
export function analyzeCodexRolloutFacts(events: readonly JsonObject[]): CodexRolloutFacts {
  let status: CodexRolloutFacts["status"] = "unknown";
  let providerStatus: CodexRolloutFacts["providerStatus"] = null;
  let activeTurnId: string | null = null;
  let lifecycleTurnId: string | null = null;
  let observedAt: string | null = null;
  let profile: SessionProfile | null = null;
  let sandbox: SessionSandbox | null = null;
  let model: SessionModel | null = null;
  let effort: SessionEffort | null = null;

  for (const event of events) {
    const payload = object(event.payload);
    if (!payload) continue;
    const eventAt = timestamp(event.timestamp);

    if (event.type === "turn_context") {
      const turnId = string(payload.turn_id);
      if (turnId) {
        activeTurnId = turnId;
        lifecycleTurnId = turnId;
      }
      status = "running";
      providerStatus = providerStatus === "task_started" ? providerStatus : "turn_context";
      observedAt = eventAt ?? observedAt;
      profile = profileFromTurnContext(payload) ?? profile;
      sandbox = sandboxFromTurnContext(payload) ?? sandbox;
      model = modelFromTurnContext(payload) ?? model;
      effort = effortFromTurnContext(payload) ?? effort;
      continue;
    }

    if (event.type !== "event_msg") continue;
    const type = string(payload.type);
    const turnId = string(payload.turn_id);
    if (type === "task_started") {
      activeTurnId = turnId;
      lifecycleTurnId = turnId;
      status = "running";
      providerStatus = "task_started";
      observedAt = eventAt ?? observedAt;
      continue;
    }
    if (type !== "task_complete" && type !== "turn_aborted") continue;
    // A late completion for an older turn must not clear a newer observed turn.
    if (activeTurnId && turnId && activeTurnId !== turnId) continue;
    activeTurnId = null;
    lifecycleTurnId = turnId;
    status = type === "turn_aborted" ? "interrupted" : "idle";
    providerStatus = type;
    observedAt = eventAt ?? observedAt;
  }

  return {
    status,
    providerStatus,
    activeTurnId,
    lifecycleTurnId,
    observedAt,
    profile,
    sandbox,
    model,
    effort,
  };
}

/** Only provider-written cleartext summaries are renderable reasoning content. */
export function codexReasoningSummary(payload: JsonObject): string {
  if (!Array.isArray(payload.summary)) return "";
  return payload.summary
    .flatMap((value) => {
      const block = object(value);
      return typeof block?.text === "string" ? [block.text] : [];
    })
    .join("\n\n")
    .trim();
}
