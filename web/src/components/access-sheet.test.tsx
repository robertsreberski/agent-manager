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
        lease={null}
        busy={false}
        mutationsReady
        onRelease={vi.fn(async () => undefined)}
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

  it("shows the writable lease in details and releases it there", async () => {
    const session = normalizeSession({
      id: "codex:managed",
      provider: "codex",
      cwd: "/tmp/project",
      ownership: "manager",
      control: { plane: "codex-app-server", capabilities: [] },
      access: { permissionMode: "default", sandboxMode: "workspace-write", fullHostAccess: false },
    });
    const onRelease = vi.fn(async () => undefined);
    render(
      <AccessSheet
        session={session}
        open
        onOpenChange={() => undefined}
        lease={{
          token: "lease",
          clientId: "browser",
          expiresAt: "2099-01-01T12:00:00.000Z",
          fullHostArmedUntil: null,
        }}
        busy={false}
        mutationsReady
        onRelease={onRelease}
        loadPreview={vi.fn()}
        loadAttach={vi.fn()}
      />,
    );

    expect(screen.getByText("/tmp/project")).toBeInTheDocument();
    expect(screen.getByText("codex-app-server")).toBeInTheDocument();
    screen.getByRole("button", { name: "Release control" }).click();
    await waitFor(() => expect(onRelease).toHaveBeenCalledOnce());
  });
});
