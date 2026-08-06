import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupHookOffer, SetupReadModel } from "../../src/shared/setup.ts";
import type { SessionActivityView, SessionView } from "./types";

const selectedSession = {
  id: "local:codex:thread-1",
  provider: "codex",
  providerThreadId: "thread-1",
  providerTurnId: null,
  name: "Observed thread",
  hostId: "local",
  hostLabel: "This Mac",
  cwd: "/work/app",
  status: "idle",
  updatedAt: "2026-08-04T12:00:00.000Z",
  generation: 4,
  todoProgress: null,
  attention: [] as SessionView["attention"],
  profile: { value: "execute" },
  sandbox: { value: null },
  model: { value: "gpt-live" },
  effort: { value: "high" },
  workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app", linked: false, branch: "main", detached: false, dirtyCount: null, ahead: null, behind: null },
  control: {
    plane: "observe-only",
    authority: "none",
    coordination: { mode: "observe-only", nativeAttach: "none", responseResolution: "single-controller" },
    recovery: null,
    capabilities: ["open-editor"],
    withheld: [{ capability: "queue", reason: "This terminal-started session has no hook bridge." }],
    takeover: null,
  },
} as SessionView;

const activity: SessionActivityView = {
  sessionId: selectedSession.id,
  items: [],
  truncated: false,
  streamEpoch: null,
  cursor: null,
  seq: null,
  connection: "open",
  updateCount: 0,
};

function hookOffer(provider: "claude"): SetupHookOffer {
  return {
    provider,
    state: "absent",
    settingsPath: `/Users/me/.${provider}/settings.json`,
    command: `agent-manager hooks install --provider ${provider} --scope user`,
    changed: true,
    diff: "--- before\n+++ after\n+Authorization: Bearer [REDACTED]",
    notice: null,
    previewId: provider === "claude" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    expiresAt: "2026-08-04T10:05:00.000Z",
  };
}

const setupModel: SetupReadModel = {
  nearby: [],
  hooks: { claude: hookOffer("claude") },
  hosts: [],
};

const loadSetup = vi.fn(async () => setupModel);

const cockpit = {
  ready: true,
  actor: "operator",
  authError: null,
  availability: "online",
  snapshot: { stale: false, generatedAt: "2026-08-04T12:00:00.000Z", diagnostics: [], seq: 1 },
  sessions: [selectedSession],
  displaySessions: [selectedSession],
  archivedCatalog: { items: [] as SessionView[], query: "", nextCursor: null as string | null, total: 0, status: "loaded" as "idle" | "loading" | "loaded" | "error", error: null as string | null },
  searchArchived: vi.fn(async () => undefined),
  loadMoreArchived: vi.fn(async () => undefined),
  selectedSession,
  selectedId: selectedSession.id,
  setSelectedId: vi.fn(),
  closeSelected: vi.fn(async () => undefined),
  scope: "all",
  setScope: vi.fn(),
  hostFilter: new Set<string>(),
  setHostFilter: vi.fn(),
  connection: "open",
  mutationsReady: true,
  hosts: [{ id: "local", label: "This Mac", kind: "local", status: "online" }],
  workspaces: [],
  busy: {},
  notice: null,
  clearNotice: vi.fn(),
  actionError: null,
  clearActionError: vi.fn(),
  refresh: vi.fn(async () => undefined),
  retryConnection: vi.fn(async () => true),
  controlConflict: undefined,
  takeOverControl: vi.fn(async () => undefined),
  hasBusyAction: false,
  sendMessage: vi.fn(async () => undefined),
  respond: vi.fn(async () => undefined),
  interrupt: vi.fn(async () => undefined),
  setProfile: vi.fn(async () => undefined),
  setModel: vi.fn(async () => undefined),
  setEffort: vi.fn(async () => undefined),
  removeQueued: vi.fn(async () => undefined),
  lifecycleAction: vi.fn(async () => undefined),
  openEditor: vi.fn(async () => undefined),
  takeCliControl: vi.fn(async () => undefined),
  cancelCliTakeover: vi.fn(async () => undefined),
  retryControl: vi.fn(async () => undefined),
  createSession: vi.fn(async () => selectedSession),
  completeWorkspacePath: vi.fn(async () => []),
  loadPreview: vi.fn(async () => undefined),
  loadAttach: vi.fn(async () => undefined),
  loadAttentionDetails: vi.fn(async () => undefined),
  loadTodoDetail: vi.fn(async () => undefined),
  searchTranscript: vi.fn(async () => ({ matches: [] })),
  loadWorkspaceFiles: vi.fn(async () => []),
  loadSettingsOptions: vi.fn(async () => undefined),
  loadProviderSettingsOptions: vi.fn(async () => ({
    available: true as const,
    source: "provider-api" as const,
    models: [{ value: "gpt-live", label: "GPT Live", description: null, efforts: ["low", "medium", "high", "max"] as const }],
  })),
  loadSessionFacts: vi.fn(async () => undefined),
  loadPlanFile: vi.fn(async () => undefined),
  loadSetup,
  applySetupHook: vi.fn(async (provider: "claude") => ({
    provider,
    outcome: "applied" as const,
    hook: { ...hookOffer(provider), changed: false, diff: "", previewId: null, expiresAt: null },
  })),
  addHost: vi.fn(async () => ({ id: "studio", label: "Studio", kind: "ssh" as const, sshTarget: "studio", status: "connecting" as const, statusMessage: null })),
  removeHost: vi.fn(async () => undefined),
  outbox: [],
  offlineReview: [],
  dismissOfflineReview: vi.fn(),
};

