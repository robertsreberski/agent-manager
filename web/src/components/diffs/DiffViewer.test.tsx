import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_PARSE_DEBOUNCE_MS, DiffViewer, type FileChangeView } from "./DiffViewer";

const UPDATE_PATCH = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -4,3 +4,3 @@
 context
-old
+new
 tail
`;

function change(overrides: Partial<FileChangeView> = {}): FileChangeView {
  return {
    path: "file.txt",
    previousPath: null,
    operation: "update",
    diff: UPDATE_PATCH,
    truncated: false,
    readKey: "session:turn:file:hash",
    upserting: false,
    ...overrides,
  };
}

function line(container: HTMLElement, kind: "context" | "add" | "remove"): HTMLElement {
  const result = container.querySelector<HTMLElement>(`[data-diff-line="${kind}"]`);
  if (!result) throw new Error(`Missing rendered ${kind} line`);
  return result;
}

function gutter(renderedLine: HTMLElement, kind: "old" | "new" | "phone"): string {
  const result = renderedLine.querySelector<HTMLElement>(`[data-diff-gutter="${kind}"]`);
  if (!result) throw new Error(`Missing rendered ${kind} gutter`);
  return result.textContent ?? "";
}

function marker(renderedLine: HTMLElement): HTMLElement {
  const result = renderedLine.querySelector<HTMLElement>("[data-diff-marker]");
  if (!result) throw new Error("Missing rendered diff marker");
  return result;
}

function addedFilePatch(count: number): string {
  const body = Array.from({ length: count }, (_, index) => `+line ${String(index + 1)}`).join("\n");
  return `diff --git a/file.txt b/file.txt
