import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeSession } from "../lib/normalize";
import { emptySessionActivity } from "../lib/session-activity";
import type { ActivityItem, SessionActivityView, SessionView } from "../types";
import { buildActivityTimeline } from "./session-activity";
import { SessionThread } from "./session-thread";

const useSessionActivityMock = vi.hoisted(() => vi.fn());
vi.mock("../hooks/use-session-activity", () => ({
  useSessionActivity: useSessionActivityMock,
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver,
});

beforeEach(() => {
  useSessionActivityMock.mockImplementation((sessionId: string | null) => emptySessionActivity(sessionId));
});

function renderThread(session: SessionView) {
  return render(
    <SessionThread
      session={session}
      lease={null}
      busy={false}
      onAcquire={vi.fn()}
      onRelease={vi.fn()}
      onSend={vi.fn()}
      onRespond={vi.fn()}
      onInterrupt={vi.fn()}
      onSetMode={vi.fn()}
      loadPreview={vi.fn()}
      loadAttach={vi.fn()}
    />,
  );
}

const WRITABLE_LEASE = {
  token: "lease-token",
  clientId: "web-test",
  expiresAt: "2099-01-01T00:00:00.000Z",
  fullHostArmedUntil: null,
};

function renderWritableThread(session: SessionView, onSend = vi.fn(async () => undefined)) {
  return {
    onSend,
    ...render(
      <SessionThread
        session={session}
        lease={WRITABLE_LEASE}
        busy={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={onSend}
        onRespond={vi.fn()}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    ),
  };
}

function activityBase(id: string, seq: number, state: ActivityItem["state"] = "complete") {
  return {
    schemaVersion: 1 as const,
    id,
    sessionId: "codex:thread",
    provider: "codex" as const,
    turnId: "turn-1",
    parentId: null,
    seq,
    revision: 1,
    state,
    startedAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:01.000Z",
    completedAt: state === "complete" ? "2026-08-03T12:00:01.000Z" : null,
    source: "provider-api" as const,
    confidence: "exact" as const,
    exposure: "provider-exposed" as const,
    truncated: false,
  };
}

function liveActivity(items: ActivityItem[], updateCount = 1): SessionActivityView {
  return {
    sessionId: "codex:thread",
    items,
    hasSnapshot: true,
    truncated: false,
    streamEpoch: "epoch-1",
    cursor: `epoch-1:${encodeURIComponent("codex:thread")}:${updateCount}`,
    seq: updateCount,
    connection: "open",
    updateCount,
  };
}

function rawSession(overrides: Record<string, unknown> = {}) {
  return normalizeSession({
    id: "codex:thread",
    provider: "codex",
    ownership: "manager",
    status: "idle",
    control: { capabilities: [] },
    ...overrides,
  });
}

describe("activity turn grouping", () => {
  it("groups only by authoritative turnId and leaves user/final prose direct", () => {
    const directUser: ActivityItem = {
      ...activityBase("user", 1),
      kind: "message",
      role: "user",
      phase: null,
      text: "Question",
      label: null,
    };
    const commentary: ActivityItem = {
      ...activityBase("commentary", 2),
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "Progress",
      label: null,
    };
    const final: ActivityItem = {
      ...activityBase("final", 3),
      kind: "message",
      role: "assistant",
      phase: "final",
      text: "Answer",
      label: null,
    };
    const otherTurn: ActivityItem = {
      ...activityBase("other-turn", 4),
      turnId: "turn-2",
      kind: "lifecycle",
      event: "turn-completed",
      level: "info",
      title: "Other turn",
      details: null,
    };
    const unscopedOne: ActivityItem = {
      ...activityBase("unscoped-1", 5),
      turnId: null,
      kind: "lifecycle",
      event: "status",
      level: "info",
      title: "Unscoped one",
      details: null,
    };
    const unscopedTwo: ActivityItem = {
      ...activityBase("unscoped-2", 6),
      turnId: null,
      kind: "lifecycle",
      event: "status",
      level: "info",
      title: "Unscoped two",
      details: null,
    };

    const timeline = buildActivityTimeline([
      directUser,
      commentary,
      final,
      otherTurn,
      unscopedOne,
      unscopedTwo,
    ]);
    const directIds = timeline.flatMap((item) => item.kind === "message" ? [item.id] : []);
    const groups = timeline.filter((item) => item.kind === "activity-group");

    expect(directIds).toEqual(["user", "final"]);
    expect(groups).toHaveLength(4);
    expect(groups.find((group) => group.turnId === "turn-1")?.items.map((item) => item.id)).toEqual(["commentary"]);
    expect(groups.filter((group) => group.turnId === null)).toHaveLength(2);
  });
});

describe("SessionThread transcript states", () => {
  it("shows a transcript loading state before selected detail arrives", () => {
    renderThread(rawSession());

    expect(screen.getByText("Loading transcript…")).toBeInTheDocument();
  });

  it("shows why a transcript is unavailable", () => {
    renderThread(rawSession({
      transcript: {
        state: "unavailable",
        source: "codex-rollout",
        reason: "unreadable",
      },
    }));

    expect(screen.getByText("Transcript unavailable")).toBeInTheDocument();
    expect(screen.getByText(/could not be read safely/u)).toBeInTheDocument();
  });

  it("distinguishes an available empty transcript from loading", () => {
    renderThread(rawSession({
      messages: [],
      transcript: {
        state: "available",
        source: "provider-api",
        messageCount: 0,
      },
    }));

    expect(screen.getByText("No transcript messages yet")).toBeInTheDocument();
    expect(screen.queryByText("Loading transcript…")).not.toBeInTheDocument();
  });

  it("shows truncation metadata and wraps long message text", () => {
    const longUrl = `https://example.com/${"long-path-segment/".repeat(20)}`;
    renderThread(rawSession({
      messages: [{ id: "answer", role: "assistant", text: longUrl }],
      transcript: {
        state: "available",
        source: "codex-rollout",
        truncated: true,
        messageCount: 12,
      },
    }));

    expect(screen.getByText("Earlier transcript content is omitted. Showing the latest 12 messages.")).toBeInTheDocument();
    expect(screen.getByText(longUrl)).toBeInTheDocument();
    expect(screen.getByText(longUrl).closest("[class*='overflow-wrap']")).not.toBeNull();
  });

  it("renders assistant markdown through the assistant-ui markdown component", () => {
    renderThread(rawSession({
      messages: [{ id: "answer", role: "assistant", text: "## Result\n\n- first\n- second" }],
      transcript: {
        state: "available",
        source: "codex-rollout",
        messageCount: 1,
      },
    }));

    const heading = screen.getByRole("heading", { name: "Result", level: 2 });
    const markdown = heading.closest(".aui-md");
    expect(heading).toBeInTheDocument();
    expect(screen.getByText("first").closest("ul")).not.toBeNull();
    expect(markdown).toHaveClass("whitespace-normal");
    expect(markdown).toHaveClass("[&_ul]:my-1");
    expect(markdown).toHaveClass("[&_li]:my-0.5");
    expect(markdown).toHaveClass("[&_li_p]:my-0");
  });
});

describe("SessionThread live activity", () => {
  const items: ActivityItem[] = [
    {
      ...activityBase("message", 1),
      kind: "message",
      role: "user",
      phase: null,
      text: "Live prompt",
      label: null,
    },
    {
      ...activityBase("reasoning", 2, "running"),
      kind: "reasoning",
      reasoningKind: "summary",
      label: "Working through it",
      text: "Analyzing the repository",
    },
    {
      ...activityBase("tool", 3),
      kind: "tool",
      toolCallId: "call-1",
      name: "read_files",
      category: "command",
      arguments: { paths: ["README.md"] },
      result: { ok: true },
      output: "read complete",
    },
    {
      ...activityBase("plan", 4, "running"),
      kind: "plan",
      text: "Implementation plan",
      steps: [{ id: "step-1", text: "Wire the stream", status: "in_progress" }],
    },
    {
      ...activityBase("lifecycle", 5, "failed"),
      kind: "lifecycle",
      event: "turn-failed",
      level: "error",
      title: "Turn failed",
      details: "Provider disconnected",
    },
    {
      ...activityBase("queue", 6, "waiting"),
      kind: "queue",
      messages: [{
        id: "queued-1",
        text: "Please continue",
        status: "queued",
        enqueuedAt: "2026-08-03T12:00:02.000Z",
        turnId: null,
      }],
    },
    {
      ...activityBase("usage", 7),
      kind: "usage",
      scope: "turn",
      inputTokens: 1_200,
      outputTokens: 340,
      cachedInputTokens: 100,
      reasoningTokens: 80,
      totalTokens: 1_540,
      costUsd: 0.0123,
    },
    {
      ...activityBase("files", 8),
      kind: "file-change",
      summary: "Updated frontend",
      changes: [{ path: "web/src/App.tsx", operation: "update", diff: "+live" }],
    },
    {
      ...activityBase("subagent", 9, "running"),
      kind: "subagent",
      taskId: "task-1",
      name: "Frontend worker",
      description: "Implementing the timeline",
      output: "Still working",
      childItemIds: [],
    },
    {
      ...activityBase("attention", 10, "waiting"),
      kind: "attention",
      requestId: "request-1",
      attentionKind: "question",
      title: "Need a decision",
      summary: "Choose a route",
      questions: [],
      respondable: true,
      resolved: false,
      isSecret: false,
    },
    {
      ...activityBase("commentary", 11, "running"),
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "Implementation progress",
      label: null,
    },
    {
      ...activityBase("final", 12),
      kind: "message",
      role: "assistant",
      phase: "final",
      text: "Finished result",
      label: null,
    },
  ];

  it("replaces the legacy transcript after the first snapshot and renders the full typed timeline", () => {
    useSessionActivityMock.mockReturnValue(liveActivity(items));
    renderThread(rawSession({
      messages: [{ id: "legacy", role: "assistant", text: "Legacy only" }],
      transcript: { state: "available", source: "codex-rollout", messageCount: 1 },
    }));

    expect(screen.queryByText("Legacy only")).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Live session activity" })).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Live prompt")).toBeInTheDocument();
    expect(screen.getByText("Implementation progress").closest("[data-activity-turn='turn-1']")).not.toBeNull();
    expect(screen.getByText("Finished result").closest("[data-activity-turn]")).toBeNull();
    expect(screen.getByText("Analyzing the repository")).toBeInTheDocument();
    expect(screen.getByText("read_files")).toBeInTheDocument();
    expect(screen.getByText("Wire the stream")).toBeInTheDocument();
    expect(screen.getByText("Provider disconnected")).toBeInTheDocument();
    expect(screen.getByText("Please continue")).toBeInTheDocument();
    expect(screen.getByText("turn usage")).toBeInTheDocument();
    expect(screen.getByText("Updated frontend")).toBeInTheDocument();
    expect(screen.getByText("Frontend worker")).toBeInTheDocument();
    expect(screen.getAllByText("Need a decision").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-activity-kind='plan']")).toHaveClass("w-full");
    expect(document.querySelector("pre")).toHaveClass("overflow-x-auto");
    expect(document.querySelectorAll("details[data-activity-turn='turn-1']")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Expand all" })).not.toBeInTheDocument();
  });

  it("opens one disclosure for live turn activity and collapses it once settled", async () => {
    let activityView = liveActivity(items);
    useSessionActivityMock.mockImplementation(() => activityView);
    const session = rawSession({ transcript: { state: "available", source: "provider-api", messageCount: 0 } });
    const rendered = renderThread(session);

    const liveTurn = document.querySelector("details[data-activity-turn='turn-1']") as HTMLDetailsElement;
    expect(liveTurn.open).toBe(true);
    expect(document.querySelectorAll("details")).toHaveLength(1);

    const settled = items
      .filter((item) => item.kind !== "lifecycle" || item.event !== "turn-failed")
      .map((item) => ({
        ...item,
        state: "complete" as const,
        completedAt: "2026-08-03T12:00:03.000Z",
      })) as ActivityItem[];
    activityView = liveActivity(settled, 2);
    rendered.rerender(
      <SessionThread
        session={session}
        lease={null}
        busy={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={vi.fn()}
        onRespond={vi.fn()}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    await waitFor(() => {
      const settledTurns = document.querySelectorAll("details[data-activity-turn='turn-1']");
      expect(settledTurns).toHaveLength(1);
      const settledTurn = settledTurns[0] as HTMLDetailsElement;
      expect(settledTurn).toHaveAttribute("data-activity-state", "complete");
      expect(settledTurn.open).toBe(false);
    });
  });

  it("keeps failed turn activity expanded for immediate inspection", () => {
    const failed = items.map((item) => ({
      ...item,
      state: item.kind === "lifecycle" ? "failed" as const : "complete" as const,
      completedAt: "2026-08-03T12:00:03.000Z",
    })) as ActivityItem[];
    useSessionActivityMock.mockReturnValue(liveActivity(failed));
    renderThread(rawSession({ transcript: { state: "available", source: "provider-api", messageCount: 0 } }));

    const failedTurn = document.querySelector("details[data-activity-turn='turn-1']") as HTMLDetailsElement;
    expect(failedTurn).toHaveAttribute("data-activity-state", "failed");
    expect(failedTurn.open).toBe(true);
  });

  it("does not follow while scrolled away and offers a counted jump back to live", () => {
    let activity = liveActivity(items.slice(0, 1), 1);
    useSessionActivityMock.mockImplementation(() => activity);
    const session = rawSession({ transcript: { state: "available", source: "provider-api", messageCount: 0 } });
    const rendered = renderThread(session);
    const log = screen.getByRole("log", { name: "Live session activity" });
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(log);

    activity = liveActivity([...items.slice(0, 1), items[1]!], 3);
    rendered.rerender(
      <SessionThread
        session={session}
        lease={null}
        busy={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={vi.fn()}
        onRespond={vi.fn()}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    const jump = screen.getByRole("button", { name: "2 new updates · Jump to live" });
    fireEvent.click(jump);
    expect(screen.queryByRole("button", { name: /new updates.*Jump to live/u })).not.toBeInTheDocument();
    expect(log.scrollTop).toBe(1_000);
  });

  it("adds safe-area padding to the mobile composer", () => {
    renderThread(rawSession({
      control: { capabilities: ["queue"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }));

    const input = screen.getByPlaceholderText("Take control to send a message");
    expect(input.parentElement?.parentElement?.className).toContain("safe-area-inset-bottom");
  });

  it("uses unresolved activity questions for exact responses and masks secret free text", async () => {
    const activityQuestion: ActivityItem = {
      ...activityBase("activity-question", 1, "waiting"),
      kind: "attention",
      requestId: "activity-request-1",
      attentionKind: "question",
      title: "Activity-only question",
      summary: "Choose the deployment target",
      questions: [{
        id: "target",
        text: "Where should this deploy?",
        options: [
          { label: "Staging", description: "Use the private staging environment." },
          { label: "Production", description: null },
        ],
        multiSelect: false,
        allowFreeText: true,
        isSecret: true,
      }],
      respondable: true,
      resolved: false,
      isSecret: true,
    };
    const resolvedQuestion: ActivityItem = {
      ...activityBase("resolved-question", 2),
      kind: "attention",
      requestId: "activity-request-2",
      attentionKind: "question",
      title: "Already resolved",
      summary: "This should not remain pending",
      questions: [],
      respondable: true,
      resolved: true,
      isSecret: false,
    };
    useSessionActivityMock.mockReturnValue(liveActivity([activityQuestion, resolvedQuestion]));
    const onRespond = vi.fn(async () => undefined);
    const session = rawSession({
      attention: [],
      control: { capabilities: ["respond"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    });
    render(
      <SessionThread
        session={session}
        lease={WRITABLE_LEASE}
        busy={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={vi.fn()}
        onRespond={onRespond}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    const pending = screen.getByRole("region", { name: "Pending requests" });
    expect(within(pending).getByText("Activity-only question")).toBeInTheDocument();
    expect(within(pending).queryByText("Already resolved")).not.toBeInTheDocument();
    fireEvent.click(within(pending).getByRole("button", { name: /Needs you/u }));
    const requestSheet = screen.getByRole("dialog", { name: "Needs you" });
    const secretInput = within(requestSheet).getByLabelText("Where should this deploy? answer");
    expect(secretInput).toHaveAttribute("type", "password");
    fireEvent.click(within(requestSheet).getByRole("button", { name: /Staging/u }));
    fireEvent.click(within(requestSheet).getByRole("button", { name: "Send answer" }));

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("activity-request-1", {
      kind: "answer",
      value: "",
      selectedOptions: ["Staging"],
    }));
  });

  it("keeps metadata-only attention read-only, enriches exact live requests, and suppresses resolved ids", async () => {
    const unresolved: ActivityItem = {
      ...activityBase("live-request", 1, "waiting"),
      kind: "attention",
      requestId: "request-live",
      attentionKind: "approval",
      title: "Live approval",
      summary: "Approve the provider action",
      questions: [],
      respondable: true,
      resolved: false,
      isSecret: false,
    };
    const resolved: ActivityItem = {
      ...activityBase("resolved-request", 2),
      kind: "attention",
      requestId: "request-resolved",
      attentionKind: "question",
      title: "Resolved live request",
      summary: null,
      questions: [],
      respondable: true,
      resolved: true,
      isSecret: false,
    };
    useSessionActivityMock.mockReturnValue(liveActivity([unresolved, resolved]));
    const onRespond = vi.fn(async () => undefined);

    const session = rawSession({
      ownership: "external",
      attention: [
        {
          id: "request-live",
          kind: "approval",
          summary: "Metadata summary",
          details: { toolName: "shell", inputSummary: "pnpm check" },
          source: "provider-api",
          confidence: "exact",
        },
        {
          id: "request-metadata-only",
          kind: "question",
          summary: "Answer in the provider session",
          details: { title: "External session question" },
          source: "heuristic",
          confidence: "heuristic",
        },
        {
          id: "request-resolved",
          kind: "question",
          summary: "Should remain hidden",
          details: { title: "Stale metadata request" },
          source: "provider-api",
          confidence: "exact",
        },
      ],
      control: { capabilities: ["respond"] },
      transcript: { state: "available", source: "codex-rollout", messageCount: 0 },
    });
    render(
      <SessionThread
        session={session}
        lease={WRITABLE_LEASE}
        busy={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={vi.fn()}
        onRespond={onRespond}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    const pending = screen.getByRole("region", { name: "Pending requests" });
    fireEvent.click(within(pending).getByRole("button", { name: /Needs you/u }));
    const requestSheet = screen.getByRole("dialog", { name: "Needs you" });
    expect(within(requestSheet).getByText("Live approval")).toBeInTheDocument();
    expect(within(requestSheet).getByText("shell")).toBeInTheDocument();
    expect(within(requestSheet).getByText("External session question")).toBeInTheDocument();
    expect(within(requestSheet).queryByText("Stale metadata request")).not.toBeInTheDocument();
    expect(within(requestSheet).getByText(/Exact request details are still loading/u)).toBeInTheDocument();
    expect(within(requestSheet).queryByRole("group", { name: /Answer in the provider session/u })).not.toBeInTheDocument();
    expect(within(requestSheet).getByRole("button", { name: "Allow once" })).toBeEnabled();
    fireEvent.click(within(requestSheet).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("request-live", {
      kind: "decision",
      decision: "allow",
    }));
  });

  it("does not expose response controls for non-exact activity-stream attention", () => {
    const transcriptQuestion: ActivityItem = {
      ...activityBase("transcript-question", 1, "waiting"),
      kind: "attention",
      requestId: "transcript-request-1",
      attentionKind: "question",
      title: "Transcript-derived question",
      summary: "This request is not provider-current",
      questions: [{
        id: "target",
        text: "Where should this deploy?",
        options: [{ label: "Staging", description: null }],
        multiSelect: false,
        allowFreeText: false,
        isSecret: false,
      }],
      respondable: true,
      resolved: false,
      isSecret: false,
      source: "transcript",
      confidence: "heuristic",
      exposure: "transcript-derived",
    };
    useSessionActivityMock.mockReturnValue(liveActivity([transcriptQuestion]));
    const onRespond = vi.fn(async () => undefined);
    const session = rawSession({
      control: { capabilities: ["respond"] },
      transcript: { state: "available", source: "codex-rollout", messageCount: 0 },
    });
    render(
      <SessionThread
        session={session}
        lease={WRITABLE_LEASE}
        busy={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={vi.fn()}
        onRespond={onRespond}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Needs you/u }));
    const requestSheet = screen.getByRole("dialog", { name: "Needs you" });
    expect(within(requestSheet).getByText(/Exact request details are still loading/u)).toBeInTheDocument();
    expect(within(requestSheet).queryByRole("group", { name: /Where should this deploy\?/u })).not.toBeInTheDocument();
    expect(within(requestSheet).queryByRole("button", { name: "Staging" })).not.toBeInTheDocument();
    expect(within(requestSheet).queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("does not build exact response controls from metadata when the live question details are incomplete", () => {
    const incompleteLiveQuestion: ActivityItem = {
      ...activityBase("incomplete-live-question", 1, "waiting"),
      kind: "attention",
      requestId: "request-incomplete",
      attentionKind: "question",
      title: "Live request without answer details",
      summary: "The provider request is current but its questions have not arrived",
      questions: [],
      respondable: true,
      resolved: false,
      isSecret: false,
    };
    useSessionActivityMock.mockReturnValue(liveActivity([incompleteLiveQuestion]));
    const onRespond = vi.fn(async () => undefined);
    const session = rawSession({
      attention: [{
        id: "request-incomplete",
        kind: "question",
        summary: "Metadata question",
        details: {
          questions: [{
            id: "metadata-answer",
            text: "Metadata-only question text",
            options: [{ label: "Unsafe metadata option" }],
          }],
        },
        source: "provider-api",
        confidence: "exact",
      }],
      control: { capabilities: ["respond"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    });
    render(
      <SessionThread
        session={session}
        lease={WRITABLE_LEASE}
        busy={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={vi.fn()}
        onRespond={onRespond}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Needs you/u }));
    const requestSheet = screen.getByRole("dialog", { name: "Needs you" });
    expect(within(requestSheet).getByText(/Exact request details are still loading/u)).toBeInTheDocument();
    expect(within(requestSheet).queryByText("Metadata-only question text")).not.toBeInTheDocument();
    expect(within(requestSheet).queryByRole("button", { name: "Unsafe metadata option" })).not.toBeInTheDocument();
    expect(within(requestSheet).queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe("SessionThread status labels", () => {
  it.each([
    ["waiting", true, "Needs you"],
    ["running", true, "Working"],
    ["failed", true, "Failed"],
    ["interrupted", true, "Stopped"],
    ["completed", false, "Completed"],
    ["unknown", true, "Unknown"],
    ["idle", true, "Ready"],
    ["idle", false, "Offline"],
  ] as const)("maps %s with runtimeAlive=%s to %s", (status, runtimeAlive, expected) => {
    renderThread(rawSession({
      status,
      runtimeAlive,
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }));

    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(within(header!).getByText(expected)).toBeInTheDocument();
  });

  it("prioritizes pending attention over a running status", () => {
    renderThread(rawSession({
      status: "running",
      runtimeAlive: true,
      attention: [{
        id: "metadata-request",
        kind: "approval",
        summary: "Pending metadata attention",
        source: "provider-api",
        confidence: "exact",
      }],
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }));

    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(within(header!).getByText("Needs you")).toBeInTheDocument();
    expect(within(header!).queryByText("Working")).not.toBeInTheDocument();
  });
});

describe("SessionThread asymmetric composer capabilities", () => {
  it("renders the provider queue with assistant-ui queue primitives", () => {
    renderWritableThread(rawSession({
      queue: [{ id: "queued-1", prompt: "Run this after the active turn" }],
      control: { capabilities: ["queue"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }));

    const queue = screen.getByLabelText("Queued messages");
    expect(queue).toHaveClass("flex-wrap");
    expect(within(queue).getByText("Run this after the active turn")).toBeInTheDocument();
  });

  it("does not dispatch or clear a queue-only draft when the steer hotkey is pressed", () => {
    const { onSend } = renderWritableThread(rawSession({
      control: { capabilities: ["queue"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }));
    const input = screen.getByPlaceholderText("Message this session…");

    fireEvent.change(input, { target: { value: "Keep this queue draft" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("Keep this queue draft");
  });

  it("does not dispatch or clear a steer-only draft on plain Enter", () => {
    const { onSend } = renderWritableThread(rawSession({
      control: { capabilities: ["steer"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }));
    const input = screen.getByPlaceholderText("Steer the current turn…");

    fireEvent.change(input, { target: { value: "Keep this steer draft" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("Keep this steer draft");
  });

  it("still delivers each supported asymmetric keyboard action", async () => {
    const queueSend = vi.fn(async () => undefined);
    const queued = renderWritableThread(rawSession({
      control: { capabilities: ["queue"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }), queueSend);
    const queueInput = screen.getByPlaceholderText("Message this session…");
    fireEvent.change(queueInput, { target: { value: "Queue this" } });
    fireEvent.keyDown(queueInput, { key: "Enter" });
    await waitFor(() => expect(queueSend).toHaveBeenCalledWith("Queue this", "queue"));
    queued.unmount();

    const steerSend = vi.fn(async () => undefined);
    renderWritableThread(rawSession({
      control: { capabilities: ["steer"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }), steerSend);
    const steerInput = screen.getByPlaceholderText("Steer the current turn…");
    fireEvent.change(steerInput, { target: { value: "Steer this" } });
    fireEvent.keyDown(steerInput, { key: "Enter", metaKey: true, shiftKey: true });
    await waitFor(() => expect(steerSend).toHaveBeenCalledWith("Steer this", "steer"));
  });

  it("makes steer primary while running and only shows Stop when interrupt is supported", () => {
    renderWritableThread(rawSession({
      status: "running",
      control: { capabilities: ["queue", "steer", "interrupt"] },
      transcript: { state: "available", source: "provider-api", messageCount: 0 },
    }));

    expect(screen.getByPlaceholderText("Steer the running turn…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Steer" })).toHaveClass("bg-primary");
    expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("keeps the cockpit read-only and preserves the draft while reconnecting", () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <SessionThread
        session={rawSession({
          status: "running",
          control: { capabilities: ["queue", "steer", "interrupt"] },
          transcript: { state: "available", source: "provider-api", messageCount: 0 },
        })}
        lease={WRITABLE_LEASE}
        busy={false}
        mutationsReady={false}
        onAcquire={vi.fn()}
        onRelease={vi.fn()}
        onSend={onSend}
        onRespond={vi.fn()}
        onInterrupt={vi.fn()}
        onSetMode={vi.fn()}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    const input = screen.getByPlaceholderText("Reconnect to continue");
    expect(input).toBeDisabled();
    expect(screen.getByText("Read-only while reconnecting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Do not send" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});
