import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionComposer } from "./SessionComposer";

/** A real click is a pointerdown followed by a click; Radix triggers listen to the first. */
function click(element: Element): void {
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerId: 1 });
  fireEvent.click(element);
}

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

  it("shows only model choices returned by the live provider catalog", async () => {
    const onModelChange = vi.fn();
    renderComposer({
      canQueue: true,
      provider: "claude",
      model: "current-model",
      modelOptions: [{ value: "live-sonnet", label: "Sonnet", description: "Balanced" }],
      onModelChange,
    });

    click(screen.getByRole("button", { name: /claude/i }));
    const sonnet = await screen.findByRole("menuitemradio", { name: /Sonnet/ });
    expect(sonnet).toHaveTextContent("live-sonnet");
    expect(sonnet).toHaveTextContent("Balanced");
    expect(screen.queryByRole("menuitemradio", { name: /current-model/ })).not.toBeInTheDocument();

    fireEvent.click(sonnet);
    expect(onModelChange).toHaveBeenCalledWith("live-sonnet");
  });

  it("marks the model, effort, and profile already in force as the checked choice", async () => {
    renderComposer({
      canQueue: true,
      model: "live-sonnet",
      effort: "high",
      modelOptions: [
        { value: "live-sonnet", label: "Sonnet", description: null },
        { value: "live-opus", label: "Opus", description: null },
      ],
      effortOptions: ["low", "high"],
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      onProfileChange: vi.fn(),
    });

    click(screen.getByRole("button", { name: /codex/i }));
    expect(await screen.findByRole("menuitemradio", { name: /Sonnet/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Opus/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: "high effort" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "low effort" })).toHaveAttribute("aria-checked", "false");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    click(screen.getByRole("button", { name: /execute/i }));
    expect(await screen.findByRole("menuitemradio", { name: /Execute/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Plan/ })).toHaveAttribute("aria-checked", "false");
  });

  it("reports the chosen execution profile and keeps full access marked as the loudest choice", async () => {
    const onProfileChange = vi.fn();
    renderComposer({ canQueue: true, onProfileChange });

    click(screen.getByRole("button", { name: /execute/i }));
    const fullAccess = await screen.findByRole("menuitemradio", { name: /Full access/ });
    expect(fullAccess.className).toContain("var(--access)");

    fireEvent.click(fullAccess);
    expect(onProfileChange).toHaveBeenCalledWith("full-access");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Execution profile" })).not.toBeInTheDocument());
  });

  it("explains when the selected harness exposes no model catalog", async () => {
    renderComposer({ canQueue: true, modelOptionsStatus: "This provider does not expose a live model catalog.", onModelChange: vi.fn() });

    click(screen.getByRole("button", { name: /codex/i }));
    const menu = await screen.findByRole("menu", { name: "Harness, model, and effort" });
    expect(within(menu).getByRole("status")).toHaveTextContent("does not expose a live model catalog");
  });

  it("offers one explicit reset to configured defaults when supported", async () => {
    const onResetSettings = vi.fn();
    renderComposer({ canQueue: true, draft: true, onResetSettings });
    click(screen.getByRole("button", { name: /codex/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset to configured defaults" }));
    expect(onResetSettings).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Harness, model, and effort" })).not.toBeInTheDocument());
  });

  it("implements the documented composer and settings shortcuts", async () => {
    const onStop = vi.fn();
    renderComposer({ canQueue: true, canStop: true, onStop, onProfileChange: vi.fn(), onModelChange: vi.fn() });
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    expect(textarea).toHaveFocus();
    textarea.blur();

    fireEvent.keyDown(window, { key: "m" });
    expect(await screen.findByRole("menu", { name: "Execution profile" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Execution profile" })).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Harness, model, and effort" })).toBeInTheDocument();
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

  it("states every withheld reason as visible text, not only as a native tooltip", () => {
    renderComposer({
      modelChangeUnavailableReason: "The hook can observe the model but cannot change it.",
      effortChangeUnavailableReason: "The hook exposes no effort control.",
      profileChangeUnavailableReason: "The hook exposes no profile control.",
    });

    const reasons = document.querySelector<HTMLElement>("[data-withheld-reasons]");
    expect(reasons).toHaveTextContent("The hook can observe the model but cannot change it.");
    expect(reasons).toHaveTextContent("The hook exposes no profile control.");
    expect(reasons).toHaveAttribute("role", "status");
  });

  it("states one identical withheld reason once and never repeats the read-only sentence", () => {
    renderComposer({
      readOnlyReason: "This harness is observation-only.",
      modelChangeUnavailableReason: "This harness is observation-only.",
      profileChangeUnavailableReason: "This harness is observation-only.",
    });

    expect(screen.getAllByText("This harness is observation-only.")).toHaveLength(1);
    expect(document.querySelector("[data-withheld-reasons]")).toBeNull();
  });

  it("keeps a readable-but-unwritable model catalog inspectable", async () => {
    renderComposer({
      canQueue: true,
      modelOptions: [{ value: "gpt-live", label: "Live", description: null }],
      modelChangeUnavailableReason: "Model choices stay in the CLI that owns this session.",
    });

    const trigger = screen.getByRole("button", { name: /codex/i });
    expect(trigger).toBeEnabled();
    click(trigger);
    const menu = await screen.findByRole("menu", { name: "Harness, model, and effort" });
    expect(within(menu).getByRole("menuitemradio", { name: /Live/u })).toHaveAttribute("aria-disabled", "true");
    expect(menu).toHaveTextContent("Model choices stay in the CLI that owns this session.");
  });

  it("still disables the runtime menu when there is nothing to read or change", () => {
    renderComposer({ modelChangeUnavailableReason: "This harness does not expose live model changes." });
    expect(screen.getByRole("button", { name: /codex/i })).toBeDisabled();
  });

  it("opens the runtime menu from the keyboard and hands focus back to the trigger on Escape", async () => {
    renderComposer({ canQueue: true, onModelChange: vi.fn(), modelOptions: [{ value: "gpt-live", label: "Live", description: null }] });
    const trigger = screen.getByRole("button", { name: /codex/i });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Harness, model, and effort" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps unsupported attachment and dictation visible, disabled, and explained", () => {
    renderComposer();
    for (const [name, reason] of [
      ["Attach files unavailable", "Attachments are not supported by this harness"],
      ["Dictation unavailable", "Dictation is not configured"],
    ] as const) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute("title", reason);
    }
  });

  it("disables one send control rather than hiding it while the draft is unsendable", () => {
    renderComposer({ isRunning: false, canQueue: true, value: "   " });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
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
