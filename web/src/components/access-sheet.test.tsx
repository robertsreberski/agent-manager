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
    expect(await screen.findByText("Native attachment unavailable")).toBeInTheDocument();
    expect(screen.getByText("This legacy session has no supported attach path.")).toBeInTheDocument();
    expect(screen.queryByText("Open in the native CLI")).not.toBeInTheDocument();
  });
});
