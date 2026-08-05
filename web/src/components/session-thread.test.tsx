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
    expect(screen.getByRole("combobox", { name: /codex/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /codex/i })).toHaveAttribute("title", "The hook can observe the model but cannot change it.");
    expect(screen.getByRole("button", { name: /execute/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /execute/i })).toHaveAttribute("title", "The hook exposes no profile control.");
    expect(document.querySelector("[data-withheld-reasons]")).toBeNull();
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

    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByText("This terminal-started session has no hook bridge.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enable replies" }));
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

    expect(screen.queryByRole("button", { name: "Enable replies" })).not.toBeInTheDocument();
    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
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
      effortOptions={["low", "medium", "high", "max"]}
    />);

    const trigger = screen.getByRole("combobox", { name: /codex/i });
    expect(trigger).toBeEnabled();
    // The assistant-ui picker opens on pointerdown; the catalog remains
    // readable while each mutation stays disabled with an accessible reason.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1 });
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "Harness, model, and effort" });
    const option = within(menu).getByRole("option", { name: /Live/u });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveAttribute("title", "The hook can observe the model but cannot change it.");
    expect(menu).not.toHaveTextContent("The hook can observe the model but cannot change it.");
    expect(document.querySelectorAll("[data-effort-bar]")).toHaveLength(4);
    expect(document.querySelectorAll("[data-effort-bar='active']")).toHaveLength(3);
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

  function renderComposer() {
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
    />);
  }

  it("keeps the state to one quiet label and setup link", () => {
    renderComposer();

    expect(document.querySelector("[data-hook-upgrade]")).toBeNull();
    expect(screen.getAllByText("Read only")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Enable replies" })).toBeInTheDocument();
    expect(screen.queryByText(/hook|observation-only|read-only session/iu)).not.toBeInTheDocument();
  });
});
