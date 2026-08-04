import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { normalizeSession } from "../lib/normalize";
import { AccessSheet } from "./access-sheet";

describe("AccessSheet", () => {
  it("renders an explicit unavailable state for a non-attachable session", async () => {
    const session = normalizeSession({
      id: "claude:external",
      provider: "claude",
      control: { capabilities: ["attach"] },
    });
    const loadAttach = vi.fn().mockResolvedValue({
      available: false,
      kind: "none",
      command: null,
      description: "This legacy session has no supported attach path.",
    });

    render(
      <AccessSheet
        session={session}
        open
        onOpenChange={() => undefined}
        loadPreview={vi.fn()}
        loadAttach={loadAttach}
      />,
    );

    await waitFor(() => expect(loadAttach).toHaveBeenCalledOnce());
    expect(await screen.findByText("Attach unavailable")).toBeInTheDocument();
    expect(screen.getByText("This legacy session has no supported attach path.")).toBeInTheDocument();
    expect(screen.getByText("Session details")).toBeInTheDocument();
    expect(screen.getByText("claude:external")).toBeInTheDocument();
    expect(screen.queryByText("Attach in terminal")).not.toBeInTheDocument();
  });

  it("shows the durable access mode without exposing lease controls", () => {
    const session = normalizeSession({
      id: "codex:managed",
      provider: "codex",
      cwd: "/tmp/project",
      ownership: "manager",
      control: { plane: "codex-app-server", capabilities: [] },
      access: { accessMode: "sandboxed", permissionMode: "default", sandboxMode: "workspace-write" },
    });
    render(
      <AccessSheet
        session={session}
        open
        onOpenChange={() => undefined}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    expect(screen.getByText("/tmp/project")).toBeInTheDocument();
    expect(screen.getByText("codex-app-server")).toBeInTheDocument();
    expect(screen.getByText("Sandboxed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /control/i })).not.toBeInTheDocument();
  });
});
