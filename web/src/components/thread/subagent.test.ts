import { describe, expect, it } from "vitest";
import { activityToThreadMessages } from "../session-activity";
import { ACTIVITY_SCHEMA_VERSION, type ActivityItem } from "../../types";
import { buildSubagentHierarchy, type SubagentFrameData } from "./subagent";

function common(id: string, seq: number, parentId: string | null) {
  return {
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    id,
    sessionId: "local:claude:thread",
    provider: "claude" as const,
    turnId: "turn-1",
    parentId,
    seq,
    revision: 1,
    state: "complete" as const,
    startedAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:00:01.000Z",
    completedAt: "2026-08-04T10:00:01.000Z",
    source: "provider-api" as const,
    confidence: "exact" as const,
    exposure: "provider-exposed" as const,
    truncated: false,
  };
}

function fixture(): ActivityItem[] {
  return [
    {
      ...common("spawn", 1, null),
      kind: "tool", toolCallId: "spawn", name: "spawn_agent", category: "collaboration",
      arguments: { task: "Audit auth" }, result: null, output: "",
    },
    {
      ...common("sub", 2, "spawn"),
      kind: "subagent", taskId: "reviewer", name: "reviewer",
      description: "Audit the auth flow", output: "Found and fixed the race.",
      childItemIds: ["read", "diff", "usage"],
    },
    {
      ...common("read", 3, "sub"),
      kind: "tool", toolCallId: "read", name: "read_file", category: "command",
      arguments: { path: "src/auth.ts" }, result: "ok", output: "",
    },
    {
      ...common("diff", 4, "sub"), kind: "file-change", summary: "Updated auth",
      changes: [{ path: "src/auth.ts", previousPath: null, operation: "update", diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n-old\n+new\n+test\n" }],
    },
    {
      ...common("usage", 5, "sub"), kind: "usage", scope: "turn",
      inputTokens: 900, outputTokens: 500, cachedInputTokens: null,
      reasoningTokens: null, totalTokens: 1_400, costUsd: 0.04, contextWindow: null,
    },
    {
      ...common("nested", 6, "read"), kind: "subagent", taskId: "nested",
      name: "nested-reviewer", description: "Check one edge", output: "done", childItemIds: ["nested-tool"],
    },
    {
      ...common("nested-tool", 7, "nested"), kind: "tool", toolCallId: "nested-tool",
      name: "search", category: "command", arguments: {}, result: "hidden", output: "",
    },
    {
      ...common("after", 8, null), kind: "message", role: "assistant", phase: "final",
      text: "Parent result", label: null,
    },
  ];
}

describe("buildSubagentHierarchy", () => {
  it("renders one level, keeps direct steps, and derives only exact return facts", () => {
    const hierarchy = buildSubagentHierarchy(fixture());
    expect(hierarchy.topLevelItems.map((item) => item.id)).toEqual(["spawn", "sub", "after"]);

    const frame = hierarchy.frames.get("sub");
    expect(frame?.steps.map((item) => item.id)).toEqual(["read", "diff"]);
    expect(frame?.nestedCount).toBe(1);
    expect(frame?.returnFacts).toEqual({ additions: 2, removals: 1, tokens: 1_400, costUsd: 0.04 });
    expect(frame?.steps.some((item) => item.id === "nested-tool")).toBe(false);
  });

  it("uses childItemIds when a retained child has no resolvable parentId", () => {
    const items = fixture();
    const subagent = items.find((item) => item.id === "sub");
    if (!subagent || subagent.kind !== "subagent") throw new Error("missing fixture subagent");
    subagent.childItemIds.push("orphaned-child");
    items.push({
      ...common("orphaned-child", 9, "provider-id-outside-window"),
      kind: "reasoning", reasoningKind: "summary", label: null, text: "Retained child step",
    });
    const usage = items.find((item) => item.id === "usage");
    if (!usage) throw new Error("missing fixture usage");
    usage.parentId = "provider-id-outside-window";

    const hierarchy = buildSubagentHierarchy(items);
    expect(hierarchy.frames.get("sub")?.steps.map((item) => item.id)).toContain("orphaned-child");
    expect(hierarchy.frames.get("sub")?.returnFacts.tokens).toBe(1_400);
    expect(hierarchy.topLevelItems.map((item) => item.id)).not.toContain("orphaned-child");
  });

  it("omits footer numbers that the provider did not expose", () => {
    const root = fixture().find((item) => item.id === "sub")!;
    const hierarchy = buildSubagentHierarchy([root]);
    expect(hierarchy.frames.get("sub")?.returnFacts).toEqual({
      additions: null,
      removals: null,
      tokens: null,
      costUsd: null,
    });
  });

  it("carries the frame on the root data part and removes child items from the parent thread", () => {
    const messages = activityToThreadMessages(fixture());
    const content = messages.flatMap((message) => typeof message.content === "string" ? [] : message.content);
    const subagentPart = content.find((part) => part.type === "data" && part.name === "agent-manager.subagent");
    expect(subagentPart?.type).toBe("data");
    const frame = subagentPart?.type === "data" ? subagentPart.data as unknown as SubagentFrameData : null;
    expect(frame?.item.id).toBe("sub");
    expect(frame?.steps.map((item) => item.id)).toEqual(["read", "diff"]);

    expect(content.some((part) => part.type === "tool-call" && part.toolCallId === "read")).toBe(false);
    expect(content.filter((part) => part.type === "data" && part.name === "agent-manager.subagent")).toHaveLength(1);
  });

  it("projects root tool timing and counts only the canonical final turn diff", () => {
    const items: ActivityItem[] = [
      {
        ...common("root-tool", 1, null), kind: "tool", toolCallId: "root-tool",
        name: "apply_patch", category: "command", arguments: { patch: "..." }, result: "ok", output: "",
      },
      {
        ...common("fragment", 2, null), kind: "file-change", summary: "Applied patch",
        changes: [{ path: "src/a.ts", previousPath: null, operation: "update", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n" }],
      },
      {
        ...common("aggregate", 3, null), kind: "file-change", summary: "Turn diff",
        changes: [{ path: "src/a.ts", previousPath: null, operation: "update", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+test\n" }],
      },
      {
        ...common("done", 4, null), kind: "lifecycle", event: "turn-completed",
        level: "info", title: "Turn completed", details: null,
      },
    ];
    const content = activityToThreadMessages(items)
      .flatMap((message) => typeof message.content === "string" ? [] : message.content);
    const tool = content.find((part) => part.type === "tool-call" && part.toolCallId === "root-tool");
    expect(tool?.type === "tool-call" ? tool.timing : null).toEqual({
      startedAt: Date.parse("2026-08-04T10:00:00.000Z"),
      completedAt: Date.parse("2026-08-04T10:00:01.000Z"),
    });
    const marker = content.find((part) => part.type === "data" && part.name === "agent-manager.turn-marker");
    expect(marker?.type === "data" ? marker.data : null).toMatchObject({ additions: 2, removals: 1 });
    expect(content.filter((part) => part.type === "data" && part.name === "agent-manager.file-change")).toHaveLength(1);
  });
});
