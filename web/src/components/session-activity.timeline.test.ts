import { describe, expect, it } from "vitest";

import { ACTIVITY_SCHEMA_VERSION, type ActivityItem } from "../types";
import { activityToThreadMessages } from "./session-activity";

const common = {
  schemaVersion: ACTIVITY_SCHEMA_VERSION,
  sessionId: "local:codex:thread-1",
  provider: "codex" as const,
  turnId: "turn-1",
  parentId: null,
  revision: 1,
  state: "complete" as const,
  startedAt: "2026-08-04T21:59:00.000Z",
  updatedAt: "2026-08-04T21:59:05.000Z",
  completedAt: "2026-08-04T21:59:05.000Z",
  source: "provider-api" as const,
  confidence: "exact" as const,
  exposure: "provider-exposed" as const,
  truncated: false,
};

/**
 * Reproduces the two orderings observed live on a completed Codex turn. The hub
 * freezes `seq` at first upsert, so a `usage` row can carry a lower `seq` than
 * the `turn-started` lifecycle row, and a streamed final answer can carry a
 * lower `seq` than both.
 */
function invertedTurn(): ActivityItem[] {
  return [
    {
      ...common, id: "user-1", seq: 1,
      kind: "message", role: "user", phase: null, text: "Tested d d d d d d d", label: null,
    },
    {
      ...common, id: "final-1", seq: 2,
      kind: "message", role: "assistant", phase: "final",
      text: "Got it — your test message came through.", label: null,
    },
    {
      ...common, id: "usage-1", seq: 3,
      kind: "usage", scope: "turn",
      inputTokens: 24_354, outputTokens: 72, cachedInputTokens: null,
      reasoningTokens: 57, totalTokens: 24_426, costUsd: null,
    },
    {
      ...common, id: "lifecycle-start", seq: 4,
      kind: "lifecycle", event: "turn-started", level: "info",
      title: "Turn started", details: null,
    },
    {
      ...common, id: "reasoning-1", seq: 30,
      kind: "reasoning", reasoningKind: "summary", label: null, text: "Check the message landed.",
    },
    {
      ...common, id: "tool-1", seq: 31,
      kind: "tool", toolCallId: "call-1", name: "exec", category: "command",
      arguments: { command: "echo hi" }, result: "hi", output: "",
    },
    {
      ...common, id: "lifecycle-end", seq: 40,
      kind: "lifecycle", event: "turn-completed", level: "info",
      title: "Turn completed", details: null,
    },
  ];
}

function partLabels(message: { content: unknown }): string[] {
  const content = message.content as ReadonlyArray<{ type: string; name?: string }>;
  return content.map((part) => (part.type === "data" ? `data:${part.name ?? ""}` : part.type));
}

