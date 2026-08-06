import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SetupHookOffer, SetupHostProbe } from "../../../../src/shared/setup.ts";
import type { SelectedSessionFactsResponse } from "../../../../src/shared/session-facts.ts";
import type { CockpitSessionView } from "../../lib/cockpit-view";
import { EmptyState, FirstRun, HookSetupStep, HostSetupStep, SessionCapabilityPanel, SessionEndedState } from "./SystemStates";

function hook(provider: "claude", overrides: Partial<SetupHookOffer> = {}): SetupHookOffer {
  return {
    provider,
    state: "absent",
    settingsPath: `/Users/me/.${provider}/settings.json`,
    command: `agent-manager hooks install --provider ${provider} --scope user`,
    changed: true,
    diff: `--- before\n+++ after\n+Authorization: Bearer [REDACTED]`,
    notice: null,
    previewId: provider === "claude" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    expiresAt: "2026-08-04T10:05:00.000Z",
    ...overrides,
  };
}

function cockpitSession(overrides: Partial<CockpitSessionView> = {}): CockpitSessionView {
  return {
    id: "local:codex:managed-1",
    provider: "codex",
    name: "Managed Codex",
    hostId: "local",
    hostLabel: "This Mac",
    remote: false,
    cwd: "/workspace/project",
    workspaceIdentity: {
      repoRoot: "/workspace/project",
      repoName: "project",
      worktreePath: "/workspace/project-worktree",
      linked: true,
      branch: "feature/session-facts",
      detached: false,
      dirtyCount: 3,
      ahead: null,
      behind: null, insertions: 312, deletions: 87,
    },
    activity: "running",
    attention: [],
    updatedAt: "2026-08-04T10:00:00.000Z",
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: { mode: "shared", nativeAttach: "join", responseResolution: "first-response-wins" },
      recovery: null,
      capabilities: ["queue", "set-profile", "attach"],
      withheld: [{ capability: "set-model", reason: "This provider cannot change models mid-session." }],
      peers: [],
      takeover: null,
    },
    profile: "execute",
    sandbox: null,
    model: "gpt-5.6",
    effort: "high",
    todo: null,
    ...overrides,
  };
}

const facts: SelectedSessionFactsResponse = {
  sessionId: "local:codex:managed-1",
  generation: 1,
  turnUsage: { turnId: "turn-1", inputTokens: 100, outputTokens: 50, cachedInputTokens: null, reasoningTokens: null, totalTokens: 150, costUsd: 0.0123 },
  account: {
    available: true,
    source: "provider-api",
    usage: {
      summary: { lifetimeTokens: 12_345, peakDailyTokens: 2_345, longestRunningTurnSec: 90, currentStreakDays: 3, longestStreakDays: 7 },
      recentDays: [{ date: "2026-08-04", tokens: 321 }],
    },
    rateLimits: [{ label: "Codex", planType: "plus", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null }, secondary: null, spendControlReached: false }],
  },
};

describe("SessionEndedState", () => {
  it("resumes the exact session in the web app before offering a new worktree thread", () => {
    const onResume = vi.fn();
    const onContinue = vi.fn();
    render(<SessionEndedState canResume canContinue onResume={onResume} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume here" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(screen.getByText("Continue this exact provider conversation in Agent Manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a new thread in this worktree" })).toBeInTheDocument();
  });

  it("does not imply resume when the harness withdrew it", () => {
    render(<SessionEndedState canResume={false} canContinue resumeUnavailableReason="Resume is unavailable because the provider queue did not drain." />);

    expect(screen.queryByRole("button", { name: "Resume here" })).not.toBeInTheDocument();
    expect(screen.getByText("Resume is unavailable because the provider queue did not drain.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a new thread in this worktree" })).toBeInTheDocument();
  });

  it("shows a busy semantic resume state without exposing a terminal command", () => {
    render(<SessionEndedState canResume resuming canContinue={false} />);

    expect(screen.getByRole("button", { name: "Resuming…" })).toBeDisabled();
    expect(screen.queryByText(/agent-manager attach|codex resume/iu)).not.toBeInTheDocument();
  });
});

