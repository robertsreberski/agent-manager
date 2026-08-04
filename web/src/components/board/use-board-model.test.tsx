import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CockpitSessionView } from "../../lib/cockpit-view";
import type { BoardModel } from "./model";
import { useBoardModel } from "./use-board-model";

function session(id: string, updatedAt: string, activity: CockpitSessionView["activity"] = "idle"): CockpitSessionView {
  return {
    id,
    provider: "codex",
    name: id,
    hostId: "local",
    hostLabel: "This Mac",
    remote: false,
    cwd: "/work/app",
    workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app", linked: false, branch: "main", detached: false, dirtyCount: null, ahead: null, behind: null },
    activity,
    attention: [],
    updatedAt,
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [] },
    profile: null,
    model: null,
    effort: null,
    todo: null,
  };
}

function ids(model: BoardModel): string[] {
  return model.columns.flatMap((column) => column.worktrees.flatMap((group) => group.sessions.map((item) => item.id)));
}

describe("useBoardModel", () => {
  it("carries the last committed order across App-style snapshot rerenders", () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: readonly CockpitSessionView[] }) => useBoardModel(sessions, { scope: "all" }),
      { initialProps: { sessions: [session("codex:first", "2026-08-04T13:00:00Z"), session("codex:second", "2026-08-04T12:00:00Z")] } },
    );
    expect(ids(result.current)).toEqual(["codex:first", "codex:second"]);

    rerender({ sessions: [session("codex:first", "2026-08-04T13:01:00Z"), session("codex:second", "2026-08-04T14:00:00Z")] });
    expect(ids(result.current)).toEqual(["codex:first", "codex:second"]);

    rerender({ sessions: [session("codex:first", "2026-08-04T13:02:00Z"), session("codex:second", "2026-08-04T14:01:00Z", "running")] });
    expect(ids(result.current)).toEqual(["codex:second", "codex:first"]);
  });
});
