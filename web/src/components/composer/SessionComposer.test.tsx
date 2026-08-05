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

  it("fills the harness tile and the reached effort bars lime, as frames 5a and 9a-2 show", () => {
    renderComposer({ effort: "medium", effortOptions: ["low", "medium", "high", "max"] });
    expect(document.querySelector<HTMLElement>("[data-provider-mark]"))
      .toHaveClass("bg-[var(--accent)]", "text-[var(--accent-ink)]");

    // Only the bars the effort actually reaches. An unreached bar staying lime
    // would make every effort level look like the highest one.
    const bars = [...document.querySelectorAll<HTMLElement>("[data-effort-bar]")];
    expect(bars.map((bar) => bar.dataset.effortBar)).toEqual(["active", "active", "inactive", "inactive"]);
    expect(bars.map((bar) => bar.style.height)).toEqual(["5px", "7px", "9px", "11px"]);
    expect(bars.filter((bar) => bar.className.includes("var(--accent)"))).toHaveLength(2);
  });

  it.each([
    ["max", ["medium", "high", "max", "ultra"], 3, "Max"],
    ["ultra", ["high", "xhigh", "max", "ultra"], 4, "Ultra"],
  ] as const)("shows the %s label beside its model-specific meter", (effort, effortOptions, activeCount, label) => {
    renderComposer({ effort, effortOptions });

    const bars = [...document.querySelectorAll<HTMLElement>("[data-effort-bar]")];
    expect(bars).toHaveLength(effortOptions.length);
    expect(bars.filter((bar) => bar.dataset.effortBar === "active")).toHaveLength(activeCount);
    expect(screen.getByText(label)).toHaveAttribute("data-effort-word");
  });

  it("uses a word-only effort fallback when the selected model scale is unavailable", () => {
    renderComposer({ effort: "high", effortOptions: [] });

    expect(document.querySelectorAll("[data-effort-bar]")).toHaveLength(0);
    expect(document.querySelector("[data-effort-meter='word-only']")).toHaveTextContent("High");
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

    click(screen.getByRole("combobox", { name: /claude/i }));
    const sonnet = await screen.findByRole("option", { name: /Sonnet/ });
    expect(sonnet).toHaveTextContent("live-sonnet");
    expect(sonnet).toHaveTextContent("Balanced");
    expect(screen.queryByRole("option", { name: /current-model/ })).not.toBeInTheDocument();

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

    click(screen.getByRole("combobox", { name: /codex/i }));
    // A cmdk option reports selection as aria-selected; the effort picker
    // beside it is a real radiogroup and reports aria-checked.
    expect(await screen.findByRole("option", { name: /Sonnet/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Opus/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("radio", { name: /high/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /low/i })).toHaveAttribute("aria-checked", "false");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Sonnet/ })).not.toBeInTheDocument());

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

    click(screen.getByRole("combobox", { name: /codex/i }));
    const menu = await screen.findByRole("dialog", { name: "Harness, model, and effort" });
    expect(within(menu).getByRole("status")).toHaveTextContent("does not expose a live model catalog");
  });

  it("offers one explicit reset to configured defaults when supported", async () => {
    const onResetSettings = vi.fn();
    renderComposer({ canQueue: true, draft: true, onResetSettings });
    click(screen.getByRole("combobox", { name: /codex/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Reset to configured defaults" }));
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
    expect(await screen.findByRole("dialog", { name: "Harness, model, and effort" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("disables absent live settings with the exact withheld reason", () => {
    renderComposer({
      modelChangeUnavailableReason: "The hook can observe the model but cannot change it.",
      effortChangeUnavailableReason: "The hook exposes no effort control.",
      profileChangeUnavailableReason: "The hook exposes no profile control.",
    });

    expect(screen.getByRole("combobox", { name: /codex/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /codex/i })).toHaveAttribute("title", "The hook can observe the model but cannot change it.");
    expect(screen.getByRole("button", { name: /execute/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /execute/i })).toHaveAttribute("title", "The hook exposes no profile control.");
  });

  it("keeps withheld reasons on the controls without rendering a reason wall", () => {
    renderComposer({
      modelChangeUnavailableReason: "The hook can observe the model but cannot change it.",
      effortChangeUnavailableReason: "The hook exposes no effort control.",
      profileChangeUnavailableReason: "The hook exposes no profile control.",
    });

    expect(document.querySelector("[data-withheld-reasons]")).toBeNull();
    expect(screen.getByRole("combobox", { name: /codex/i })).toHaveAttribute(
      "aria-description",
      "The hook can observe the model but cannot change it.",
    );
    expect(screen.getByRole("button", { name: /execute/i })).toHaveAttribute(
      "aria-description",
      "The hook exposes no profile control.",
    );
  });

  it("uses the read-only reason only as state and does not repeat it as copy", () => {
    renderComposer({
      readOnlyReason: "This harness is observation-only.",
      modelChangeUnavailableReason: "This harness is observation-only.",
      profileChangeUnavailableReason: "This harness is observation-only.",
    });

    expect(screen.queryByText("This harness is observation-only.")).not.toBeInTheDocument();
    expect(document.querySelector("[data-withheld-reasons]")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "");
  });

  it("keeps a readable-but-unwritable model catalog inspectable", async () => {
    renderComposer({
      canQueue: true,
      modelOptions: [{ value: "gpt-live", label: "Live", description: null }],
      modelChangeUnavailableReason: "Model choices stay in the CLI that owns this session.",
    });

    const trigger = screen.getByRole("combobox", { name: /codex/i });
    expect(trigger).toBeEnabled();
    click(trigger);
    const menu = await screen.findByRole("dialog", { name: "Harness, model, and effort" });
    const option = within(menu).getByRole("option", { name: /Live/u });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveAttribute(
      "title",
      "Model choices stay in the CLI that owns this session.",
    );
    expect(option).toHaveAttribute(
      "aria-description",
      "Model choices stay in the CLI that owns this session.",
    );
    expect(menu).not.toHaveTextContent("Model choices stay in the CLI that owns this session.");
  });

  it("still disables the runtime menu when there is nothing to read or change", () => {
    renderComposer({ modelChangeUnavailableReason: "This harness does not expose live model changes." });
    expect(screen.getByRole("combobox", { name: /codex/i })).toBeDisabled();
  });

  it("opens the runtime picker from the keyboard and hands focus back to the trigger on Escape", async () => {
    renderComposer({ canQueue: true, onModelChange: vi.fn(), modelOptions: [{ value: "gpt-live", label: "Live", description: null }] });
    const trigger = screen.getByRole("combobox", { name: /codex/i });
    trigger.focus();

    // A combobox opens on the arrows, which is what the trigger binds; Enter
    // reaches it as a click, and jsdom does not synthesize that from a keydown.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("option", { name: /Live/u });
    const menu = document.querySelector<HTMLElement>('[data-slot="model-selector-content"]')!;
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Live/u })).not.toBeInTheDocument());
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
      screen.getByRole("combobox", { name: /codex/i }),
      screen.getByRole("button", { name: /execute/i }),
      screen.getByRole("button", { name: "Send message" }),
    ]) expect(control).toHaveAttribute("data-compact-control");
    unmount();

    render(<SessionComposer value="" onChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} isRunning canQueue canSteer={false} canStop provider="codex" model="gpt" effort="medium" profile="execute" />);
    expect(screen.getByRole("button", { name: "Stop turn" })).toHaveAttribute("data-compact-control");
  });
});
