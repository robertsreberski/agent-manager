import assert from "node:assert/strict";
import test from "node:test";

import { parseProposedPlan } from "./proposed-plan.ts";

test("parses an entire proposed-plan wrapper and preserves its markdown", () => {
  assert.equal(
    parseProposedPlan("\n<proposed_plan>\n# Fix\n\n- Inspect\n- Verify\n</proposed_plan>\n"),
    "# Fix\n\n- Inspect\n- Verify",
  );
});

test("rejects prose around, malformed, nested, repeated, and empty wrappers", () => {
  for (const value of [
    "Before <proposed_plan># Fix</proposed_plan>",
    "<proposed_plan># Fix</proposed_plan> after",
    "<proposed_plan># Fix",
    "<proposed_plan><proposed_plan># Fix</proposed_plan></proposed_plan>",
    "<proposed_plan># One</proposed_plan><proposed_plan># Two</proposed_plan>",
    "<proposed_plan>   </proposed_plan>",
  ]) assert.equal(parseProposedPlan(value), null, value);
});
