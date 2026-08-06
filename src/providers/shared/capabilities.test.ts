import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_CAPABILITIES } from "../../shared/session.ts";
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
