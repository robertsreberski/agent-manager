import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SessionActivityView, SessionView } from "../types";
import { emptyActivityCopy, SessionThreadComposer } from "./session-thread";

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
    takeover: null,
  },
} as SessionView;

const activity = {
  items: [{
    kind: "queue",
    messages: [{ id: "queued-1", text: "Do not duplicate this bubble", status: "queued", enqueuedAt: "2026-08-04T12:00:00.000Z", turnId: "turn-1" }],
  }],
} as SessionActivityView;

describe("empty activity connection copy", () => {
  it.each([
    ["connecting", "Loading activity"],
    ["retrying", "Reconnecting to activity"],
    ["open", "Waiting for provider activity"],
    ["offline", "Activity stream unavailable"],
  ] as const)("renders %s truthfully", (connection, title) => {
    expect(emptyActivityCopy(connection, false).title).toBe(title);
  });

  it("never describes a retention boundary as waiting", () => {
    expect(emptyActivityCopy("open", true).title).toBe("No retained activity");
  });
});

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
    fireEvent.click(screen.getByRole("button", { name: "Enable live activity" }));
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

    expect(screen.queryByRole("button", { name: "Enable live activity" })).not.toBeInTheDocument();
    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
  });

  it("offers guided takeover and separately confirms the single graceful stop", () => {
    const onTakeControl = vi.fn(async () => undefined);
    const observed = {
      ...session,
      control: {
        ...session.control,
        capabilities: ["take-control"],
        takeover: {
          id: null,
          state: "available",
          methods: ["guided-exit", "graceful-stop"],
          method: null,
          requestedAt: null,
          deadlineAt: null,
          fallbackProfile: "plan",
          error: null,
        },
      },
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
      onTakeControl={onTakeControl}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(screen.getByText(/conservative/iu)).toHaveTextContent("plan");
    fireEvent.click(screen.getByRole("button", { name: "Stop CLI gracefully…" }));
    expect(onTakeControl).not.toHaveBeenCalled();
    expect(screen.getByText(/exactly one SIGTERM/iu)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm graceful stop" }));
    expect(onTakeControl).toHaveBeenCalledWith("graceful-stop");
  });

  it("can cancel only the guided takeover while it waits for CLI exit", () => {
    const onCancelTakeControl = vi.fn(async () => undefined);
    const observed = {
      ...session,
      control: {
        ...session.control,
        capabilities: ["cancel-take-control"],
        takeover: {
          id: "takeover-1",
          state: "waiting-for-exit",
          methods: ["guided-exit", "graceful-stop"],
          method: "guided-exit",
          requestedAt: "2026-08-05T10:00:00.000Z",
          deadlineAt: "2026-08-05T10:05:00.000Z",
          fallbackProfile: null,
          error: null,
        },
      },
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
      onCancelTakeControl={onCancelTakeControl}
    />);

    expect(screen.getByText(/Exit the Codex CLI/iu)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel takeover" }));
    expect(onCancelTakeControl).toHaveBeenCalledWith("takeover-1");
  });

  it("offers a native continuation when safe takeover is unavailable", async () => {
    const onNativeContinue = vi.fn(async () => ({
      available: true as const,
      kind: "tmux" as const,
      command: "tmux attach-session -t work",
      description: "Attach to the existing CLI",
      requiresHandoff: false,
      argv: ["tmux", "attach-session", "-t", "work"],
      cwd: "/workspace",
    }));
    const observed = {
      ...session,
      control: { ...session.control, capabilities: ["attach"], takeover: null },
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
      onNativeContinue={onNativeContinue}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Continue in CLI" }));
    expect(await screen.findByText("tmux attach-session -t work")).toBeInTheDocument();
  });

  it("keeps native continuation available after a takeover failure", () => {
    const observed = {
      ...session,
      control: {
        ...session.control,
        capabilities: ["take-control", "attach"],
        takeover: {
          id: "failed-takeover",
          state: "failed",
          methods: ["guided-exit", "graceful-stop"],
          method: "guided-exit",
          requestedAt: "2026-08-05T10:00:00.000Z",
          deadlineAt: null,
          fallbackProfile: null,
          error: "Provider identity changed",
        },
      },
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
      onTakeControl={vi.fn(async () => undefined)}
      onNativeContinue={vi.fn(async () => ({
        available: false as const,
        kind: "none" as const,
        command: null,
        description: null,
        requiresHandoff: false,
        argv: [],
        cwd: null,
      }))}
    />);

    expect(screen.getByRole("button", { name: "Take control" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue in CLI" })).toBeInTheDocument();
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
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
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
    expect(screen.getByRole("button", { name: "Enable live activity" })).toBeInTheDocument();
    expect(screen.queryByText(/hook|observation-only|read-only session/iu)).not.toBeInTheDocument();
  });
});
