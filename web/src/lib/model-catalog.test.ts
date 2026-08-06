import { describe, expect, it } from "vitest";
import { composerEffortOptions, coveringModelOption } from "./model-catalog";
import { CLAUDE_REASONING_EFFORTS, CODEX_REASONING_EFFORTS } from "../../../src/shared/session.ts";

describe("composerEffortOptions", () => {
  it("uses the granted harness vocabulary while the catalog is unavailable", () => {
    expect(composerEffortOptions("claude", undefined, true)).toEqual(CLAUDE_REASONING_EFFORTS);
    expect(composerEffortOptions("codex", undefined, true)).toEqual(CODEX_REASONING_EFFORTS);
  });

  it("uses exactly the levels a loaded catalog names", () => {
    expect(composerEffortOptions("claude", ["low", "high"], true)).toEqual(["low", "high"]);
    // A granted capability does not widen what the provider actually declared.
    expect(composerEffortOptions("codex", ["medium"], true)).toEqual(["medium"]);
  });

  it("falls back to the provider vocabulary when a loaded catalog names none", () => {
    /*
      This is the case that left a fresh Claude draft with no effort control:
      the catalog loads, every row abstains or disagrees, and the intersection
      is empty. A granted write is the harness's own claim that a level from its
      vocabulary will be accepted, so that vocabulary is the honest offer.
    */
    expect(composerEffortOptions("claude", [], true)).toEqual(CLAUDE_REASONING_EFFORTS);
    expect(composerEffortOptions("codex", [], true)).toEqual(CODEX_REASONING_EFFORTS);
    // Claude's vocabulary excludes the Codex-only levels.
    expect(composerEffortOptions("claude", [], true)).not.toContain("minimal");
    expect(composerEffortOptions("claude", [], true)).not.toContain("ultra");
  });

  it("offers nothing the harness has not granted", () => {
    expect(composerEffortOptions("claude", [], false)).toEqual([]);
    // A withheld capability cannot be rescued by a catalog that named levels
    // either — the composer disables the control, and this only sizes it.
    expect(composerEffortOptions("codex", undefined, false)).toEqual([]);
  });

  it("offers nothing before a draft has chosen a provider", () => {
    // There is no vocabulary to fall back to until the harness is known.
    expect(composerEffortOptions(null, [], true)).toEqual([]);
    expect(composerEffortOptions(null, ["low"], true)).toEqual(["low"]);
  });
});

describe("coveringModelOption", () => {
  it("matches a wire model id through an alias row", () => {
    const models = [
      { value: "sonnet", resolvedModel: "claude-sonnet-5" },
      { value: "opus", resolvedModel: "claude-opus-5" },
    ];
    expect(coveringModelOption("claude-opus-5", models)?.value).toBe("opus");
    expect(coveringModelOption("sonnet", models)?.value).toBe("sonnet");
    expect(coveringModelOption("missing", models)).toBeNull();
  });

  it("covers a null model only with the row the catalog marks default", () => {
    expect(coveringModelOption(null, [{ value: "a" }, { value: "b", isDefault: true }])?.value).toBe("b");
    // "The first row" is an accident of ordering, not a claim the catalog made.
    expect(coveringModelOption(null, [{ value: "a" }, { value: "b" }])).toBeNull();
  });
});
