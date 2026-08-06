import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TodoList } from "./TodoList";
import type { TodoListView } from "./model";

const list: TodoListView = {
  id: "todo-1",
  steps: [{ id: "one", text: "Implement", status: "in-progress", detail: null, removedReason: null, addedAfterStart: false }],
  added: 0,
  removed: 0,
  running: true,
  active: true,
  hasMoved: true,
  duration: null,
  lastTransitionAt: "2026-08-04T12:00:00Z",
};

describe("TodoList", () => {
  it("starts compact, toggles on demand, and preserves expansion for updates to the same list", async () => {
    const { container, rerender } = render(<TodoList list={list} />);
    const trigger = screen.getByRole("button", { name: /^Expand todos, 0 of 1 completed/u });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("[data-todo-details]")).not.toBeInTheDocument();
    expect(screen.getByText("Implement", { selector: "[data-current-todo]" })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: /^Collapse todos, 0 of 1 completed/u })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("[data-todo-details]")).toBeInTheDocument();

    rerender(<TodoList list={{ ...list, steps: [{ ...list.steps[0]!, detail: "Still moving" }] }} />);
    expect(container.querySelector("[data-todo-details]")).toBeInTheDocument();
    expect(screen.getByText("Still moving")).toBeInTheDocument();

    rerender(<TodoList list={{ ...list, id: "todo-2" }} />);
    await waitFor(() => expect(container.querySelector("[data-todo-details]")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Expand todos, 0 of 1 completed/u })).toHaveAttribute("aria-expanded", "false");
  });

  it("raises the compact stalled indicator and amber detail only after nine minutes", () => {
    const { rerender } = render(<TodoList list={list} now={Date.parse("2026-08-04T12:08:59Z")} />);
    expect(screen.queryByText("stalled")).not.toBeInTheDocument();
    rerender(<TodoList list={list} now={Date.parse("2026-08-04T12:09:00Z")} />);
    expect(screen.getByText("stalled")).toBeInTheDocument();
    expect(screen.getByText("9m")).toBeInTheDocument();
    expect(screen.queryByText("No todo has moved in 9 minutes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Expand todos, 0 of 1 completed/u }));
    expect(screen.getByText("No todo has moved in 9 minutes")).toBeInTheDocument();
    expect(screen.getByText("It is not blocked on you.")).toBeInTheDocument();
    rerender(<TodoList list={{ ...list, hasMoved: false, lastTransitionAt: null }} now={Date.parse("2026-08-04T13:00:00Z")} />);
    expect(screen.queryByText(/No todo has moved/u)).not.toBeInTheDocument();
  });

  it("renders exact plus/dash churn rows, footer counts, and only supplied removal reasons", () => {
    const { container, rerender } = render(<TodoList list={{
      ...list,
      steps: [
        { id: "base", text: "Baseline", status: "pending", detail: null, removedReason: null, addedAfterStart: false },
        { id: "added", text: "Added later", status: "pending", detail: null, removedReason: null, addedAfterStart: true },
        { id: "removed", text: "Dropped", status: "removed", detail: null, removedReason: null, addedAfterStart: false },
      ],
      added: 1,
      removed: 1,
    }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Expand todos, 0 of 2 completed/u }));
    expect(container.querySelector('[data-todo-churn="added"]')).toHaveTextContent("Added later");
    expect(container.querySelector('[data-todo-churn="removed"]')).toHaveTextContent("Dropped");
    expect(screen.getByText("+1 −1 since it started")).toBeInTheDocument();
    expect(screen.queryByText(/no longer needed/iu)).not.toBeInTheDocument();

    rerender(<TodoList list={{
      ...list,
      steps: [{
        id: "removed",
        text: "Dropped",
        status: "removed",
        detail: null,
        removedReason: "Provider cancelled this exact todo",
        addedAfterStart: false,
      }],
      added: 0,
      removed: 1,
    }} />);
    expect(screen.getByText("Provider cancelled this exact todo")).toBeInTheDocument();
  });

  it("caps expanded pinned details so the message viewport keeps the remaining height", () => {
    const { container } = render(<TodoList list={list} placement="pinned" />);
    fireEvent.click(screen.getByRole("button", { name: /^Expand todos, 0 of 1 completed/u }));
    expect(container.querySelector("[data-todo-placement='pinned']")).toBeInTheDocument();
    const details = container.querySelector("[data-todo-details]");
    expect(details).toHaveClass("max-h-[min(30dvh,20rem)]", "overflow-y-auto", "overscroll-contain");
    expect(details).toHaveAttribute("role", "region");
    expect(details).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("region", { name: "Pinned todos, 0 of 1" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pinned todo details, 0 of 1 completed" })).toBeInTheDocument();
  });
});
