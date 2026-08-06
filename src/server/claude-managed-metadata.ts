import type { SessionView } from "../core/types.ts";
import type { ManagedSessionMetadata } from "./persistence.ts";

export function isLegacyClaudeSharedRecoveryCandidate(
  record: Pick<ManagedSessionMetadata, "provider" | "metadata">,
): boolean {
  // Only the old steady manager-owned state has an unambiguous shared-join
  // meaning. Transitional handoff/native ownership remains fail-closed.
  return record.provider === "claude"
    && record.metadata.ownership === "manager-exclusive"
    && (record.metadata.nativeOwner ?? null) === null
    && (record.metadata.handoffId ?? null) === null;
}

export function mergeClaudeManagedSessionMetadata(
  persisted: ManagedSessionMetadata,
  session: Pick<
    SessionView,
    "name" | "profile" | "model" | "effort" | "providerStatus" | "control"
  >,
): Record<string, unknown> {
  const recoveryMustCanonicalizeOwnership = isLegacyClaudeSharedRecoveryCandidate(persisted);
  return {
    ...persisted.metadata,
    name: session.name,
    profile: session.profile.value,
    model: session.model.value,
    effort: session.effort.value,
    managerControl: session.providerStatus === "closed"
      ? persisted.metadata.managerControl ?? "active"
      : "active",
    // A provider callback can run before the recovery coordinator validates
    // the restored session and workspace. Preserve an eligible legacy marker
    // until that exact validation succeeds; the coordinator alone may upgrade
    // it to shared ownership.
    ...(session.control.authority === "manager" && !recoveryMustCanonicalizeOwnership
      ? {
          ownership: "shared",
          recovery: null,
        }
      : {}),
  };
}
