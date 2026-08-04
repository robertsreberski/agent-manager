import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutSheet } from "./ShortcutSheet";

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open shortcuts</button><ShortcutSheet open={open} onClose={() => setOpen(false)} /></>;
}

describe("ShortcutSheet", () => {
  it("contains focus, consumes Escape, and restores its opener", () => {
    const globalKeydown = vi.fn();
    window.addEventListener("keydown", globalKeydown);
    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open shortcuts" });
      opener.focus();
      fireEvent.click(opener);
      const close = screen.getByRole("button", { name: "Close shortcuts" });
      expect(close).toHaveFocus();
      expect(close).toHaveAttribute("data-compact-control");

      opener.focus();
      expect(close).toHaveFocus();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
      expect(globalKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", globalKeydown);
    }
  });
});
