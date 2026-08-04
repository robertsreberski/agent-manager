import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueuedMessages } from "./QueuedMessages";

describe("QueuedMessages", () => {
  it("expands the compact remove control for coarse pointers without changing its action", () => {
    const onRemove = vi.fn();
    render(<QueuedMessages messages={[{ id: "queued-1", text: "Follow up", status: "queued" }]} canRemove onRemove={onRemove} />);

    const remove = screen.getByRole("button", { name: "Remove queued message 1" });
    expect(remove).toHaveAttribute("data-compact-control");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith("queued-1");
  });
});
