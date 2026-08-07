import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SessionActivityView, SessionView } from "../types";
import { emptyActivityCopy, relativeDeadlineCopy, SessionThreadComposer } from "./session-thread";

const sharedCoordination = {
  mode: "shared",
  nativeAttach: "join",
  responseResolution: "first-response-wins",
} as const;
const sharedClaudeCoordination = {
  mode: "shared",
  nativeAttach: "join",
  // Claude has no `serverRequest/resolved`, so each controller answers only its
  // own requests and there is nothing to arbitrate.
  responseResolution: "single-controller",
} as const;
const observeCoordination = {
  mode: "observe-only",
  nativeAttach: "none",
  responseResolution: "single-controller",
} as const;

const session = {
  id: "local:codex:thread-1",
  provider: "codex",
  status: "running",
  todoProgress: null,
  model: { value: "gpt-live" },
  effort: { value: "high" },
  profile: { value: "execute" },
  sandbox: { value: { mode: "workspace-write", networkAccess: false } },
  control: {
    plane: "codex-private",
    authority: "manager",
    coordination: sharedCoordination,
    recovery: null,
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

  it("never describes an empty archive as live or waiting", () => {
    expect(emptyActivityCopy("open", false, true)).toEqual({
      title: "No archived activity",
      description: "No retained transcript is available for this archived session.",
    });
  });

  it.each([
    ["connecting", "Loading activity"],
    ["retrying", "Reconnecting to activity"],
    ["offline", "Activity stream unavailable"],
  ] as const)("keeps an empty archive in its %s connection state", (connection, title) => {
    expect(emptyActivityCopy(connection, false, true).title).toBe(title);
  });
});

