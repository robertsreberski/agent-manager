import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SetupHookOffer, SetupHostProbe } from "../../../../src/shared/setup.ts";
import type { SelectedSessionFactsResponse } from "../../../../src/shared/session-facts.ts";
import type { CockpitSessionView } from "../../lib/cockpit-view";
import { EmptyState, FirstRun, HookSetupStep, HostSetupStep, SessionCapabilityPanel, SessionEndedState } from "./SystemStates";

function hook(provider: "claude" | "codex", overrides: Partial<SetupHookOffer> = {}): SetupHookOffer {
  return {
    provider,
    state: "absent",
    settingsPath: `/Users/me/.${provider}/settings.json`,
    command: `agent-manager hooks install --provider ${provider} --scope user`,
    changed: true,
    diff: `--- before\n+++ after\n+Authorization: Bearer [REDACTED]`,
    notice: null,
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
      capabilities: ["queue", "set-profile", "attach"],
      withheld: [{ capability: "set-model", reason: "This provider cannot change models mid-session." }],
    },
    profile: "execute",
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
  it("loads the exact resume wrapper before offering a new worktree thread", () => {
    const onResume = vi.fn();
    const onContinue = vi.fn();
    const { rerender } = render(<SessionEndedState canResume canContinue onResume={onResume} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Show resume command" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Start a new thread in this worktree" })).toBeInTheDocument();

    rerender(<SessionEndedState canResume canContinue resumeCommand="agent-manager attach guarded-token" resumeDescription="Resume the same provider session." onResume={onResume} onContinue={onContinue} />);
    expect(screen.getByText("agent-manager attach guarded-token")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show resume command" })).not.toBeInTheDocument();
  });

  it("does not imply resume when the harness withdrew it", () => {
    render(<SessionEndedState canResume={false} canContinue resumeUnavailableReason="Resume is unavailable because the provider queue did not drain." />);

    expect(screen.queryByRole("button", { name: "Show resume command" })).not.toBeInTheDocument();
    expect(screen.getByText("Resume is unavailable because the provider queue did not drain.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a new thread in this worktree" })).toBeInTheDocument();
  });
});

describe("SessionCapabilityPanel", () => {
  it("renders the four ordered questions from truthful session and Codex facts", () => {
    render(<SessionCapabilityPanel session={cockpitSession()} facts={facts} factsStatus="loaded" attachCommand={null} onRevealAttach={vi.fn()} />);

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Where it runs",
      "What it may do",
      "What this turn cost",
      "How to attach from a terminal",
    ]);
    const rendered = document.body.textContent ?? "";
    for (const text of ["This Mac", "project", "/workspace/project-worktree", "feature/session-facts", "3 files · +312 −87 uncommitted", "Codex managed app server", "Queue messages for the next turn", "This provider cannot change models mid-session.", "150", "$0.0123", "12.3K lifetime tokens", "25% used"]) expect(rendered).toContain(text);
    expect(screen.queryByText("codex-private")).not.toBeInTheDocument();
    expect(screen.queryByText("danger-full-access")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show guarded attach command" })).toBeInTheDocument();
  });

  it("keeps unknown facts unknown and never calls a zero-dirty worktree dirty", () => {
    const { rerender } = render(<SessionCapabilityPanel
      session={cockpitSession({ workspaceIdentity: null, cwd: null, profile: null, model: null, effort: null, control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [] } })}
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

  it("reveals and copies only the guarded manager wrapper", () => {
    const onRevealAttach = vi.fn();
    const { rerender } = render(<SessionCapabilityPanel session={cockpitSession()} facts={facts} factsStatus="loaded" onRevealAttach={onRevealAttach} />);
    fireEvent.click(screen.getByRole("button", { name: "Show guarded attach command" }));
    expect(onRevealAttach).toHaveBeenCalledOnce();

    rerender(<SessionCapabilityPanel session={cockpitSession()} facts={facts} factsStatus="loaded" attachCommand="agent-manager attach opaque-handoff" onRevealAttach={onRevealAttach} />);
    expect(screen.getByText("agent-manager attach opaque-handoff")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy guarded attach command" })).toBeInTheDocument();
    expect(screen.queryByText(/codex app-server|claude --resume/u)).not.toBeInTheDocument();
  });
});

describe("first-run setup", () => {
  it("shows absent hook status, exact CLI commands and redacted diffs without a browser apply action", () => {
    const onContinue = vi.fn();
    render(<HookSetupStep
      hooks={{ claude: hook("claude"), codex: hook("codex") }}
      onContinue={onContinue}
    />);

    expect(screen.getAllByText("Not installed")).toHaveLength(2);
    expect(screen.getByText("agent-manager hooks install --provider claude --scope user")).toBeInTheDocument();
    expect(screen.getAllByText(/Bearer \[REDACTED\]/u)).toHaveLength(2);
    expect(screen.getByText(/This browser never changes provider settings/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply|install/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue without changing settings" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("names the region the settings-diff disclosure controls and collapses it", () => {
    render(<HookSetupStep hooks={{ claude: hook("claude"), codex: hook("codex") }} standalone />);
    const [disclosure] = screen.getAllByRole("button", { name: "Exact redacted settings diff" });
    if (!disclosure) throw new Error("Missing settings diff disclosure");

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const controls = disclosure.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)?.textContent).toContain("Bearer [REDACTED]");

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).not.toHaveAttribute("aria-controls");
    expect(screen.getAllByText(/Bearer \[REDACTED\]/u)).toHaveLength(1);
  });

  it("drops the wizard framing when reached outside first run, keeping the same read-only facts", () => {
    render(<HookSetupStep hooks={{ claude: hook("claude"), codex: hook("codex") }} standalone />);

    expect(screen.queryByText("Optional setup · 2 of 3")).not.toBeInTheDocument();
    expect(screen.getByText("Provider hooks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue without changing settings" })).not.toBeInTheDocument();
    expect(screen.getByText("agent-manager hooks install --provider claude --scope user")).toBeInTheDocument();
    expect(screen.getByText(/This browser never changes provider settings/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply|install/u })).not.toBeInTheDocument();
  });

  it("drops the wizard framing on the standalone host step", () => {
    render(<HostSetupStep hosts={[]} standalone />);

    expect(screen.queryByText("Optional setup · 3 of 3")).not.toBeInTheDocument();
    expect(screen.getByText("Remote hosts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to new thread" })).not.toBeInTheDocument();
    expect(screen.getByText(/No remote hosts are configured/u)).toBeInTheDocument();
  });

  it("reports current hooks without an install action", () => {
    render(<HookSetupStep
      hooks={{
        claude: hook("claude", { state: "active", changed: false, diff: "" }),
        codex: hook("codex", { state: "awaiting-trust", changed: false, diff: "" }),
      }}
      onContinue={vi.fn()}
    />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Installed · awaiting Codex trust")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install/u })).not.toBeInTheDocument();
    expect(screen.getAllByText("No settings change needed")).toHaveLength(2);
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
    render(<HostSetupStep hosts={[host]} onContinue={vi.fn()} />);
    expect(screen.getByText("codex missing")).toBeInTheDocument();
    expect(screen.getByText("claude present")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to new thread" })).toBeEnabled();
  });
});
