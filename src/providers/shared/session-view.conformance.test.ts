import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../../core/types.ts";
import {
  CONTROL_CAPABILITIES,
  noSandbox,
  providerControlCoordination,
  reasoningEffortsForProvider,
  sessionRecordId,
} from "../../shared/session.ts";

/*
  The one shape both managed adapters publish.

  Codex and Claude assemble ~35 fields each, by hand, from unrelated provider
  state. Everything asserted here is a property neither provider is free to
  differ on — so it holds before and after any consolidation of those two
  builders, and a collapse that changed published behaviour fails here rather
  than in review.

  Provider-specific facts are deliberately absent: `sandbox` for Codex, lineage,
  presence, and `updatedAt` are judgements each adapter owns, and asserting them
  in common would be asserting a coincidence.
*/

export function assertPublishedSessionView(view: SessionView): void {
  // Identity is derived, never asserted independently of its parts.
  assert.equal(
    view.id,
    sessionRecordId(view.hostId, view.provider, view.providerThreadId),
    "session id must be derived from host, provider, and provider thread",
  );
  assert.equal(view.hostId, "local");
  assert.equal(view.hostLabel, "This Mac");

  // A managed provider session is never anything else.
  assert.equal(view.kind, "interactive");
  assert.equal(view.depth, 0);
  assert.equal(view.archived, false);
  assert.equal(view.terminal, null);
  assert.equal(view.todoProgress, null);
  assert.equal(view.statusSource, "provider-api");
  assert.deepEqual(view.childSummary, {
    total: 0,
    running: 0,
    waiting: 0,
    idle: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    unknown: 0,
  });

  // Coordination is a property of the provider, not of one session's state.
  assert.deepEqual(view.control.coordination, providerControlCoordination(view.provider));

  // The two published lists partition what the adapter ruled on, and every
  // member is a real capability.
  const granted = new Set(view.control.capabilities);
  const withheld = new Set(view.control.withheld.map(({ capability }) => capability));
  assert.equal(granted.size, view.control.capabilities.length, "capabilities are unique");
  assert.equal(withheld.size, view.control.withheld.length, "withheld entries are unique");
  for (const capability of granted) {
    assert.equal(withheld.has(capability), false, `${capability} is granted and withheld`);
    assert.ok(CONTROL_CAPABILITIES.includes(capability), `${capability} is not a capability`);
  }
  for (const capability of withheld) {
    assert.ok(CONTROL_CAPABILITIES.includes(capability), `${capability} is not a capability`);
  }

  // Capabilities a later layer owns must reach neither list, or the server's
  // own decorators read them as a standing refusal.
  for (const deferred of ["open-editor", "take-control", "cancel-take-control", "preview"] as const) {
    assert.equal(granted.has(deferred), false, `${deferred} must be deferred, not granted`);
    assert.equal(withheld.has(deferred), false, `${deferred} must be deferred, not withheld`);
  }

  // A withheld capability the operator cannot act on still owes them a reason.
  for (const { capability, reason } of view.control.withheld) {
    assert.equal(typeof reason, "string", `${capability} reason is not a string`);
    assert.ok(reason.trim().length > 0, `${capability} has an empty reason`);
    assert.equal(reason.includes("\n"), false, `${capability} reason spans lines`);
  }

  // Publication order is the vocabulary's, so two providers offering the same
  // set cannot publish it in two orders.
  const order = (list: readonly string[]) =>
    [...list].sort((a, b) => CONTROL_CAPABILITIES.indexOf(a as never) - CONTROL_CAPABILITIES.indexOf(b as never));
  assert.deepEqual(view.control.capabilities, order(view.control.capabilities));
  assert.deepEqual(
    view.control.withheld.map(({ capability }) => capability),
    order(view.control.withheld.map(({ capability }) => capability)),
  );

  // Absence of a provider fact is a gap in observation, never a proven value.
  for (const [name, evidenced] of [
    ["profile", view.profile],
    ["model", view.model],
    ["effort", view.effort],
  ] as const) {
    if (evidenced.providerValue === null) {
      assert.equal(evidenced.confidence, "heuristic", `${name} claims exactness for nothing`);
    }
  }

  // Claude having no sandbox is an exact fact; Codex's is a real policy.
  if (view.provider === "claude") assert.deepEqual(view.sandbox, noSandbox());

  // Neither provider may publish a level outside its own vocabulary.
  if (view.effort.value !== null) {
    assert.ok(
      reasoningEffortsForProvider(view.provider).includes(view.effort.value),
      `${view.effort.value} is outside the ${view.provider} vocabulary`,
    );
  }

  assert.ok(Number.isFinite(Date.parse(view.updatedAt)), "updatedAt is not a timestamp");
  assert.ok(Number.isInteger(view.generation) && view.generation >= 0);
}

test("the conformance assertions accept a well-formed managed view", () => {
  // A guard on the guard: the suite is only useful if it can fail.
  const base: SessionView = {
    id: "local:claude:session-1",
    provider: "claude",
    providerThreadId: "session-1",
    providerTreeId: "session-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: null,
    cwd: "/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: null,
    runtimePid: null,
    startedAt: null,
    updatedAt: "2026-08-05T12:00:00.000Z",
    childSummary: {
      total: 0, running: 0, waiting: 0, idle: 0,
      completed: 0, failed: 0, interrupted: 0, unknown: 0,
    },
    statusSource: "provider-api",
    source: "claude-sdk",
    profile: { value: null, providerValue: null, source: "provider-api", confidence: "heuristic" },
    sandbox: noSandbox(),
    model: { value: null, providerValue: null, source: "provider-api", confidence: "heuristic" },
    effort: { value: null, providerValue: null, source: "provider-api", confidence: "heuristic" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "claude-sdk",
      authority: "manager",
      coordination: providerControlCoordination("claude"),
      recovery: null,
      capabilities: ["queue", "interrupt"],
      withheld: [{ capability: "set-sandbox", reason: "Claude has no sandbox setting" }],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 1,
  };
  assertPublishedSessionView(base);

  assert.throws(() => assertPublishedSessionView({
    ...base,
    control: { ...base.control, capabilities: ["queue", "interrupt", "open-editor"] },
  }), /open-editor must be deferred/u);

  assert.throws(() => assertPublishedSessionView({
    ...base,
    control: {
      ...base.control,
      withheld: [{ capability: "set-sandbox", reason: "   " }],
    },
  }), /empty reason/u);

  assert.throws(() => assertPublishedSessionView({
    ...base,
    control: { ...base.control, capabilities: ["interrupt", "queue"] },
  }), /Expected values to be strictly deep-equal/u);

  assert.throws(() => assertPublishedSessionView({ ...base, hostId: "studio" }));

  assert.throws(() => assertPublishedSessionView({
    ...base,
    effort: { value: "minimal", providerValue: "minimal", source: "provider-api", confidence: "exact" },
  }), /outside the claude vocabulary/u);
});
