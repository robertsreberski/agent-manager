import { render, screen } from "@testing-library/react";
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
  it("raises the amber field only for a moved active list after nine minutes", () => {
    const { rerender } = render(<TodoList list={list} now={Date.parse("2026-08-04T12:08:59Z")} />);
    expect(screen.queryByText(/No todo has moved/u)).not.toBeInTheDocument();
    rerender(<TodoList list={list} now={Date.parse("2026-08-04T12:09:00Z")} />);
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
});
