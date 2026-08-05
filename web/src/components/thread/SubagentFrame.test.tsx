import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ACTIVITY_SCHEMA_VERSION, type ActivityItem, type ActivitySubagentItem } from "../../types";
import { SubagentFrame } from "./GroupedActivityParts";
import type { SubagentFrameData } from "./subagent";

const common = {
  schemaVersion: ACTIVITY_SCHEMA_VERSION,
  sessionId: "local:claude:thread",
  provider: "claude" as const,
  turnId: "turn-1",
  revision: 1,
  state: "complete" as const,
  startedAt: "2026-08-04T10:00:00.000Z",
  updatedAt: "2026-08-04T10:00:01.000Z",
  completedAt: "2026-08-04T10:00:01.000Z",
  source: "provider-api" as const,
  confidence: "exact" as const,
  exposure: "provider-exposed" as const,
  truncated: false,
};

describe("SubagentFrame", () => {
  it("renders the brief, direct steps, nested count, output, and exact return facts", () => {
    const item: ActivitySubagentItem = {
      ...common, id: "sub", parentId: "spawn", seq: 1,
      kind: "subagent", taskId: "reviewer", name: "option-writer",
      description: "Rewrite the option list with hints.", output: "Three options returned.",
      childItemIds: ["read"],
    };
    const step: ActivityItem = {
      ...common, id: "read", parentId: "sub", seq: 2,
      kind: "tool", toolCallId: "read", name: "read_file", category: "command",
      arguments: { path: "src/options.ts" }, result: "loaded", output: "",
    };
    const data: SubagentFrameData = {
      item,
      steps: [step],
      nestedCount: 2,
      returnFacts: { additions: 12, removals: 3, tokens: 14_000, costUsd: 0.04 },
    };

    render(<SubagentFrame data={data} />);

    expect(screen.getByText("option-writer")).toBeInTheDocument();
    expect(screen.getByText("Rewrite the option list with hints.")).toBeInTheDocument();
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getByText("2 nested subagents")).toBeInTheDocument();
    expect(screen.getByText("Three options returned.")).toBeInTheDocument();
    expect(screen.getByText("returned to parent")).toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.getByText("−3")).toBeInTheDocument();
    expect(screen.getByText("14,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("$0.04")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /read_file/u })).toHaveAttribute("data-compact-control");
  });

  it("announces the reasoning disclosure's state and reveals the text on demand", () => {
    const item: ActivitySubagentItem = {
      ...common, id: "sub", parentId: "spawn", seq: 1,
      kind: "subagent", taskId: "reviewer", name: "reasoner",
      description: null, output: "", childItemIds: ["thought"],
    };
    const step: ActivityItem = {
      ...common, id: "thought", parentId: "sub", seq: 2,
      kind: "reasoning", reasoningKind: "summary", label: null, text: "Compare the exact provider facts.",
    };
    const data: SubagentFrameData = {
      item,
      steps: [step],
      nestedCount: 0,
      returnFacts: { additions: null, removals: null, tokens: null, costUsd: null },
    };

    render(<SubagentFrame data={data} />);

    const disclosure = screen.getByRole("button", { name: "Reasoning" });
    expect(disclosure).toHaveAttribute("data-compact-control");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Compare the exact provider facts.")).not.toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Compare the exact provider facts.")).toBeInTheDocument();
    // The disclosure names the region it controls, which a bare `<details>` never did.
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).toContainElement(
      screen.getByText("Compare the exact provider facts."),
    );
  });
});
