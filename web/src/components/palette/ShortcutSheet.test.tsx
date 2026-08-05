import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ShortcutSheet } from "./ShortcutSheet";

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open shortcuts</button><ShortcutSheet open={open} onClose={() => setOpen(false)} /></>;
}

describe("ShortcutSheet", () => {
  it("contains focus, closes on Escape, and restores its opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open shortcuts" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // The board behind the sheet is out of the accessibility tree while it is up.
    expect(opener.closest("[aria-hidden]")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("prints every chord as its own key cap next to what it does", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open shortcuts" }));

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const caps = [...dialog.querySelectorAll("dt")].map((term) => [...term.querySelectorAll("kbd")].map((cap) => cap.textContent));
    expect(caps).toContainEqual(["⌘K"]);
    // "J / K" is two caps around a separator, not one three-character cap.
    expect(caps).toContainEqual(["J", "K"]);
    expect(dialog.querySelectorAll("dl").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByRole("definition").length).toBe(caps.length);
    expect(within(dialog).getByText("Next / previous session")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
  });
});