describe("turn timeline ordering", () => {
  it("renders prompt, body, final answer, then turn totals regardless of provider seq", () => {
    const messages = activityToThreadMessages(invertedTurn());

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(partLabels(messages[1]!)).toEqual([
      "data:agent-manager.lifecycle",
      "reasoning",
      "tool-call",
      "text",
      "data:agent-manager.turn-marker",
    ]);
  });

  it("states the turn totals once, in the marker, not also as a usage row", () => {
    // Spec 05 R12 puts tokens and cost in the turn marker. A standalone usage
    // row alongside it reported every finished turn's totals twice.
    const parts = partLabels(activityToThreadMessages(invertedTurn())[1]!);

    expect(parts).not.toContain("data:agent-manager.usage");
    expect(parts.filter((part) => part === "data:agent-manager.turn-marker")).toHaveLength(1);
  });

  it("still shows the usage row while a turn is open and has no marker yet", () => {
    // Suppression is conditional on the marker existing. A running turn has no
    // marker, so its running totals must remain visible.
    const open = invertedTurn().filter((item) => !(item.kind === "lifecycle" && item.event === "turn-completed"));
    const parts = partLabels(activityToThreadMessages(open).at(-1)!);

    expect(parts).not.toContain("data:agent-manager.turn-marker");
    expect(parts).toContain("data:agent-manager.usage");
  });

  it("states the turn end exactly once when a turn marker carries the same facts", () => {
    const messages = activityToThreadMessages(invertedTurn());
    const parts = (messages[1]!.content as ReadonlyArray<{ type: string; name?: string; data?: unknown }>);
    const lifecycleTitles = parts.flatMap((part) => (
      part.type === "data" && part.name === "agent-manager.lifecycle"
        ? [(part.data as { title: string }).title]
        : []
    ));

    expect(lifecycleTitles).toEqual(["Turn started"]);
    expect(parts.at(-1)?.name).toBe("agent-manager.turn-marker");
  });

  it("keeps a failed turn end visible because the turn marker cannot state an outcome", () => {
    const items = invertedTurn().map((item) => (
      item.id === "lifecycle-end" && item.kind === "lifecycle"
        ? { ...item, event: "turn-failed" as const, level: "error" as const, title: "Turn failed" }
        : item
    ));
    const parts = activityToThreadMessages(items)[1]!.content as ReadonlyArray<{ type: string; name?: string; data?: unknown }>;
    const lifecycleTitles = parts.flatMap((part) => (
      part.type === "data" && part.name === "agent-manager.lifecycle"
        ? [(part.data as { title: string }).title]
        : []
    ));

    expect(lifecycleTitles).toEqual(["Turn started", "Turn failed"]);
  });

  it("bands the todo list and the turn diff with the turn facts so a tool run stays whole", () => {
    // A provider emits one todo and one aggregate diff per turn, and the hub
    // pins each to the seq of its first upsert — in the middle of a tool run.
    // Left there, they split the run, because adjacent-prefix grouping closes a
    // group at the first part that is not a tool call.
    const items: ActivityItem[] = [
      ...invertedTurn(),
      {
        ...common, id: "tool-2", seq: 32,
        kind: "tool", toolCallId: "call-2", name: "apply_patch", category: "command",
        arguments: { path: "a.ts" }, result: "ok", output: "",
      },
      {
        ...common, id: "todo-1", seq: 31.5,
        kind: "todo", steps: [], added: 0, removed: 0,
      },
    ];
    const parts = activityToThreadMessages(items)[1]!.content as ReadonlyArray<{ type: string; name?: string }>;

    expect(partLabels({ content: parts })).toEqual([
      "data:agent-manager.lifecycle",
      "reasoning",
      "tool-call",
      "tool-call",
      "text",
      "data:agent-manager.todo",
      "data:agent-manager.turn-marker",
    ]);
  });

  it("keeps provider order inside the body band", () => {
    const items = invertedTurn().map((item) => (
      item.id === "tool-1" ? { ...item, seq: 29 } : item
    ));
    const parts = activityToThreadMessages(items)[1]!.content as ReadonlyArray<{ type: string }>;

    // lifecycle · tool · reasoning · answer · turn marker. Swapping the tool's
    // seq above the reasoning item swaps them here too, and nothing else moves.
    expect(parts.map((part) => part.type)).toEqual([
      "data", "tool-call", "reasoning", "text", "data",
    ]);
  });
});

/**
 * The transcript reader has no turn concept — `TranscriptItem` carries none, so
 * every draft it produces materialises with `turnId: null`. Keying those items
 * individually put each one in a turn of its own, which produced one assistant
 * message per item and left the grouping primitive nothing adjacent to
 * coalesce: every tool call rendered its own "1 tool call" shell.
 */
describe("turns a provider never stated", () => {
  const unassociated = { ...common, turnId: null };

  function tool(id: string, seq: number): ActivityItem {
    return {
      ...unassociated, id, seq,
      kind: "tool", toolCallId: id, name: "read_file", category: "other",
      arguments: { path: `${id}.ts` }, result: "ok", output: "",
    };
  }

  it("gathers adjacent unassociated items into one assistant message", () => {
    const messages = activityToThreadMessages([
      { ...unassociated, id: "m-user", seq: 1, kind: "message", role: "user", phase: null, text: "Go", label: null },
      tool("t-1", 2),
      tool("t-2", 3),
      tool("t-3", 4),
      { ...unassociated, id: "m-final", seq: 5, kind: "message", role: "assistant", phase: "final", text: "Done", label: null },
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(partLabels(messages[1]!)).toEqual(["tool-call", "tool-call", "tool-call", "text"]);
  });

  it("opens a new turn at an operator message and closes one at a turn end", () => {
    const messages = activityToThreadMessages([
      tool("t-1", 1),
      { ...unassociated, id: "m-user", seq: 2, kind: "message", role: "user", phase: null, text: "Again", label: null },
      tool("t-2", 3),
      {
        ...unassociated, id: "end", seq: 4,
        kind: "lifecycle", event: "turn-completed", level: "info", title: "Turn completed", details: null,
      },
      tool("t-3", 5),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant", "assistant"]);
    expect(partLabels(messages[0]!)).toEqual(["tool-call"]);
    expect(partLabels(messages[3]!)).toEqual(["tool-call"]);
  });

  it("never merges items a provider did assign to different turns", () => {
    const messages = activityToThreadMessages([
      { ...common, turnId: "turn-a", id: "a", seq: 1, kind: "tool", toolCallId: "a", name: "read_file", category: "other", arguments: null, result: "ok", output: "" },
      { ...common, turnId: "turn-b", id: "b", seq: 2, kind: "tool", toolCallId: "b", name: "read_file", category: "other", arguments: null, result: "ok", output: "" },
    ]);

    expect(messages).toHaveLength(2);
  });
});
