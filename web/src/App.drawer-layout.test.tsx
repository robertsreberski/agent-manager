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
  model: { value: "gpt-live" },
  effort: { value: "high" },
  workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app", linked: false, branch: "main", detached: false, dirtyCount: null, ahead: null, behind: null },
  control: {
    plane: "observe-only",
    authority: "none",
    capabilities: ["open-editor"],
    withheld: [{ capability: "queue", reason: "This terminal-started session has no hook bridge." }],
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

function hookOffer(provider: "claude" | "codex"): SetupHookOffer {
  return {
    provider,
    state: "absent",
    settingsPath: `/Users/me/.${provider}/settings.json`,
    command: `agent-manager hooks install --provider ${provider} --scope user`,
    changed: true,
    diff: "--- before\n+++ after\n+Authorization: Bearer [REDACTED]",
    notice: null,
  };
}

const setupModel: SetupReadModel = {
  nearby: [],
  hooks: { claude: hookOffer("claude"), codex: hookOffer("codex") },
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
  createSession: vi.fn(async () => selectedSession),
  completeWorkspacePath: vi.fn(async () => []),
  loadPreview: vi.fn(async () => undefined),
  loadAttach: vi.fn(async () => undefined),
  loadAttentionDetails: vi.fn(async () => undefined),
  loadTodoDetail: vi.fn(async () => undefined),
  searchTranscript: vi.fn(async () => ({ matches: [] })),
  loadSettingsOptions: vi.fn(async () => undefined),
  loadProviderSettingsOptions: vi.fn(async () => undefined),
  loadSessionFacts: vi.fn(async () => undefined),
  loadPlanFile: vi.fn(async () => undefined),
  loadSetup,
  outbox: [],
  offlineReview: [],
  dismissOfflineReview: vi.fn(),
};

vi.mock("./hooks/use-cockpit", () => ({
  BROWSER_CLIENT_ID: "web-test-client",
  useCockpit: () => cockpit,
}));
vi.mock("./hooks/use-session-activity", () => ({ useSessionActivity: () => activity }));
// The shell layout, not the thread body, is under test here.
vi.mock("./components/session-thread", () => ({
  SessionThread: () => null,
  SessionThreadComposer: () => null,
}));

const { default: App } = await import("./App");

describe("cockpit shell layout", () => {
  beforeEach(() => {
    loadSetup.mockClear();
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

  it("reaches hook and host setup from the palette once the board exists", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Search sessions and commands" }));
    fireEvent.click(await screen.findByRole("option", { name: /Setup and integrations/u }));

    const dialog = await screen.findByRole("dialog", { name: "Setup and integrations" });
    expect(loadSetup).toHaveBeenCalled();
    await waitFor(() => expect(dialog).toHaveTextContent("agent-manager hooks install --provider claude --scope user"));
    expect(dialog).toHaveTextContent(/Bearer \[REDACTED\]/u);
    expect(dialog).toHaveTextContent(/This browser never changes provider settings/u);
    expect(screen.queryByRole("button", { name: /install|apply/iu })).not.toBeInTheDocument();
    expect(screen.queryByText(/Optional setup · 2 of 3/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue without changing settings" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close setup and integrations" }));
    expect(screen.queryByRole("dialog", { name: "Setup and integrations" })).not.toBeInTheDocument();
  });
});
