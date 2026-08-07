import { describe, expect, it } from "vitest";
import { displayDuration, groupActivityPart, isTrailingToolRun, toolCallDetail, toolGroupTiming, toolRunActive, toolRunPresentation } from "./grouping";

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

/*
  A run goes quiet between calls: the moment the last call reports its result
  every part in the group reads `complete`, which is indistinguishable from the
  run having finished. Taking the group's hold from that alone collapsed the
  panel in every gap and reopened it on the next call — once per tool, for the
  length of the turn. The turn's own status is what tells the two apart.
*/
describe("tool run activity", () => {
  const settledRun = [
    { type: "reasoning" },
    { type: "tool-call" },
    { type: "tool-call" },
  ];

  it("treats a run as trailing until a later tool call joins the message", () => {
    expect(isTrailingToolRun(settledRun, [1, 2])).toBe(true);
    // Aggregate bookkeeping does not close a run; human-visible boundaries do.
    expect(isTrailingToolRun([...settledRun, { type: "data" }], [1, 2])).toBe(true);
    expect(isTrailingToolRun([...settledRun, { type: "data", name: "agent-manager.attention" }], [1, 2])).toBe(false);
    expect(isTrailingToolRun([...settledRun, { type: "data", name: "agent-manager.todo" }], [1, 2])).toBe(false);
    expect(isTrailingToolRun([...settledRun, { type: "text" }, { type: "tool-call" }], [1, 2])).toBe(false);
    expect(isTrailingToolRun(settledRun, [])).toBe(false);
  });

  it("holds a settled trailing run while the turn is still in motion", () => {
    expect(toolRunActive({ type: "complete" }, settledRun, [1, 2], true)).toBe(true);
    expect(toolRunActive({ type: "complete" }, settledRun, [1, 2], false)).toBe(false);
  });

  it("releases a run that a later part already closed, even mid-turn", () => {
    const parts = [...settledRun, { type: "text" }, { type: "tool-call" }];
    expect(toolRunActive({ type: "complete" }, parts, [1, 2], true)).toBe(false);
    expect(toolRunActive({ type: "complete" }, parts, [4], true)).toBe(true);
  });

  it("holds a run whose own calls are running whatever the turn reports", () => {
    expect(toolRunActive({ type: "running" }, settledRun, [1, 2], false)).toBe(true);
    expect(toolRunActive({ type: "requires-action" }, settledRun, [1, 2], false)).toBe(true);
  });

  it("distinguishes a parent tool waiting for the operator from active work", () => {
    const waiting = [
      { type: "tool-call", providerMetadata: { "agent-manager": { waitingLabel: "waiting for answer" } } },
      { type: "data", name: "agent-manager.attention" },
    ];
    expect(toolRunPresentation({ type: "complete" }, waiting, [0], true)).toEqual({
      phase: "waiting",
      label: "waiting for answer",
    });
    expect(toolRunActive({ type: "complete" }, waiting, [0], true)).toBe(false);
  });

  it("keeps a completed pre-question run settled after the answer resolves", () => {
    const answered = [
      { type: "tool-call" },
      { type: "data", name: "agent-manager.attention" },
    ];
    expect(toolRunPresentation({ type: "complete" }, answered, [0], true)).toEqual({
      phase: "settled",
      label: null,
    });
    const resumed = [...answered, { type: "tool-call" }];
    expect(toolRunPresentation({ type: "complete" }, resumed, [2], true).phase).toBe("active");
    expect(toolRunPresentation({ type: "running" }, answered, [0], true).phase).toBe("active");
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
