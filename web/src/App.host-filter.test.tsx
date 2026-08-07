import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  boardScrollBehavior,
  cockpitContentMode,
  modelCatalogEfforts,
  effectiveDraftHostId,
  Header,
  hostSelectionSummary,
  CockpitToast,
  NotificationSettings,
  notificationAwaySince,
  settingsUnavailableMessage,
  SetupDialog,
  shouldRetrySettingsLookup,
} from "./App";
import { composerEffortOptions } from "./lib/model-catalog";

describe("hostSelectionSummary", () => {
  it("describes the empty filter as the truthful default-all state", () => {
    expect(hostSelectionSummary(["local"], new Set())).toBe("All hosts selected");
    expect(hostSelectionSummary(["local", "remote"], new Set())).toBe("All hosts selected");
  });

  it("counts only known explicit selections", () => {
    expect(hostSelectionSummary(["local", "remote"], new Set(["local"]))).toBe("1 of 2 hosts selected");
    expect(hostSelectionSummary(["local"], new Set(["stale-host"]))).toBe("No hosts selected");
    expect(hostSelectionSummary([], new Set())).toBe("No hosts available");
  });
});

describe("CockpitToast", () => {
  it("offers takeover only for an actual writer conflict and never replays the losing action", () => {
    const onTakeOver = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(<CockpitToast actionError="Action failed" notice={null} canTakeOver={false} onTakeOver={onTakeOver} onDismiss={onDismiss} />);
    expect(screen.queryByRole("button", { name: "Use here" })).not.toBeInTheDocument();

    rerender(<CockpitToast actionError="Another browser window is steering this session." notice={null} canTakeOver onTakeOver={onTakeOver} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Use here" }));
    expect(onTakeOver).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<CockpitToast actionError={null} notice="Message held locally until the cockpit reconnects." canTakeOver onTakeOver={onTakeOver} onDismiss={onDismiss} />);
    expect(screen.queryByRole("button", { name: "Use here" })).not.toBeInTheDocument();
  });
});

describe("notificationAwaySince", () => {
  it("never treats an untouched visible page as away", () => {
    expect(notificationAwaySince("visible", 1_000)).toBeNull();
    expect(notificationAwaySince("hidden", 1_000)).toBe(1_000);
  });
});

