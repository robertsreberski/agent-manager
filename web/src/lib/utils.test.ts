import { describe, expect, it } from "vitest";
import { cn } from "./utils";

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
      "text-card",
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