vi.mock("./hooks/use-cockpit", () => ({
  BROWSER_CLIENT_ID: "web-test-client",
  useCockpit: () => cockpit,
}));
vi.mock("./hooks/use-session-activity", () => ({ useSessionActivity: () => activity }));
// The shell layout, not the thread body, is under test here. The runtime
// provider is stubbed as a pass-through so the assertions below still see the
// drawer as a direct child of the board region — which is the point: neither
// the runtime nor the viewport store may put an element between them.
vi.mock("./components/session-thread", () => ({
  SessionRuntimeProvider: ({ children }: { children: (ref: () => void) => React.ReactNode }) => children(() => undefined),
  SessionThread: () => null,
  SessionThreadComposer: () => null,
}));

const { default: App } = await import("./App");

describe("cockpit shell layout", () => {
  beforeEach(() => {
    loadSetup.mockClear();
    cockpit.applySetupHook.mockClear();
    cockpit.addHost.mockClear();
    cockpit.removeHost.mockClear();
    cockpit.loadProviderSettingsOptions.mockClear();
    cockpit.loadSettingsOptions.mockClear();
    cockpit.closeSelected.mockClear();
    cockpit.setScope.mockClear();
  });

  it("overlays the drawer on the board region instead of the whole page", () => {
    render(<App />);

    const header = document.querySelector("[data-header-primary]")!.closest("header")!;
    const region = document.querySelector<HTMLElement>("[data-board-region]");
    const drawer = document.querySelector<HTMLElement>("[data-thread-drawer]");
    expect(region).not.toBeNull();
    expect(drawer).not.toBeNull();

    // `absolute inset-y-0` resolves against the nearest positioned ancestor, so
    // the drawer must live inside a positioned board region.
    expect(region).toContainElement(drawer);
    expect(drawer!.parentElement).toBe(region);
    expect(region!.className).toContain("relative");

    // The header must never share a parent with the drawer: as siblings the
    // full-height overlay covers every header control.
    expect(region).not.toContainElement(header);
    expect([...header.parentElement!.children]).not.toContain(drawer);
    expect(drawer!.parentElement).not.toBe(header.parentElement);

    // The board stays mounted and un-shifted underneath the overlay.
    expect(region).toContainElement(document.querySelector<HTMLElement>("[data-desktop-board]"));
  });

  it("renders the archived catalog as a separate searchable read-only scope", () => {
    const previous = {
      sessions: cockpit.sessions,
      displaySessions: cockpit.displaySessions,
      selectedSession: cockpit.selectedSession,
      scope: cockpit.scope,
      archivedCatalog: cockpit.archivedCatalog,
    };
    const archived = {
      ...selectedSession,
      archived: true,
      status: "completed",
      control: { plane: "observe-only", authority: "none", coordination: { mode: "observe-only", nativeAttach: "none", responseResolution: "single-controller" }, recovery: null, capabilities: [], withheld: [], peers: [], takeover: null },
    } as SessionView;
    cockpit.sessions = [];
    cockpit.displaySessions = [archived];
    cockpit.selectedSession = archived;
    cockpit.scope = "archived";
    cockpit.archivedCatalog = { items: [archived], query: "", nextCursor: "next", total: 51, status: "loaded", error: null };
    try {
      render(<App />);
      expect(screen.getByRole("button", { name: "Archived, 51 sessions" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("searchbox", { name: "Search archived sessions" })).toBeInTheDocument();
      expect(screen.getAllByText("Observed thread").length).toBeGreaterThan(0);
      expect(screen.getByText("Archived · read-only")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New thread here" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(cockpit.loadMoreArchived).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: /^All,/u }));
      expect(cockpit.closeSelected).toHaveBeenCalledOnce();
      expect(cockpit.setScope).toHaveBeenCalledWith("all");
    } finally {
      cockpit.sessions = previous.sessions;
      cockpit.displaySessions = previous.displaySessions;
      cockpit.selectedSession = previous.selectedSession;
      cockpit.scope = previous.scope;
      cockpit.archivedCatalog = previous.archivedCatalog;
    }
  });

  it("renders archive load failures as failures with an explicit retry", () => {
    const previous = {
      sessions: cockpit.sessions,
      displaySessions: cockpit.displaySessions,
      selectedSession: cockpit.selectedSession,
      scope: cockpit.scope,
      archivedCatalog: cockpit.archivedCatalog,
    };
    cockpit.sessions = [];
    cockpit.displaySessions = [];
    cockpit.selectedSession = null as unknown as SessionView;
    cockpit.scope = "archived";
    cockpit.archivedCatalog = { items: [], query: "needle", nextCursor: null, total: 0, status: "error", error: "Archive index is temporarily unavailable." };
    try {
      render(<App />);
      expect(screen.getByRole("heading", { name: "Archived sessions unavailable" })).toBeInTheDocument();
      expect(screen.queryByText("No archived sessions match")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(cockpit.searchArchived).toHaveBeenCalledWith("needle");
    } finally {
      cockpit.sessions = previous.sessions;
      cockpit.displaySessions = previous.displaySessions;
      cockpit.selectedSession = previous.selectedSession;
      cockpit.scope = previous.scope;
      cockpit.archivedCatalog = previous.archivedCatalog;
    }
  });

  it("closes and releases the active drawer before entering Archived", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Archived,/u }));

    expect(cockpit.closeSelected).toHaveBeenCalledOnce();
    expect(cockpit.setScope).toHaveBeenCalledWith("archived");
  });

  it("reloads manager model settings when recovery completes", async () => {
    const previous = {
      sessions: cockpit.sessions,
      displaySessions: cockpit.displaySessions,
      selectedSession: cockpit.selectedSession,
    };
    const recovering = {
      ...selectedSession,
      control: {
        ...selectedSession.control,
        plane: "codex-private",
        authority: "manager",
        coordination: { mode: "shared", nativeAttach: "join", responseResolution: "first-response-wins" },
        recovery: {
          state: "reconnecting",
          attempt: 1,
          startedAt: "2026-08-05T10:00:00.000Z",
          deadlineAt: "2026-08-05T10:00:30.000Z",
          nextRetryAt: null,
          error: null,
        },
      },
    } as SessionView;
    const recovered = {
      ...recovering,
      control: { ...recovering.control, recovery: null },
    } as SessionView;
    cockpit.sessions = [recovering];
    cockpit.displaySessions = [recovering];
    cockpit.selectedSession = recovering;
    try {
      const { rerender } = render(<App />);
      await waitFor(() => expect(cockpit.loadSettingsOptions).toHaveBeenCalledTimes(1));

      cockpit.sessions = [recovered];
      cockpit.displaySessions = [recovered];
      cockpit.selectedSession = recovered;
      rerender(<App />);

      await waitFor(() => expect(cockpit.loadSettingsOptions).toHaveBeenCalledTimes(2));
    } finally {
      cockpit.sessions = previous.sessions;
      cockpit.displaySessions = previous.displaySessions;
      cockpit.selectedSession = previous.selectedSession;
    }
  });

  it("reaches hook and host setup from the palette once the board exists", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Search sessions and commands" }));
    fireEvent.click(await screen.findByRole("option", { name: /Setup and integrations/u }));

    const dialog = await screen.findByRole("dialog", { name: "Setup and integrations" });
    expect(loadSetup).toHaveBeenCalled();
    expect(dialog).toHaveTextContent(/Hooks add exact live activity and surface held approvals or questions/iu);
    expect(dialog).toHaveTextContent(/Sending new messages still requires provider control/iu);
    expect(dialog).toHaveTextContent(/Bearer \[REDACTED\]/u);
    expect(dialog).toHaveTextContent(/install it directly from Agent Manager/u);
    expect(screen.getByRole("button", { name: "Install claude hook" })).toBeEnabled();
    expect(screen.queryByText("agent-manager hooks install --provider claude --scope user")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Advanced · manual installation" })[0]!);
    expect(screen.getByText("agent-manager hooks install --provider claude --scope user")).toBeInTheDocument();
    expect(screen.queryByText(/Optional setup · 2 of 3/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue without installing hooks" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close setup and integrations" }));
    expect(screen.queryByRole("dialog", { name: "Setup and integrations" })).not.toBeInTheDocument();
  });

  it("confirms remote-host removal before closing a drawer on that host", async () => {
    const previous = {
      sessions: cockpit.sessions,
      displaySessions: cockpit.displaySessions,
      selectedSession: cockpit.selectedSession,
      hosts: cockpit.hosts,
    };
    const remoteSession = { ...selectedSession, id: "studio:codex:thread-1", hostId: "studio", hostLabel: "Studio" } as SessionView;
    cockpit.sessions = [remoteSession];
    cockpit.displaySessions = [remoteSession];
    cockpit.selectedSession = remoteSession;
    cockpit.hosts = [{ id: "studio", label: "Studio", kind: "ssh", status: "online" }];
    loadSetup.mockResolvedValue({
      ...setupModel,
      hosts: [{
        id: "studio",
        label: "Studio",
        kind: "ssh",
        status: "online",
        statusMessage: null,
        harnesses: {
          codex: { state: "present", reason: null },
          claude: { state: "present", reason: null },
        },
      }],
    });
    try {
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Search sessions and commands" }));
      fireEvent.click(await screen.findByRole("option", { name: /Setup and integrations/u }));
      await screen.findByRole("dialog", { name: "Setup and integrations" });

      fireEvent.click(screen.getByRole("button", { name: "Remove Studio" }));
      expect(cockpit.removeHost).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirm removal of Studio" }));

      await waitFor(() => expect(cockpit.removeHost).toHaveBeenCalledWith("studio"));
      await waitFor(() => expect(cockpit.closeSelected).toHaveBeenCalledOnce());
    } finally {
      cockpit.sessions = previous.sessions;
      cockpit.displaySessions = previous.displaySessions;
      cockpit.selectedSession = previous.selectedSession;
      cockpit.hosts = previous.hosts;
      loadSetup.mockResolvedValue(setupModel);
    }
  });
});

