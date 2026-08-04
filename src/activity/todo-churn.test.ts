import assert from "node:assert/strict";
import test from "node:test";

import { reconcileTodoRewrite } from "./todo-churn.ts";

const step = (id: string, text = id) => ({
  id,
  text,
  status: "pending" as const,
  detail: null,
});

test("todo rewrites preserve identity while retaining additions and removed tombstones", () => {
  const baseline = reconcileTodoRewrite(null, [step("one"), step("two")]);
  assert.deepEqual(baseline, {
    steps: [
      { ...step("one"), addedAfterStart: false, removedReason: null },
      { ...step("two"), addedAfterStart: false, removedReason: null },
    ],
    added: 0,
    removed: 0,
  });

  const rewrite = reconcileTodoRewrite(baseline, [
    { ...step("two"), status: "in_progress" },
    step("three"),
  ]);
  assert.deepEqual(rewrite, {
    steps: [
      { ...step("two"), status: "in_progress", addedAfterStart: false, removedReason: null },
      { ...step("three"), addedAfterStart: true, removedReason: null },
      { ...step("one"), status: "removed", addedAfterStart: false, removedReason: null },
    ],
    added: 1,
    removed: 1,
  });

  const later = reconcileTodoRewrite(rewrite, [step("three"), step("four")]);
  assert.deepEqual(later.steps.map((entry) => [entry.id, entry.status, entry.addedAfterStart]), [
    ["three", "pending", true],
    ["four", "pending", true],
    ["one", "removed", false],
    ["two", "removed", false],
  ]);
  assert.equal(later.added, 2);
  assert.equal(later.removed, 2);
});

test("todo removal reasons cross the contract only when the provider supplies one", () => {
  const baseline = reconcileTodoRewrite(null, [step("keep"), step("drop")]);
  const withoutReason = reconcileTodoRewrite(baseline, [step("keep")]);
  assert.equal(withoutReason.steps.find((entry) => entry.id === "drop")?.removedReason, null);

  const supplied = reconcileTodoRewrite(
    baseline,
    [step("keep")],
    new Map([["drop", "Provider cancelled this exact todo"]]),
  );
  assert.equal(
    supplied.steps.find((entry) => entry.id === "drop")?.removedReason,
    "Provider cancelled this exact todo",
  );
});

test("todo rewrites reject duplicate provider identities", () => {
  assert.throws(
    () => reconcileTodoRewrite(null, [step("duplicate"), step("duplicate")]),
    /duplicate todo step id/u,
  );
});
