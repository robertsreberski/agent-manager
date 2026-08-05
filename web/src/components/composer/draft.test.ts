import { describe, expect, it } from "vitest";
import {
  canAttemptDraftCreation,
  draftIdempotencyKey,
  draftLaunchPath,
  draftReducer,
  newDraftSession,
} from "./draft";

describe("draft session", () => {
  it("uses one stable first-send key and permits one creation attempt", () => {
    let draft = newDraftSession({ key: "abc", workspace: { hostId: "local", path: "/work/app" } });
    draft = draftReducer(draft, { type: "set-text", text: "Build it" });
    expect(canAttemptDraftCreation(draft)).toBe(true);
    expect(draftIdempotencyKey(draft)).toBe("draft:abc:first-send");
    expect(canAttemptDraftCreation(draftReducer(draft, { type: "creating" }))).toBe(false);
  });

  it("never silently retries an unknown outcome", () => {
    const failed = draftReducer(newDraftSession(), { type: "create-failed", message: "Outcome unknown", outcomeUnknown: true });
    expect(draftReducer(failed, { type: "retry" })).toBe(failed);
  });

  it("keeps effort choices honest when switching harnesses", () => {
    const codex = newDraftSession({ provider: "codex", effort: "ultra" });
    expect(codex.effort).toBe("ultra");
    const claude = draftReducer(codex, { type: "set-provider", provider: "claude", model: null });
    expect(claude.effort).toBe("medium");
    expect(newDraftSession({ provider: "claude", effort: "minimal" }).effort).toBe("medium");
    expect(newDraftSession({ provider: "claude", effort: "ultra" }).effort).toBe("medium");
  });

  it("runs in the chosen worktree, and in the folder itself when there is none", () => {
    const draft = newDraftSession({ workspace: { hostId: "local", path: "/work/app" } });
    expect(draft.workspace?.worktree).toEqual({ kind: "none" });
    expect(draftLaunchPath(draft.workspace!)).toBe("/work/app");

    const selected = draftReducer(draft, {
      type: "set-worktree",
      worktree: { kind: "existing", path: "/work/app/.worktrees/spike", branch: "spike" },
    });
    expect(draftLaunchPath(selected.workspace!)).toBe("/work/app/.worktrees/spike");
  });

  it("drops a worktree choice that was made for a different folder", () => {
    const chosen = draftReducer(
      newDraftSession({ workspace: { hostId: "local", path: "/work/app" } }),
      { type: "set-worktree", worktree: { kind: "existing", path: "/work/app/.worktrees/spike", branch: "spike" } },
    );

    const sameFolder = draftReducer(chosen, { type: "set-workspace", workspace: { hostId: "local", path: "/work/app" } });
    expect(sameFolder.workspace?.worktree).toEqual({ kind: "existing", path: "/work/app/.worktrees/spike", branch: "spike" });

    const moved = draftReducer(chosen, { type: "set-workspace", workspace: { hostId: "local", path: "/work/other" } });
    expect(moved.workspace?.worktree).toEqual({ kind: "none" });

    const rehosted = draftReducer(chosen, { type: "set-workspace", workspace: { hostId: "build", path: "/work/app" } });
    expect(rehosted.workspace?.worktree).toEqual({ kind: "none" });
  });

  it("will not attempt a creation for a worktree that cannot be named", () => {
    const named = (name: string) => draftReducer(
      draftReducer(
        newDraftSession({ workspace: { hostId: "local", path: "/work/app" } }),
        { type: "set-text", text: "Build it" },
      ),
      { type: "set-worktree", worktree: { kind: "new", name, repoRoot: "/work/app" } },
    );

    expect(canAttemptDraftCreation(named(""))).toBe(false);
    expect(canAttemptDraftCreation(named("../escape"))).toBe(false);
    expect(canAttemptDraftCreation(named("spike"))).toBe(true);
  });

  it("reuses a worktree that outlived a failed creation instead of asking for a second", () => {
    const requested = draftReducer(
      newDraftSession({ workspace: { hostId: "local", path: "/work/app" } }),
      { type: "set-worktree", worktree: { kind: "new", name: "spike", repoRoot: "/work/app" } },
    );

    const created = draftReducer(requested, {
      type: "worktree-created",
      path: "/work/app/.worktrees/spike",
      branch: "spike",
    });
    expect(created.workspace?.worktree).toEqual({ kind: "existing", path: "/work/app/.worktrees/spike", branch: "spike" });

    const retried = draftReducer(
      draftReducer(created, { type: "create-failed", message: "The harness refused.", outcomeUnknown: false }),
      { type: "retry" },
    );
    expect(retried.workspace?.worktree).toEqual({ kind: "existing", path: "/work/app/.worktrees/spike", branch: "spike" });
  });

  it("resets every public draft setting to the configured create defaults", () => {
    const changed = newDraftSession({ provider: "claude", model: "opus", effort: "high", profile: "full-access" });
    expect(draftReducer(changed, { type: "reset-settings" })).toMatchObject({
      provider: "codex",
      model: null,
      effort: null,
      profile: "plan",
    });
  });
});
