import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CREATE_ATTEMPT_STORAGE_KEY } from "../lib/create-attempt";
import { LaunchDialog } from "./launch-dialog";

describe("LaunchDialog", () => {
  afterEach(() => localStorage.clear());

  it("reuses one persisted creation key after remount without storing message content", async () => {
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({});
    const firstRender = render(
      <LaunchDialog
        open
        onOpenChange={() => undefined}
        workspaces={[{ id: "workspace-1", label: "Workspace" }]}
        creating={false}
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Describe the outcome you want…"), {
      target: { value: "Build the feature" },
    });
    const launch = screen.getByRole("button", { name: "Launch session" });
    await waitFor(() => expect(launch).toBeEnabled());

    fireEvent.click(launch);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const persisted = localStorage.getItem(CREATE_ATTEMPT_STORAGE_KEY);
    expect(persisted).toBeTruthy();
    expect(persisted).not.toContain("Build the feature");

    firstRender.unmount();
    render(
      <LaunchDialog
        open
        onOpenChange={() => undefined}
        workspaces={[{ id: "workspace-1", label: "Workspace" }]}
        creating={false}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Describe the outcome you want…"), {
      target: { value: "Build the feature" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch session" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));

    const first = onCreate.mock.calls[0]![0];
    const second = onCreate.mock.calls[1]![0];
    expect(first.idempotencyKey).toBeTruthy();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(localStorage.getItem(CREATE_ATTEMPT_STORAGE_KEY)).toBeNull();
  });

  it("replaces the persisted attempt when the request fingerprint changes", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("response lost"));
    render(
      <LaunchDialog
        open
        onOpenChange={() => undefined}
        workspaces={[{ id: "workspace-1", label: "Workspace" }]}
        creating={false}
        onCreate={onCreate}
      />,
    );
    const message = screen.getByPlaceholderText("Describe the outcome you want…");
    const launch = screen.getByRole("button", { name: "Launch session" });
    fireEvent.change(message, { target: { value: "First request" } });
    fireEvent.click(launch);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const firstKey = onCreate.mock.calls[0]![0].idempotencyKey;

    fireEvent.change(message, { target: { value: "Changed request" } });
    fireEvent.click(launch);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[1]![0].idempotencyKey).not.toBe(firstKey);
    expect(localStorage.getItem(CREATE_ATTEMPT_STORAGE_KEY)).not.toContain("Changed request");
  });
});
