import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./use-modal-focus";

function Modal({ active, name, onEscape, priority = 0 }: { active: boolean; name: string; onEscape: () => void; priority?: number }) {
  const initialRef = useRef<HTMLButtonElement>(null);
  const modalRef = useModalFocus<HTMLElement>({ active, initialFocusRef: initialRef, onEscape, priority });
  if (!active) return null;
  return <section ref={modalRef} role="dialog" aria-label={name} tabIndex={-1}><button ref={initialRef}>First {name}</button><button>Last {name}</button></section>;
}

function ToggleModal() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open modal</button><Modal active={open} name="test" onEscape={() => setOpen(false)} /></>;
}

describe("useModalFocus", () => {
  it("contains focus, wraps Tab, closes on Escape, and restores the opener", () => {
    render(<><ToggleModal /><button>Outside</button></>);
    const opener = screen.getByRole("button", { name: "Open modal" });
    opener.focus();
    fireEvent.click(opener);

    const first = screen.getByRole("button", { name: "First test" });
    const last = screen.getByRole("button", { name: "Last test" });
    expect(first).toHaveFocus();
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    screen.getByRole("button", { name: "Outside" }).focus();
    expect(first).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "test" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("lets only the highest-priority layer consume Escape", () => {
    const lowEscape = vi.fn();
    const highEscape = vi.fn();
    const globalEscape = vi.fn();
    window.addEventListener("keydown", globalEscape);
    const { rerender } = render(<><Modal active name="low" priority={10} onEscape={lowEscape} /><Modal active name="high" priority={20} onEscape={highEscape} /></>);

    expect(screen.getByRole("button", { name: "First high" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(highEscape).toHaveBeenCalledOnce();
    expect(lowEscape).not.toHaveBeenCalled();
    expect(globalEscape).not.toHaveBeenCalled();

    rerender(<><Modal active name="low" priority={10} onEscape={lowEscape} /><Modal active={false} name="high" priority={20} onEscape={highEscape} /></>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(lowEscape).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", globalEscape);
  });
});
