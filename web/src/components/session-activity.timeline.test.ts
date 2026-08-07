import { describe, expect, it } from "vitest";

import { ACTIVITY_SCHEMA_VERSION, type ActivityItem } from "../types";
import { activityToThreadMessages, currentActionableProposedPlanId } from "./session-activity";

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
  memoryCitation: null,
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
      reasoningTokens: 57, totalTokens: 24_426, costUsd: null, contextWindow: null,
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
  it("carries an opaque reasoning marker through assistant-ui metadata", () => {
    const item: ActivityItem = {
      ...common,
      id: "reasoning-opaque",
      seq: 1,
      kind: "reasoning",
      reasoningKind: "summary",
      label: null,
      text: "",
      opaque: true,
    };
    const message = activityToThreadMessages([item])[0]!;
    const part = (message.content as ReadonlyArray<{
      type: string;
      text?: string;
      providerMetadata?: Record<string, unknown>;
    }>)[0];

    expect(part).toMatchObject({
      type: "reasoning",
      providerMetadata: { "agent-manager": { opaque: true } },
    });
    expect(part?.text).not.toContain("encrypted");
  });

  it("keeps a recorded assistant message in sequence with body activity", () => {
    const messages = activityToThreadMessages(invertedTurn());

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(partLabels(messages[1]!)).toEqual([
      "text",
      "data:agent-manager.lifecycle",
      "reasoning",
      "tool-call",
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

  it("keeps a todo marker where the list was created while retaining aggregate turn facts", () => {
    // The live details are pinned above the composer, but the timeline marker
    // remains a real chronological boundary. Later tools must never jump above
    // it just because the todo is still being rewritten in place.
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
      "text",
      "data:agent-manager.lifecycle",
      "reasoning",
      "tool-call",
      "data:agent-manager.todo",
      "tool-call",
      "data:agent-manager.turn-marker",
    ]);
  });

  it("keeps provider order inside the body band", () => {
    const items = invertedTurn().map((item) => (
      item.id === "tool-1" ? { ...item, seq: 29 } : item
    ));
    const parts = activityToThreadMessages(items)[1]!.content as ReadonlyArray<{ type: string }>;

    // answer · lifecycle · tool · reasoning · turn marker: the canonical
    // provider order is not rewritten around a message boundary.
    expect(parts.map((part) => part.type)).toEqual([
      "text", "data", "tool-call", "reasoning", "data",
    ]);
  });
});

