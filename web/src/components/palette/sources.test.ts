import { describe, expect, it } from "vitest";
import type { BoardSession } from "../board/model";
import { sessionPaletteEntries, worktreePaletteEntries } from "./sources";

function session(overrides: Partial<BoardSession> & Pick<BoardSession, "id">): BoardSession {
  const { id, ...rest } = overrides;
  return {
    id,
    provider: "codex",
    name: overrides.id,
    hostId: "local",
    hostLabel: "This Mac",
    remote: false,
    cwd: "/work/app",
    workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app-feature", linked: true, branch: "feature", detached: false, dirtyCount: null, ahead: null, behind: null },
    activity: "running",
    attention: [],
    updatedAt: "2026-08-04T12:00:00Z",
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [] },
    profile: null,
    model: null,
    effort: null,
    todo: null,
    boardState: "working",
    attentionExact: false,
    stateLine: "Working",
    ...rest,
  };
}

describe("palette sources", () => {
  it("carries the canonical session's current todo, counts, and board state", () => {
    const [entry] = sessionPaletteEntries([session({
      id: "codex:one",
      todo: { completed: 2, total: 6, current: "Fixing the shared fixture" },
      stateLine: "Fixing the shared fixture",
    })]);
    expect(entry).toMatchObject({
      id: "session:codex:one",
      detail: "Fixing the shared fixture",
      boardState: "working",
      progress: { completed: 2, total: 6 },
      payload: { type: "session", id: "codex:one" },
    });
  });

  it("deduplicates only observed host-qualified worktree paths", () => {
    const entries = worktreePaletteEntries([
      session({ id: "codex:one" }),
      session({ id: "codex:two" }),
      session({ id: "codex:unknown", cwd: null, workspaceIdentity: null }),
      session({ id: "codex:remote", hostId: "studio", hostLabel: "Studio", remote: true }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "worktree", label: "feature", detail: "app · This Mac" }),
      expect.objectContaining({ kind: "worktree", label: "feature", detail: "app · Studio" }),
    ]));
    expect(entries.some((entry) => entry.label === "Unknown worktree")).toBe(false);
  });
});
