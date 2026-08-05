import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DISCLOSURE_SCROLL_LOCK_MS, ToolCall, ToolGroupShell } from "./GroupedActivityParts";
import { TOOL_GROUP_ANIMATION_MS } from "../assistant-ui/tool-group";

const CODEX_TOOL_NAME = `/bin/zsh -lc "sed -n '1,260p' 'README.md' && rg --files -g '*.ts' | head -200"`;
const CODEX_ARGS = {
  command: CODEX_TOOL_NAME,
  workdir: "/Users/operator/Personal_Repositories/agent-manager/web/src/components/thread",
  yield_time_ms: 10_000,
  max_output_tokens: 8_000,
};

function classesOf(element: Element | null): string[] {
  return (element?.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean);
}

describe("tool call containment", () => {
  it("holds a shell-command tool name to a bound instead of forcing the row wide", () => {
    // Frame 11b asks for `flex-shrink: 0` so the name is never what gets
    // clipped. Unbounded, a Codex `commandExecution` — whose name is the whole
    // command — produced a 2551px row inside a 390px viewport.
    const { container } = render(<ToolCall part={{
      toolName: CODEX_TOOL_NAME,
      args: CODEX_ARGS,
      argsText: JSON.stringify(CODEX_ARGS, null, 2),
      result: "ok",
      status: { type: "complete" },
    }} />);

    const name = container.querySelector("[data-tool-name]");
    expect(name?.textContent).toBe(CODEX_TOOL_NAME);
    expect(classesOf(name)).toEqual(expect.arrayContaining(["min-w-0", "truncate", "shrink-0", "max-w-[60%]"]));

    const row = container.querySelector("[data-tool-status]");
    expect(classesOf(row)).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "overflow-hidden"]));

    const detail = container.querySelector("[data-tool-detail]");
    expect(classesOf(detail)).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "truncate"]));
  });

  it("summarises the collapsed detail instead of printing raw JSON", () => {
    const { container } = render(<ToolCall part={{
      toolName: "exec",
      args: { input: JSON.stringify(CODEX_ARGS) },
      argsText: JSON.stringify(CODEX_ARGS),
      status: { type: "complete" },
    }} />);

    const detail = container.querySelector("[data-tool-detail]");
    expect(detail?.textContent).toBe(CODEX_TOOL_NAME);
    expect(detail?.textContent?.startsWith("{")).toBe(false);
  });

  it("expands arguments as the provider's own named fields, not a JSON blob", () => {
    const { container } = render(<ToolCall part={{
      toolName: "exec",
      args: CODEX_ARGS,
      argsText: JSON.stringify(CODEX_ARGS, null, 2),
      result: "ok",
      status: { type: "complete" },
    }} />);

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const fields = [...container.querySelectorAll("[data-tool-arguments] [data-tool-argument]")];
    expect(fields.map((field) => field.getAttribute("data-tool-argument"))).toEqual([
      "command",
      "workdir",
      "yield_time_ms",
      "max_output_tokens",
    ]);
    // Each value is the provider's, verbatim — no escaping, no re-serialisation.
    expect(fields[0]?.textContent).toContain(CODEX_TOOL_NAME);
    expect(fields[2]?.textContent).toContain("10000");
    expect(container.querySelector("[data-tool-arguments]")?.textContent?.startsWith("{")).toBe(false);
  });

  it("wraps expanded argument and result blocks rather than widening the row", () => {
    const { container } = render(<ToolCall part={{
      toolName: "exec",
      args: { ...CODEX_ARGS, script: `${CODEX_TOOL_NAME}\n`.repeat(4) },
      argsText: JSON.stringify(CODEX_ARGS, null, 2),
      result: "x".repeat(4_000),
      status: { type: "complete" },
    }} />);

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const blocks = [...container.querySelectorAll("[data-tool-argument]")];
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      const contained = block.tagName === "PRE" ? block : block.querySelector("pre") ?? block;
      expect(classesOf(contained), block.getAttribute("data-tool-argument") ?? "").toEqual(expect.arrayContaining([
        "min-w-0",
        "max-w-full",
        "whitespace-pre-wrap",
        "[overflow-wrap:anywhere]",
      ]));
      expect(classesOf(contained)).not.toContain("overflow-x-auto");
    }
  });

  it("clamps a value long enough to bury the rows under it", () => {
    const prompt = "Investigate the failure.\n".repeat(40);
    const { container } = render(<ToolCall part={{
      toolName: "Agent",
      args: { subagent_type: "Explore", prompt },
      argsText: JSON.stringify({ prompt }, null, 2),
      status: { type: "complete" },
    }} />);

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const field = container.querySelector('[data-tool-argument="prompt"]');
    expect(classesOf(field?.querySelector("pre") ?? null)).toContain("max-h-32");

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(classesOf(field?.querySelector("pre") ?? null)).not.toContain("max-h-32");
  });

  it("keeps a running call collapsed so its arguments do not fill the drawer", () => {
    const { container } = render(<ToolCall part={{
      toolName: "Agent",
      args: { prompt: "x".repeat(4_000) },
      argsText: "",
      status: { type: "running" },
    }} />);

    expect(container.querySelector("[data-tool-arguments]")).toBeNull();
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });
});

