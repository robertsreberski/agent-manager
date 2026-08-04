import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanArtifact } from "./PlanArtifact";
import type { PlanArtifactView } from "./model";

const plan: PlanArtifactView = {
  id: "plan-1",
  path: "/work/plan.md",
  version: 2,
  markdown: "# Exact plan\n\nDo the work.",
  writtenAt: "2026-08-04T12:00:00Z",
  supersededBy: null,
  approvedAt: null,
};

describe("PlanArtifact", () => {
  it("renders provider prose as safe markdown without turning it into rows", () => {
    const { container } = render(<PlanArtifact plan={{ ...plan, markdown: "# Exact plan\n\nKeep **this prose**.\n\n![tracker](https://example.test/pixel.png)\n\n<script>bad()</script>" }} />);
    expect(screen.getByRole("heading", { name: "Exact plan", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("this prose")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText("[image: tracker]")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("[data-plan-row]")).not.toBeInTheDocument();
  });

  it("exposes exact execute and send-back actions only when supplied", () => {
    const onExecute = vi.fn();
    const onSendBack = vi.fn();
    render(<PlanArtifact plan={plan} onExecute={onExecute} onSendBack={onSendBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Execute this plan" }));
    expect(onExecute).toHaveBeenCalledWith(plan);
    fireEvent.click(screen.getByRole("button", { name: "Send it back with notes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), { target: { value: "Keep the existing API." } });
    fireEvent.click(screen.getByRole("button", { name: "Send notes" }));
    expect(onSendBack).toHaveBeenCalledWith(plan, "Keep the existing API.");
  });

  it("does not invent plan actions without an exact request", () => {
    render(<PlanArtifact plan={plan} />);
    expect(screen.queryByRole("button", { name: "Execute this plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send it back/u })).not.toBeInTheDocument();
  });

  it("collapses when the exact approval is confirmed", () => {
    const { rerender } = render(<PlanArtifact plan={plan} onExecute={vi.fn()} />);
    expect(screen.getByText("Nothing has run — the profile is Plan.")).toBeInTheDocument();
    rerender(<PlanArtifact
      plan={{ ...plan, approvedAt: "2026-08-04T12:01:00.000Z" }}
      onExecute={vi.fn()}
    />);
    expect(screen.queryByText("Nothing has run — the profile is Plan.")).not.toBeInTheDocument();
    expect(screen.getByText(/approved/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execute this plan" })).not.toBeInTheDocument();
  });

  it("opens the strict path-backed file as one unversioned document with copy and download", async () => {
    const current = { ...plan, version: null };
    const loadFile = vi.fn(async () => ({
      sessionId: "local:claude:thread-1",
      itemId: current.id,
      path: current.path!,
      markdown: "# File on disk\n\nUse the exact filesystem prose.\n",
      truncated: false,
    }));
    render(<PlanArtifact plan={current} loadFile={loadFile} />);

    fireEvent.click(screen.getByRole("button", { name: "Open plan document" }));
    const view = await screen.findByRole("dialog", { name: "Plan document" });
    expect(loadFile).toHaveBeenCalledOnce();
    expect(loadFile).toHaveBeenCalledWith(current.id);
    expect(within(view).getByRole("heading", { name: "File on disk" })).toBeInTheDocument();
    expect(within(view).getByText("Use the exact filesystem prose.")).toBeInTheDocument();
    expect(within(view).getByRole("button", { name: "Copy plan path" })).toBeInTheDocument();
    expect(within(view).getByRole("link", { name: "Download plan file" })).toHaveAttribute("download", "plan.md");
    expect(within(view).queryByRole("tab")).not.toBeInTheDocument();
    expect(within(view).getByText("Current provider artifact · no preserved revision history reported")).toBeInTheDocument();
  });

  it("reports unavailable and truncated file reads without substituting inline prose", async () => {
    const unavailable = vi.fn(async () => { throw new Error("the registered plan file cannot be read safely"); });
    const { unmount } = render(<PlanArtifact plan={plan} loadFile={unavailable} />);
    fireEvent.click(screen.getByRole("button", { name: "Open plan document" }));
    const unavailableView = await screen.findByRole("dialog", { name: "Plan document" });
    expect(await within(unavailableView).findByRole("heading", { name: "Plan file unavailable" })).toBeInTheDocument();
    expect(within(unavailableView).getByText("the registered plan file cannot be read safely")).toBeInTheDocument();
    expect(within(unavailableView).getByText("No inline fallback is substituted for this filesystem read.")).toBeInTheDocument();
    unmount();

    render(<PlanArtifact plan={plan} onExecute={vi.fn()} loadFile={async () => ({
      sessionId: "local:claude:thread-1",
      itemId: plan.id,
      path: plan.path!,
      markdown: "# Retained prefix",
      truncated: true,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open plan document" }));
    expect(await screen.findByText("This file exceeded the safe read limit. Only its retained prefix is shown.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download retained plan prefix" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execute v2" })).toBeDisabled();
  });

  it("does not offer a file view when the provider supplied no path", () => {
    render(<PlanArtifact plan={{ ...plan, path: null, version: null }} loadFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Open plan document" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy plan path" })).not.toBeInTheDocument();
  });
});
