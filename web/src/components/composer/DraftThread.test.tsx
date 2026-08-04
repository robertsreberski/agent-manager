import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DraftThread } from "./DraftThread";
import { newDraftSession } from "./draft";

describe("DraftThread", () => {
  it("selects only models returned by the live provider catalog", () => {
    const dispatch = vi.fn();
    render(<DraftThread
      draft={{ ...newDraftSession({ workspace: { hostId: "local", path: "/work/project" } }), text: "Start" }}
      hosts={[{ id: "local", label: "This Mac", kind: "local", sshTarget: null, status: "online", statusMessage: null }]}
      workspaces={[]}
      busy={false}
      mutationsReady
      modelOptions={[{ value: "gpt-live", label: "GPT Live", description: "Returned by the provider", isDefault: true, defaultEffort: "xhigh", efforts: ["high", "xhigh", "ultra"] }]}
      modelOptionsStatus={null}
      effortOptions={["high", "xhigh", "ultra"]}
      dispatch={dispatch}
      onFirstSend={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /codex/i }));
    expect(screen.getByRole("menuitemradio", { name: "ultra effort" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "medium effort" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT Live/u }));
    expect(dispatch).toHaveBeenCalledWith({ type: "set-model", model: "gpt-live" });
    expect(screen.queryByText("default-model")).not.toBeInTheDocument();
  });
});
