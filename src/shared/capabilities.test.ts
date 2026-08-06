import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_CAPABILITIES, OBSERVE_ONLY_REASON, observeOnlyControl } from "./session.ts";
import { assertCapabilityContract } from "../providers/shared/session-view.conformance.test.ts";
import {
  DEFERRED,
  allCapabilities,
  deferredToLaterLayers,
  resolveControlCapabilities,
  type CapabilityRulings,
} from "./capabilities.ts";

function rulings(overrides: Partial<CapabilityRulings> = {}): CapabilityRulings {
  return { ...allCapabilities("not available here"), ...overrides } as CapabilityRulings;
}

test("a ruling table splits into disjoint published lists", () => {
  const { capabilities, withheld } = resolveControlCapabilities(rulings({
    queue: true,
    steer: true,
    interrupt: "Available while a turn is running",
  }));
  assert.deepEqual(capabilities.slice(0, 2), ["queue", "steer"]);
  const withheldNames = new Set(withheld.map(({ capability }) => capability));
  for (const capability of capabilities) {
    assert.equal(withheldNames.has(capability), false, `${capability} is in both lists`);
  }
  assert.equal(
    withheld.find(({ capability }) => capability === "interrupt")?.reason,
    "Available while a turn is running",
  );
});

test("granted and withheld together account for every capability that was ruled on", () => {
  const { capabilities, withheld } = resolveControlCapabilities(rulings({ queue: true }));
  const accounted = new Set([...capabilities, ...withheld.map((entry) => entry.capability)]);
  assert.equal(accounted.size, CONTROL_CAPABILITIES.length);
  for (const capability of CONTROL_CAPABILITIES) assert.ok(accounted.has(capability), capability);
});

test("a deferred capability reaches neither list", () => {
  /*
    `withLocalEditorCapability` treats a withheld `open-editor` as a standing
    refusal, so publishing an honest reason for it would remove the editor
    button from every managed session. Deferring leaves the decision to the
    layer that owns it.
  */
  const { capabilities, withheld } = resolveControlCapabilities(rulings({
    ...deferredToLaterLayers(),
    queue: true,
  }));
  for (const capability of ["open-editor", "take-control", "cancel-take-control", "preview"] as const) {
    assert.equal(capabilities.includes(capability), false, `${capability} granted`);
    assert.equal(
      withheld.some((entry) => entry.capability === capability),
      false,
      `${capability} withheld`,
    );
  }
});

test("publication order follows the capability vocabulary, not insertion order", () => {
  const { capabilities } = resolveControlCapabilities(rulings({
    "open-editor": true,
    queue: true,
    resume: true,
  }));
  const expected = CONTROL_CAPABILITIES.filter((capability) =>
    ["open-editor", "queue", "resume"].includes(capability)
  );
  assert.deepEqual(capabilities, expected);
});

test("a withheld capability with no reason is a caller bug, not a valid state", () => {
  assert.throws(() => resolveControlCapabilities(rulings({ queue: "" })), /needs a reason/u);
  assert.throws(() => resolveControlCapabilities(rulings({ queue: "   " })), /needs a reason/u);
});

test("allCapabilities covers the vocabulary exactly", () => {
  const table = allCapabilities(DEFERRED);
  assert.deepEqual(Object.keys(table).sort(), [...CONTROL_CAPABILITIES].sort());
  const { capabilities, withheld } = resolveControlCapabilities(table as CapabilityRulings);
  assert.deepEqual(capabilities, []);
  assert.deepEqual(withheld, []);
});

test("an observed session refuses every write it cannot do, and says why", () => {
  const control = observeOnlyControl();
  assertCapabilityContract(control);

  /*
    The regression this exists for. Publishing two empty lists left the cockpit
    disabling every control and then reaching for a fallback string, which told
    operators the harness had no model setting — of a harness that has one, on a
    session Agent Manager simply does not own.
  */
  const withheld = new Map(control.withheld.map(({ capability, reason }) => [capability, reason]));
  for (const capability of ["set-model", "set-effort", "set-profile", "queue", "steer"] as const) {
    assert.equal(control.capabilities.includes(capability), false, `${capability} must not be granted`);
    assert.equal(withheld.get(capability), OBSERVE_ONLY_REASON, `${capability} must state why`);
  }
  assert.match(OBSERVE_ONLY_REASON, /take control/iu, "the reason names the remedy");
  assert.doesNotMatch(OBSERVE_ONLY_REASON, /harness/iu, "the reason blames no harness limitation");

  /*
    Discovery grants these by replacing `capabilities` outright while keeping
    `withheld`, so withholding them here would leave them granted and refused at
    the same time the moment a session is matched to a tmux pane.
  */
  for (const capability of ["take-control", "attach", "resume", "preview", "open-editor"] as const) {
    assert.equal(withheld.has(capability), false, `${capability} must stay deferred`);
    assert.equal(control.capabilities.includes(capability), false, `${capability} must stay deferred`);
  }
});
