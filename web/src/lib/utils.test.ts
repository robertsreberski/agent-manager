import { describe, expect, it } from "vitest";
import { cn } from "./utils";
import { workspaceChangeFacts, workspaceChangeLabel } from "./cockpit-view";

describe("cn", () => {
  it("keeps a text colour and a named type-scale size together", () => {
    // Regression: tailwind-merge only knows its own scale, so it filed the
    // handoff's `text-meta-sm` under text-COLOR and evicted the ink beside it.
    // A filled lime button then rendered near-white `--text` on `--accent`,
    // roughly 1.2:1, everywhere `Button variant="primary"` had a size.
    const merged = cn("bg-[var(--accent)] text-[var(--accent-ink)]", "text-meta-sm");

    expect(merged).toContain("text-[var(--accent-ink)]");
    expect(merged).toContain("text-meta-sm");
  });

  it("covers every step of the type scale, not just the one that regressed", () => {
    for (const size of [
      "text-display", "text-display-md", "text-display-sm",
      "text-title", "text-title-md", "text-title-sm",
      "text-card-title",
      "text-body", "text-body-sm",
      "text-meta", "text-meta-sm",
      "text-code", "text-code-sm", "text-code-xs",
      "text-eyebrow",
    ]) {
      expect(cn("text-[var(--text)]", size), size).toContain("text-[var(--text)]");
      expect(cn("text-[var(--text)]", size), size).toContain(size);
    }
  });

  it("still collapses genuine conflicts within each group", () => {
    expect(cn("text-meta", "text-body")).toBe("text-body");
    expect(cn("text-[var(--a)]", "text-[var(--b)]")).toBe("text-[var(--b)]");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("keeps clsx conditional behaviour", () => {
    expect(cn("a", false && "b", undefined, ["c", { d: true, e: false }])).toBe("a c d");
  });
});

describe("what uncommitted work amounts to", () => {
  const identity = {
    repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app",
    linked: false, branch: "main", detached: false,
    dirtyCount: 25, ahead: null, behind: null, insertions: 312, deletions: 87,
  };

  it("says how many files and how many lines, not just a bare number", () => {
    // "25 uncommitted" answered neither question an operator asks next.
    expect(workspaceChangeLabel(workspaceChangeFacts(identity)!)).toBe("25 files · +312 −87");
  });

  it("reports a clean worktree as nothing at all", () => {
    expect(workspaceChangeFacts({ ...identity, dirtyCount: 0 })).toBeNull();
    expect(workspaceChangeFacts({ ...identity, dirtyCount: null })).toBeNull();
    expect(workspaceChangeFacts(null)).toBeNull();
  });

  it("falls back to the file count when git could not supply the lines", () => {
    // A count of zero and "we could not find out" must not look the same.
    expect(workspaceChangeLabel(workspaceChangeFacts({ ...identity, insertions: null, deletions: null })!))
      .toBe("25 files");
    expect(workspaceChangeLabel(workspaceChangeFacts({ ...identity, insertions: 0, deletions: 0 })!))
      .toBe("25 files · +0 −0");
  });

  it("counts one file as a file", () => {
    expect(workspaceChangeLabel(workspaceChangeFacts({ ...identity, dirtyCount: 1 })!))
      .toBe("1 file · +312 −87");
  });
});
