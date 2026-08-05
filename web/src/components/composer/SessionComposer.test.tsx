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

  it("checks the catalog row that covers the session's resolved model", async () => {
    const onModelChange = vi.fn();
    const onEffortChange = vi.fn();
    renderComposer({
      canQueue: true,
      provider: "claude",
      // The provider states the wire id; the catalog lists alias rows.
      model: "claude-sonnet-5",
      effort: "high",
      modelOptions: [
        { value: "sonnet", label: "Sonnet", description: null, resolvedModel: "claude-sonnet-5", efforts: ["low", "high"] },
        { value: "opus", label: "Opus", description: null, resolvedModel: "claude-opus-5", efforts: ["medium", "max"] },
      ],
      onModelChange,
      onEffortChange,
    });

    click(screen.getByRole("combobox", { name: /claude/i }));
    const sonnet = await screen.findByRole("option", { name: /Sonnet/ });
    expect(sonnet).toHaveAttribute("aria-selected", "true");
    // The check glyph marks the covering row; the other row carries none.
    expect(sonnet.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("option", { name: /Opus/ }).querySelector("svg")).toBeNull();
    // Efforts come from the covering row, not from a failed exact match.
    expect(screen.getByRole("radio", { name: /high/i })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /low/i }));
    expect(onEffortChange).toHaveBeenCalledWith("low");
    fireEvent.click(screen.getByRole("option", { name: /Opus/ }));
    expect(onModelChange).toHaveBeenCalledWith("opus");
  });

  it("checks no model row while the session model is unknown", async () => {
    renderComposer({
      canQueue: true,
      model: null,
      modelOptions: [
        { value: "sonnet", label: "Sonnet", description: null },
        { value: "opus", label: "Opus", description: null },
      ],
      onModelChange: vi.fn(),
    });

    click(screen.getByRole("combobox", { name: /codex/i }));
    // An unknown model must not silently present the first row as chosen.
    // cmdk still highlights a row for the keyboard (aria-selected); what must
    // not appear is the check glyph claiming a selection the session never made.
    const sonnet = await screen.findByRole("option", { name: /Sonnet/ });
    expect(sonnet.querySelector("svg")).toBeNull();
    expect(screen.getByRole("option", { name: /Opus/ }).querySelector("svg")).toBeNull();
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

  it("sets the Codex sandbox separately from the execution profile", async () => {
    const onSandboxChange = vi.fn();
    const onProfileChange = vi.fn();
    renderComposer({
      canQueue: true,
      profile: "full-access",
      sandbox: { mode: "workspace-write", networkAccess: false },
      onSandboxChange,
      onProfileChange,
    });

    // Full access is the profile's business; the sandbox says "Workspace".
    expect(screen.getByRole("button", { name: /Full access/ })).toBeInTheDocument();
    click(screen.getByRole("button", { name: /^Workspace/ }));
    const danger = await screen.findByRole("menuitemradio", { name: /Danger: full access/ });
    expect(danger.className).toContain("var(--access)");

    fireEvent.click(danger);
    expect(onSandboxChange).toHaveBeenCalledWith({ mode: "danger-full-access", networkAccess: true });
    expect(onProfileChange).not.toHaveBeenCalled();
  });

  it("offers network access only for the sandbox that can have it", async () => {
    const onSandboxChange = vi.fn();
    const { rerender } = render(<SessionComposer value="Keep this" onChange={vi.fn()} onSend={vi.fn()} isRunning={false} canQueue canSteer={false} canStop={false} provider="codex" model="gpt" effort="medium" profile="execute" sandbox={{ mode: "read-only", networkAccess: false }} onSandboxChange={onSandboxChange} />);

    click(screen.getByRole("button", { name: /Read-only/ }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Network access" }))
      .toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(document.body, { key: "Escape" });

    rerender(<SessionComposer value="Keep this" onChange={vi.fn()} onSend={vi.fn()} isRunning={false} canQueue canSteer={false} canStop={false} provider="codex" model="gpt" effort="medium" profile="execute" sandbox={{ mode: "workspace-write", networkAccess: false }} onSandboxChange={onSandboxChange} />);
    click(screen.getByRole("button", { name: /^Workspace/ }));
    const network = await screen.findByRole("menuitemcheckbox", { name: "Network access" });
    expect(network).toBeEnabled();
    fireEvent.click(network);
    expect(onSandboxChange).toHaveBeenCalledWith({ mode: "workspace-write", networkAccess: true });
  });

  it("shows no sandbox control for a harness that has no sandbox", () => {
    renderComposer({ provider: "claude", canQueue: true, sandbox: null, onSandboxChange: vi.fn() });
    expect(screen.queryByRole("button", { name: /Sandbox|Workspace|Read-only/ })).not.toBeInTheDocument();
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
    // Stated once, in the menu, where it can be read. A row that is disabled
    // and silent is indistinguishable from a control that is simply broken.
    expect(within(menu).getByRole("status")).toHaveTextContent(
      "Model choices stay in the CLI that owns this session.",
    );
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

  it("keeps the unsupported attachment visible, disabled, and explained", () => {
    renderComposer();
    const control = screen.getByRole("button", { name: "Attach files unavailable" });
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute("title", "Attachments are not supported yet — tracked in #6");
  });

  // Dictation has no path forward, so it was removed rather than left disabled.
  // A dead control that can never become live is noise, not an honest capability.
  it("renders no dictation control at all", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: /dictation/iu })).not.toBeInTheDocument();
  });

  it("disables one send control rather than hiding it while the draft is unsendable", () => {
    renderComposer({ isRunning: false, canQueue: true, value: "   " });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
  });

  it("groups every control into a composer-width responsive toolbar", () => {
    renderComposer({
      model: "gpt-5.6-sol",
      effort: "max",
      effortOptions: ["low", "medium", "high", "max"],
      profile: "full-access",
      sandbox: null,
      onProfileChange: vi.fn(),
      onSandboxChange: vi.fn(),
    });

    const composer = document.querySelector<HTMLElement>("[data-session-composer]");
    const toolbar = document.querySelector<HTMLElement>("[data-composer-toolbar]");
    const runtime = toolbar?.querySelector<HTMLElement>(".composer-toolbar__runtime");
    const policies = toolbar?.querySelector<HTMLElement>(".composer-toolbar__policies");
    const actions = toolbar?.querySelector<HTMLElement>(".composer-toolbar__actions");

    expect(composer).toHaveClass("w-full", "min-w-0", "max-w-full");
    expect(toolbar).toHaveClass("min-w-0", "max-w-full");
    expect(runtime).toContainElement(screen.getByRole("combobox", { name: /gpt-5\.6-sol/i }));
    expect(runtime).toContainElement(screen.getByRole("img", { name: /Max effort/u }));
    expect(policies).toContainElement(screen.getByRole("button", { name: /Full access/u }));
    expect(policies).toContainElement(screen.getByRole("button", { name: /Sandbox unknown/u }));
    expect(policies?.querySelectorAll(".composer-wide-separator")).toHaveLength(2);
    expect(actions).toContainElement(screen.getByRole("button", { name: "Queue message" }));
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
