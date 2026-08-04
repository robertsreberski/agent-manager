import { describe, expect, it } from "vitest";
import type { ActivityItem, ActivityItemBase } from "../types";
import { buildActivityTimeline } from "./session-activity";

function base(id: string, seq: number, state: ActivityItemBase["state"]): ActivityItemBase {
  return {
    schemaVersion: 1,
    id,
    sessionId: "codex:one",
    provider: "codex",
    turnId: "turn-1",
    parentId: null,
    seq,
    revision: 1,
    state,
    startedAt: "2026-08-04T08:00:00.000Z",
    updatedAt: "2026-08-04T08:00:01.000Z",
    completedAt: state === "running" ? null : "2026-08-04T08:00:01.000Z",
    source: "provider-api",
    confidence: "exact",
    exposure: "provider-exposed",
    truncated: false,
  };
}

function groupedState(items: ActivityItem[]) {
  const [entry] = buildActivityTimeline(items);
  if (!entry || entry.kind !== "activity-group") throw new Error("expected one activity group");
  return entry.state;
}

describe("activity turn state", () => {
  it.each([
    ["turn-failed", "failed"],
    ["turn-interrupted", "interrupted"],
    ["turn-completed", "complete"],
  ] as const)("lets authoritative %s lifecycle dominate a lingering running child", (event, expected) => {
    const running: ActivityItem = {
      ...base("reasoning", 1, "running"),
      kind: "reasoning",
      reasoningKind: "summary",
      label: null,
      text: "Still marked live by the provider stream",
    };
    const terminal: ActivityItem = {
      ...base("terminal", 2, expected),
      kind: "lifecycle",
      event,
      level: expected === "failed" ? "error" : "info",
      title: event,
      details: null,
    };

    expect(groupedState([running, terminal])).toBe(expected);
  });

  it("does not let a recoverable failed child override a still-running turn", () => {
    const failedTool: ActivityItem = {
      ...base("tool", 1, "failed"),
      kind: "tool",
      toolCallId: "tool-1",
      name: "shell",
      category: "command",
      arguments: null,
      result: null,
      output: "command failed",
    };
    const running: ActivityItem = {
      ...base("reasoning", 2, "running"),
      kind: "reasoning",
      reasoningKind: "summary",
      label: null,
      text: "Recovering",
    };

    expect(groupedState([failedTool, running])).toBe("running");
  });
});

describe("activity timeline ordering", () => {
  function message(
    id: string,
    seq: number,
    role: "user" | "assistant",
    phase: "commentary" | "final" | null,
  ): ActivityItem {
    return {
      ...base(id, seq, "complete"),
      kind: "message",
      role,
      phase,
      text: id,
      label: null,
    };
  }

  function lifecycle(
    id: string,
    seq: number,
    event: "turn-started" | "turn-completed",
  ): ActivityItem {
    return {
      ...base(id, seq, event === "turn-started" ? "running" : "complete"),
      kind: "lifecycle",
      event,
      level: "info",
      title: id,
      details: null,
    };
  }

  it("renders a Codex turn as user, activity, then final despite provider arrival order", () => {
    const timeline = buildActivityTimeline([
      lifecycle("turn-started", 1, "turn-started"),
      message("prompt", 2, "user", null),
      {
        ...base("tool", 3, "complete"),
        kind: "tool",
        toolCallId: "tool-1",
        name: "read",
        category: "command",
        arguments: null,
        result: null,
        output: "done",
      },
      message("answer", 4, "assistant", "final"),
      lifecycle("turn-completed", 5, "turn-completed"),
    ]);

    expect(timeline.map((item) => item.kind === "activity-group" ? "activity" : item.id))
      .toEqual(["prompt", "activity", "answer"]);
    const activity = timeline[1];
    expect(activity?.kind === "activity-group" ? activity.items.map((item) => item.id) : [])
      .toEqual(["turn-started", "tool", "turn-completed"]);
  });

  it("splits activity around a later steering message without moving it to the turn start", () => {
    const timeline = buildActivityTimeline([
      lifecycle("turn-started", 1, "turn-started"),
      message("prompt", 2, "user", null),
      {
        ...base("tool-before", 3, "complete"),
        kind: "plan",
        text: "before",
        steps: [],
      },
      message("steer", 4, "user", null),
      {
        ...base("tool-after", 5, "complete"),
        kind: "plan",
        text: "after",
        steps: [],
      },
      message("answer", 6, "assistant", "final"),
    ]);

    expect(timeline.map((item) => item.kind === "activity-group" ? item.items.map((child) => child.id) : item.id))
      .toEqual([
        "prompt",
        ["turn-started", "tool-before"],
        "steer",
        ["tool-after"],
        "answer",
      ]);
  });
});
