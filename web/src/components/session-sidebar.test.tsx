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
    effectiveAccess: { permissionMode: null, sandboxMode: null, fullHostAccess: false },
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
      connection="open"
      actor="Robert"
      onSelect={vi.fn()}
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

  it("hydrates scope from the URL, exposes counts, and preserves the session query", () => {
    renderSidebar();

    expect(screen.getByRole("button", { name: "Managed, 1 session" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Claude, 1 session" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Claude, 1 session" }));
    expect(window.location.search).toBe("?session=codex%3Aroot&scope=claude");
  });

  it("keeps matching ancestors and renders compact hierarchy rows", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "All, 3 sessions" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "deploy" } });

    const tree = screen.getByRole("tree", { name: "All sessions" });
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Root project");
    expect(rows[0]).toHaveAttribute("data-ancestor-only", "true");
    expect(rows[1]).toHaveTextContent("Deploy reports");
    expect(rows[1]).toHaveAttribute("aria-level", "2");
    expect(rows[1]).toHaveClass("h-[52px]");
    expect(rows[1]).toHaveAttribute("data-compact-control");
  });

  it("keeps launch visible but safely disabled when mutations are unavailable", () => {
    renderSidebar({ canLaunch: false });

    expect(screen.getByRole("button", { name: "New session unavailable while the manager is reconnecting" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Expand scope navigation" })).toHaveAttribute("aria-expanded", "false");
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
        connection="open"
        actor="Robert"
        onSelect={vi.fn()}
        onLaunch={vi.fn()}
        onRefresh={vi.fn()}
        installAvailable={false}
        onInstall={onInstall}
      />,
    );
    expect(screen.queryByRole("button", { name: "Install Agent Manager" })).not.toBeInTheDocument();
  });
});
