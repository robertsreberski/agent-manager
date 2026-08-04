import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { EMPTY_PALETTE_SOURCES } from "./registry";

describe("CommandPalette", () => {
  it("renders canonical session state, current todo, and n of m progress", () => {
    const { container } = render(<CommandPalette
      open
      sources={{
        ...EMPTY_PALETTE_SOURCES,
        sessions: [{
          id: "session:one",
          kind: "session",
          label: "Boole",
          detail: "Fixing the shared fixture",
          keywords: [],
          boardState: "working",
          progress: { completed: 2, total: 6 },
        }],
      }}
      onOpenChange={vi.fn()}
      onChoose={vi.fn()}
    />);

    expect(screen.getByRole("option", { name: /Boole.*Fixing the shared fixture.*2 of 6/u })).toHaveAttribute("data-compact-control");
    expect(container.querySelector("[data-palette-session-state='working']")).toHaveClass("rounded-full", "bg-[var(--text-muted)]");
    expect(container.querySelector("[data-palette-todo-progress]")).toHaveTextContent("2 of 6");
  });

  it("contains focus, consumes Escape before global handlers, and restores the opener", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open palette</button><CommandPalette open={open} sources={EMPTY_PALETTE_SOURCES} onOpenChange={setOpen} onChoose={vi.fn()} /></>;
    }
    const globalKeydown = vi.fn();
    window.addEventListener("keydown", globalKeydown);
    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open palette" });
      opener.focus();
      fireEvent.click(opener);
      const search = screen.getByPlaceholderText("Sessions, commands, # transcript…");
      expect(search).toHaveFocus();

      opener.focus();
      expect(search).toHaveFocus();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
      expect(globalKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", globalKeydown);
    }
  });
});
