import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SessionActivityView, SessionView } from "../types";
import { SessionThreadComposer } from "./session-thread";

const session = {
  id: "local:codex:thread-1",
  provider: "codex",
  status: "running",
  todoProgress: null,
  model: { value: "gpt-live" },
  effort: { value: "high" },
  profile: { value: "execute" },
  control: {
    plane: "codex-hook-bridge",
    authority: "foreign",
    capabilities: ["queue"],
    withheld: [
      { capability: "set-model", reason: "The hook can observe the model but cannot change it." },
      { capability: "set-effort", reason: "The hook exposes no effort control." },
      { capability: "set-profile", reason: "The hook exposes no profile control." },
    ],
  },
} as SessionView;

const activity = {
  items: [{
    kind: "queue",
    messages: [{ id: "queued-1", text: "Do not duplicate this bubble", status: "queued", enqueuedAt: "2026-08-04T12:00:00.000Z", turnId: "turn-1" }],
  }],
} as SessionActivityView;

describe("SessionThreadComposer", () => {
  it("shows only a queue count and truthfully disables absent setting controls", () => {
    render(<SessionThreadComposer
      session={session}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
    />);

    expect(screen.getByLabelText("1 queued message")).toHaveTextContent("1 queued");
    expect(screen.queryByText("Do not duplicate this bubble")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /codex/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /codex/i })).toHaveAttribute("title", "The hook can observe the model but cannot change it.");
    expect(screen.getByRole("button", { name: /execute/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /execute/i })).toHaveAttribute("title", "The hook exposes no profile control.");
    expect(document.querySelector("[data-withheld-reasons]"))
      .toHaveTextContent("The hook can observe the model but cannot change it. · The hook exposes no profile control.");
  });

  it("hands a read-only session a way to reach the setup that would fix it", () => {
    const onOpenSetup = vi.fn();
    const observed = {
      ...session,
      control: { ...session.control, capabilities: [], withheld: [
        ...session.control.withheld,
        { capability: "queue", reason: "This terminal-started session has no hook bridge." },
      ] },
    } as SessionView;

    render(<SessionThreadComposer
      session={observed}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onOpenSetup={onOpenSetup}
    />);

    expect(screen.getByText("This terminal-started session has no hook bridge.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Why is this read-only?" }));
    expect(onOpenSetup).toHaveBeenCalledOnce();
  });

  it("omits the setup affordance when the session is writable", () => {
    render(<SessionThreadComposer
      session={session}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onOpenSetup={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: "Why is this read-only?" })).not.toBeInTheDocument();
  });

  it("passes a catalog the session cannot write through as a read-only list", () => {
    render(<SessionThreadComposer
      session={session}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[{ value: "gpt-live", label: "Live", description: null }]}
      modelOptionsStatus={null}
    />);

    const trigger = screen.getByRole("button", { name: /codex/i });
    expect(trigger).toBeEnabled();
    // The composer's menus are Radix dropdowns now: they open on pointerdown,
    // and a withheld choice is an `aria-disabled` menu item rather than a
    // disabled <button>. The claim under test is unchanged — the catalog is
    // readable and every row in it is unwritable.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1 });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Harness, model, and effort" });
    expect(within(menu).getByRole("menuitemradio", { name: /Live/u })).toHaveAttribute("aria-disabled", "true");
    expect(menu).toHaveTextContent("The hook can observe the model but cannot change it.");
  });
});

/*
  An ordinary CLI session exposes no queue or steer channel, so read-only is
  honest. What was missing is that the composer stated the fact without naming
  the one thing that changes it — and `cockpitContentMode` returns "board" as
  soon as any session exists, so the operator never met the hook step either.
*/
describe("the upgrade path off a read-only session", () => {
  const observed = {
    ...session,
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [] },
  } as unknown as SessionView;

  function renderComposer(props: { hookState?: "absent" | "installed-unseen" | "active" } = {}) {
    return render(<SessionThreadComposer
      session={observed}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onOpenSetup={vi.fn()}
      {...props}
    />);
  }

  it("names the missing hook, and offers the command rather than an explanation", () => {
    renderComposer({ hookState: "absent" });

    expect(document.querySelector('[data-hook-upgrade="absent"]'))
      .toHaveTextContent("No codex hook is installed.");
    expect(screen.getByRole("button", { name: "Show me the command" })).toBeInTheDocument();
  });

  it("says an installed hook is waiting for an event rather than repeating the ask", () => {
    renderComposer({ hookState: "installed-unseen" });

    expect(document.querySelector('[data-hook-upgrade="installed-unseen"]'))
      .toHaveTextContent("attaches on this session's next provider event");
    expect(screen.getByRole("button", { name: "Why is this read-only?" })).toBeInTheDocument();
  });

  it("claims nothing about hooks before the facts have been read", () => {
    renderComposer();

    expect(document.querySelector("[data-hook-upgrade]")).toBeNull();
    expect(screen.getByRole("button", { name: "Why is this read-only?" })).toBeInTheDocument();
  });

  it("stays quiet when the hook is already doing its job", () => {
    renderComposer({ hookState: "active" });

    expect(document.querySelector("[data-hook-upgrade]")).toBeNull();
  });
});
