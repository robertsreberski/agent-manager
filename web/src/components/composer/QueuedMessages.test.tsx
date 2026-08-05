import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionRuntimeProvider } from "../session-thread";
import { QueuedMessages } from "./QueuedMessages";

/*
  The queue primitives read from the runtime, and the runtime reads from an
  adapter fed by the provider's own `kind:"queue"` items. That is the whole
  point of the adoption: the rendered queue is the harness's, not a client-side
  one the browser keeps — so these render through the runtime rather than
  passing an array straight to the component.
*/

const queued = [{ id: "queued-1", text: "Follow up", status: "queued" as const }];

function renderQueue(options: { canRemove: boolean; onRemove?: (id: string) => void; withheldReason?: string }) {
  return render(
    <SessionRuntimeProvider
      items={[]}
      queue={{ messages: queued, canRemove: options.canRemove, onRemove: options.onRemove ?? (() => undefined) }}
    >
      {() => <QueuedMessages messages={queued} canRemove={options.canRemove} {...(options.withheldReason ? { withheldReason: options.withheldReason } : {})} />}
    </SessionRuntimeProvider>,
  );
}

describe("QueuedMessages", () => {
  it("renders the harness's own queue text through the primitive", () => {
    renderQueue({ canRemove: false });

    expect(screen.getByText("Follow up")).toBeInTheDocument();
  });

  it("expands the compact remove control for coarse pointers without changing its action", () => {
    const onRemove = vi.fn();
    renderQueue({ canRemove: true, onRemove });

    const remove = screen.getByRole("button", { name: "Remove queued message 1" });
    expect(remove).toHaveAttribute("data-compact-control");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith("queued-1");
  });

  it("states a withheld remove rather than offering a control that would fail", () => {
    // `QueueItemPrimitive.Remove` is an always-enabled button with no way to
    // express a capability the harness did not offer.
    const onRemove = vi.fn();
    renderQueue({ canRemove: false, onRemove, withheldReason: "This hook cannot remove a queued message." });

    expect(screen.queryByRole("button", { name: /Remove queued message/u })).not.toBeInTheDocument();
    expect(document.querySelector("[data-queue-withheld]"))
      .toHaveTextContent("This hook cannot remove a queued message.");
    expect(onRemove).not.toHaveBeenCalled();
  });
});
