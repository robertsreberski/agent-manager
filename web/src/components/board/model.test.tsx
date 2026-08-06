import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CockpitSessionView } from "../../lib/cockpit-view";
import { DesktopBoard } from "./DesktopBoard";
import { PhoneBoardBands } from "./PhoneBoardBands";
import { buildBoard, type BoardModel } from "./model";

function session(overrides: Partial<CockpitSessionView> & Pick<CockpitSessionView, "id">): CockpitSessionView {
  return {
    provider: "codex", name: overrides.id, hostId: "local", hostLabel: "This Mac", remote: false,
    cwd: "/work/app", workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app", linked: false, branch: "main", detached: false, dirtyCount: null, ahead: null, behind: null, insertions: null, deletions: null },
    activity: "idle", attention: [], updatedAt: "2026-08-04T12:00:00Z",
    control: {
      plane: "observe-only",
      authority: "none",
      coordination: {
        mode: "observe-only",
        nativeAttach: "none",
        responseResolution: "single-controller",
      },
      recovery: null,
      capabilities: [],
      withheld: [],
      peers: [],
      takeover: null,
    },
    profile: null, model: null, effort: null, todo: null, ...overrides,
    sandbox: null,
  };
}

function desktopSessionIds(model: BoardModel): string[] {
  return model.columns.flatMap((column) => column.worktrees.flatMap((group) => group.sessions.map((item) => item.id)));
}

function phoneSessionIds(model: BoardModel, state: "wants-you" | "working" | "idle"): string[] {
  return model.bands.find((band) => band.state === state)?.sessions.map((item) => item.id) ?? [];
}

