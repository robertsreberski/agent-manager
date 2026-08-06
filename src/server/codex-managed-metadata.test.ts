import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../shared/session.ts";
import {
  codexProfileRepairCandidateIds,
  mergeCodexManagedSessionMetadata,
  repairPersistedCodexManagedSessions,
} from "./codex-managed-metadata.ts";
import { ManagerDatabase } from "./persistence.ts";

const createdAt = "2026-08-03T08:00:00.000Z";
const updatedAt = "2026-08-03T08:05:00.000Z";

function persistCodex(
  database: ManagerDatabase,
  threadId: string,
  metadata: Record<string, unknown>,
): void {
  database.upsertManagedSession({
    id: `local:codex:${threadId}`,
    provider: "codex",
    providerSessionId: threadId,
    workspaceId: "workspace",
    metadata: {
      managerRequestId: `request:${threadId}`,
      name: threadId,
      profile: "execute",
      model: null,
      effort: null,
      hostId: "local",
      ownership: "shared",
      providerTreeId: `tree:${threadId}`,
      providerParentThreadId: null,
      ...metadata,
    },
    createdAt,
    updatedAt,
  });
}

test("repairs only callback-corrupted Codex settings and preserves durable identity clocks", () => {
  const database = new ManagerDatabase();
  try {
    database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
    persistCodex(database, "missing-profile", {
      name: "x".repeat(121),
      profile: null,
      unrelated: { retained: true },
    });

    assert.deepEqual(codexProfileRepairCandidateIds(database), ["missing-profile"]);
    assert.deepEqual(
      repairPersistedCodexManagedSessions(
        database,
        new Map([["missing-profile", "full-access"]]),
      ),
      [{
        id: "local:codex:missing-profile",
        fields: ["name", "profile"],
        profile: "full-access",
      }],
    );

    const repaired = database.listManagedSessions()[0];
    assert.ok(repaired);
    assert.equal(repaired.createdAt, createdAt);
    assert.equal(repaired.updatedAt, updatedAt);
    assert.equal(repaired.metadata.name, null);
    assert.equal(repaired.metadata.profile, "full-access");
    assert.equal(repaired.metadata.providerTreeId, "tree:missing-profile");
    assert.equal(repaired.metadata.providerParentThreadId, null);
    assert.deepEqual(repaired.metadata.unrelated, { retained: true });
    assert.deepEqual(repairPersistedCodexManagedSessions(database), []);
  } finally {
    database.close();
  }
});

test("falls back to plan but never repairs a mismatched Codex identity", () => {
  const database = new ManagerDatabase();
  try {
    database.addWorkspace({ id: "workspace", label: "Workspace", path: "/tmp/workspace" });
    persistCodex(database, "fallback", { profile: null });
    persistCodex(database, "wrong-host", { profile: null, hostId: "remote" });

    const repairs = repairPersistedCodexManagedSessions(database);
    assert.deepEqual(repairs, [{
      id: "local:codex:fallback",
      fields: ["profile"],
      profile: "plan",
    }]);
    const records = new Map(database.listManagedSessions().map((record) => [record.id, record]));
    assert.equal(records.get("local:codex:fallback")?.metadata.profile, "plan");
    assert.equal(records.get("local:codex:wrong-host")?.metadata.profile, null);
  } finally {
    database.close();
  }
});

test("keeps heuristic unknowns and oversized provider titles out of durable metadata", () => {
  const heuristicUnknown = {
    name: "x".repeat(220),
    profile: {
      value: null,
      providerValue: null,
      source: "provider-api",
      confidence: "heuristic",
    },
    model: {
      value: null,
      providerValue: null,
      source: "provider-api",
      confidence: "heuristic",
    },
    effort: {
      value: null,
      providerValue: null,
      source: "provider-api",
      confidence: "heuristic",
    },
  } satisfies Pick<SessionView, "name" | "profile" | "model" | "effort">;
  const persisted = {
    name: "Manager title",
    profile: "execute",
    model: "gpt-5.6",
    effort: "high",
    ownership: "shared",
    recovery: { state: "reconnecting" },
    unrelated: true,
  };

  assert.deepEqual(mergeCodexManagedSessionMetadata(persisted, heuristicUnknown), {
    ...persisted,
    name: "Manager title",
    profile: "execute",
    model: "gpt-5.6",
    effort: "high",
    ownership: "shared",
    recovery: null,
  });
  assert.equal(
    mergeCodexManagedSessionMetadata({ ...persisted, name: null }, heuristicUnknown).name,
    null,
  );

  const confirmed = {
    ...heuristicUnknown,
    name: "Confirmed title",
    profile: { ...heuristicUnknown.profile, value: "full-access", confidence: "exact" },
    model: { ...heuristicUnknown.model, value: "gpt-5.6-sol", confidence: "exact" },
    effort: { ...heuristicUnknown.effort, value: "ultra", confidence: "exact" },
  } satisfies Pick<SessionView, "name" | "profile" | "model" | "effort">;
  const merged = mergeCodexManagedSessionMetadata(persisted, confirmed);
  assert.equal(merged.name, "Confirmed title");
  assert.equal(merged.profile, "full-access");
  assert.equal(merged.model, "gpt-5.6-sol");
  assert.equal(merged.effort, "ultra");
});
