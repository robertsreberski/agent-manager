import { describe, expect, it } from "vitest";
import { displayDuration, groupActivityPart, toolCallDetail, toolGroupTiming } from "./grouping";

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

describe("collapsed tool detail", () => {
  it("prefers the command, path, then search argument a provider actually named", () => {
    expect(toolCallDetail({ workdir: "/repo", command: "rg --files -g '*.ts'" })).toBe("rg --files -g '*.ts'");
    expect(toolCallDetail({ description: "Read it", file_path: "/repo/README.md" })).toBe("/repo/README.md");
    expect(toolCallDetail({ path: "/repo/src", pattern: "seq" })).toBe("/repo/src");
    expect(toolCallDetail({ description: "Search", pattern: "seq" })).toBe("seq");
    expect(toolCallDetail({ limit: 5, query: "activity hub" })).toBe("activity hub");
  });

  it("never renders a serialized argument object on the collapsed row", () => {
    const args = { command: "/bin/zsh -lc \"sed -n '1,260p' 'README.md'\"", workdir: "/repo" };
    expect(toolCallDetail({ input: JSON.stringify(args) })).toBe(args.command);
    expect(toolCallDetail(JSON.stringify(args))).toBe(args.command);
    expect(toolCallDetail({ payload: JSON.stringify({ nothing: 1 }) })).toBeNull();
    expect(toolCallDetail({ items: "[1,2,3]" })).toBeNull();
  });

  it("collapses whitespace and bounds a very long detail", () => {
    expect(toolCallDetail({ command: "  cat one.txt \n  && cat two.txt  " })).toBe("cat one.txt && cat two.txt");
    const long = toolCallDetail({ command: "x".repeat(500) });
    expect(long?.length).toBe(200);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("returns nothing when the provider exposed no scalar argument", () => {
    expect(toolCallDetail({})).toBeNull();
    expect(toolCallDetail(null)).toBeNull();
    expect(toolCallDetail(42)).toBeNull();
    expect(toolCallDetail({ nested: { command: "hidden" } })).toBeNull();
  });
});