describe("buildBoard", () => {
  it("uses host-qualified repos, keeps main first, and preserves an existing column order", () => {
    const initial = buildBoard([
      session({ id: "codex:linked", workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app-feature", linked: true, branch: "feature", detached: false, dirtyCount: 2, ahead: null, behind: null, insertions: null, deletions: null } }),
      session({ id: "codex:main" }),
      session({ id: "codex:remote", hostId: "remote", hostLabel: "Studio", remote: true, updatedAt: "2026-08-04T11:00:00Z" }),
    ]);
    const model = buildBoard([
      session({ id: "codex:linked", workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app-feature", linked: true, branch: "feature", detached: false, dirtyCount: 2, ahead: null, behind: null, insertions: null, deletions: null } }),
      session({ id: "codex:main" }),
      session({ id: "codex:remote", hostId: "remote", hostLabel: "Studio", remote: true, updatedAt: "2026-08-04T13:00:00Z" }),
    ], { previousOrder: initial.order });
    expect(model.columns.map((column) => column.key)).toEqual(["local:repo:/work/app", "remote:repo:/work/app"]);
    expect(model.columns[0]!.worktrees.map((group) => group.label)).toEqual(["main", "feature"]);
  });

  it("keeps a repository in one column when a session arrives without git facts", () => {
    const model = buildBoard([
      session({
        id: "codex:scanned",
        cwd: "/Users/me/agents/paola-bot",
        workspaceIdentity: { repoRoot: "/Users/me/agents/paola-bot", repoName: "paola-bot", worktreePath: "/Users/me/agents/paola-bot", linked: false, branch: "master", detached: false, dirtyCount: 25, ahead: null, behind: null, insertions: null, deletions: null },
      }),
      session({ id: "codex:managed", cwd: "/Users/me/agents/paola-bot", workspaceIdentity: null }),
    ]);
    expect(model.columns).toHaveLength(1);
    expect(model.columns[0]!.repoName).toBe("paola-bot");
    expect(model.columns[0]!.worktrees).toHaveLength(1);
    expect(model.columns[0]!.worktrees[0]!.label).toBe("master");
    expect(desktopSessionIds(model)).toEqual(["codex:managed", "codex:scanned"]);
  });

  it("adopts repository facts for a column first created by an identity-less session", () => {
    const model = buildBoard([
      session({ id: "codex:managed", cwd: "/Users/me/agents/paola-bot", workspaceIdentity: null }),
      session({
        id: "codex:scanned",
        cwd: "/Users/me/agents/paola-bot",
        workspaceIdentity: { repoRoot: "/Users/me/agents/paola-bot", repoName: "paola-bot", worktreePath: "/Users/me/agents/paola-bot", linked: false, branch: "master", detached: false, dirtyCount: 25, ahead: null, behind: null, insertions: null, deletions: null },
      }),
    ]);
    expect(model.columns).toHaveLength(1);
    expect(model.columns[0]!.key).toBe("local:repo:/Users/me/agents/paola-bot");
    expect(model.columns[0]!.worktrees[0]!.identity?.branch).toBe("master");
    expect(model.columns[0]!.worktrees[0]!.label).toBe("master");
  });

  it("keeps identity-less sessions in different repositories apart", () => {
    const model = buildBoard([
      session({ id: "codex:one", cwd: "/work/one", workspaceIdentity: null }),
      session({ id: "codex:two", cwd: "/work/two", workspaceIdentity: null }),
      session({ id: "codex:remote-same-path", hostId: "remote", hostLabel: "Studio", remote: true, cwd: "/work/one", workspaceIdentity: null }),
    ]);
    expect(model.columns.map((column) => column.key).sort()).toEqual([
      "local:path:/work/one",
      "local:path:/work/two",
      "remote:path:/work/one",
    ]);
  });

  it("keeps desktop cards and phone cards still when only updatedAt facts change", () => {
    const initial = buildBoard([
      session({ id: "codex:newer", updatedAt: "2026-08-04T13:00:00Z" }),
      session({ id: "codex:older", updatedAt: "2026-08-04T12:00:00Z" }),
    ]);
    expect(desktopSessionIds(initial)).toEqual(["codex:newer", "codex:older"]);

    const tick = buildBoard([
      session({ id: "codex:newer", updatedAt: "2026-08-04T13:01:00Z" }),
      session({ id: "codex:older", updatedAt: "2026-08-04T14:00:00Z" }),
    ], { previousOrder: initial.order });

    expect(desktopSessionIds(tick)).toEqual(["codex:newer", "codex:older"]);
    expect(phoneSessionIds(tick, "idle")).toEqual(["codex:newer", "codex:older"]);
  });

  it("moves real state transitions between priority buckets on both presentations", () => {
    const initial = buildBoard([
      session({ id: "codex:idle", updatedAt: "2026-08-04T14:00:00Z" }),
      session({ id: "codex:transition", updatedAt: "2026-08-04T13:00:00Z" }),
      session({ id: "codex:working", activity: "running", updatedAt: "2026-08-04T12:00:00Z" }),
    ]);
    const wantsYou = buildBoard([
      session({ id: "codex:idle", updatedAt: "2026-08-04T14:01:00Z" }),
      session({ id: "codex:transition", attention: [{ requestId: null, kind: "blocked", label: "blocked", summary: null, confidence: "heuristic", respondable: false }], updatedAt: "2026-08-04T14:01:00Z" }),
      session({ id: "codex:working", activity: "running", updatedAt: "2026-08-04T14:01:00Z" }),
    ], { previousOrder: initial.order });
    expect(desktopSessionIds(wantsYou)).toEqual(["codex:transition", "codex:working", "codex:idle"]);
    expect(phoneSessionIds(wantsYou, "wants-you")).toEqual(["codex:transition"]);
    expect(phoneSessionIds(wantsYou, "working")).toEqual(["codex:working"]);

    const working = buildBoard([
      session({ id: "codex:idle" }),
      session({ id: "codex:transition", activity: "running" }),
      session({ id: "codex:working", activity: "running" }),
    ], { previousOrder: wantsYou.order });
    expect(desktopSessionIds(working)).toEqual(["codex:working", "codex:transition", "codex:idle"]);
    expect(phoneSessionIds(working, "working")).toEqual(["codex:working", "codex:transition"]);
  });

  it("adds deterministically, removes immediately, and drops removed ids from retained state", () => {
    const initial = buildBoard([session({ id: "codex:existing" })]);
    const added = buildBoard([
      session({ id: "codex:beta", updatedAt: "2026-08-04T14:00:00Z" }),
      session({ id: "codex:existing", updatedAt: "2026-08-04T15:00:00Z" }),
      session({ id: "codex:alpha", updatedAt: "2026-08-04T14:00:00Z" }),
    ], { previousOrder: initial.order });
    expect(desktopSessionIds(added)).toEqual(["codex:existing", "codex:alpha", "codex:beta"]);
    expect(phoneSessionIds(added, "idle")).toEqual(["codex:existing", "codex:alpha", "codex:beta"]);

    const removed = buildBoard([
      session({ id: "codex:beta" }),
      session({ id: "codex:existing" }),
    ], { previousOrder: added.order });
    expect(desktopSessionIds(removed)).toEqual(["codex:existing", "codex:beta"]);
    expect(JSON.stringify(removed.order)).not.toContain("codex:alpha");
  });

  it("puts heuristic attention in wants-you but labels it as transcript evidence", () => {
    const model = buildBoard([session({ id: "codex:blocked", attention: [{ requestId: null, kind: "blocked", label: "blocked", summary: null, confidence: "heuristic", respondable: false }] })]);
    expect(model.bands[0]!.state).toBe("wants-you");
    expect(model.bands[0]!.sessions[0]).toMatchObject({ attentionExact: false, stateLine: "Looks blocked — from transcript" });
  });

  it("uses exactly three phone bands and keeps failed cards visibly failed inside idle", () => {
    const model = buildBoard([session({ id: "codex:failed", activity: "failed" }), session({ id: "codex:idle" })]);
    expect(model.bands).toHaveLength(1);
    expect(model.bands[0]).toMatchObject({ state: "idle", sessions: [{ boardState: "failed" }, { boardState: "idle" }] });
    expect(buildBoard([session({ id: "codex:failed", activity: "failed" })], { scope: "idle" }).columns).toHaveLength(1);
  });

  it("applies the active scope and host filters to phone bands as well as desktop columns", () => {
    const sessions = [
      session({ id: "local:waiting", attention: [{ requestId: "request-1", kind: "question", label: "Choose", summary: "Choose", confidence: "exact", respondable: true }] }),
      session({ id: "local:working", activity: "running" }),
      session({ id: "remote:working", hostId: "remote", hostLabel: "Studio", remote: true, activity: "running" }),
      session({ id: "remote:idle", hostId: "remote", hostLabel: "Studio", remote: true }),
    ];

    const workingLocal = buildBoard(sessions, { scope: "working", hostIds: new Set(["local"]) });
    expect(desktopSessionIds(workingLocal)).toEqual(["local:working"]);
    expect(workingLocal.bands.map((band) => [band.state, band.sessions.map((item) => item.id)])).toEqual([
      ["working", ["local:working"]],
    ]);

    const wantsRemote = buildBoard(sessions, { scope: "wants-you", hostIds: new Set(["remote"]) });
    expect(wantsRemote.columns).toEqual([]);
    expect(wantsRemote.bands).toEqual([]);
  });
});

describe("board presentations", () => {
  it("shows the current todo and n of m tick bar on every desktop card", () => {
    const model = buildBoard([session({
      id: "codex:progress",
      todo: { completed: 2, total: 4, current: "Fixing the shared fixture" },
    })]);
    const { container } = render(<DesktopBoard columns={model.columns} onOpenSession={vi.fn()} />);
    expect(screen.getByText("Fixing the shared fixture")).toBeInTheDocument();
    expect(screen.getByLabelText("2 of 4 todos completed")).toHaveTextContent("2 of 4");
    const ticks = container.querySelector("[data-todo-progress]")?.firstElementChild?.children;
    expect(ticks).toHaveLength(4);
    expect(ticks?.[0]).toHaveClass("bg-[var(--accent)]", "w-4");
    expect(ticks?.[2]).toHaveClass("bg-[var(--accent-quiet)]", "w-4");
  });

  it("shows the same current todo and n of m tick bar on phone cards", () => {
    const model = buildBoard([session({
      id: "codex:phone-progress",
      todo: { completed: 1, total: 3, current: "Rendering the phone row" },
    })]);
    render(<PhoneBoardBands bands={model.bands} onOpenSession={vi.fn()} />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("Rendering the phone row")).toBeInTheDocument();
    expect(within(item).getByLabelText("1 of 3 todos completed")).toHaveTextContent("1 of 3");
  });

  it("omits null and zero dirty counts and starts selection without opening", () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    const model = buildBoard([
      session({ id: "codex:one" }),
      session({
        id: "codex:clean",
        cwd: "/work/clean",
        workspaceIdentity: { repoRoot: "/work/clean", repoName: "clean", worktreePath: "/work/clean", linked: false, branch: "main", detached: false, dirtyCount: 0, ahead: null, behind: null, insertions: null, deletions: null },
      }),
    ]);
    render(<DesktopBoard columns={model.columns} onOpenSession={onOpen} onToggleSelection={onSelect} />);
    const board = screen.getByRole("region", { name: "Agent sessions by repository" });
    expect(within(board).getByRole("button", { name: /codex:one/u })).toBeInTheDocument();
    expect(within(board).queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/uncommitted/u)).not.toBeInTheDocument();
    expect(screen.queryByText("0 uncommitted")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /codex:one/u }), { shiftKey: true });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows evidence rather than a fabricated question on the phone", () => {
    const onOpen = vi.fn();
    const model = buildBoard([session({ id: "codex:one", attention: [{ requestId: null, kind: "blocked", label: "blocked", summary: "Maybe waiting", confidence: "heuristic", respondable: false }] })]);
    render(<PhoneBoardBands bands={model.bands} onOpenSession={onOpen} />);
    const board = screen.getByRole("region", { name: "Agent sessions" });
    expect(screen.getByRole("listitem")).toHaveAttribute("data-attention-confidence", "heuristic");
    const item = screen.getByRole("listitem");
    const stateLine = within(item).getByText("Looks blocked — from transcript");
    expect(stateLine).toHaveClass("text-[var(--text-muted)]");
    expect(stateLine).not.toHaveClass("text-[var(--wants-text)]");
    expect(item.querySelector("[data-attention-edge='inferred']")).toHaveClass("border-dashed", "border-[var(--accent)]");
    const action = within(board).getByRole("button", { name: /codex:one.*Looks blocked — from transcript/u });
    fireEvent.click(action);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows the authenticated exact-question overlay on the phone", () => {
    const model = buildBoard([session({ id: "codex:one", attention: [{ requestId: "request-1", kind: "question", label: "Which branch should I update?", summary: "Which branch should I update?", confidence: "exact", respondable: true }] })]);
    render(<PhoneBoardBands bands={model.bands} onOpenSession={vi.fn()} />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveAttribute("data-attention-confidence", "exact");
    expect(within(item).getByText("Which branch should I update?")).toHaveClass("text-[var(--wants-text)]");
    expect(item.querySelector("[data-attention-edge='inferred']")).not.toBeInTheDocument();
  });
});