describe("current proposed plan", () => {
  const plan: ActivityItem = {
    ...common,
    id: "plan-1",
    seq: 10,
    kind: "plan",
    path: null,
    version: null,
    markdown: "# Plan",
    supersededBy: null,
    approvalRequestId: null,
    approvedAt: null,
  };

  it("keeps only the latest complete Codex proposal actionable", () => {
    expect(currentActionableProposedPlanId([plan])).toBe(plan.id);
    expect(currentActionableProposedPlanId([{ ...plan, state: "running" }])).toBeNull();
    expect(currentActionableProposedPlanId([{ ...plan, truncated: true }])).toBeNull();
  });

  it("makes a proposal historical after the next operator message", () => {
    expect(currentActionableProposedPlanId([
      plan,
      { ...common, id: "next-user", seq: 11, kind: "message", role: "user", phase: null, text: "Refine it", label: null },
    ])).toBeNull();
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
    expect(messages[1]!.id).toMatch(/^assistant:/u);
    expect(messages[1]!.id).not.toContain("turn:unassociated");
    expect(activityToThreadMessages([
      { ...unassociated, id: "m-user", seq: 1, kind: "message", role: "user", phase: null, text: "Go", label: null },
      tool("t-1", 2),
      tool("t-2", 3),
      tool("t-3", 4),
      { ...unassociated, id: "m-final", seq: 5, kind: "message", role: "assistant", phase: "final", text: "Done", label: null },
    ])[1]!.id).toBe(messages[1]!.id);
  });

  it("projects a parsed memory citation directly after its assistant text", () => {
    const messages = activityToThreadMessages([{
      ...unassociated,
      id: "m-cited",
      seq: 1,
      kind: "message",
      role: "assistant",
      phase: "final",
      text: "From prior project context.",
      label: null,
      memoryCitation: {
        entries: [{ path: "MEMORY.md", lineStart: 1, lineEnd: 3, note: "prior project context" }],
        rolloutIds: [],
      },
    }]);
    const parts = messages[0]!.content as ReadonlyArray<{ type: string; name?: string; data?: unknown }>;
    expect(partLabels(messages[0]!)).toEqual(["text", "data:agent-manager.memory-citation"]);
    expect(parts[1]?.data).toEqual({
      entries: [{ path: "MEMORY.md", lineStart: 1, lineEnd: 3, note: "prior project context" }],
      rolloutIds: [],
    });
  });

  it("keeps an assistant message between two tool runs in the same stated turn", () => {
    const messages = activityToThreadMessages([
      { ...tool("t-1", 1), turnId: "turn-1" },
      { ...unassociated, turnId: "turn-1", id: "m-between", seq: 2, kind: "message", role: "assistant", phase: "final", text: "First result checked", label: null },
      { ...tool("t-2", 3), turnId: "turn-1" },
    ]);

    expect(messages).toHaveLength(1);
    expect(partLabels(messages[0]!)).toEqual(["tool-call", "text", "tool-call"]);
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

/*
  Every lifecycle fixture in this file was a turn boundary, so nothing covered
  the rows an operator actually complained about: hook notifications, session
  status, compaction. Those took the same bordered card as an approval request
  — a hook firing and a command needing an answer looked equally urgent — and
  sat in the body band, where one of them split a tool run in two.
*/
describe("provider status lines", () => {
  function status(id: string, seq: number, level: "info" | "warning" | "error"): ActivityItem {
    return {
      ...common, id, seq,
      kind: "lifecycle", event: "hook", level,
      title: "PostToolUse · Bash", details: null,
    };
  }

  function tool(id: string, seq: number): ActivityItem {
    return {
      ...common, id, seq,
      kind: "tool", toolCallId: id, name: "Read", category: "other",
      arguments: { path: `${id}.ts` }, result: "ok", output: "",
    };
  }

  it("keeps an info status at its recorded position", () => {
    const parts = activityToThreadMessages([
      tool("t-1", 1),
      status("hook-1", 2, "info"),
      tool("t-2", 3),
    ])[0]!.content as ReadonlyArray<{ type: string; name?: string }>;

    expect(partLabels({ content: parts })).toEqual([
      "tool-call",
      "data:agent-manager.lifecycle",
      "tool-call",
    ]);
  });

  it("leaves a warning where the work is, because it is about the work", () => {
    const parts = activityToThreadMessages([
      tool("t-1", 1),
      status("hook-1", 2, "warning"),
      tool("t-2", 3),
    ])[0]!.content as ReadonlyArray<{ type: string; name?: string }>;

    expect(partLabels({ content: parts })).toEqual([
      "tool-call",
      "data:agent-manager.lifecycle",
      "tool-call",
    ]);
  });

  it("keeps a turn end in the turn-fact band, not the status band", () => {
    // `turn-completed` carries level "info" too, so ordering the checks the
    // other way round would demote it out of the footer.
    const parts = activityToThreadMessages([
      tool("t-1", 1),
      { ...common, id: "end", seq: 2, kind: "lifecycle", event: "turn-failed", level: "error", title: "Turn failed", details: null },
      status("hook-1", 3, "info"),
    ])[0]!.content as ReadonlyArray<{ type: string; name?: string }>;

    // The marker still closes the turn; both lifecycle rows retain provider order.
    expect(partLabels({ content: parts }).at(-1)).toBe("data:agent-manager.turn-marker");
    const lifecycleTitles = parts.flatMap((part) => (
      part.type === "data" && part.name === "agent-manager.lifecycle"
        ? [(part as unknown as { data: { title: string } }).data.title]
        : []
    ));
    expect(lifecycleTitles).toEqual(["Turn failed", "PostToolUse · Bash"]);
  });
});

/*
  A question or approval is raised *by* a tool call, but every provider emits
  the request before the call it belongs to — Claude asks permission and only
  then reports the tool — and the hub freezes an item's seq at its first upsert.
  So the question kept the earlier position permanently and rendered above the
  thing that asked it. This ordering had no coverage at all.
*/
describe("a request sits under the tool call that raised it", () => {
  function tool(id: string, seq: number): ActivityItem {
    return {
      ...common, id, seq,
      kind: "tool", toolCallId: id, name: "AskUserQuestion", category: "other",
      arguments: null, result: "ok", output: "",
    };
  }

  function question(id: string, seq: number, parentId: string | null): ActivityItem {
    return {
      ...common, id, seq, parentId,
      kind: "attention", requestId: id, attentionKind: "question",
      title: "Claude requests AskUserQuestion", summary: null, questions: [],
      approvalFacts: null, respondable: true, resolved: false, isSecret: false,
      state: "waiting",
    };
  }

  it("places the question after its tool call even though it was seen first", () => {
    const parts = activityToThreadMessages([
      question("ask-1", 1, "tool-1"),
      tool("tool-1", 2),
    ])[0]!.content as ReadonlyArray<{ type: string; name?: string }>;

    expect(partLabels({ content: parts })).toEqual([
      "tool-call",
      "data:agent-manager.attention",
    ]);
  });

  it("leaves provider order alone when the provider named no parent", () => {
    const parts = activityToThreadMessages([
      question("ask-1", 1, null),
      tool("tool-1", 2),
    ])[0]!.content as ReadonlyArray<{ type: string; name?: string }>;

    expect(partLabels({ content: parts })).toEqual([
      "data:agent-manager.attention",
      "tool-call",
    ]);
  });

  it("does not reach into another turn for a parent", () => {
    const messages = activityToThreadMessages([
      { ...tool("tool-1", 1), turnId: "turn-a" },
      { ...question("ask-1", 2, "tool-1"), turnId: "turn-b" },
    ]);

    // Two turns, and the question stays in its own.
    expect(messages).toHaveLength(2);
    expect(partLabels(messages[1]!)).toEqual(["data:agent-manager.attention"]);
  });

  it("keeps two questions with the same parent in provider order", () => {
    const parts = activityToThreadMessages([
      question("ask-1", 1, "tool-1"),
      question("ask-2", 2, "tool-1"),
      tool("tool-1", 3),
    ])[0]!.content as ReadonlyArray<{ type: string; name?: string }>;

    expect(partLabels({ content: parts })).toEqual([
      "tool-call",
      "data:agent-manager.attention",
      "data:agent-manager.attention",
    ]);
  });
});

/*
  `useMessageTiming` was rejected during the refactor because its fields are
  browser-stream measurements — when the first chunk arrived, how many there
  were, a rate off a client clock — and printing those beside provider totals
  is inventing facts. The component is adopted by changing where the numbers
  come from, not by relaxing that.
*/
describe("turn timing carries provider facts only", () => {
  function timingOf(items: ActivityItem[]) {
    const message = activityToThreadMessages(items).at(-1) as { metadata?: { timing?: Record<string, number> } };
    return message.metadata?.timing;
  }

  it("takes the span from the provider's own start and end", () => {
    const timing = timingOf(invertedTurn());
    // 21:59:00 → 21:59:05 as the fixture reports them.
    expect(timing?.totalStreamTime).toBe(5_000);
    expect(timing?.streamStartTime).toBe(Date.parse("2026-08-04T21:59:00.000Z"));
  });

  it("derives the rate from provider output tokens over the provider's span", () => {
    // 72 output tokens over 5s.
    expect(timingOf(invertedTurn())?.tokensPerSecond).toBeCloseTo(14.4, 5);
    expect(timingOf(invertedTurn())?.tokenCount).toBe(24_426);
  });

  it("counts the turn's tool calls, and never a stream chunk", () => {
    const timing = timingOf(invertedTurn());
    expect(timing?.toolCallCount).toBe(1);
    // Required by the type and unknowable here: the cockpit is not the thing
    // receiving the stream. The vendored component does not render it.
    expect(timing?.totalChunks).toBe(0);
  });

  it("states no timing at all for a turn the provider never closed", () => {
    const open = invertedTurn().filter((item) => !(item.kind === "lifecycle" && item.event === "turn-completed"));
    expect(timingOf(open)).toBeUndefined();
  });

  it("omits the rate when the provider reported no output tokens", () => {
    const items = invertedTurn().map((item) => (
      item.kind === "usage" ? { ...item, outputTokens: null } : item
    ));
    const timing = timingOf(items);
    expect(timing?.totalStreamTime).toBe(5_000);
    expect(timing?.tokensPerSecond).toBeUndefined();
  });
});