describe("control deadline copy", () => {
  it("renders a compact live countdown without claiming an expired deadline is active", () => {
    const now = Date.parse("2026-08-05T10:00:00.000Z");
    expect(relativeDeadlineCopy("2026-08-05T10:01:05.000Z", now)).toBe("1m 5s remaining");
    expect(relativeDeadlineCopy("2026-08-05T09:59:59.000Z", now)).toBe("deadline reached");
    expect(relativeDeadlineCopy(null, now)).toBeNull();
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
      onSetSandbox={vi.fn()}
      
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
    expect(document.querySelector("[data-session-thread-composer]")).toHaveClass("min-w-0", "max-w-full");
  });

  it("hands a read-only session a way to reach the setup that would fix it", () => {
    const onOpenSetup = vi.fn();
    const observed = {
      ...session,
      control: { ...session.control, plane: "observe-only", authority: "none", coordination: observeCoordination, capabilities: [], withheld: [
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
      onSetSandbox={vi.fn()}
      
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onOpenSetup={onOpenSetup}
    />);

    expect(screen.getByText("Live observation only")).toBeInTheDocument();
    expect(screen.getByText("This terminal-started session has no hook bridge.")).toBeInTheDocument();
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
      onSetSandbox={vi.fn()}
      
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onOpenSetup={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: "Enable live activity" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-control-state]")).not.toBeInTheDocument();
  });

  it("explains external Codex takeover as a one-time migration to shared control", () => {
    const onTakeControl = vi.fn(async () => undefined);
    const observed = {
      ...session,
      control: {
        ...session.control,
        plane: "observe-only",
        authority: "foreign",
        coordination: observeCoordination,
        capabilities: ["take-control", "resume"],
        withheld: [{ capability: "queue", reason: "This Codex CLI has not migrated to the shared server yet." }],
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
      onSetSandbox={vi.fn()}
      
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onTakeControl={onTakeControl}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Migrate to shared web + CLI" }));
    expect(screen.queryByRole("button", { name: "Resume here" })).not.toBeInTheDocument();
    expect(screen.getByText(/one-time migration/iu)).toHaveTextContent("CLI and web remain writable together");
    expect(screen.getByText(/was not exposed/iu)).toHaveTextContent("plan");
    expect(screen.queryByText(/conservative/iu)).not.toBeInTheDocument();
    const menu = document.querySelector("[data-takeover-menu]");
    expect(menu).not.toBeNull();
    const choices = within(menu as HTMLElement).getAllByRole("button");
    expect(choices[0]).toHaveAccessibleName("Prepare graceful Codex stop…");
    expect(choices[0]).toHaveClass("bg-[var(--accent)]");
    expect(choices[1]).toHaveAccessibleName("I’ll exit Codex myself");
    expect(choices[1]).toHaveClass("border");
    fireEvent.click(choices[0]!);
    expect(onTakeControl).toHaveBeenCalledWith("graceful-stop", undefined);
  });

  it("confirms graceful stop only with the server-issued takeover id", async () => {
    const onTakeControl = vi.fn(async () => undefined);
    const onCancelTakeControl = vi.fn(async () => undefined);
    const prepared = {
      ...session,
      control: {
        ...session.control,
        plane: "observe-only",
        authority: "foreign",
        coordination: sharedCoordination,
        capabilities: ["take-control", "cancel-take-control"],
        withheld: [{ capability: "queue", reason: "Codex is awaiting graceful-stop confirmation." }],
        takeover: {
          id: "takeover-confirmation-1",
          state: "awaiting-confirmation",
          methods: ["guided-exit", "graceful-stop"],
          method: "graceful-stop",
          requestedAt: "2026-08-05T10:00:00.000Z",
          deadlineAt: null,
          fallbackProfile: null,
          error: null,
        },
      },
    } as SessionView;
    render(<SessionThreadComposer
      session={prepared}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onTakeControl={onTakeControl}
      onCancelTakeControl={onCancelTakeControl}
    />);

    expect(screen.getByText(/No signal has been sent/iu)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop and migrate" }));
    expect(onTakeControl).toHaveBeenCalledWith("graceful-stop", "takeover-confirmation-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel without signalling" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel without signalling" }));
    expect(onCancelTakeControl).toHaveBeenCalledWith("takeover-confirmation-1");
  });

  // Renamed from "keeps Claude exclusive …": a live external Claude session is
  // no longer exclusive. This still covers the takeover escalation/cancel UI,
  // which Codex standalone migration keeps using.
  it("offers browser safe-stop escalation and cancellation during a takeover", async () => {
    const onTakeControl = vi.fn(async () => undefined);
    const onCancelTakeControl = vi.fn(async () => undefined);
    const observed = {
      ...session,
      provider: "claude",
      control: {
        ...session.control,
        plane: "claude-hook-bridge",
        authority: "foreign",
        coordination: sharedClaudeCoordination,
        capabilities: ["take-control", "cancel-take-control"],
        withheld: [{ capability: "queue", reason: "Claude Code currently owns this conversation." }],
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
      onSetSandbox={vi.fn()}
      
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onTakeControl={onTakeControl}
      onCancelTakeControl={onCancelTakeControl}
    />);

    expect(screen.getByText("Claude Code is running")).toBeInTheDocument();
    expect(screen.getByText(/waiting for exclusive access/iu)).toHaveTextContent("Stop the validated Claude Code process safely here");
    const safeStop = screen.getByRole("button", { name: "Stop safely here…" });
    expect(safeStop).toHaveClass("bg-[var(--accent)]");
    fireEvent.click(safeStop);
    expect(onTakeControl).toHaveBeenCalledWith("graceful-stop", "takeover-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelTakeControl).toHaveBeenCalledWith("takeover-1");
    expect(screen.queryByText(/agent-manager attach|codex resume/iu)).not.toBeInTheDocument();
  });

  it("keeps managed Codex writable without putting CLI access in the composer", () => {
    const observed = {
      ...session,
      control: { ...session.control, capabilities: ["queue", "steer", "attach"], takeover: null },
    } as SessionView;
    render(<SessionThreadComposer
      session={observed}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
    />);

    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(document.querySelector("[data-control-state]")).not.toBeInTheDocument();
    expect(screen.queryByText(/The first surface to answer a question or approval wins/iu)).not.toBeInTheDocument();
    expect(document.querySelector("[data-session-thread-composer]")?.lastElementChild).toHaveAttribute("data-session-composer");
    expect(screen.queryByRole("button", { name: /CLI (?:join|resume) command/iu })).not.toBeInTheDocument();
    expect(screen.queryByText(/codex resume/iu)).not.toBeInTheDocument();
  });

  it("keeps a managed Claude writer visible without a composer CLI handoff", () => {
    const managedClaude = {
      ...session,
      provider: "claude",
      control: {
        ...session.control,
        plane: "claude-sdk",
        authority: "manager",
        coordination: sharedClaudeCoordination,
        capabilities: ["queue", "attach"],
        takeover: null,
      },
    } as SessionView;
    render(<SessionThreadComposer
      session={managedClaude}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
    />);

    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Move control to Claude Code|CLI/iu })).not.toBeInTheDocument();
    expect(screen.queryByText(/agent-manager attach/iu)).not.toBeInTheDocument();
  });

  it("lets an ended resume-only session send through transparent resume", async () => {
    const onSend = vi.fn(async () => undefined);
    const dormantClaude = {
      ...session,
      provider: "claude",
      status: "completed",
      control: {
        ...session.control,
        plane: "resume-only",
        authority: "none",
        coordination: sharedClaudeCoordination,
        capabilities: ["resume", "attach"],
        takeover: null,
      },
    } as SessionView;
    render(<SessionThreadComposer
      session={dormantClaude}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={onSend}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
    />);

    const textbox = screen.getByRole("textbox", { name: "Message" });
    expect(textbox).toBeEnabled();
    expect(screen.queryByText("This session ended")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume here" })).not.toBeInTheDocument();
    fireEvent.change(textbox, { target: { value: "Continue from here" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Continue from here", "queue"));
  });

  it("resumes a non-ended resume-only session directly in the web app", async () => {
    const onResumeInWeb = vi.fn(async () => undefined);
    const resumable = {
      ...session,
      status: "idle",
      control: {
        ...session.control,
        plane: "resume-only",
        authority: "none",
        coordination: sharedCoordination,
        capabilities: ["resume", "attach"],
        withheld: [{ capability: "queue", reason: "The provider session is dormant." }],
        takeover: null,
      },
    } as SessionView;
    render(<SessionThreadComposer
      session={resumable}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onResumeInWeb={onResumeInWeb}
    />);

    const details = screen.getByRole("button", { name: "Ready to resume here" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/No terminal command is required/iu)).not.toBeInTheDocument();
    expect(document.querySelector("[data-session-thread-composer]")?.lastElementChild).toHaveAttribute("data-session-composer");
    fireEvent.click(details);
    expect(screen.getByText(/No terminal command is required/iu)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume here" }));
    await waitFor(() => expect(onResumeInWeb).toHaveBeenCalledOnce());
    expect(screen.queryByText(/codex resume|agent-manager attach/iu)).not.toBeInTheDocument();
  });

  it("keeps takeover retry in the composer while demoting optional CLI access", () => {
    const observed = {
      ...session,
      control: {
        ...session.control,
        plane: "observe-only",
        authority: "foreign",
        coordination: sharedCoordination,
        capabilities: ["take-control", "resume", "attach"],
        withheld: [{ capability: "queue", reason: "Shared control migration failed." }],
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
      onSetSandbox={vi.fn()}
      
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onTakeControl={vi.fn(async () => undefined)}
      onResumeInWeb={vi.fn(async () => undefined)}
    />);

    expect(screen.getByText("Web control was not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry shared-control migration" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume here" })).toBeInTheDocument();
    expect(screen.getAllByText(/Optional CLI access.*Advanced session facts/iu).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /CLI resume command/iu })).not.toBeInTheDocument();
  });

  it("keeps CLI commands out while an active Codex migration can be completed in the browser", () => {
    const onTakeControl = vi.fn(async () => undefined);
    const migrating = {
      ...session,
      control: {
        ...session.control,
        plane: "observe-only",
        authority: "foreign",
        coordination: observeCoordination,
        capabilities: ["take-control", "cancel-take-control", "attach"],
        withheld: [{ capability: "queue", reason: "The standalone Codex session is migrating." }],
        takeover: {
          id: "migration-1",
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
      session={migrating}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onTakeControl={onTakeControl}
      onCancelTakeControl={vi.fn(async () => undefined)}
    />);

    expect(screen.getByText(/waiting for exclusive access/iu)).toHaveTextContent("Stop the validated Codex process safely here");
    fireEvent.click(screen.getByRole("button", { name: "Stop safely here…" }));
    expect(onTakeControl).toHaveBeenCalledWith("graceful-stop", "migration-1");
    expect(screen.queryByRole("button", { name: /Show (?:Codex CLI|Claude Code)/iu })).not.toBeInTheDocument();
    expect(screen.queryByText(/agent-manager attach|codex resume/iu)).not.toBeInTheDocument();
  });

  it("renders durable recovery with exact retry state and a retry-now action", () => {
    const onRetryControl = vi.fn(async () => undefined);
    const recovering = {
      ...session,
      provider: "claude",
      control: {
        ...session.control,
        plane: "claude-sdk",
        authority: "none",
        coordination: sharedClaudeCoordination,
        recovery: {
          state: "needs-attention",
          attempt: 3,
          startedAt: "2026-08-05T10:00:00.000Z",
          deadlineAt: null,
          nextRetryAt: null,
          error: "Managed Claude recovery stopped safely: managed Claude recovery timed out",
        },
        capabilities: ["retry-control"],
        withheld: [{ capability: "queue", reason: "Provider control is reconnecting." }],
        takeover: null,
      },
    } as SessionView;
    render(<SessionThreadComposer
      session={recovering}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onRetryControl={onRetryControl}
    />);

    expect(screen.getByText("Claude Code control needs attention")).toBeInTheDocument();
    expect(screen.getByText("Agent Manager could not restore web control. Your conversation history is safe.")).toBeInTheDocument();
    expect(screen.queryByText("attempt 3")).not.toBeInTheDocument();
    expect(screen.queryByText("Managed Claude recovery stopped safely: managed Claude recovery timed out")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText("Managed Claude recovery stopped safely: managed Claude recovery timed out")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry web control" }));
    expect(onRetryControl).toHaveBeenCalledOnce();
  });

  it("offers a live external Claude session a join, not a takeover", () => {
    const onResumeInWeb = vi.fn(async () => undefined);
    /*
      This replaces two tests that asserted the opposite: that a live native
      Claude owner parked recovery in a healthy "Claude Code has control" wait,
      and that the remedy was a takeover which stopped that process. Shared join
      removed both. A live external session is joinable, so it advertises
      `resume` with no recovery state at all.
    */
    const live = {
      ...session,
      provider: "claude",
      status: "running",
      control: {
        ...session.control,
        plane: "resume-only",
        authority: "foreign",
        coordination: sharedClaudeCoordination,
        recovery: null,
        capabilities: ["resume"],
        withheld: [{ capability: "queue", reason: "Agent Manager is observing this session. Join it to reply here." }],
        peers: [],
        takeover: null,
      },
    } as SessionView;
    render(<SessionThreadComposer
      session={live}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onResumeInWeb={onResumeInWeb}
    />);

    const details = screen.getByRole("button", { name: "Ready to join here" });
    expect(screen.queryByText(/has control/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move Claude Code control here/iu })).not.toBeInTheDocument();
    // The terminal keeps running, and the fork is stated rather than implied.
    fireEvent.click(details);
    expect(screen.getByText(/The terminal session keeps running/iu)).toBeInTheDocument();
    expect(screen.getByText(/the conversation forks/iu)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join here" }));
    expect(onResumeInWeb).toHaveBeenCalledOnce();
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
      onSetSandbox={vi.fn()}
      
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
    // The harness's own reason is stated in the menu, not only on hover.
    expect(within(menu).getByRole("status")).toHaveTextContent(
      "The hook can observe the model but cannot change it.",
    );
    expect(document.querySelectorAll("[data-effort-bar]")).toHaveLength(4);
    expect(document.querySelectorAll("[data-effort-bar='active']")).toHaveLength(3);
  });
});

/*
  The one wiring no test pinned while the pickers shipped dead: a fresh
  manager-owned Claude session grants `set-model` and `set-effort` from its
  first record, and the composer must turn those grants into genuinely
  selectable rows and radios.
*/
describe("a managed session with granted model and effort control", () => {
  const managed = {
    ...session,
    id: "local:claude:managed-1",
    provider: "claude",
    model: { value: "claude-sonnet-5" },
    effort: { value: "high" },
    control: {
      plane: "claude-sdk",
      authority: "manager",
      coordination: sharedClaudeCoordination,
      recovery: null,
      capabilities: ["queue", "interrupt", "set-profile", "set-model", "set-effort", "end"],
      withheld: [],
      peers: [],
      takeover: null,
    },
  } as unknown as SessionView;
  const catalog = [
    { value: "sonnet", label: "Sonnet", description: null, resolvedModel: "claude-sonnet-5", efforts: ["low", "high"] as const },
    { value: "opus", label: "Opus", description: null, resolvedModel: "claude-opus-5", efforts: ["medium", "max"] as const },
  ];

  function renderManaged(
    overrides: Partial<React.ComponentProps<typeof SessionThreadComposer>> & {
      omitEffortOptions?: boolean;
    } = {},
  ) {
    const { omitEffortOptions = false, ...componentOverrides } = overrides;
    const onSetModel = vi.fn(async () => undefined);
    const onSetEffort = vi.fn(async () => undefined);
    render(<SessionThreadComposer
      session={managed}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={onSetModel}
      onSetEffort={onSetEffort}
      modelOptions={catalog}
      modelOptionsStatus={null}
      {...(!omitEffortOptions ? { effortOptions: ["low", "high"] as const } : {})}
      {...componentOverrides}
    />);
    return { onSetModel, onSetEffort };
  }

  function openRuntimeMenu() {
    const trigger = screen.getByRole("combobox", { name: /claude/i });
    expect(trigger).toBeEnabled();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1 });
    fireEvent.click(trigger);
    return screen.getByRole("dialog", { name: "Harness, model, and effort" });
  }

  it("lets the operator pick a model and an effort", () => {
    const { onSetModel, onSetEffort } = renderManaged();

    const menu = openRuntimeMenu();
    const sonnet = within(menu).getByRole("option", { name: /Sonnet/u });
    const opus = within(menu).getByRole("option", { name: /Opus/u });
    expect(sonnet).not.toHaveAttribute("aria-disabled", "true");
    expect(opus).not.toHaveAttribute("aria-disabled", "true");
    // The covering row — matched through `resolvedModel` — carries the check.
    expect(sonnet.querySelector("svg")).not.toBeNull();
    expect(opus.querySelector("svg")).toBeNull();

    const high = within(menu).getByRole("radio", { name: /high/iu });
    expect(high).toHaveAttribute("aria-checked", "true");
    expect(high).toBeEnabled();
    fireEvent.click(within(menu).getByRole("radio", { name: /low/iu }));
    expect(onSetEffort).toHaveBeenCalledWith("low");

    fireEvent.click(opus);
    expect(onSetModel).toHaveBeenCalledWith("opus");
  });

  it("offers the provider effort vocabulary when the loaded row declares none", () => {
    const bare = catalog.map(({ efforts: _efforts, ...option }) => option);
    const { onSetEffort } = renderManaged({ modelOptions: bare, effortOptions: [] });

    const menu = openRuntimeMenu();
    const radios = within(menu).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    fireEvent.click(within(menu).getByRole("radio", { name: /medium/iu }));
    expect(onSetEffort).toHaveBeenCalledWith("medium");
  });

  it("keeps effort selectable when the model catalog is unavailable", () => {
    const { onSetEffort } = renderManaged({
      modelOptions: [],
      modelOptionsStatus: "The provider model catalog could not be loaded.",
      omitEffortOptions: true,
    });

    const menu = openRuntimeMenu();
    expect(within(menu).getByRole("status")).toHaveTextContent(
      "The provider model catalog could not be loaded.",
    );
    const radios = within(menu).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    fireEvent.click(within(menu).getByRole("radio", { name: /xhigh/iu }));
    expect(onSetEffort).toHaveBeenCalledWith("xhigh");
  });

  it("fabricates no effort radios where the capability is withheld", () => {
    render(<SessionThreadComposer
      session={session}
      activity={activity}
      busy={false}
      mutationsReady
      onSend={vi.fn(async () => undefined)}
      onInterrupt={vi.fn(async () => undefined)}
      onSetProfile={vi.fn(async () => undefined)}
      onSetSandbox={vi.fn()}
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[{ value: "gpt-live", label: "Live", description: null }]}
      modelOptionsStatus={null}
      effortOptions={[]}
    />);

    const trigger = screen.getByRole("combobox", { name: /codex/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1 });
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "Harness, model, and effort" });
    expect(within(menu).queryAllByRole("radio")).toHaveLength(0);
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
    control: { plane: "observe-only", authority: "none", coordination: observeCoordination, recovery: null, capabilities: [], withheld: [], peers: [], takeover: null },
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
      onSetSandbox={vi.fn()}
      
      onSetModel={vi.fn(async () => undefined)}
      onSetEffort={vi.fn(async () => undefined)}
      modelOptions={[]}
      modelOptionsStatus={null}
      onOpenSetup={vi.fn()}
    />);
  }

  it("names observation-only state and its direct setup action", () => {
    renderComposer();

    expect(document.querySelector("[data-hook-upgrade]")).toBeNull();
    expect(screen.getByText("Live observation only")).toBeInTheDocument();
    expect(screen.getByText("Replies are unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable live activity" })).toBeInTheDocument();
  });
});
