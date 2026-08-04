import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "./session-sidebar";
import type { SessionView } from "../types";

function session(overrides: Partial<SessionView> & Pick<SessionView, "id">): SessionView {
  return {
    provider: "codex",
    name: overrides.id,
    cwd: `/work/${overrides.id}`,
    parentSessionId: null,
    depth: 0,
    ownership: "external",
    runtimeAlive: true,
    mode: { value: "execution", providerValue: null, source: "test", confidence: "exact" },
    activity: "idle",
    attention: [],
    effectiveAccess: { accessMode: "unknown", permissionMode: null, sandboxMode: null },
    terminal: null,
    control: { plane: "test", capabilities: [], managerOwned: false, writableLease: false },
    generation: 1,
    runId: null,
    updatedAt: "2026-08-04T10:00:00.000Z",
    messages: [],
    queue: [],
    ...overrides,
  };
}

const sessions = [
  session({ id: "codex:root", name: "Root project", ownership: "manager" }),
  session({ id: "codex:child", name: "Deploy reports", parentSessionId: "root", depth: 1, activity: "running" }),
  session({ id: "claude:external", name: "Claude notes", provider: "claude" }),
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof SessionSidebar>> = {}) {
  return render(
    <SessionSidebar
      sessions={sessions}
      selectedId="codex:root"
      scope="managed"
      connection="open"
      actor="Robert"
      onSelect={vi.fn()}
      onScopeChange={vi.fn()}
      onLaunch={vi.fn()}
      onRefresh={vi.fn()}
      {...overrides}
    />,
  );
}

describe("SessionSidebar", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?session=codex%3Aroot&scope=managed");
  });

  it("renders the controlled scope, exposes counts, and reports scope changes", () => {
    const onScopeChange = vi.fn();
    renderSidebar({ onScopeChange });

    expect(screen.getByRole("button", { name: "Managed, 1 session" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Claude, 1 session" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Claude, 1 session" }));
    expect(onScopeChange).toHaveBeenCalledOnce();
    expect(onScopeChange).toHaveBeenCalledWith("claude");
    expect(window.location.search).toBe("?session=codex%3Aroot&scope=managed");
  });

  it("does not change the active session or scope when the query changes", () => {
    const onSelect = vi.fn();
    const onScopeChange = vi.fn();
    renderSidebar({ scope: "all", onSelect, onScopeChange });

    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
      target: { value: "claude" },
    });

    expect(screen.getByRole("treeitem")).toHaveTextContent("Claude notes");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("keeps matching ancestors and renders compact hierarchy rows", () => {
    renderSidebar({ scope: "all" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "deploy" } });

    const tree = screen.getByRole("tree", { name: "All sessions" });
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Root project");
    expect(rows[0]).toHaveAttribute("data-ancestor-only", "true");
    expect(rows[1]).toHaveTextContent("Deploy reports");
    expect(rows[1]).toHaveAttribute("aria-level", "2");
    expect(rows[1]).toHaveClass("h-[52px]", "ps-5");
    expect(rows[1]).toHaveAttribute("data-compact-control");
    expect(rows[1]).not.toHaveAttribute("style");
    expect(rows[1]!.querySelector(".w-px")).toHaveClass("start-[5px]");
    expect(rows[1]!.querySelector(".w-px")).not.toHaveAttribute("style");
  });

  it("keeps launch visible but safely disabled when mutations are unavailable", () => {
    renderSidebar({ canLaunch: false });

    expect(screen.getByRole("button", { name: "New session unavailable while the manager is reconnecting" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Expand scope navigation" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Open navigation" }).parentElement).toHaveClass(
      "left-[max(0.75rem,env(safe-area-inset-left))]",
      "top-[max(0.75rem,env(safe-area-inset-top))]",
    );
  });

  it("exposes the browser-owned install action only when it is available", () => {
    const onInstall = vi.fn();
    const view = renderSidebar({ installAvailable: true, onInstall });

    fireEvent.click(screen.getByRole("button", { name: "Install Agent Manager" }));
    expect(onInstall).toHaveBeenCalledOnce();

    view.rerender(
      <SessionSidebar
        sessions={sessions}
        selectedId="codex:root"
        scope="managed"
        connection="open"
        actor="Robert"
        onSelect={vi.fn()}
        onScopeChange={vi.fn()}
        onLaunch={vi.fn()}
        onRefresh={vi.fn()}
        installAvailable={false}
        onInstall={onInstall}
      />,
    );
    expect(screen.queryByRole("button", { name: "Install Agent Manager" })).not.toBeInTheDocument();
  });

  it("keeps one session list grouped by local and SSH host", () => {
    renderSidebar({
      scope: "all",
      sessions: [
        session({ id: "remote:one", name: "Remote task", hostId: "host-studio", hostLabel: "Studio Mac" }),
        session({ id: "codex:root", name: "Local task", hostId: "local", hostLabel: "This Mac" }),
      ],
    });

    const tree = screen.getByRole("tree", { name: "All sessions" });
    const groups = within(tree).getAllByRole("region");
    expect(groups[0]).toHaveAccessibleName("This Mac sessions");
    expect(groups[0]).toHaveTextContent("Local task");
    expect(groups[1]).toHaveAccessibleName("Studio Mac sessions");
    expect(groups[1]).toHaveTextContent("Remote task");
  });
});
