import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActiveModalLayer } from "../../hooks/use-modal-focus";
import { DiffReview } from "./DiffReview";
import { DIFF_PARSE_DEBOUNCE_MS, type FileChangeView } from "./DiffViewer";

function added(path: string, lines: readonly string[], readKey: string): FileChangeView {
  return {
    path,
    previousPath: null,
    operation: "add",
    diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`,
    truncated: false,
    readKey,
    upserting: false,
  };
}

const CHANGES = [
  added("one.txt", ["one"], "one"),
  added("two.txt", ["two", "three"], "two"),
] as const;

function review(overrides: Partial<Parameters<typeof DiffReview>[0]> = {}) {
  return <DiffReview changes={CHANGES} branch="main" uncommitted readKeys={new Set(["one"])} onReadChange={vi.fn()} onClose={vi.fn()} {...overrides} />;
}

describe("DiffReview file navigation", () => {
  it("shows exact per-file counts and read ticks in the desktop file list", () => {
    render(review());
    const files = screen.getByRole("navigation", { name: "Changed files" });
    expect(within(files).getByRole("button", { name: "one.txt, +1, −0, read" })).toHaveAttribute("aria-current", "true");
    expect(within(files).getByRole("button", { name: "two.txt, +2, −0" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("2 files ·", { exact: false })).toHaveTextContent("2 files · +3 −0 · uncommitted");
  });

  it("opens the phone file list as a bottom sheet and selects a file", () => {
    const { container } = render(review());
    fireEvent.click(screen.getByRole("button", { name: "Choose file, 1 of 2" }));

    const sheet = screen.getByRole("dialog", { name: "Changed files" });
    expect(within(sheet).getByRole("button", { name: "one.txt, +1, −0, read" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "two.txt, +2, −0" }));
    expect(screen.queryByRole("dialog", { name: "Changed files" })).not.toBeInTheDocument();

    const main = container.querySelector<HTMLElement>("main[data-diff-scroll-container]");
    if (!main) throw new Error("Missing review diff container");
    expect(within(main).getByRole("button", { name: "two.txt" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Choose file, 2 of 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next file" })).toBeDisabled();
  });

  it("keeps the phone footer read action wired to the selected file identity", () => {
    const onReadChange = vi.fn();
    const { container } = render(review({ readKeys: new Set<string>(), onReadChange }));
    const footer = container.querySelector<HTMLElement>("footer");
    if (!footer) throw new Error("Missing phone review footer");
    fireEvent.click(within(footer).getByRole("button", { name: "Mark read" }));
    expect(onReadChange).toHaveBeenCalledWith("one", true);
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.click(within(footer).getByRole("button", { name: "Mark read" }));
    expect(onReadChange).toHaveBeenLastCalledWith("two", true);
  });

  it("keeps the phone file selector through 900px and starts the desktop rail at 901px", () => {
    const { container } = render(review());
    const rail = container.querySelector<HTMLElement>("[data-desktop-file-rail]");
    const footer = container.querySelector<HTMLElement>("[data-phone-file-footer]");
    if (!rail || !footer) throw new Error("Missing responsive file navigation");

    expect(rail).toHaveClass("hidden", "min-[901px]:block");
    expect(footer).toHaveClass("min-[901px]:hidden");
    expect(rail.className).not.toContain("sm:");
    expect(footer.className).not.toContain("sm:");

    fireEvent.click(screen.getByRole("button", { name: "Choose file, 1 of 2" }));
    const sheet = container.querySelector<HTMLElement>("[data-phone-file-sheet]");
    if (!sheet) throw new Error("Missing phone file sheet");
    expect(sheet).toHaveClass("min-[901px]:hidden");
    expect(sheet.className).not.toContain("sm:");
  });

  it("bounds every review surface so 320px and 390px phone layouts cannot scroll sideways", () => {
    const { container } = render(review());
    const root = screen.getByRole("dialog", { name: "Review changes" });
    const main = container.querySelector<HTMLElement>("main[data-diff-scroll-container]");
    const viewer = container.querySelector<HTMLElement>("article");
    if (!main || !viewer) throw new Error("Missing review surfaces");

    expect(root).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
    expect(main).toHaveClass("min-w-0", "max-w-full", "overflow-x-hidden");
    expect(viewer).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
    expect(main).toHaveClass("p-2", "min-[390px]:p-3");
  });
});

describe("DiffReview modal focus", () => {
  it("contains focus, consumes Escape, and restores the review opener", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open review</button>{open && review({ onClose: () => setOpen(false) })}</>;
    }
    const globalKeydown = vi.fn();
    window.addEventListener("keydown", globalKeydown);
    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open review" });
      opener.focus();
      fireEvent.click(opener);

      const dialog = screen.getByRole("dialog", { name: "Review changes" });
      const close = screen.getByRole("button", { name: "Close review" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(close).toHaveFocus();
      expect(close).toHaveAttribute("data-compact-control");
      opener.focus();
      expect(close).toHaveFocus();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Review changes" })).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
      expect(globalKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", globalKeydown);
    }
  });

  it("closes the nested phone file sheet first and restores its chooser", () => {
    const onClose = vi.fn();
    render(review({ onClose }));
    const chooser = screen.getByRole("button", { name: "Choose file, 1 of 2" });
    chooser.focus();
    fireEvent.click(chooser);

    const sheet = screen.getByRole("dialog", { name: "Changed files" });
    const closeSheet = within(sheet).getByRole("button", { name: "Close changed files" });
    expect(closeSheet).toHaveFocus();
    expect(closeSheet).toHaveAttribute("data-compact-control");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Changed files" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Review changes" })).toBeInTheDocument();
    expect(chooser).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps an earlier application capture listener from closing beneath the top modal", () => {
    const onClose = vi.fn();
    const closeAtApplicationLayer = vi.fn();
    function applicationKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !hasActiveModalLayer()) closeAtApplicationLayer();
    }
    window.addEventListener("keydown", applicationKeydown, true);
    try {
      render(review({ onClose }));
      fireEvent.click(screen.getByRole("button", { name: "Choose file, 1 of 2" }));
      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByRole("dialog", { name: "Changed files" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Review changes" })).toBeInTheDocument();
      expect(closeAtApplicationLayer).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", applicationKeydown, true);
    }
  });
});

describe("DiffReview editor path boundary", () => {
  it("omits the editor action when path resolution rejects the provider path", () => {
    render(review({ onOpenEditor: vi.fn(), resolveEditorPath: () => null }));
    expect(screen.queryByRole("button", { name: "Open in editor" })).not.toBeInTheDocument();
  });

  it("omits the editor action when no trusted path resolver is supplied", () => {
    render(review({ onOpenEditor: vi.fn() }));
    expect(screen.queryByRole("button", { name: "Open in editor" })).not.toBeInTheDocument();
  });

  it("passes only the resolved editor path to the host callback", () => {
    const onOpenEditor = vi.fn();
    const resolveEditorPath = vi.fn(() => "safe/one.txt");
    render(review({ readKeys: new Set<string>(), onOpenEditor, resolveEditorPath }));

    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(resolveEditorPath).toHaveBeenCalledWith("one.txt");
    expect(onOpenEditor).toHaveBeenCalledWith("safe/one.txt");
  });
});

describe("DiffReview changing counts", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces running file-list counts and finalizes them on completion", async () => {
    vi.useFakeTimers();
    const version = (lineCount: number, upserting: boolean): FileChangeView => ({
      ...added("one.txt", Array.from({ length: lineCount }, (_, index) => `line ${String(index + 1)}`), `one-${String(lineCount)}`),
      upserting,
    });
    const { rerender } = render(review({ changes: [version(1, true)], readKeys: new Set<string>() }));
    const fileList = () => screen.getByRole("navigation", { name: "Changed files" });
    expect(within(fileList()).getByRole("button", { name: "one.txt, +1, −0" })).toBeInTheDocument();

    rerender(review({ changes: [version(2, true)], readKeys: new Set<string>() }));
    await act(() => vi.advanceTimersByTimeAsync(DIFF_PARSE_DEBOUNCE_MS - 1));
    expect(within(fileList()).getByRole("button", { name: "one.txt, +1, −0" })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(within(fileList()).getByRole("button", { name: "one.txt, +2, −0" })).toBeInTheDocument();

    rerender(review({ changes: [version(3, false)], readKeys: new Set<string>() }));
    expect(within(fileList()).getByRole("button", { name: "one.txt, +3, −0" })).toBeInTheDocument();
  });

  it("shows unavailable per-file and aggregate counts for malformed patches", () => {
    const malformed: FileChangeView = {
      ...added("broken.txt", ["ignored"], "broken"),
      diff: "@@ -1 +1 @@\n?bad",
    };
    render(review({ changes: [malformed], readKeys: new Set<string>() }));

    expect(screen.getByRole("button", { name: "broken.txt, counts unavailable" })).toBeInTheDocument();
    expect(screen.getByText("1 files ·", { exact: false })).toHaveTextContent("1 files · counts unavailable · uncommitted");
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("−0")).not.toBeInTheDocument();
  });

  it("makes aggregate counts unavailable when any patch is truncated", () => {
    const truncated = { ...added("partial.txt", ["one"], "partial"), truncated: true };
    render(review({ changes: [CHANGES[0], truncated], readKeys: new Set<string>() }));

    expect(screen.getByRole("button", { name: "partial.txt, counts unavailable" })).toBeInTheDocument();
    expect(screen.getByText("2 files ·", { exact: false })).toHaveTextContent("2 files · counts unavailable · uncommitted");
  });
});
