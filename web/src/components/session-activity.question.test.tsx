import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActivityAttentionItem, ActivityQueueItem } from "../types";
import { questionView, renderActivityData, type ActivityDataControls } from "./session-activity";
import { SessionRuntimeProvider } from "./session-thread";

const attention: ActivityAttentionItem = {
  schemaVersion: 3,
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
      attention: { exactRequestIds: new Set(), mutationsReady: true, canRespond: false, busy: false, workspaceRoot: null, remoteHost: null, sessionsOnHost: null, onRespond: vi.fn(async () => undefined) },
      files: { sessionId: queue.sessionId, canOpenEditor: false, workspaceRoot: null, readKeys: new Set(), onReadChange: vi.fn() },
      plans: { requestIds: new Map(), mutationsReady: true, canRespond: false, busy: false, loadFile: vi.fn(async () => { throw new Error("unused"); }), onRespond: vi.fn(async () => undefined) },
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