describe("SessionCapabilityPanel", () => {
  it("renders the ordered facts and describes resume as an exact web action", () => {
    const { rerender } = render(<SessionCapabilityPanel session={cockpitSession()} facts={facts} factsStatus="loaded" attachCommand={null} onRevealAttach={vi.fn()} />);

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Where it runs",
      "What it may do",
      "What this turn cost",
    ]);
    const rendered = document.body.textContent ?? "";
    for (const text of ["This Mac", "project", "/workspace/project-worktree", "feature/session-facts", "3 files · +312 −87 uncommitted", "Codex managed app server", "Queue messages for the next turn", "This provider cannot change models mid-session.", "150", "$0.0123", "12.3K lifetime tokens", "25% used"]) expect(rendered).toContain(text);
    expect(screen.queryByText("codex-private")).not.toBeInTheDocument();
    expect(screen.queryByText("danger-full-access")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Advanced · CLI access" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Show Codex CLI join command" })).not.toBeInTheDocument();
    expect(screen.getByText("Shared CLI + web")).toBeInTheDocument();
    expect(screen.getByText("Use Codex CLI and web together. The first surface to answer a question or approval wins.")).toBeInTheDocument();

    const resumable = cockpitSession({ activity: "completed", control: { ...cockpitSession().control, capabilities: ["resume", "attach"] } });
    rerender(<SessionCapabilityPanel session={resumable} facts={facts} factsStatus="loaded" />);
    expect(screen.getByText("Resume the exact session in the web app")).toBeInTheDocument();
  });

  it("keeps unknown facts unknown and never calls a zero-dirty worktree dirty", () => {
    const { rerender } = render(<SessionCapabilityPanel
      session={cockpitSession({ workspaceIdentity: null, cwd: null, profile: null, model: null, effort: null, control: { plane: "observe-only", authority: "none", coordination: { mode: "observe-only", nativeAttach: "none", responseResolution: "single-controller" }, recovery: null, capabilities: [], withheld: [], peers: [], takeover: null } })}
      facts={{ sessionId: "local:codex:managed-1", generation: 1, turnUsage: null, account: { available: false, reason: "unsupported-provider" } }}
      factsStatus="loaded"
    />);
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByLabelText("Unknown").length).toBeGreaterThan(0);
    expect(screen.getByText("No exact turn usage has been exposed.")).toBeInTheDocument();
    expect(screen.queryByText("Codex account facts are temporarily unavailable.")).not.toBeInTheDocument();

    rerender(<SessionCapabilityPanel session={cockpitSession({ workspaceIdentity: { ...cockpitSession().workspaceIdentity!, dirtyCount: 0 } })} facts={facts} factsStatus="loaded" />);
    expect(screen.getByText("Clean")).toBeInTheDocument();
    expect(screen.queryByText("0 uncommitted")).not.toBeInTheDocument();
  });

  it("reveals truthful shared Codex attach metadata", () => {
    const onRevealAttach = vi.fn();
    const { rerender } = render(<SessionCapabilityPanel session={cockpitSession()} facts={facts} factsStatus="loaded" onRevealAttach={onRevealAttach} />);
    fireEvent.click(screen.getByRole("button", { name: "Advanced · CLI access" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Codex CLI join command" }));
    expect(onRevealAttach).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Advanced · CLI access" }));

    rerender(<SessionCapabilityPanel session={cockpitSession()} facts={facts} factsStatus="loaded" attachCommand="codex resume managed-1 --remote unix:///tmp/codex.sock" attachDescription="Join the managed Codex App Server." onRevealAttach={onRevealAttach} />);
    expect(screen.queryByText("codex resume managed-1 --remote unix:///tmp/codex.sock")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Advanced · CLI access" }));
    expect(screen.getByText("codex resume managed-1 --remote unix:///tmp/codex.sock")).toBeInTheDocument();
    expect(screen.getByText("Join the managed Codex App Server.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Codex CLI join command" })).toBeInTheDocument();
    expect(screen.getByText("CLI joins; web control stays active")).toBeInTheDocument();
  });

  it("describes takeover by provider target even while foreign sessions are observe-only", () => {
    const foreign = {
      plane: "observe-only",
      authority: "foreign",
      coordination: { mode: "observe-only", nativeAttach: "none", responseResolution: "single-controller" },
      recovery: null,
      capabilities: ["take-control"],
      withheld: [],
      peers: [],
      takeover: null,
    } as CockpitSessionView["control"];
    const { rerender } = render(<SessionCapabilityPanel session={cockpitSession({ provider: "codex", control: foreign })} facts={facts} factsStatus="loaded" />);
    expect(screen.getByText("Migrate once to shared CLI + web control")).toBeInTheDocument();

    /*
      Claude used to read "Move exclusive Claude Code control to the web app".
      Only Codex migrates now, so both providers get the same sentence — and a
      Claude session should not be offering takeover at all.
    */
    rerender(<SessionCapabilityPanel session={cockpitSession({ provider: "claude", control: foreign })} facts={facts} factsStatus="loaded" />);
    expect(screen.getByText("Migrate once to shared CLI + web control")).toBeInTheDocument();
    expect(screen.queryByText(/exclusive Claude Code control/iu)).not.toBeInTheDocument();
  });

  it("describes a dormant Claude wrapper as a join command, not an ownership handoff", () => {
    const dormant = cockpitSession({
      provider: "claude",
      activity: "completed",
      control: {
        plane: "resume-only",
        authority: "none",
        coordination: { mode: "shared", nativeAttach: "join", responseResolution: "single-controller" },
        recovery: null,
        capabilities: ["resume"],
        withheld: [],
        peers: [],
        takeover: null,
      },
    });
    const { rerender } = render(<SessionCapabilityPanel session={dormant} facts={facts} factsStatus="loaded" onRevealAttach={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Advanced · CLI access" }));
    expect(screen.getByRole("button", { name: "Show Claude Code join command" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Advanced · CLI access" }));

    rerender(<SessionCapabilityPanel session={dormant} facts={facts} factsStatus="loaded" attachCommand="agent-manager attach exact-claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Advanced · CLI access" }));
    // The old copy promised web replies would stop. They do not.
    expect(screen.getByText("CLI joins; web control stays active")).toBeInTheDocument();
    expect(screen.queryByText(/moves provider control to the CLI/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/web replies stay unavailable/iu)).not.toBeInTheDocument();
  });

  it("renders every archived capability as definitively unavailable", () => {
    render(<SessionCapabilityPanel
      session={cockpitSession()}
      archived
      facts={facts}
      factsStatus="loaded"
      onRevealAttach={vi.fn()}
    />);

    expect(screen.getByText("Archived · read-only")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Available")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unknown")).not.toBeInTheDocument();
    expect(screen.getAllByText("Archived sessions are read-only.").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Advanced · CLI access" }));
    expect(screen.queryByRole("button", { name: "Show Codex CLI join command" })).not.toBeInTheDocument();
  });
});

describe("first-run setup", () => {
  it("installs an exact preview in the browser and keeps manual commands under Advanced", async () => {
    const onContinue = vi.fn();
    const onApply = vi.fn(async () => undefined);
    render(<HookSetupStep
      hooks={{ claude: hook("claude") }}
      onApply={onApply}
      onContinue={onContinue}
    />);

    expect(screen.getAllByText("Not installed")).toHaveLength(1);
    expect(screen.getByText(/Hooks add exact live activity and surface held approvals or questions/iu)).toHaveTextContent("Sending new messages still requires provider control");
    expect(screen.queryByText(/see and answer sessions/iu)).not.toBeInTheDocument();
    expect(screen.queryByText("agent-manager hooks install --provider claude --scope user")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Bearer \[REDACTED\]/u)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Install claude hook" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("claude", "11111111-1111-4111-8111-111111111111"));
    fireEvent.click(screen.getAllByRole("button", { name: "Advanced · manual installation" })[0]!);
    expect(screen.getByText("agent-manager hooks install --provider claude --scope user")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue without installing hooks" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("names the region the settings-diff disclosure controls and collapses it", () => {
    render(<HookSetupStep hooks={{ claude: hook("claude") }} standalone />);
    const [disclosure] = screen.getAllByRole("button", { name: "Exact redacted settings diff" });
    if (!disclosure) throw new Error("Missing settings diff disclosure");

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const controls = disclosure.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)?.textContent).toContain("Bearer [REDACTED]");

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).not.toHaveAttribute("aria-controls");
    expect(screen.queryAllByText(/Bearer \[REDACTED\]/u)).toHaveLength(0);
  });

  it("drops the wizard framing outside first run while retaining the in-app install action", () => {
    const onApply = vi.fn(async () => undefined);
    render(<HookSetupStep hooks={{ claude: hook("claude") }} onApply={onApply} standalone />);

    expect(screen.queryByText("Optional setup · 2 of 3")).not.toBeInTheDocument();
    expect(screen.getByText("Provider hooks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue without installing hooks" })).not.toBeInTheDocument();
    expect(screen.queryByText("agent-manager hooks install --provider claude --scope user")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install claude hook" })).toBeEnabled();
  });

  it("keeps apply pending locally and reports a failed provider update", async () => {
    let rejectApply!: (error: Error) => void;
    const onApply = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectApply = reject; }));
    const onRefresh = vi.fn();
    render(<HookSetupStep hooks={{ claude: hook("claude") }} onApply={onApply} onRefresh={onRefresh} standalone />);

    fireEvent.click(screen.getByRole("button", { name: "Install claude hook" }));
    expect(await screen.findByRole("button", { name: "Installing…" })).toBeDisabled();
    rejectApply(new Error("That preview expired. Refresh setup and try again."));

    expect(await screen.findByRole("alert")).toHaveTextContent("That preview expired. Refresh setup and try again.");
    expect(screen.getByRole("button", { name: "Install claude hook" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("drops the wizard framing on the standalone host step", () => {
    render(<HostSetupStep hosts={[]} onAddHost={vi.fn(async () => undefined)} onRemoveHost={vi.fn(async () => undefined)} standalone />);

    expect(screen.queryByText("Optional setup · 3 of 3")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remote hosts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to new thread" })).not.toBeInTheDocument();
    expect(screen.getByText(/No remote hosts are configured/u)).toBeInTheDocument();
    expect(screen.queryByText(/agent-manager host add/u)).not.toBeInTheDocument();
  });

  it("adds a trimmed SSH target in-app while keeping first-run Continue available", async () => {
    let finishAdd!: () => void;
    const onAddHost = vi.fn(() => new Promise<void>((resolve) => { finishAdd = resolve; }));
    const onContinue = vi.fn();
    render(<HostSetupStep
      hosts={[]}
      onAddHost={onAddHost}
      onRemoveHost={vi.fn(async () => undefined)}
      onContinue={onContinue}
    />);

    fireEvent.change(screen.getByRole("textbox", { name: "Host label" }), { target: { value: "  Build host  " } });
    fireEvent.change(screen.getByRole("textbox", { name: "SSH target" }), { target: { value: "  dev@build.example  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));

    expect(onAddHost).toHaveBeenCalledWith("Build host", "dev@build.example");
    expect(await screen.findByRole("button", { name: "Adding…" })).toBeDisabled();
    const continueButton = screen.getByRole("button", { name: "Continue to new thread" });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(onContinue).toHaveBeenCalledOnce();
    expect(screen.getByText(/does not delete remote files or stop remote processes/u)).toBeInTheDocument();
    expect(screen.queryByText(/agent-manager host add/u)).not.toBeInTheDocument();

    finishAdd();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add host" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Host label" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "SSH target" })).toHaveValue("");
  });

  it("reports current hooks without an install action", () => {
    render(<HookSetupStep
      hooks={{
        claude: hook("claude", { state: "active", changed: false, diff: "", previewId: null, expiresAt: null }),
      }}
      onContinue={vi.fn()}
    />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install/u })).not.toBeInTheDocument();
    expect(screen.getAllByText("No settings change needed")).toHaveLength(1);
  });

  it("browses through bounded server folder suggestions and chooses a real returned path", async () => {
    const onBrowse = vi.fn(async () => ["/srv/project"]);
    const onChooseFolder = vi.fn();
    render(<FirstRun
      nearby={[]}
      hosts={[{ id: "local", label: "This Mac", kind: "local" }, { id: "studio", label: "Studio", kind: "ssh" }]}
      onBrowse={onBrowse}
      onChooseFolder={onChooseFolder}
    />);

    // Frame 13c keeps the folder field on screen; there is no disclosure to open.
    const host = screen.getByRole("combobox", { name: "Browse host" });
    expect(host).toHaveTextContent("This Mac");
    fireEvent.keyDown(host, { key: "ArrowDown" });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["This Mac", "Studio"]);
    fireEvent.click(screen.getByRole("option", { name: "Studio" }));
    await waitFor(() => expect(host).toHaveTextContent("Studio"));

    fireEvent.change(screen.getByRole("textbox", { name: "Browse folder path" }), { target: { value: "/srv/pro" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    expect(await screen.findByRole("button", { name: "/srv/project" })).toBeInTheDocument();
    expect(onBrowse).toHaveBeenCalledWith("studio", "/srv/pro");
    fireEvent.click(screen.getByRole("button", { name: "/srv/project" }));
    expect(onChooseFolder).toHaveBeenCalledWith({ hostId: "studio", path: "/srv/project" });
  });

  it("keeps the ordinary empty state separate from first-run setup", () => {
    const onOpen = vi.fn();
    render(<EmptyState repositories={[{ id: "workspace-1", name: "project", path: "/srv/project" }]} onOpen={onOpen} />);
    expect(screen.getByRole("heading", { name: "No agent sessions yet" })).toBeInTheDocument();
    expect(screen.queryByText(/First run/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /project/u }));
    expect(onOpen).toHaveBeenCalledWith("workspace-1");
  });

  it("reports a missing remote harness without failing the step", () => {
    const host: SetupHostProbe = {
      id: "studio",
      label: "Studio",
      kind: "ssh",
      status: "online",
      statusMessage: null,
      harnesses: {
        codex: { state: "missing", reason: "codex is not installed on this host." },
        claude: { state: "present", reason: null },
      },
    };
    render(<HostSetupStep hosts={[host]} onAddHost={vi.fn(async () => undefined)} onRemoveHost={vi.fn(async () => undefined)} onContinue={vi.fn()} />);
    expect(screen.getByText("codex missing")).toBeInTheDocument();
    expect(screen.getByText("claude present")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to new thread" })).toBeEnabled();
  });

  it("removes a configured host in-app and reports removal failures locally", async () => {
    const host: SetupHostProbe = {
      id: "studio",
      label: "Studio",
      kind: "ssh",
      status: "offline",
      statusMessage: "SSH authentication failed.",
      harnesses: {
        codex: { state: "unavailable", reason: "Host is offline." },
        claude: { state: "unavailable", reason: "Host is offline." },
      },
    };
    let failRemoval!: (error: Error) => void;
    const onRemoveHost = vi.fn(() => new Promise<void>((_resolve, reject) => { failRemoval = reject; }));
    render(<HostSetupStep
      hosts={[host]}
      onAddHost={vi.fn(async () => undefined)}
      onRemoveHost={onRemoveHost}
      standalone
    />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Studio" }));
    expect(onRemoveHost).not.toHaveBeenCalled();
    expect(screen.getByText("Forget this host and its remembered workspaces?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel removal of Studio" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal of Studio" }));
    expect(onRemoveHost).toHaveBeenCalledWith("studio");
    expect(await screen.findByRole("button", { name: "Removing Studio" })).toBeDisabled();
    failRemoval(new Error("That host is still being removed elsewhere."));

    expect(await screen.findByRole("alert")).toHaveTextContent("That host is still being removed elsewhere.");
    expect(screen.getByRole("button", { name: "Confirm removal of Studio" })).toBeEnabled();
  });
});
