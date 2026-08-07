import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  WIRE_SCHEMA_VERSION,
  type ActivityAttentionItem,
  type ActivityQueueItem,
  type SessionActivityView,
} from "../types";
import { currentContext, questionView, renderActivityData, supersededAttentionIds, type ActivityDataControls } from "./session-activity";
import { SessionRuntimeProvider } from "./session-thread";

const attention: ActivityAttentionItem = {
  schemaVersion: WIRE_SCHEMA_VERSION,
  id: "attention-1",
  sessionId: "local:codex:thread-1",
  provider: "codex",
  kind: "attention",
  turnId: "turn-1",
  parentId: null,
  seq: 4,
  revision: 1,
  state: "waiting",
  startedAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
  completedAt: null,
  source: "provider-api",
  confidence: "exact",
  exposure: "provider-exposed",
  truncated: false,
  requestId: "request-1",
  attentionKind: "question",
  title: "Choose",
  summary: null,
  questions: [{
    id: "destination",
    text: "Where?",
    options: [
      { label: "Moon", description: null, recommended: true },
      { label: "Ocean", description: null, recommended: null },
      { label: "Cloud", description: null, recommended: false },
    ],
    multiSelect: false,
    allowFreeText: false,
    isSecret: false,
  }],
  approvalFacts: null,
  respondable: true,
  resolved: false,
  isSecret: false,
};

