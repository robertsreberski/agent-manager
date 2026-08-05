import { describe, expect, it } from "vitest";

import { recentProjects } from "./projects";
import type { WorkspaceOption } from "../types";

function workspace(overrides: Partial<WorkspaceOption> & { path: string }): WorkspaceOption {
  return {
    id: overrides.path,
    label: overrides.path.split("/").at(-1) ?? overrides.path,
    hostId: "local",
    hostLabel: "This Mac",
    hostKind: "local",
    repoRoot: null,
    repoName: null,
    lastOpenedAt: null,
    temporary: false,
    ...overrides,
  };
}

describe("recentProjects", () => {
  it("collapses a repository and its worktrees into one project", () => {
    const projects = recentProjects([
      workspace({ path: "/repos/app", repoRoot: "/repos/app", repoName: "app" }),
      workspace({ path: "/repos/app/.worktrees/fix-auth", label: "app · fix-auth", repoRoot: "/repos/app", repoName: "app" }),
      workspace({ path: "/repos/app/.worktrees/spike", label: "app · spike", repoRoot: "/repos/app", repoName: "app" }),
    ]);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ label: "app", path: "/repos/app" });
  });

  it("takes the project's recency from its most recently opened worktree", () => {
    const projects = recentProjects([
      workspace({ path: "/repos/app", repoRoot: "/repos/app", repoName: "app", lastOpenedAt: "2026-08-04T09:00:00.000Z" }),
      workspace({
        path: "/repos/app/.worktrees/fix-auth",
        repoRoot: "/repos/app",
        repoName: "app",
        lastOpenedAt: "2026-08-04T11:00:00.000Z",
      }),
      workspace({ path: "/repos/other", repoRoot: "/repos/other", repoName: "other", lastOpenedAt: "2026-08-04T10:00:00.000Z" }),
    ]);

    expect(projects.map((project) => project.label)).toEqual(["app", "other"]);
    expect(projects[0]?.lastOpenedAt).toBe("2026-08-04T11:00:00.000Z");
    // Where in the repository the work was last done is a preference for the
    // worktree step, carried alongside the project.
    expect(projects[0]?.lastWorktreePath).toBe("/repos/app/.worktrees/fix-auth");
  });

  it("carries no worktree preference when the repository root was the last thing opened", () => {
    const projects = recentProjects([
      workspace({
        path: "/repos/app/.worktrees/fix-auth",
        repoRoot: "/repos/app",
        repoName: "app",
        lastOpenedAt: "2026-08-04T09:00:00.000Z",
      }),
      workspace({ path: "/repos/app", repoRoot: "/repos/app", repoName: "app", lastOpenedAt: "2026-08-04T12:00:00.000Z" }),
    ]);

    expect(projects[0]?.lastWorktreePath).toBeNull();
  });

  it("keeps a directory that is not a repository as its own project", () => {
    const projects = recentProjects([
      workspace({ path: "/notes", label: "notes" }),
      workspace({ path: "/repos/app", repoRoot: "/repos/app", repoName: "app" }),
    ]);

    expect(projects.map((project) => project.path)).toEqual(["/notes", "/repos/app"]);
  });

  it("never merges the same path across two hosts", () => {
    const projects = recentProjects([
      workspace({ path: "/repos/app", repoRoot: "/repos/app", repoName: "app" }),
      workspace({ path: "/repos/app", id: "remote", hostId: "studio", hostLabel: "Studio", repoRoot: "/repos/app", repoName: "app" }),
    ]);

    expect(projects).toHaveLength(2);
    expect(projects.map((project) => project.hostId)).toEqual(["local", "studio"]);
  });

  it("orders never-opened projects behind opened ones without reshuffling them", () => {
    const projects = recentProjects([
      workspace({ path: "/repos/alpha", repoRoot: "/repos/alpha", repoName: "alpha" }),
      workspace({ path: "/repos/bravo", repoRoot: "/repos/bravo", repoName: "bravo" }),
      workspace({ path: "/repos/charlie", repoRoot: "/repos/charlie", repoName: "charlie", lastOpenedAt: "2026-08-04T10:00:00.000Z" }),
    ]);

    expect(projects.map((project) => project.label)).toEqual(["charlie", "alpha", "bravo"]);
  });
});
