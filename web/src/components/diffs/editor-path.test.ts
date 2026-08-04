import { describe, expect, it } from "vitest";
import { relativeEditorPath } from "./editor-path";

describe("relativeEditorPath", () => {
  it("keeps relative paths and strips the selected workspace root", () => {
    expect(relativeEditorPath("/work/app", "src/App.tsx")).toBe("src/App.tsx");
    expect(relativeEditorPath("/work/app/", "/work/app/src/App.tsx")).toBe("src/App.tsx");
  });

  it("rejects paths that could escape or address another workspace", () => {
    expect(relativeEditorPath("/work/app", "/work/other/file.ts")).toBeNull();
    expect(relativeEditorPath("/work/app", "../other/file.ts")).toBeNull();
    expect(relativeEditorPath("/work/app", "src/../secret.ts")).toBeNull();
    expect(relativeEditorPath(null, "/work/app/file.ts")).toBeNull();
  });
});
