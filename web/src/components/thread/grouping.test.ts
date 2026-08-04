import { describe, expect, it } from "vitest";
import { displayDuration, groupActivityPart, toolGroupTiming } from "./grouping";

describe("activity grouping", () => {
  it("groups only adjacent thought/tool and one-level subagent parts", () => {
    expect(groupActivityPart({ type: "reasoning" })).toEqual(["group-thought"]);
    expect(groupActivityPart({ type: "tool-call", toolName: "exec" })).toEqual(["group-thought", "group-tools"]);
    expect(groupActivityPart({ type: "data", name: "agent-manager.subagent" })).toEqual(["group-subagent"]);
    expect(groupActivityPart({ type: "text" })).toEqual([]);
  });
  it("omits untrusted timing", () => {
    expect(displayDuration({ startedAt: 1, completedAt: 1501 })).toBe("1.5s");
    expect(displayDuration({ startedAt: 2, completedAt: 1 })).toBeNull();
  });

  it("derives an exact tool-group span only when every call completed", () => {
    const parts = [
      { type: "reasoning" },
      { type: "tool-call", timing: { startedAt: 1_000, completedAt: 1_500 } },
      { type: "tool-call", timing: { startedAt: 1_600, completedAt: 2_250 } },
    ];
    expect(toolGroupTiming(parts, [1, 2])).toEqual({ startedAt: 1_000, completedAt: 2_250 });
    expect(toolGroupTiming([
      ...parts.slice(0, 2),
      { type: "tool-call", timing: { startedAt: 1_600 } },
    ], [1, 2])).toBeUndefined();
    expect(toolGroupTiming(parts, [0])).toBeUndefined();
  });
});
