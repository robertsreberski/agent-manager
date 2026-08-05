import { describe, expect, it } from "vitest";

import { providerControlCoordination } from "../../../src/shared/session.ts";
import { AGENT_MANAGER_BUILD_ID, WireUpgradeRequiredError, WIRE_SCHEMA_VERSION } from "../../../src/shared/wire.ts";
import { parseSessionRecord, parseSnapshot } from "./normalize";

function session() {
  return {
    id: "local:codex:thread-1",
    provider: "codex",
    providerThreadId: "thread-1",
    providerTreeId: null,
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: null,
    cwd: "/tmp/project",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: null,
    runtimePid: null,
    startedAt: null,
    updatedAt: "2026-08-04T10:00:00.000Z",
    childSummary: {
      total: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    },
    statusSource: "provider-api",
    source: "thread/list",
    profile: {
      value: "plan",
      providerValue: "plan",
      source: "provider-api",
      confidence: "exact",
    },
    model: {
      value: "gpt-5.6",
      providerValue: "gpt-5.6",
      source: "provider-api",
      confidence: "exact",
    },
    effort: {
      value: "medium",
      providerValue: "medium",
      source: "provider-api",
      confidence: "exact",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "set-profile"],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 1,
  };
}

describe("strict browser wire parsing", () => {
  it("accepts an exact current session and snapshot", () => {
    expect(parseSessionRecord(session()).providerThreadId).toBe("thread-1");
    expect(parseSnapshot({
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: AGENT_MANAGER_BUILD_ID,
      generatedAt: "2026-08-04T10:00:00.000Z",
      seq: 1,
      stale: false,
      sessions: [session()],
      diagnostics: [],
    }).sessions).toHaveLength(1);
  });

  it("rejects old DTO aliases instead of translating them", () => {
    expect(() => parseSessionRecord({
      ...session(),
      sessionId: "thread-1",
    })).toThrow();
    expect(() => parseSessionRecord({
      ...session(),
      mode: { value: "planning" },
    })).toThrow();
    expect(() => parseSessionRecord({
      ...session(),
      effectiveAccess: { accessMode: "sandboxed" },
    })).toThrow();
  });

  it("rejects an old snapshot epoch and partial sessions", () => {
    expect(() => parseSnapshot({
      version: 2,
      generatedAt: null,
      seq: null,
      stale: false,
      sessions: [],
      diagnostics: [],
    })).toThrow();
    expect(() => parseSessionRecord({ id: "local:codex:thread-1", provider: "codex" })).toThrow();
  });

  it("reports a build mismatch as upgrade-required rather than a generic invalid response", () => {
    expect(() => parseSnapshot({
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: "previous-build",
      generatedAt: "2026-08-04T10:00:00.000Z",
      seq: 1,
      stale: false,
      sessions: [],
      diagnostics: [],
    })).toThrow(WireUpgradeRequiredError);
  });
});