/*
  `cockpitContentMode` returns "board" as soon as one session exists, so an
  operator whose only sessions were started in a terminal never met the first-run
  hook step and never learned that hooks add exact live activity to such a session.
  And because adding a hook edits a settings file — which emits no provider
  event — nothing tells this browser the state has changed.
*/
describe("reaching hooks from an observation-only board", () => {
  beforeEach(() => {
    loadSetup.mockClear();
    cockpit.loadProviderSettingsOptions.mockClear();
    vi.useRealTimers();
  });

  it("reads model capabilities, but not setup copy, for an observation-only session", async () => {
    render(<App />);

    await waitFor(() => expect(cockpit.loadProviderSettingsOptions).toHaveBeenCalledWith("codex", "local"));
    expect(loadSetup).not.toHaveBeenCalled();
  });

  async function openSetupDialog() {
    fireEvent.click(screen.getByRole("button", { name: "Search sessions and commands" }));
    fireEvent.click(await screen.findByRole("option", { name: /Setup and integrations/u }));
    await screen.findByRole("dialog", { name: "Setup and integrations" });
    await waitFor(() => expect(loadSetup).toHaveBeenCalled());
    return loadSetup.mock.calls.length;
  }

  it("re-reads an unfinished hook while its dialog is open, so the state moves without a restart", async () => {
    // The clock has to be fake before the component schedules on it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    const afterOpen = await openSetupDialog();

    await vi.advanceTimersByTimeAsync(9_000);

    expect(loadSetup.mock.calls.length).toBeGreaterThan(afterOpen);
  });

  it("applies the exact hook preview and refreshes setup facts in place", async () => {
    render(<App />);
    const afterOpen = await openSetupDialog();

    fireEvent.click(screen.getByRole("button", { name: "Install claude hook" }));

    await waitFor(() => expect(cockpit.applySetupHook).toHaveBeenCalledWith("claude", "11111111-1111-4111-8111-111111111111"));
    await waitFor(() => expect(loadSetup.mock.calls.length).toBeGreaterThan(afterOpen));
  });

  it("stops re-reading once every hook has settled", async () => {
    loadSetup.mockResolvedValue({
      ...setupModel,
      hooks: {
        claude: { ...hookOffer("claude"), state: "active", changed: false, diff: "", previewId: null, expiresAt: null },
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    const afterOpen = await openSetupDialog();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(loadSetup.mock.calls.length).toBe(afterOpen);
    loadSetup.mockResolvedValue(setupModel);
  });

  it("gives up rather than polling a hook the operator never finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await openSetupDialog();

    // Fifteen probes at eight seconds is two minutes, under the endpoint's
    // ten-reads-a-minute budget the whole way. Left uncapped, a dialog someone
    // walked away from would read forever.
    await vi.advanceTimersByTimeAsync(8_000 * 60);

    expect(loadSetup.mock.calls.length).toBeLessThanOrEqual(17);
  });
});
