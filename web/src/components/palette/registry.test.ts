import { describe, expect, it } from "vitest";
import { EMPTY_PALETTE_SOURCES, paletteResults, type PaletteEntry } from "./registry";

function entry(id: string, kind: PaletteEntry["kind"], boardState?: PaletteEntry["boardState"]): PaletteEntry {
  return { id, kind, label: id, detail: null, keywords: [], ...(boardState ? { boardState } : {}) };
}

describe("palette registry", () => {
  const sources = {
    ...EMPTY_PALETTE_SOURCES,
    sessions: [entry("idle", "session", "idle"), entry("needs", "session", "wants-you")],
    commands: [entry("refresh", "command")],
    files: [entry("README", "file")],
    hosts: [entry("host:studio", "host")],
    worktrees: [entry("worktree:feature", "worktree")],
  };
  it("is a triage list before typing", () => {
    expect(paletteResults(sources, "").map((item) => item.id)).toEqual(["needs", "idle", "refresh"]);
  });
  it("never guesses across an unavailable prefixed source", () => {
    expect(paletteResults(sources, "/help")).toEqual([]);
    expect(paletteResults(sources, "@read").map((item) => item.id)).toEqual(["README"]);
  });
  it("keeps real hosts and worktrees behind the location prefix", () => {
    expect(paletteResults(sources, "").map((item) => item.id)).not.toContain("host:studio");
    expect(paletteResults(sources, "~").map((item) => item.id)).toEqual(["host:studio", "worktree:feature"]);
  });
});
