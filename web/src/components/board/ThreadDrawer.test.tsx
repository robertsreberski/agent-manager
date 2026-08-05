import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadDrawer } from "./ThreadDrawer";

function TypingHarness() {
  const [value, setValue] = useState("");
  return (
    <ThreadDrawer
      open
      title="Session"
      onClose={() => undefined}
      composer={<textarea aria-label="Message" value={value} onChange={(event) => setValue(event.target.value)} />}
    >
      Thread activity
    </ThreadDrawer>
  );
}

describe("ThreadDrawer", () => {
  it("uses an opaque isolated full-screen surface on phones and the split drawer at desktop width", () => {
    const { container } = render(
      <ThreadDrawer open title="Session" onClose={vi.fn()} composer={<div>Composer</div>}>
        <div>Thread activity</div>
      </ThreadDrawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Session" });
    expect(dialog.tagName).toBe("DIV");
    expect(dialog).toHaveAttribute("data-phone-surface", "fullscreen");
    expect(dialog).toHaveAttribute("data-desktop-surface", "drawer");
    expect(dialog).toHaveClass(
      "fixed",
      "inset-0",
      "z-50",
      "isolate",
      "max-w-none",
      "overflow-hidden",
      "bg-[var(--ground)]",
      "min-[901px]:absolute",
      "min-[901px]:left-auto",
      "min-[901px]:right-0",
      "min-[901px]:max-w-[760px]",
      "min-[901px]:bg-[var(--drawer,var(--ground))]",
      "min-[901px]:motion-safe:animate-[p-in_160ms_ease-out]",
    );
    expect(dialog).not.toHaveClass("motion-safe:animate-[p-in_160ms_ease-out]");
    expect(container.querySelector("[data-thread-header]")).toHaveClass("shrink-0", "bg-inherit");
    expect(container.querySelector("[data-thread-content]")).toHaveClass("min-h-0", "flex-1", "bg-inherit");
    expect(container.querySelector("[data-thread-composer]")).toHaveClass("shrink-0", "bg-inherit");
  });

  it("stays in the tree it was rendered into rather than portalling to the page root", () => {
    // Spec 05 R7: the drawer overlays the board region only. A portalled sheet
    // would become a sibling of the header and swallow every header control.
    const { container } = render(
      <div data-board-region className="relative">
        <ThreadDrawer open title="Session" onClose={vi.fn()}>Thread activity</ThreadDrawer>
      </div>,
    );
    const drawer = screen.getByRole("dialog", { name: "Session" });
    expect(drawer.parentElement).toBe(container.querySelector("[data-board-region]"));
  });

  it("leaves the board behind it reachable instead of blocking it with a scrim", () => {
    render(
      <>
        <button type="button">Board card</button>
        <ThreadDrawer open title="Session" onClose={vi.fn()}>Thread activity</ThreadDrawer>
      </>,
    );
    // No scrim, and the board is not hidden from assistive tech: on desktop the
    // board stays clickable while the drawer is open.
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Board card" })).toBeInTheDocument();
  });

  it("closes on Escape and hands focus back to the control that opened it", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open session</button>
        <ThreadDrawer open={open} title="Session" onClose={() => setOpen(false)}>Thread activity</ThreadDrawer>
      </>;
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open session" });
    opener.focus();
    fireEvent.click(opener);

    const drawer = await screen.findByRole("dialog", { name: "Session" });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Session" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("closes from its own close control", async () => {
    const onClose = vi.fn();
    render(<ThreadDrawer open title="Session" onClose={onClose}>Thread activity</ThreadDrawer>);
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("does not leave an inert phone surface behind when closed", () => {
    render(<ThreadDrawer open={false} title="Session" onClose={vi.fn()}>Thread activity</ThreadDrawer>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps composer focus when a parent render supplies a fresh close callback", () => {
    render(<TypingHarness />);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    textarea.focus();

    fireEvent.change(textarea, { target: { value: "a" } });
    expect(textarea).toHaveValue("a");
    expect(textarea).toHaveFocus();
    fireEvent.change(textarea, { target: { value: "ab" } });

    expect(screen.getByRole("textbox", { name: "Message" })).toBe(textarea);
    expect(textarea).toHaveValue("ab");
    expect(textarea).toHaveFocus();
  });

  it("shows a header todo chip only when a real list exists", () => {
    const { rerender } = render(
      <ThreadDrawer
        open
        title="Session"
        todo={{ completed: 2, total: 6, current: "Fixing the fixture" }}
        onClose={vi.fn()}
      >
        Thread activity
      </ThreadDrawer>,
    );
    expect(screen.getByLabelText("2 of 6 todos completed")).toHaveTextContent("2 of 6");

    rerender(<ThreadDrawer open title="Session" todo={null} onClose={vi.fn()}>Thread activity</ThreadDrawer>);
    expect(screen.queryByLabelText(/todos completed/u)).not.toBeInTheDocument();
  });
});