--- /dev/null
+++ b/file.txt
@@ -0,0 +1,${String(count)} @@
${body}
`;
}

describe("DiffViewer gutters", () => {
  it("renders independent desktop gutters and one phone fallback gutter for every line operation", () => {
    const { container } = render(<DiffViewer change={change()} />);

    const context = line(container, "context");
    expect(gutter(context, "old")).toBe("4");
    expect(gutter(context, "new")).toBe("4");
    expect(gutter(context, "phone")).toBe("4");

    const removed = line(container, "remove");
    expect(removed).toHaveClass("bg-[var(--removed-field)]", "text-[var(--removed-line-text)]");
    expect(gutter(removed, "old")).toBe("5");
    expect(gutter(removed, "new")).toBe("");
    expect(gutter(removed, "phone")).toBe("5");

    const added = line(container, "add");
    expect(added).toHaveClass("bg-[var(--added-field)]", "text-[var(--added-line-text)]");
    expect(gutter(added, "old")).toBe("");
    expect(gutter(added, "new")).toBe("5");
    expect(gutter(added, "phone")).toBe("5");
  });

  /**
   * Frame 10a splits the saturated marker from the quieter line prose. Asserting
   * both halves — and that neither carries the other's token — stops a later
   * change from collapsing them back into one colour.
   */
  it("keeps the +/− marker saturated while the line prose stays quiet", () => {
    const { container } = render(<DiffViewer change={change()} />);

    const added = line(container, "add");
    expect(marker(added)).toHaveClass("text-[var(--added)]");
    expect(marker(added).className).not.toContain("--added-line-text");
    expect(added.className).not.toContain("text-[var(--added)]");

    const removed = line(container, "remove");
    expect(marker(removed)).toHaveClass("text-[var(--removed)]");
    expect(marker(removed).className).not.toContain("--removed-line-text");
    expect(removed.className).not.toContain("text-[var(--removed)]");

    expect(marker(line(container, "context"))).toHaveClass("text-[var(--text-faint)]");
  });

  it("keeps one wrapping gutter through 900px and starts desktop gutters at 901px", () => {
    const { container } = render(<DiffViewer change={change()} />);
    const rendered = line(container, "context");
    expect(rendered).toHaveClass("grid-cols-[30px_13px_minmax(0,1fr)]", "min-[901px]:grid-cols-[38px_38px_16px_minmax(0,1fr)]");
    expect(rendered).not.toHaveClass("sm:grid-cols-[38px_38px_16px_minmax(0,1fr)]");
    expect(rendered.querySelector('[data-diff-gutter="phone"]')).toHaveClass("min-[901px]:hidden");
    expect(rendered.querySelector('[data-diff-gutter="old"]')).toHaveClass("min-[901px]:block");
    expect(rendered.querySelector('[data-diff-gutter="new"]')).toHaveClass("min-[901px]:block");
  });

  it("renders an added file without an old gutter", () => {
    const { container } = render(<DiffViewer change={change({
      operation: "add",
      path: "new.txt",
      diff: `--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+first\n`,
    })} />);
    const added = line(container, "add");
    expect(gutter(added, "old")).toBe("");
    expect(gutter(added, "new")).toBe("1");
  });

  it("renders a deleted file without a new gutter or editor action", () => {
    const { container } = render(<DiffViewer change={change({
      operation: "delete",
      path: "old.txt",
      diff: `--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-last\n`,
    })} onOpenEditor={vi.fn()} />);
    const removed = line(container, "remove");
    expect(gutter(removed, "old")).toBe("1");
    expect(gutter(removed, "new")).toBe("");
    expect(screen.queryByRole("button", { name: "Open in editor" })).not.toBeInTheDocument();
  });

  it("renders both paths and gutters for a renamed file", () => {
    const { container } = render(<DiffViewer change={change({
      operation: "rename",
      previousPath: "before.txt",
      path: "after.txt",
      diff: `--- a/before.txt\n+++ b/after.txt\n@@ -1,1 +1,1 @@\n same\n`,
    })} />);
    expect(screen.getByText("before.txt → after.txt")).toBeInTheDocument();
    const context = line(container, "context");
    expect(gutter(context, "old")).toBe("1");
    expect(gutter(context, "new")).toBe("1");
  });
});

describe("DiffViewer upsert parsing", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of active full replacements into the last debounced parse", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<DiffViewer change={change({ diff: addedFilePatch(1), upserting: true })} />);
    expect(screen.getByText("+1")).toBeInTheDocument();

    rerender(<DiffViewer change={change({ diff: addedFilePatch(2), upserting: true })} />);
    await act(() => vi.advanceTimersByTimeAsync(DIFF_PARSE_DEBOUNCE_MS - 1));
    expect(screen.getByText("+1")).toBeInTheDocument();

    rerender(<DiffViewer change={change({ diff: addedFilePatch(3), upserting: true })} />);
    await act(() => vi.advanceTimersByTimeAsync(DIFF_PARSE_DEBOUNCE_MS - 1));
    expect(screen.getByText("+1")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.queryByText("+2")).not.toBeInTheDocument();
  });

  it("parses the final replacement immediately when the activity completes", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<DiffViewer change={change({ diff: addedFilePatch(1), upserting: true })} />);
    rerender(<DiffViewer change={change({ diff: addedFilePatch(2), upserting: true })} />);
    expect(screen.getByText("+1")).toBeInTheDocument();

    rerender(<DiffViewer change={change({ diff: addedFilePatch(3), upserting: false })} />);
    expect(screen.getByText("+3")).toBeInTheDocument();

    await act(() => vi.runAllTimersAsync());
    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("labels malformed and truncated counts unavailable instead of claiming zero", () => {
    const { container, rerender } = render(<DiffViewer change={change({ diff: "@@ -1 +1 @@\n?bad" })} />);
    expect(screen.getByLabelText("Diff counts unavailable")).toHaveTextContent("counts unavailable");
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("−0")).not.toBeInTheDocument();
    expect(container.querySelector("[data-raw-diff]")).toHaveClass("overflow-x-hidden", "whitespace-pre-wrap", "break-words", "[overflow-wrap:anywhere]");

    rerender(<DiffViewer change={change({ truncated: true })} />);
    expect(screen.getByLabelText("Diff counts unavailable")).toBeInTheDocument();
    expect(screen.queryByText("+1")).not.toBeInTheDocument();
  });
});

describe("DiffViewer layout toggle", () => {
  it("preserves the review scroll position and read state", () => {
    const onReadChange = vi.fn();
    const { container } = render(
      <div data-diff-scroll-container>
        <DiffViewer change={change()} read onReadChange={onReadChange} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "file.txt" }));

    const scroll = container.querySelector<HTMLElement>("[data-diff-scroll-container]");
    if (!scroll) throw new Error("Missing diff scroll container");
    scroll.scrollTop = 147;
    scroll.scrollLeft = 11;
    fireEvent.click(screen.getByRole("button", { name: "split" }));

    expect(scroll.scrollTop).toBe(147);
    expect(scroll.scrollLeft).toBe(11);
    expect(container.querySelector("article")).toHaveAttribute("data-read", "true");
    expect(screen.getByLabelText("Read")).toBeInTheDocument();
    expect(onReadChange).not.toHaveBeenCalled();
  });

  it("keeps unified markup on phone and exposes split markup only from 901px", () => {
    const { container } = render(<DiffViewer change={change()} />);
    fireEvent.click(screen.getByRole("button", { name: "split" }));
    expect(container.querySelector("[data-phone-unified-diff]")).toHaveClass("min-[901px]:hidden");
    expect(container.querySelector("[data-desktop-split-diff]")).toHaveClass("hidden", "min-[901px]:grid");
    expect(screen.getByRole("group", { name: "Diff layout" })).toHaveClass("hidden", "min-[901px]:flex");
  });

  it("invokes an already-resolved editor action without passing provider path text", () => {
    const onOpenEditor = vi.fn();
    render(<DiffViewer change={change()} onOpenEditor={onOpenEditor} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onOpenEditor).toHaveBeenCalledWith();
  });

  it("names the region the file disclosure controls and unmounts it when collapsed", () => {
    const { container } = render(<DiffViewer change={change()} />);
    const disclosure = screen.getByRole("button", { name: "file.txt" });

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const controls = disclosure.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(controls!)}`)).toContainElement(line(container, "add"));

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).not.toHaveAttribute("aria-controls");
    expect(container.querySelector('[data-diff-line="add"]')).toBeNull();
  });

  it("marks every sub-44px viewer control for coarse-pointer expansion", () => {
    render(<DiffViewer change={change()} onOpenEditor={vi.fn()} onReadChange={vi.fn()} />);
    for (const name of ["file.txt", "Copy diff for file.txt", "unified", "split", "Open in editor", "Mark read"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("data-compact-control");
    }
  });
});
