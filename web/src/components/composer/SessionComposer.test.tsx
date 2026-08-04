import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionComposer } from "./SessionComposer";

function renderComposer(overrides: Partial<React.ComponentProps<typeof SessionComposer>> = {}) {
  const onSend = vi.fn();
  render(<SessionComposer value="Keep this" onChange={vi.fn()} onSend={onSend} isRunning canQueue={false} canSteer={false} canStop={false} provider="codex" model="gpt" effort="medium" profile="execute" {...overrides} />);
  return onSend;
}

describe("SessionComposer", () => {
  it("prevents unsupported delivery without clearing the draft", () => {
    const onSend = renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Message" });
    expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("Keep this");
  });

  it("keeps live settings disabled when the provider only applies next-turn overrides", () => {
    renderComposer({ settingsIdleOnly: true, onProfileChange: vi.fn() });
    expect(screen.getByRole("button", { name: /execute/i })).toBeDisabled();
  });

  it("keeps provider identity and effort neutral instead of reusing wants-you lime", () => {
    renderComposer();
    const providerMark = document.querySelector<HTMLElement>("[data-provider-mark]");
    expect(providerMark).toHaveClass("bg-[var(--surface-selected-active)]", "text-[var(--text-muted)]");
    expect(providerMark).not.toHaveClass("bg-[var(--accent)]", "text-[var(--accent-ink)]");
    for (const bar of document.querySelectorAll<HTMLElement>("[data-effort-bar]")) {
      expect(bar.className).not.toContain("var(--accent)");
    }
  });

  it("shows only model choices returned by the live provider catalog", () => {
    const onModelChange = vi.fn();
    renderComposer({
      canQueue: true,
      provider: "claude",
      model: "current-model",
      modelOptions: [{ value: "live-sonnet", label: "Sonnet", description: "Balanced" }],
      onModelChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /claude/i }));
    expect(screen.getByRole("menuitemradio", { name: /Sonnet/ })).toHaveTextContent("live-sonnet");
    expect(screen.queryByRole("menuitemradio", { name: /current-model/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet/ }));
    expect(onModelChange).toHaveBeenCalledWith("live-sonnet");
  });

  it("explains when the selected harness exposes no model catalog", () => {
    renderComposer({ canQueue: true, modelOptionsStatus: "This provider does not expose a live model catalog.", onModelChange: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: /codex/i }));
    expect(screen.getByRole("status")).toHaveTextContent("does not expose a live model catalog");
  });

  it("offers one explicit reset to configured defaults when supported", () => {
    const onResetSettings = vi.fn();
    renderComposer({ canQueue: true, draft: true, onResetSettings });
    fireEvent.click(screen.getByRole("button", { name: /codex/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset to configured defaults" }));
    expect(onResetSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "Harness, model, and effort" })).not.toBeInTheDocument();
  });

  it("implements the documented composer and settings shortcuts", () => {
    const onStop = vi.fn();
    renderComposer({ canQueue: true, canStop: true, onStop, onProfileChange: vi.fn(), onModelChange: vi.fn() });
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    expect(textarea).toHaveFocus();
    textarea.blur();

    fireEvent.keyDown(window, { key: "m" });
    expect(screen.getByRole("menu", { name: "Execution profile" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Execution profile" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true });
    expect(screen.getByRole("menu", { name: "Harness, model, and effort" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("disables absent live settings with the exact withheld reason", () => {
    renderComposer({
      modelChangeUnavailableReason: "The hook can observe the model but cannot change it.",
      effortChangeUnavailableReason: "The hook exposes no effort control.",
      profileChangeUnavailableReason: "The hook exposes no profile control.",
    });

    expect(screen.getByRole("button", { name: /codex/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /codex/i })).toHaveAttribute("title", "The hook can observe the model but cannot change it.");
    expect(screen.getByRole("button", { name: /execute/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /execute/i })).toHaveAttribute("title", "The hook exposes no profile control.");
  });

  it("keeps Escape inside the open composer menu", () => {
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <SessionComposer value="Keep this" onChange={vi.fn()} onSend={vi.fn()} isRunning canQueue canSteer={false} canStop={false} provider="codex" model="gpt" effort="medium" profile="execute" onModelChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /codex/i }));
    expect(screen.getByRole("menu", { name: "Harness, model, and effort" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Harness, model, and effort" })).not.toBeInTheDocument();
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  it("marks every compact primary composer control for coarse-pointer expansion", () => {
    const { unmount } = render(<SessionComposer value="Send this" onChange={vi.fn()} onSend={vi.fn()} isRunning={false} canQueue canSteer={false} canStop={false} provider="codex" model="gpt" effort="medium" profile="execute" onModelChange={vi.fn()} onProfileChange={vi.fn()} />);
    for (const control of [
      screen.getByRole("button", { name: /codex/i }),
      screen.getByRole("button", { name: /execute/i }),
      screen.getByRole("button", { name: "Send message" }),
    ]) expect(control).toHaveAttribute("data-compact-control");
    unmount();

    render(<SessionComposer value="" onChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} isRunning canQueue canSteer={false} canStop provider="codex" model="gpt" effort="medium" profile="execute" />);
    expect(screen.getByRole("button", { name: "Stop turn" })).toHaveAttribute("data-compact-control");
  });
});