describe("tool group containment", () => {
  it("constrains the open group body to its container width", () => {
    const { container } = render(
      <ToolGroupShell status={{ type: "complete" }} active={false} count={6} duration="2.5s">
        <span>call</span>
      </ToolGroupShell>,
    );

    expect(screen.getByText("6 tool calls")).toBeInTheDocument();
    const section = container.querySelector("[data-tool-group-status]");
    expect(classesOf(section)).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "overflow-hidden"]));

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const body = container.querySelector("[data-tool-group-body]");
    expect(classesOf(body)).toEqual(expect.arrayContaining([
      "grid",
      "grid-cols-[minmax(0,1fr)]",
      "min-w-0",
      "max-w-full",
    ]));
  });

  /*
    jsdom has no layout, so "nothing exceeds 390px" cannot be measured. It can
    be asserted in the only vocabulary that decides it: an expanded group must
    contain no track that sizes to max-content, no horizontal scroller, and no
    unbreakable run — the three ways a 2.5k-character Codex command has widened
    this drawer before.
  */
  it("expands the whole grammar without a single max-content escape hatch", () => {
    const { container } = render(
      <ToolGroupShell status={{ type: "complete" }} active={false} count={1} duration="2.5s">
        <ToolCall part={{
          toolName: CODEX_TOOL_NAME,
          args: CODEX_ARGS,
          argsText: JSON.stringify(CODEX_ARGS, null, 2),
          result: "y".repeat(2_500),
          status: { type: "complete" },
        }} />
      </ToolGroupShell>,
    );

    // The group mounts its rows only once open, so expansion is two passes.
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(2);

    for (const element of container.querySelectorAll<HTMLElement>("*")) {
      const classes = classesOf(element);
      for (const escapeHatch of ["w-max", "min-w-max", "w-fit", "overflow-x-auto", "overflow-x-scroll"]) {
        expect(classes, `${element.tagName} carries ${escapeHatch}`).not.toContain(escapeHatch);
      }
      // `truncate` implies nowrap, and is only safe on a `min-w-0` flex/grid child.
      if (classes.includes("whitespace-nowrap") || classes.includes("truncate")) {
        expect(classes, `${element.tagName} clips without min-w-0`).toContain("min-w-0");
      }
      for (const track of classes.filter((name) => name.startsWith("grid-cols-"))) {
        expect(track).toBe("grid-cols-[minmax(0,1fr)]");
      }
    }
  });

  it("keeps an active group forced open", () => {
    render(
      <ToolGroupShell status={{ type: "running" }} active count={1} duration={null}>
        <span>call</span>
      </ToolGroupShell>,
    );
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  /*
    Every call in a run reads `complete` in the gap between one result and the
    next call landing. Deriving the hold from the parts alone collapsed the panel
    in every one of those gaps and reopened it on the next call — once per tool,
    for the length of the turn. `active` is the caller's answer to "is this run
    still in motion", and it outranks the settled status.
  */
  it("holds a settled run open while its turn is still in motion", () => {
    render(
      <ToolGroupShell status={{ type: "complete" }} active count={3} duration="2.5s">
        <span>call</span>
      </ToolGroupShell>,
    );

    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
    // A span is a fact about a finished run. Printed beside the `active` chip it
    // blinked in during every gap, because that is exactly when every call in
    // the group has reported a completion time.
    expect(screen.queryByText("2.5s")).not.toBeInTheDocument();
  });

  it("ignores a toggle while the run is held open", () => {
    render(
      <ToolGroupShell status={{ type: "complete" }} active count={3} duration={null}>
        <span>call</span>
      </ToolGroupShell>,
    );

    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });
});

/*
  Collapsing a disclosure removes height from the middle of the transcript, and
  the drawer's scroll container reacts by moving everything the operator was
  reading. These assert the behaviour, not the hook: the surrounding scroll
  offset survives the toggle, and it is the operator's again straight after.
*/
describe("transcript scroll stability", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const stage of document.querySelectorAll("[data-test-transcript]")) stage.remove();
  });

  function scrollableStage(): HTMLDivElement {
    const stage = document.createElement("div");
    stage.setAttribute("data-test-transcript", "");
    stage.style.overflowY = "auto";
    document.body.append(stage);
    return stage;
  }

  it("holds the surrounding scroll offset across a tool-group collapse, then releases it", () => {
    vi.useFakeTimers();
    const transcript = scrollableStage();
    render(
      <ToolGroupShell status={{ type: "complete" }} active={false} count={6} duration="2.5s">
        <span>call</span>
      </ToolGroupShell>,
      { container: transcript },
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    transcript.scrollTop = 420;

    fireEvent.click(screen.getByRole("button", { expanded: true }));
    // What the browser does when the group's body stops taking up room.
    transcript.scrollTop = 96;
    fireEvent.scroll(transcript);
    expect(transcript.scrollTop).toBe(420);

    // The group's panel now animates its height, so the lock has to outlive the
    // animation rather than just the reflow a bare disclosure caused.
    vi.advanceTimersByTime(TOOL_GROUP_ANIMATION_MS + 1);
    transcript.scrollTop = 96;
    fireEvent.scroll(transcript);
    expect(transcript.scrollTop).toBe(96);
  });

  it("holds it across a single tool row collapsing too", () => {
    vi.useFakeTimers();
    const transcript = scrollableStage();
    render(
      <ToolCall part={{ toolName: "exec", args: { command: "ls" }, argsText: "{}", result: "ok", status: { type: "complete" } }} />,
      { container: transcript },
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    transcript.scrollTop = 310;

    fireEvent.click(screen.getByRole("button", { expanded: true }));
    transcript.scrollTop = 40;
    fireEvent.scroll(transcript);
    expect(transcript.scrollTop).toBe(310);
  });
});
