import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ACTIVITY_SCHEMA_VERSION, type ActivityItem, type SessionActivityView, type SessionView } from "../types";
import { SessionRuntimeProvider, SessionThread } from "./session-thread";
import { ThreadDrawer } from "./board";

/*
  The cockpit shipped with no thread auto-scroll at all: watching a live session
  meant new activity appended below the fold and the view never moved, which is
  the one thing the drawer exists to do. The primitives were always there — they
  just had to reach the drawer's own scroller, which is rendered a component
  above the runtime that owns the thread.

  jsdom lays nothing out and has no ResizeObserver, so the follow-the-bottom
  path itself cannot run here. What is asserted instead is the wiring that path
  depends on: the viewport is the drawer's own scroller and no second one is
  nested inside it, and the viewport's `isAtBottom` tracks real scroll events —
  observable through the control that only exists once the operator has
  detached.
*/

const common = {
  schemaVersion: ACTIVITY_SCHEMA_VERSION,
  sessionId: "local:claude:thread-1",
  provider: "claude" as const,
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
  sandbox: { value: null },
  control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
} as unknown as SessionView;

const items: readonly ActivityItem[] = [
  { ...common, id: "m-1", seq: 1, kind: "message", role: "assistant", phase: null, text: "line one", label: null },
];

/** jsdom computes no layout, so the scroller's metrics are supplied directly. */
function measure(element: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: metrics.clientHeight });
}

function scrollTo(element: HTMLElement, top: number) {
  act(() => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
  });
}

function renderDrawer() {
  const result = render(
    <div data-board-region>
      <SessionRuntimeProvider items={items}>{(viewportRef) => (
        <ThreadDrawer viewportRef={viewportRef} open title="Thread" onClose={() => undefined}>
          <SessionThread
            session={session}
            activity={{ items, truncated: false, connection: "open" } as unknown as SessionActivityView}
            remote={false}
            busy={false}
            mutationsReady
            onRespond={vi.fn(async () => undefined)}
            onRemoveQueued={vi.fn(async () => undefined)}
            onOpenEditor={vi.fn(async () => undefined)}
            onResumeInWeb={vi.fn(async () => undefined)}
            readKeys={new Set()}
            onReadChange={vi.fn()}
            loadAttach={vi.fn(async () => ({ available: false }) as never)}
            loadSessionFacts={vi.fn(async () => ({}) as never)}
            loadPlanFile={vi.fn(async () => ({}) as never)}
            onContinueInWorkspace={vi.fn()}
            sessionsOnHost={null}
          />
        </ThreadDrawer>
      )}</SessionRuntimeProvider>
    </div>,
  );
  const scroller = result.container.querySelector<HTMLElement>("[data-thread-content]");
  expect(scroller).not.toBeNull();
  return { ...result, scroller: scroller! };
}

describe("thread auto-scroll", () => {
  it("makes the drawer's own scroller the viewport instead of nesting a second one", () => {
    const { container, scroller } = renderDrawer();

    const scrollers = [...container.querySelectorAll<HTMLElement>("div")]
      .filter((element) => element.className.includes("overflow-y-auto"));
    expect(scrollers).toEqual([scroller]);
  });

  it("offers a way back only once the operator has scrolled away from the bottom", () => {
    const { scroller } = renderDrawer();
    const jump = () => screen.getByRole("button", { name: /jump to latest/iu });

    measure(scroller, { scrollHeight: 1_000, clientHeight: 400 });
    scrollTo(scroller, 600);
    expect(jump()).toBeDisabled();

    scrollTo(scroller, 120);
    expect(jump()).toBeEnabled();

    scrollTo(scroller, 600);
    expect(jump()).toBeDisabled();
  });

  it("returns to the newest activity when that way back is taken", async () => {
    const { scroller } = renderDrawer();

    measure(scroller, { scrollHeight: 1_000, clientHeight: 400 });
    scrollTo(scroller, 120);
    act(() => { screen.getByRole("button", { name: /jump to latest/iu }).click(); });
    // The scroll is scheduled on an animation frame so a burst of activity
    // coalesces into one move.
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    expect(scroller.scrollTop).toBe(1_000);
  });
});