describe("cockpit presentation contracts", () => {
  it("loads draft settings for the workspace host, otherwise the local default", () => {
    const hosts = [
      { id: "build", kind: "ssh" as const },
      { id: "local-main", kind: "local" as const },
    ];
    expect(effectiveDraftHostId({ workspace: { hostId: "build", path: "/srv/repo", worktree: { kind: "none" } } }, hosts)).toBe("build");
    expect(effectiveDraftHostId({ workspace: null }, hosts)).toBe("local-main");
    expect(effectiveDraftHostId({ workspace: null }, [{ id: "build", kind: "ssh" }])).toBe("build");
    expect(effectiveDraftHostId({ workspace: null }, [])).toBe("local");
    expect(effectiveDraftHostId(null, hosts)).toBeNull();
  });

  it("explains that draft model discovery is unavailable on a remote host", () => {
    expect(settingsUnavailableMessage("remote-host")).toBe(
      "Model choices are unavailable when creating a thread on a remote host.",
    );
  });

  it("uses only the selected model's provider-declared efforts for either provider", () => {
    const codex = {
      available: true,
      source: "provider-api",
      models: [
        { value: "codex-default", label: "Default", description: null, isDefault: true, defaultEffort: "high", efforts: ["low", "high"] },
        { value: "codex-deep", label: "Deep", description: null, isDefault: false, defaultEffort: "xhigh", efforts: ["high", "xhigh", "ultra"] },
      ],
    } satisfies NonNullable<Parameters<typeof modelCatalogEfforts>[1]>;
    const claude = {
      available: true,
      source: "provider-api",
      models: [
        { value: "sonnet", label: "Sonnet", description: null, isDefault: true, defaultEffort: "medium", efforts: ["low", "medium", "high"] },
        { value: "opus", label: "Opus", description: null, defaultEffort: "high", efforts: ["medium", "high", "max"] },
      ],
    } satisfies NonNullable<Parameters<typeof modelCatalogEfforts>[1]>;
    expect(modelCatalogEfforts(null, codex)).toEqual(["low", "high"]);
    expect(modelCatalogEfforts("codex-deep", codex)).toEqual(["high", "xhigh", "ultra"]);
    expect(modelCatalogEfforts("opus", claude)).toEqual(["medium", "high", "max"]);
    expect(modelCatalogEfforts("missing", codex)).toEqual([]);

    // A catalog that marks no default leaves nothing covering a null model —
    // Claude's does not, since its ModelInfo declares none. The levels every
    // row agrees on hold whichever model the provider then picks, so a fresh
    // draft still has an effort control rather than none at all.
    const unmarked = {
      available: true,
      source: "provider-api",
      models: [
        { value: "sonnet", label: "Sonnet", description: null, efforts: ["low", "medium", "high"] },
        { value: "opus", label: "Opus", description: null, efforts: ["medium", "high", "max"] },
      ],
    } satisfies NonNullable<Parameters<typeof modelCatalogEfforts>[1]>;
    expect(modelCatalogEfforts(null, unmarked)).toEqual(["medium", "high"]);
    // A model that is named but absent is unknown, not unspecified.
    expect(modelCatalogEfforts("haiku", unmarked)).toEqual([]);
  });

  it("lets a model that declares no efforts abstain rather than veto the catalog", () => {
    /*
      The real Claude catalog's shape: no row marks itself default, and `haiku`
      declares no efforts at all because its ModelInfo sets no `supportsEffort`,
      so `claudeModelOption` omits the field. Counting that silence as a vote
      for zero levels emptied the intersection and left a fresh Claude draft
      with no effort control and a meter reading "Unknown".
    */
    const claude = {
      available: true,
      source: "provider-api",
      models: [
        { value: "default", label: "Default", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
        { value: "opus[1m]", label: "Opus", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
        { value: "sonnet", label: "Sonnet", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
        { value: "haiku", label: "Haiku", description: null },
      ],
    } satisfies NonNullable<Parameters<typeof modelCatalogEfforts>[1]>;
    expect(modelCatalogEfforts(null, claude)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The abstaining row is still unknown when named outright: it declared
    // nothing, and nothing is what it borrows from the rows that did.
    expect(modelCatalogEfforts("haiku", claude)).toEqual([]);

    // Every row abstaining leaves the catalog with nothing to say. The
    // composer's capability-gated vocabulary fallback covers that case.
    const silent = {
      available: true,
      source: "provider-api",
      models: [
        { value: "one", label: "One", description: null },
        { value: "two", label: "Two", description: null },
      ],
    } satisfies NonNullable<Parameters<typeof modelCatalogEfforts>[1]>;
    expect(modelCatalogEfforts(null, silent)).toEqual([]);
  });

  it("carries the real Claude catalog through to a draft's effort control", () => {
    /*
      The whole path the bug ran down, in one assertion: the catalog the SDK
      actually returns (measured — `haiku` reports `supportsEffort: undefined`
      and `supportedEffortLevels: null`, the other four declare all five levels),
      through the catalog reader, into the resolver the composer offers from.
      Either half alone looked correct; only the composition rendered nothing.
    */
    const live = {
      available: true,
      source: "provider-api",
      models: [
        { value: "default", label: "Default", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
        { value: "opus[1m]", label: "Opus", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
        { value: "claude-fable-5[1m]", label: "Fable", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
        { value: "sonnet", label: "Sonnet", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
        { value: "haiku", label: "Haiku", description: null },
      ],
    } satisfies NonNullable<Parameters<typeof modelCatalogEfforts>[1]>;
    const offered = composerEffortOptions("claude", modelCatalogEfforts(null, live), true);
    expect(offered).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Non-empty is the property the control actually gates on: `ModelSelector`
    // returns null for an empty set, which is how the meter read "Unknown".
    expect(offered.length).toBeGreaterThan(0);
  });

  it("matches a session's wire model id to the alias row that resolves to it", () => {
    const claude = {
      available: true,
      source: "provider-api",
      models: [
        { value: "sonnet", label: "Sonnet", description: null, resolvedModel: "claude-sonnet-5", efforts: ["low", "medium", "high"] },
        { value: "opus", label: "Opus", description: null, resolvedModel: "claude-opus-5", efforts: ["medium", "high", "max"] },
      ],
    } satisfies NonNullable<Parameters<typeof modelCatalogEfforts>[1]>;
    expect(modelCatalogEfforts("claude-opus-5", claude)).toEqual(["medium", "high", "max"]);
    // An exact `value` match still wins over any alias resolution.
    expect(modelCatalogEfforts("sonnet", claude)).toEqual(["low", "medium", "high"]);
    expect(modelCatalogEfforts("claude-haiku-4-5", claude)).toEqual([]);
  });

  it("retries a failed catalog lookup only on the running-to-settled edge", () => {
    const error = { state: "error", response: null } as const;
    const unavailable: Parameters<typeof shouldRetrySettingsLookup>[2] = {
      state: "loaded",
      response: { available: false, reason: "provider-unavailable", models: [] },
    };
    expect(shouldRetrySettingsLookup("running", "idle", error)).toBe(true);
    expect(shouldRetrySettingsLookup("running", "waiting", unavailable)).toBe(true);
    // A repeated failure while settled never loops — it waits for the next edge.
    expect(shouldRetrySettingsLookup("idle", "idle", error)).toBe(false);
    // A fresh selection has no edge; the primary lookup owns that load.
    expect(shouldRetrySettingsLookup(null, "idle", error)).toBe(false);
    expect(shouldRetrySettingsLookup("running", "running", error)).toBe(false);
    expect(shouldRetrySettingsLookup("running", "idle", null)).toBe(false);
    expect(shouldRetrySettingsLookup("running", "idle", { state: "loading", response: null })).toBe(false);
    expect(shouldRetrySettingsLookup("running", "idle", {
      state: "loaded",
      response: { available: true, source: "provider-api", models: [] },
    })).toBe(false);
    // Structural refusals are facts about the session, not transient weather.
    expect(shouldRetrySettingsLookup("running", "idle", {
      state: "loaded",
      response: { available: false, reason: "not-manager-owned", models: [] },
    })).toBe(false);
  });

  it("separates a configured empty cockpit from genuine first run", () => {
    expect(cockpitContentMode(0, 0)).toBe("first-run");
    expect(cockpitContentMode(0, 2)).toBe("empty");
    expect(cockpitContentMode(1, 0)).toBe("board");
  });

  it("turns off JavaScript smooth scrolling when reduced motion is requested", () => {
    expect(boardScrollBehavior(false)).toBe("smooth");
    expect(boardScrollBehavior(true)).toBe("auto");
  });

  it("contains notification settings focus, closes on Escape, and restores its opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open notifications</button>
        {open && <NotificationSettings
          preferences={{ browser: true, blocked: true, finished: true, stalled: true, includeSessionName: false, quiet: false }}
          onChange={vi.fn()}
          onClose={() => setOpen(false)}
        />}
      </>;
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open notifications" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    const close = within(dialog).getByRole("button", { name: "Close notification settings" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(close).toHaveAttribute("data-compact-control");

    // The permission line and the local-only explanation are the honest part of
    // this surface, so they are stated on the panel rather than implied.
    expect(dialog).toHaveTextContent(/permission:/u);
    expect(dialog).toHaveAccessibleDescription(/Local browser notifications only\./u);
    expect(dialog).toHaveTextContent(/There is no push service/u);

    // Focus stays inside the panel while it is up.
    opener.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("reports every notification class with its current delivery and never writes one silently", async () => {
    const onChange = vi.fn();
    render(<NotificationSettings
      preferences={{ browser: true, blocked: true, finished: false, stalled: true, includeSessionName: false, quiet: false }}
      onChange={onChange}
      onClose={vi.fn()}
    />);

    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    const preferences = within(dialog).getAllByRole("checkbox");
    expect(preferences).toHaveLength(6);
    expect(dialog).toHaveTextContent("A session finished");
    expect(dialog).toHaveTextContent("Only after five continuous minutes away");

    // Each class states its real current delivery, so the control and the word
    // beside it can never disagree.
    expect(preferences.map((preference) => preference.getAttribute("aria-checked")))
      .toEqual(["true", "true", "false", "true", "false", "false"]);
    expect(within(dialog).getAllByText("Always")).toHaveLength(3);
    expect(within(dialog).getAllByText("Never")).toHaveLength(3);

    // Clicking the row is clicking the checkbox, and it reports rather than writes.
    fireEvent.click(within(dialog).getByText("A session finished"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ finished: true }));
    expect(preferences[2]).toHaveAttribute("aria-checked", "false");

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Quiet delivery/u }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ quiet: true }));
  });

  it("contains setup focus and offers one retry when the setup facts cannot be read", async () => {
    const onRetry = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open setup</button>
        {open && <SetupDialog
          setup={{ state: "error", value: null, error: "The cockpit is offline." }}
          onAddHost={vi.fn(async () => undefined)}
          onRemoveHost={vi.fn(async () => undefined)}
          onRetry={onRetry}
          onClose={() => setOpen(false)}
        />}
      </>;
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open setup" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "Setup and integrations" });
    const close = within(dialog).getByRole("button", { name: "Close setup and integrations" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(dialog).toHaveTextContent("The cockpit is offline.");
    expect(dialog).toHaveTextContent("Install optional provider integrations and manage remote hosts without leaving the web app.");
    expect(within(dialog).queryByRole("button", { name: /install|apply|write/iu })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Setup and integrations" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});

describe("Header", () => {
  it("renders the accepted two-row desktop hierarchy with visible host filters", () => {
    const onScope = vi.fn();
    const onToggleHost = vi.fn();
    const onPalette = vi.fn();
    const onHelp = vi.fn();
    const onNew = vi.fn();
    render(<Header
      counts={{ all: 5, "wants-you": 2, working: 1, failed: 1, idle: 2, archived: 3 }}
      scope="wants-you"
      hosts={[
        { id: "local", label: "This Mac", kind: "local", status: "online", count: 3 },
        { id: "remote", label: "Build box", kind: "ssh", status: "online", count: 2 },
      ]}
      hostFilter={new Set(["local"])}
      connection="open"
      diagnostics={2}
      onScope={onScope}
      onToggleHost={onToggleHost}
      onPalette={onPalette}
      onHelp={onHelp}
      onNew={onNew}
    />);

    const header = screen.getByRole("banner");
    const primary = header.querySelector<HTMLElement>("[data-header-primary]")!;
    const filters = header.querySelector<HTMLElement>("[data-header-filters]")!;
    expect(primary).toHaveClass("h-[46px]");
    expect(filters).not.toBe(primary);
    expect(within(primary).queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Agent Manager" })).toHaveClass("font-mono", "uppercase", "tracking-[0.14em]");

    const wantsYou = within(filters).getByRole("button", { name: "Wants you, 2 sessions" });
    expect(wantsYou).toHaveAttribute("aria-current", "page");
    expect(wantsYou).toHaveClass("text-[var(--accent)]");
    expect(within(filters).getByRole("navigation", { name: "Session filters" })).toBeInTheDocument();
    expect(within(filters).getByRole("navigation", { name: "Host filters: 1 of 2 hosts selected" })).toBeInTheDocument();

    const local = within(filters).getByRole("button", { name: "This Mac, 3 sessions" });
    const remote = within(filters).getByRole("button", { name: "Build box, 2 sessions" });
    expect(local).toHaveAttribute("aria-pressed", "true");
    expect(remote).toHaveAttribute("aria-pressed", "false");
    expect(remote).toHaveClass("text-[var(--remote-dim)]", "opacity-50");

    const search = within(primary).getByRole("button", { name: "Search sessions and commands" });
    const help = within(primary).getByRole("button", { name: "Open help and keyboard shortcuts" });
    const newThread = within(primary).getByRole("button", { name: "New thread" });
    // Frame 7a draws both header controls with the 0.22 frame hairline.
    expect(search).toHaveClass("h-7", "border-[var(--border-frame)]");
    expect(help).toHaveTextContent("?");
    expect(newThread).toHaveClass("h-8", "rounded-full");
    expect(newThread).toHaveTextContent("New thread");
    for (const control of [search, help, newThread, wantsYou, local, remote]) expect(control).toHaveAttribute("data-compact-control");
    // The scope tabs and host chips take a height-only touch floor: a 44px
    // square on each would push this overflow-x-auto row into sideways
    // scrolling on every phone.
    for (const control of [wantsYou, local, remote]) expect(control).toHaveAttribute("data-compact-control", "height");
    expect(screen.getByRole("status")).toHaveTextContent("Connection open · 2 diagnostics");
    // Frame 7a lights a live connection lime; anything else stays a warning.
    const connectionIndicator = primary.querySelector<HTMLElement>("[data-connection-indicator='open']");
    expect(connectionIndicator).toHaveClass("bg-[var(--accent)]");

    fireEvent.click(within(filters).getByRole("button", { name: "Working, 1 session" }));
    fireEvent.click(remote);
    fireEvent.click(search);
    fireEvent.click(help);
    fireEvent.click(newThread);
    expect(onScope).toHaveBeenCalledWith("working");
    expect(onToggleHost).toHaveBeenCalledWith("remote");
    expect(onPalette).toHaveBeenCalledOnce();
    expect(onHelp).toHaveBeenCalledOnce();
    expect(onNew).toHaveBeenCalledOnce();
  });
});
