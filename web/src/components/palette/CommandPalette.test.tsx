import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { EMPTY_PALETTE_SOURCES, type PaletteEntry } from "./registry";

const sessionEntry: PaletteEntry = {
  id: "session:one",
  kind: "session",
  label: "Boole",
  detail: "Fixing the shared fixture",
  keywords: [],
  boardState: "working",
  progress: { completed: 2, total: 6 },
};

function Harness({ sources = EMPTY_PALETTE_SOURCES, ...props }: Partial<React.ComponentProps<typeof CommandPalette>>) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open palette</button>
    <CommandPalette open={open} sources={sources} onOpenChange={setOpen} onChoose={vi.fn()} {...props} />
  </>;
}

describe("CommandPalette", () => {
  it("renders canonical session state, current todo, and n of m progress", async () => {
    render(<CommandPalette open sources={{ ...EMPTY_PALETTE_SOURCES, sessions: [sessionEntry] }} onOpenChange={vi.fn()} onChoose={vi.fn()} />);

    const option = await screen.findByRole("option", { name: /Boole.*Fixing the shared fixture.*2 of 6/u });
    expect(option).toHaveAttribute("data-compact-control");
    expect(option.querySelector("[data-palette-session-state='working']")).toHaveClass("rounded-full", "bg-[var(--text-muted)]");
    expect(option.querySelector("[data-palette-todo-progress]")).toHaveTextContent("2 of 6");
  });

  it("opens as a modal dialog, closes on Escape, and restores the opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    opener.focus();
    fireEvent.click(opener);

    await screen.findByRole("dialog", { name: "Command palette" });
    // The board behind the palette is out of the accessibility tree while it is up.
    expect(opener.closest("[aria-hidden]")).not.toBeNull();
    const search = screen.getByPlaceholderText("Sessions, commands, # transcript…");
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("moves the active row with the arrow keys and chooses it with Enter", async () => {
    const onChoose = vi.fn();
    const onOpenChange = vi.fn();
    render(<CommandPalette
      open
      sources={{
        ...EMPTY_PALETTE_SOURCES,
        sessions: [sessionEntry, { ...sessionEntry, id: "session:two", label: "Church", detail: null }],
      }}
      onOpenChange={onOpenChange}
      onChoose={onChoose}
    />);

    const search = await screen.findByPlaceholderText("Sessions, commands, # transcript…");
    const [first, second] = screen.getAllByRole("option");
    await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));

    fireEvent.keyDown(search, { key: "ArrowDown" });
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    expect(first).toHaveAttribute("aria-selected", "false");
    // The active row is announced through aria-activedescendant rather than
    // left for a screen reader to infer from a hover style.
    expect(search).toHaveAttribute("aria-activedescendant", second!.id);

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: "session:two" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("never lets a withheld command be chosen", async () => {
    const onChoose = vi.fn();
    render(<CommandPalette
      open
      sources={{
        ...EMPTY_PALETTE_SOURCES,
        commands: [{ id: "command:review", kind: "command", label: "Review this turn's changes", detail: null, keywords: [], disabledReason: "No file changes in the selected turn" }],
      }}
      onOpenChange={vi.fn()}
      onChoose={onChoose}
    />);

    const option = await screen.findByRole("option", { name: /Review this turn's changes/u });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveAttribute("title", "No file changes in the selected turn");

    fireEvent.click(option);
    fireEvent.keyDown(screen.getByPlaceholderText("Sessions, commands, # transcript…"), { key: "Enter" });
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("answers a prefix whose source has nothing with no rows rather than guesses", async () => {
    const onQueryChange = vi.fn();
    render(<CommandPalette
      open
      sources={{ ...EMPTY_PALETTE_SOURCES, sessions: [sessionEntry] }}
      onOpenChange={vi.fn()}
      onChoose={vi.fn()}
      onQueryChange={onQueryChange}
    />);

    const search = await screen.findByPlaceholderText("Sessions, commands, # transcript…");
    // `#` routes to the transcript source. That source is empty here, so the
    // one session on file must not be offered as a near-enough answer.
    fireEvent.change(search, { target: { value: "#Boole" } });

    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    expect(screen.getByText("No results from the available sources.")).toBeInTheDocument();
    // App.tsx debounces its transcript search off this callback.
    expect(onQueryChange).toHaveBeenLastCalledWith("#Boole");
  });

  it("keeps registry matching authoritative instead of re-filtering the rows it returned", async () => {
    render(<CommandPalette
      open
      sources={{
        ...EMPTY_PALETTE_SOURCES,
        transcripts: [{ id: "transcript:1", kind: "transcript", label: "the fixture is shared", detail: "turn 3", keywords: [] }],
      }}
      onOpenChange={vi.fn()}
      onChoose={vi.fn()}
    />);

    const search = await screen.findByPlaceholderText("Sessions, commands, # transcript…");
    fireEvent.change(search, { target: { value: "#fixture" } });

    // The prefix character is part of the raw query and matches nothing in the
    // row itself; the row must survive anyway.
    await waitFor(() => expect(screen.getByRole("option", { name: /the fixture is shared/u })).toBeInTheDocument());
  });
});
