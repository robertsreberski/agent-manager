import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ACTIVITY_SCHEMA_VERSION, type ActivityItem, type SessionActivityView, type SessionView } from "../types";
import { SessionRuntimeProvider, SessionThread } from "./session-thread";

/*
  Nothing rendered `GroupedActivityParts` before: the grouping unit tests
  asserted `groupActivityPart`'s return value, and the shell tests passed a
  hard-coded `count` straight into `ToolGroupShell`. Neither could see that the
  transcript path produced one assistant message per item, so no two tool calls
  were ever adjacent inside a message and every one rendered its own "1 tool
  call" shell.
*/

const common = {
  schemaVersion: ACTIVITY_SCHEMA_VERSION,
  sessionId: "local:claude:thread-1",
  provider: "claude" as const,
  parentId: null,
  revision: 1,
  state: "complete" as const,
  startedAt: "2026-08-04T21:59:00.000Z",
  updatedAt: "2026-08-04T21:59:05.000Z",
  completedAt: "2026-08-04T21:59:05.000Z",
  source: "transcript" as const,
  confidence: "inferred" as const,
  exposure: "transcript-derived" as const,
  truncated: false,
};

const session = {
  id: "local:claude:thread-1",
  provider: "claude",
  providerThreadId: "thread-1",
  name: "thread-1",
  hostId: "local",
  hostLabel: "This machine",
  status: "running",
  generation: 1,
  cwd: "/workspace",
  workspaceIdentity: null,
  attention: [],
  updatedAt: "2026-08-04T21:59:05.000Z",
  todoProgress: null,
  model: { value: "sonnet" },
  effort: { value: "high" },
  profile: { value: "ask-first" },
  control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [] },
} as unknown as SessionView;

function tool(id: string, name: string, seq: number, turnId: string | null): ActivityItem {
  return {
    ...common, id, seq, turnId,
    kind: "tool", toolCallId: id, name, category: "other",
    arguments: { path: `${id}.ts` }, result: "ok", output: "",
  };
}

function renderThread(items: readonly ActivityItem[]) {
  return render(<SessionRuntimeProvider items={items}>{() => <SessionThread
    session={session}
    activity={{ items, truncated: false, connection: "live" } as unknown as SessionActivityView}
    remote={false}
    busy={false}
    mutationsReady
    onRespond={vi.fn(async () => undefined)}
    onRemoveQueued={vi.fn(async () => undefined)}
    onOpenEditor={vi.fn(async () => undefined)}
    readKeys={new Set()}
    onReadChange={vi.fn()}
    loadAttach={vi.fn(async () => ({ available: false }) as never)}
    loadSessionFacts={vi.fn(async () => ({}) as never)}
    loadPlanFile={vi.fn(async () => ({}) as never)}
    onContinueInWorkspace={vi.fn()}
    sessionsOnHost={null}
  />}</SessionRuntimeProvider>);
}

describe("tool grouping in a rendered thread", () => {
  it("coalesces a run of tool calls a provider never assigned a turn to", () => {
    const { container } = renderThread([
      tool("t-1", "Read", 1, null),
      tool("t-2", "Grep", 2, null),
      tool("t-3", "Glob", 3, null),
    ]);

    expect(container.querySelectorAll("[data-tool-group-status]")).toHaveLength(1);
    expect(screen.getByText("3 tool calls")).toBeInTheDocument();
  });

  it("groups a stated turn's tool calls the same way", () => {
    const { container } = renderThread([
      tool("t-1", "Read", 1, "turn-1"),
      tool("t-2", "Grep", 2, "turn-1"),
    ]);

    expect(container.querySelectorAll("[data-tool-group-status]")).toHaveLength(1);
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  });

  it("does not reach across an operator message to group two separate runs", () => {
    const { container } = renderThread([
      tool("t-1", "Read", 1, null),
      { ...common, id: "m-1", seq: 2, turnId: null, kind: "message", role: "user", phase: null, text: "Now do the other thing", label: null },
      tool("t-2", "Grep", 3, null),
    ]);

    expect(container.querySelectorAll("[data-tool-group-status]")).toHaveLength(2);
    expect(screen.getAllByText("1 tool call")).toHaveLength(2);
  });

  it("does not reach across an assistant message inside one stated turn", () => {
    const { container } = renderThread([
      tool("t-1", "Read", 1, "turn-1"),
      { ...common, id: "m-1", seq: 2, turnId: "turn-1", kind: "message", role: "assistant", phase: "final", text: "The first file is clear.", label: null },
      tool("t-2", "Grep", 3, "turn-1"),
    ]);

    expect(container.querySelectorAll("[data-tool-group-status]")).toHaveLength(2);
    expect(screen.getAllByText("1 tool call")).toHaveLength(2);
    expect(screen.getByText("The first file is clear.")).toBeInTheDocument();
  });

  it("keeps a todo written mid-run from splitting the run in two", () => {
    const { container } = renderThread([
      tool("t-1", "Read", 1, "turn-1"),
      { ...common, id: "todo-1", seq: 2, turnId: "turn-1", kind: "todo", steps: [], added: 0, removed: 0 },
      tool("t-2", "Grep", 3, "turn-1"),
    ]);

    expect(container.querySelectorAll("[data-tool-group-status]")).toHaveLength(1);
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  });
});