describe("question activity projection", () => {
  it("preserves only an explicit provider recommendation", () => {
    expect(questionView(attention).questions[0]?.options.map((option) => option.recommended)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("renders queued bubbles once in the thread with the real removal action", () => {
    const queue: ActivityQueueItem = {
      ...attention,
      id: "queue-1",
      kind: "queue",
      state: "running",
      messages: [{ id: "message-1", text: "Run the focused tests", status: "queued", enqueuedAt: "2026-08-04T12:00:00.000Z", turnId: "turn-1" }],
    };
    const onRemove = vi.fn();
    const controls: ActivityDataControls = {
      attention: { exactRequestIds: new Set(), planOwnedRequestIds: new Set(),
      supersededIds: new Set(),
      respondUnavailableReason: null, mutationsReady: true, canRespond: false, busy: false, workspaceRoot: null, remoteHost: null, sessionsOnHost: null, onRespond: vi.fn(async () => undefined) },
      files: { sessionId: queue.sessionId, canOpenEditor: false, workspaceRoot: null, readKeys: new Set(), onReadChange: vi.fn() },
      plans: { requestIds: new Map(), proposedPlanId: null, proposedPlanReadOnlyReason: null, mutationsReady: true, canRespond: false, busy: false, loadFile: vi.fn(async () => { throw new Error("unused"); }), onRespond: vi.fn(async () => undefined), onAcceptProposed: vi.fn(async () => undefined), onRefineProposed: vi.fn(async () => undefined) },
      queue: { canRemove: true, busy: false, withheldReason: null },
    };
    // Removal now runs through the runtime queue adapter, which is what lets
    // the primitive render the button at all.
    render(<SessionRuntimeProvider
      items={[]}
      queue={{ messages: queue.messages, canRemove: true, onRemove }}
    >{() => <>{renderActivityData("agent-manager.queue", queue, controls)}</>}</SessionRuntimeProvider>);

    expect(screen.getByText("Run the focused tests")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));
    expect(onRemove).toHaveBeenCalledWith("message-1");
  });
});

/*
  A token count without a denominator says nothing about how full the context
  is, and a denominator the provider never stated would be the cockpit guessing.
  Both providers do state one; both projectors used to drop it.
*/
function controls(): ActivityDataControls {
  return {
    attention: { exactRequestIds: new Set(), planOwnedRequestIds: new Set(),
      supersededIds: new Set(),
      respondUnavailableReason: null, mutationsReady: true, canRespond: false, busy: false, workspaceRoot: null, remoteHost: null, sessionsOnHost: null, onRespond: vi.fn(async () => undefined) },
    files: { sessionId: "local:codex:thread-1", canOpenEditor: false, workspaceRoot: null, readKeys: new Set(), onReadChange: vi.fn() },
    plans: { requestIds: new Map(), proposedPlanId: null, proposedPlanReadOnlyReason: null, mutationsReady: true, canRespond: false, busy: false, loadFile: vi.fn(async () => { throw new Error("unused"); }), onRespond: vi.fn(async () => undefined), onAcceptProposed: vi.fn(async () => undefined), onRefineProposed: vi.fn(async () => undefined) },
    queue: { canRemove: false, busy: false, withheldReason: null },
  };
}

describe("context usage", () => {
  const usage = {
    ...attention,
    id: "usage-1",
    kind: "usage" as const,
    scope: "turn" as const,
    inputTokens: 24_000,
    outputTokens: 400,
    cachedInputTokens: null,
    reasoningTokens: 60,
    totalTokens: 24_460,
    costUsd: null,
  };

  /*
    Usage is a running total, not an event, and rendering it as a row restated
    the same fact once per turn all the way down the transcript. Every number in
    it is already stated where it belongs: the turn's tokens and cost in its turn
    marker, how full the window is in the composer. The items stay — they are the
    source for both — but they render nothing of their own.
  */
  it("renders no row of its own, whether or not a window was stated", () => {
    for (const contextWindow of [200_000, null]) {
      const { container, unmount } = render(<>{renderActivityData("agent-manager.usage", { ...usage, contextWindow }, controls())}</>);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  /*
    Codex emits both scopes on every update, and the cumulative one is a trap:
    a chat request carries the whole conversation as input, so `thread` re-counts
    that prefix once per turn. Reading it as occupancy pinned the meter at 100%
    on any conversation of length.
  */
  it("reads the latest turn, never the thread's cumulative total", () => {
    const thread = { ...usage, id: "usage-thread", scope: "thread" as const, totalTokens: 900_000, contextWindow: 200_000 };
    const turn = { ...usage, id: "usage-turn", totalTokens: 24_460, contextWindow: 200_000 };
    const view = { items: [thread, turn], truncated: false, connection: "open" } as unknown as SessionActivityView;

    expect(currentContext(view)?.id).toBe("usage-turn");
  });

  it("states no context at all where no provider stated a window", () => {
    const view = {
      items: [{ ...usage, contextWindow: null }],
      truncated: false,
      connection: "open",
    } as unknown as SessionActivityView;

    expect(currentContext(view)).toBeNull();
  });
});

/*
  Codex raises one `request_user_input` on two surfaces: the App Server, which
  can be answered, and the rollout transcript, which cannot. They are supposed to
  collapse on a shared `correlationId` built from the response-item id — and
  neither surface is obliged to state one, so the pair reached the drawer as two
  questionnaires. Two on screen is not merely noisy: `QuestionRequest` refuses
  its number and Enter shortcuts when it cannot tell which one a key meant.
*/
describe("a request the provider states on two surfaces", () => {
  const transcriptTwin: ActivityAttentionItem = {
    ...attention,
    id: "transcript:attention-1",
    requestId: "call-1",
    title: "request_user_input",
    source: "transcript",
    confidence: "inferred",
    exposure: "transcript-derived",
    respondable: false,
  };

  it("supersedes the transcript copy when an exact twin asks the same questions", () => {
    expect([...supersededAttentionIds([attention, transcriptTwin])]).toEqual(["transcript:attention-1"]);
  });

  it("matches on the request id even when the questions were rewritten", () => {
    const renamed = { ...transcriptTwin, requestId: attention.requestId, questions: [] };
    // No questions means nothing to supersede — an empty card is not the twin.
    expect([...supersededAttentionIds([attention, renamed])]).toEqual([]);
    expect([...supersededAttentionIds([attention, { ...transcriptTwin, requestId: attention.requestId }])])
      .toEqual(["transcript:attention-1"]);
  });

  it("keeps a lone transcript request, because nothing else is stating it", () => {
    expect([...supersededAttentionIds([transcriptTwin])]).toEqual([]);
  });

  it("keeps a transcript request that asks something else entirely", () => {
    const other = {
      ...transcriptTwin,
      requestId: "call-9",
      questions: [{ ...attention.questions[0]!, text: "Something else?" }],
    };
    expect([...supersededAttentionIds([attention, other])]).toEqual([]);
  });
});

describe("a questionnaire this session cannot answer", () => {
  function renderAttention(canRespond: boolean, reason: string | null) {
    const controls: ActivityDataControls = {
      attention: {
        exactRequestIds: new Set([attention.requestId!]),
        planOwnedRequestIds: new Set(),
        supersededIds: new Set(),
        respondUnavailableReason: reason,
        mutationsReady: true,
        canRespond,
        busy: false,
        workspaceRoot: null,
        remoteHost: null,
        sessionsOnHost: null,
        onRespond: vi.fn(async () => undefined),
      },
      files: { sessionId: attention.sessionId, canOpenEditor: false, workspaceRoot: null, readKeys: new Set(), onReadChange: vi.fn() },
      plans: { requestIds: new Map(), proposedPlanId: null, proposedPlanReadOnlyReason: null, mutationsReady: true, canRespond, busy: false, loadFile: vi.fn(async () => { throw new Error("unused"); }), onRespond: vi.fn(async () => undefined), onAcceptProposed: vi.fn(async () => undefined), onRefineProposed: vi.fn(async () => undefined) },
      queue: { canRemove: false, busy: false, withheldReason: null },
    };
    return render(<>{renderActivityData("agent-manager.attention", attention, controls)}</>);
  }

  /*
    `readOnly` is a fact about the request; `disabled` is a fact about the
    session. Only the first used to be stated or styled, so an observed session
    rendered a questionnaire with live pills and a live cursor that silently
    swallowed every click.
  */
  it("states the harness's own reason and stops looking clickable", () => {
    const { container } = renderAttention(false, "Agent Manager is observing this session. Take control to change it.");

    expect(screen.getByText("Agent Manager is observing this session. Take control to change it.")).toBeInTheDocument();
    expect(container.querySelector("[data-question-locked='true']")).toBeInTheDocument();
    for (const label of container.querySelectorAll("label")) {
      expect(label.className).toContain("cursor-default");
      expect(label.className).not.toContain("cursor-pointer");
    }
    // And it must not claim the keyboard it cannot act on.
    expect(container.querySelector("[data-question-shortcut-ready='true']")).toBeNull();
  });

  it("leaves an answerable request fully live", () => {
    const { container } = renderAttention(true, null);

    expect(container.querySelector("[data-question-locked='false']")).toBeInTheDocument();
    expect(container.querySelector("[data-question-read-only-guidance]")).toBeNull();
    expect(container.querySelector("[data-question-shortcut-ready='true']")).toBeInTheDocument();
    for (const label of container.querySelectorAll("label")) {
      expect(label.className).toContain("cursor-pointer");
    }
  });
});
