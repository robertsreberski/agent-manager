import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeSession } from "../lib/normalize";
import { emptySessionActivity } from "../lib/session-activity";
import type { ActivityItem, SessionActivityView, SessionView } from "../types";
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
    cursor: `epoch-1:${updateCount}`,
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
  });

  it("expands active work and failures, collapses completed work, and honors bulk controls", () => {
    useSessionActivityMock.mockReturnValue(liveActivity(items));
    renderThread(rawSession({ transcript: { state: "available", source: "provider-api", messageCount: 0 } }));

    const reasoning = document.querySelector("details[data-activity-kind='reasoning']") as HTMLDetailsElement;
    const tool = document.querySelector("details[data-activity-kind='tool']") as HTMLDetailsElement;
    const failure = document.querySelector("details[data-activity-kind='lifecycle']") as HTMLDetailsElement;
    expect(reasoning.open).toBe(true);
    expect(tool.open).toBe(false);
    expect(failure.open).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    for (const detail of document.querySelectorAll("details[data-activity-kind]")) {
      expect((detail as HTMLDetailsElement).open).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    for (const detail of document.querySelectorAll("details[data-activity-kind]")) {
      expect((detail as HTMLDetailsElement).open).toBe(false);
    }
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
        lease={{
          token: "lease-token",
          clientId: "web-test",
          expiresAt: "2099-01-01T00:00:00.000Z",
          fullHostArmedUntil: null,
        }}
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
    const secretInput = within(pending).getByLabelText("Where should this deploy? answer");
    expect(secretInput).toHaveAttribute("type", "password");
    fireEvent.click(within(pending).getByRole("button", { name: /Staging/u }));
    fireEvent.click(within(pending).getByRole("button", { name: "Send answer" }));

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("activity-request-1", {
      kind: "answer",
      value: "",
      selectedOptions: ["Staging"],
    }));
  });
});
