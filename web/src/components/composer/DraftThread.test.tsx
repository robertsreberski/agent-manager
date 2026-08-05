import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DraftThread } from "./DraftThread";
import { newDraftSession } from "./draft";

const hosts = [
  { id: "local", label: "This Mac", kind: "local", sshTarget: null, status: "online", statusMessage: null },
  { id: "build", label: "Build box", kind: "ssh", sshTarget: "build", status: "online", statusMessage: null },
] as const;

describe("DraftThread", () => {
  it("lists every configured host and clears the path when the host changes", async () => {
    const dispatch = vi.fn();
    render(<DraftThread
      draft={newDraftSession({ workspace: { hostId: "local", path: "/work/project" } })}
      hosts={hosts}
      workspaces={[]}
      busy={false}
      mutationsReady
      modelOptions={[]}
      modelOptionsStatus={null}
      dispatch={dispatch}
      onFirstSend={vi.fn()}
    />);

    const host = screen.getByRole("combobox", { name: "Host" });
    expect(host).toHaveTextContent("This Mac");
    expect(screen.getByLabelText("Workspace folder")).toHaveValue("/work/project");

    fireEvent.keyDown(host, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["This Mac", "Build box"]);

    fireEvent.click(screen.getByRole("option", { name: "Build box" }));

    // A folder discovered on one machine is not a claim about any other, so the
    // draft drops the path rather than carrying it to the new host.
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "set-workspace", workspace: { hostId: "build", path: "" } }));
    expect(screen.getByLabelText("Workspace folder")).toHaveValue("");
  });

  it("offers a retry that never replays a failed creation on its own", () => {
    const dispatch = vi.fn();
    render(<DraftThread
      draft={{ ...newDraftSession({ workspace: { hostId: "local", path: "/work/project" } }), createState: "failed", error: "The harness refused." }}
      hosts={hosts}
      workspaces={[]}
      busy={false}
      mutationsReady
      modelOptions={[]}
      modelOptionsStatus={null}
      dispatch={dispatch}
      onFirstSend={vi.fn()}
    />);

    expect(screen.getByText("The harness refused.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "retry" });
  });

  it("selects only models returned by the live provider catalog", () => {
    const dispatch = vi.fn();
    render(<DraftThread
      draft={{ ...newDraftSession({ workspace: { hostId: "local", path: "/work/project" } }), text: "Start" }}
      hosts={[hosts[0]]}
      workspaces={[]}
      busy={false}
      mutationsReady
      modelOptions={[{ value: "gpt-live", label: "GPT Live", description: "Returned by the provider", isDefault: true, defaultEffort: "xhigh", efforts: ["high", "xhigh", "ultra"] }]}
      modelOptionsStatus={null}
      effortOptions={["high", "xhigh", "ultra"]}
      dispatch={dispatch}
      onFirstSend={vi.fn()}
    />);

    // The runtime menu is a Radix dropdown: it opens on pointerdown.
    const trigger = screen.getByRole("button", { name: /codex/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1 });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "ultra effort" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "medium effort" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT Live/u }));
    expect(dispatch).toHaveBeenCalledWith({ type: "set-model", model: "gpt-live" });
    expect(screen.queryByText("default-model")).not.toBeInTheDocument();
  });
});
