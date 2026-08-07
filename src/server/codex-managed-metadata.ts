import { isAbsolute } from "node:path";

import type { ExecutionProfile, SessionView } from "../shared/session.ts";
import { sessionRecordId } from "../shared/session.ts";
import {
  executionProfileSchema,
  reasoningEffortSchema,
  sandboxPolicySchema,
} from "./contracts.ts";
import type { ManagedSessionMetadata } from "./persistence.ts";
import { ManagerDatabase } from "./persistence.ts";

const MAX_PERSISTED_NAME_LENGTH = 120;
const MAX_PERSISTED_MODEL_LENGTH = 256;

export interface CodexManagedMetadataRepair {
  id: string;
  fields: readonly ("name" | "profile")[];
  profile: ExecutionProfile;
}

function validPersistedName(value: unknown): value is string | null {
  return value === null
    || (typeof value === "string" && value.length <= MAX_PERSISTED_NAME_LENGTH);
}

function validPersistedModel(value: unknown): value is string | null {
  return value === null
    || (typeof value === "string"
      && value.length > 0
      && value.length <= MAX_PERSISTED_MODEL_LENGTH);
}

/**
 * This deliberately mirrors the non-repairable Codex checks in
 * managedRecoveryRecords. A bad profile or generated title is recoverable;
 * a mismatched provider/workspace/ownership identity is not.
 */
function canRepairCodexMetadata(
  database: ManagerDatabase,
  persisted: ManagedSessionMetadata,
): boolean {
  if (persisted.provider !== "codex") return false;
  const workspace = persisted.workspaceId
    ? database.getWorkspace(persisted.workspaceId)
    : null;
  return persisted.providerSessionId.length > 0
    && persisted.providerSessionId.length <= 512
    && persisted.id === sessionRecordId("local", "codex", persisted.providerSessionId)
    && workspace !== null
    && workspace.hostId === "local"
    && workspace.hostKind === "local"
    && isAbsolute(workspace.path)
    && persisted.metadata.hostId === "local"
    && validPersistedModel(persisted.metadata.model)
    && reasoningEffortSchema.nullable().safeParse(persisted.metadata.effort).success
    && sandboxPolicySchema.nullable().safeParse(persisted.metadata.sandbox ?? null).success
    && (persisted.metadata.ownership ?? "shared") === "shared"
    && (persisted.metadata.nativeOwner ?? null) === null
    && persisted.metadata.managerControl === undefined
    && Number.isFinite(Date.parse(persisted.createdAt))
    && Number.isFinite(Date.parse(persisted.updatedAt));
}

export function codexProfileRepairCandidateIds(database: ManagerDatabase): string[] {
  return [...new Set(database.listManagedSessions().flatMap((persisted) =>
    canRepairCodexMetadata(database, persisted)
      && !executionProfileSchema.safeParse(persisted.metadata.profile).success
      ? [persisted.providerSessionId]
      : []
  ))];
}

/**
 * Repairs only the two fields the Codex provider callback historically wrote
 * outside their durable schema. The original record clocks and every identity
 * component remain byte-for-byte stable.
 */
export function repairPersistedCodexManagedSessions(
  database: ManagerDatabase,
  profileHints: ReadonlyMap<string, ExecutionProfile> = new Map(),
): CodexManagedMetadataRepair[] {
  const repairs: CodexManagedMetadataRepair[] = [];
  for (const persisted of database.listManagedSessions()) {
    if (!canRepairCodexMetadata(database, persisted)) continue;
    const persistedProfile = executionProfileSchema.safeParse(persisted.metadata.profile);
    const validName = validPersistedName(persisted.metadata.name);
    if (persistedProfile.success && validName) continue;

    const hintedProfile = executionProfileSchema.safeParse(
      profileHints.get(persisted.providerSessionId),
    );
    const profile = persistedProfile.success
      ? persistedProfile.data
      : hintedProfile.success
        ? hintedProfile.data
        : "plan";
    const fields: Array<"name" | "profile"> = [];
    if (!validName) fields.push("name");
    if (!persistedProfile.success) fields.push("profile");
    database.upsertManagedSession({
      ...persisted,
      metadata: {
        ...persisted.metadata,
        name: validName ? persisted.metadata.name : null,
        profile,
      },
      // Repair is not activity and must not make a stale thread look live.
      updatedAt: persisted.updatedAt,
    });
    repairs.push({ id: persisted.id, fields, profile });
  }
  return repairs;
}

function durableModel(
  persisted: unknown,
  observed: Pick<SessionView, "model">["model"],
): string | null {
  if (observed.value === null && observed.confidence === "heuristic") {
    return validPersistedModel(persisted) ? persisted : null;
  }
  return validPersistedModel(observed.value)
    ? observed.value
    : validPersistedModel(persisted)
      ? persisted
      : null;
}

function durableEffort(
  persisted: unknown,
  observed: Pick<SessionView, "effort">["effort"],
): SessionView["effort"]["value"] {
  const persistedEffort = reasoningEffortSchema.nullable().safeParse(persisted);
  if (observed.value === null && observed.confidence === "heuristic") {
    return persistedEffort.success ? persistedEffort.data : null;
  }
  const observedEffort = reasoningEffortSchema.nullable().safeParse(observed.value);
  return observedEffort.success
    ? observedEffort.data
    : persistedEffort.success
      ? persistedEffort.data
      : null;
}

function durableSandbox(
  persisted: unknown,
  observed: Pick<SessionView, "sandbox">["sandbox"],
): SessionView["sandbox"]["value"] {
  const persistedSandbox = sandboxPolicySchema.nullable().safeParse(persisted);
  if (observed.value === null && observed.confidence === "heuristic") {
    return persistedSandbox.success ? persistedSandbox.data : null;
  }
  const observedSandbox = sandboxPolicySchema.nullable().safeParse(observed.value);
  return observedSandbox.success
    ? observedSandbox.data
    : persistedSandbox.success
      ? persistedSandbox.data
      : null;
}

/**
 * Provider views may truthfully carry heuristic unknowns while a setting is
 * still being confirmed. Those unknowns belong in the live view, not in the
 * durable identity required for restart recovery.
 */
export function mergeCodexManagedSessionMetadata(
  persisted: Readonly<Record<string, unknown>>,
  observed: Pick<SessionView, "name" | "profile" | "sandbox" | "model" | "effort">,
): Record<string, unknown> {
  const observedProfile = executionProfileSchema.safeParse(observed.profile.value);
  const persistedProfile = executionProfileSchema.safeParse(persisted.profile);
  const profile = observedProfile.success
    ? observedProfile.data
    : persistedProfile.success
      ? persistedProfile.data
      : "plan";
  const name = validPersistedName(observed.name)
    ? observed.name
    : validPersistedName(persisted.name)
      ? persisted.name
      : null;
  return {
    ...persisted,
    name,
    profile,
    sandbox: durableSandbox(persisted.sandbox, observed.sandbox),
    model: durableModel(persisted.model, observed.model),
    effort: durableEffort(persisted.effort, observed.effort),
    ownership: "shared",
    recovery: null,
  };
}
