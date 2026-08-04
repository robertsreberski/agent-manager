import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  boardScrollBehavior,
  cockpitContentMode,
  codexCatalogEfforts,
  handleCockpitEscape,
  handleOpenDrawerMenuEscape,
  Header,
  hostSelectionSummary,
  CockpitToast,
  NotificationSettings,
  notificationAwaySince,
} from "./App";

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

    rerender(<CockpitToast actionError={null} notice="Action completed." canTakeOver onTakeOver={onTakeOver} onDismiss={onDismiss} />);
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
  it("uses only the selected Codex model's provider-declared efforts", () => {
    const response = {
      available: true,
      source: "provider-api",
      models: [
        { value: "codex-default", label: "Default", description: null, isDefault: true, defaultEffort: "high", efforts: ["low", "high"] },
        { value: "codex-deep", label: "Deep", description: null, isDefault: false, defaultEffort: "xhigh", efforts: ["high", "xhigh", "ultra"] },
      ],
    } satisfies NonNullable<Parameters<typeof codexCatalogEfforts>[2]>;
    expect(codexCatalogEfforts("codex", null, response)).toEqual(["low", "high"]);
    expect(codexCatalogEfforts("codex", "codex-deep", response)).toEqual(["high", "xhigh", "ultra"]);
    expect(codexCatalogEfforts("codex", "missing", response)).toEqual([]);
    expect(codexCatalogEfforts("claude", "codex-deep", response)).toBeUndefined();
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

  it("consumes one Escape at the top layer without closing the draft drawer underneath", () => {
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    const actions = {
      closePalette: vi.fn(),
      closeShortcuts: vi.fn(),
      closeReview: vi.fn(),
      closeDrawer: vi.fn(),
    };

    expect(handleCockpitEscape(event, {
      paletteOpen: true,
      shortcutsOpen: false,
      reviewOpen: false,
      drawerOpen: true,
    }, actions)).toBe(true);

    expect(actions.closePalette).toHaveBeenCalledOnce();
    expect(actions.closeDrawer).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("closes an open drawer menu through its own trigger instead of closing the drawer", () => {
    const root = document.createElement("div");
    root.innerHTML = '<aside data-thread-drawer><button aria-haspopup="menu" aria-expanded="true">Runtime</button><div role="menu"></div></aside>';
    const trigger = root.querySelector("button")!;
    const click = vi.spyOn(trigger, "click");
    const event = { key: "Escape", preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as KeyboardEvent;

    expect(handleOpenDrawerMenuEscape(event, root)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("contains notification settings focus, closes through the modal hook, and restores its opener", () => {
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
    const close = screen.getByRole("button", { name: "Close notification settings" });
    expect(close).toHaveFocus();
    expect(close).toHaveAttribute("data-compact-control");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
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
      counts={{ all: 5, "wants-you": 2, working: 1, failed: 1, idle: 2 }}
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
    expect(search).toHaveClass("h-7", "border-[var(--border-hairline)]");
    expect(help).toHaveTextContent("?");
    expect(newThread).toHaveClass("h-8", "rounded-full");
    expect(newThread).toHaveTextContent("New thread");
    for (const control of [search, help, newThread, wantsYou, local, remote]) expect(control).toHaveAttribute("data-compact-control");
    expect(screen.getByRole("status")).toHaveTextContent("Connection open · 2 diagnostics");
    const connectionIndicator = primary.querySelector<HTMLElement>("[data-connection-indicator='open']");
    expect(connectionIndicator).toHaveClass("bg-[var(--text-muted)]");
    expect(connectionIndicator).not.toHaveClass("bg-[var(--accent)]");

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
