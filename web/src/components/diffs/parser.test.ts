import { describe, expect, it } from "vitest";
import { diffIdentityKey, parseUnifiedDiff, splitRows } from "./parser";

const PATCH = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 one
-two
+TWO
+two-and-half
 three
`;

describe("parseUnifiedDiff", () => {
  it("tracks uneven gutters and split rows exactly", () => {
    const parsed = parseUnifiedDiff(PATCH);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed).toMatchObject({ oldPath: "a.txt", newPath: "a.txt", additions: 2, removals: 1 });
    expect(parsed.hunks[0]!.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1], ["remove", 2, null], ["add", null, 2], ["add", null, 3], ["context", 3, 4],
    ]);
    expect(splitRows(parsed.hunks[0]!)).toHaveLength(4);
  });

  it("falls back for malformed and bounded input, and keeps markers explicit", () => {
    expect(parseUnifiedDiff("@@ -1 +1 @@\n?bad")).toMatchObject({ kind: "raw", reason: "malformed" });
    expect(parseUnifiedDiff(PATCH, { maxBytes: 4, maxLines: 20, maxLineBytes: 100 })).toMatchObject({ kind: "raw", reason: "budget" });
    expect(parseUnifiedDiff("Binary files a/image.png and b/image.png differ")).toEqual({ kind: "marker", text: "Binary files a/image.png and b/image.png differ" });
  });

  it("reads a blank context line that lost its leading space", () => {
    // Trailing-whitespace stripping (editors, .editorconfig, lint autofix, some
    // provider serialisations) turns a blank context line " " into "". Treating
    // that as malformed discarded the whole file's gutters, tinting and counts.
    const stripped = `--- a/a.txt
+++ b/a.txt
@@ -1,4 +1,4 @@
 one

-two
+TWO
 three
`;
    const parsed = parseUnifiedDiff(stripped);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed).toMatchObject({ additions: 1, removals: 1 });
    expect(parsed.hunks[0]!.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1], ["context", 2, 2], ["remove", 3, null], ["add", null, 3], ["context", 4, 4],
    ]);
  });

  it("still treats a trailing empty line as the end of the patch, not as context", () => {
    const parsed = parseUnifiedDiff(PATCH);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.hunks[0]!.lines.filter((line) => line.kind === "context")).toHaveLength(2);
  });

  it("invalidates read state when content changes", () => {
    expect(diffIdentityKey("s", "t", "a", "update", PATCH)).not.toBe(diffIdentityKey("s", "t", "a", "update", `${PATCH}+more`));
  });
});
