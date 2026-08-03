import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PendingRequests } from "./pending-requests";
import type { SessionView } from "../types";

function sessionWithQuestions(): SessionView {
  return {
    id: "session-1",
    provider: "claude",
    name: "Questions",
    cwd: "/tmp/example",
    parentSessionId: null,
    depth: 0,
    ownership: "manager",
    runtimeAlive: true,
    mode: { value: "execution", providerValue: "default", source: "provider-api", confidence: "exact" },
    activity: "waiting",
    attention: [{
      id: "request-1",
      kind: "question",
      summary: "Configure storage",
      title: "Two answers needed",
      source: "provider-api",
      confidence: "exact",
      questions: [
        {
          id: "database",
          text: "Which database?",
          options: [{ label: "SQLite" }, { label: "Postgres" }],
          multiSelect: false,
          allowFreeText: false,
        },
        {
          id: "features",
          text: "Which features?",
          options: [{ label: "Backups" }, { label: "Encryption" }],
          multiSelect: true,
          allowFreeText: false,
        },
      ],
    }],
    effectiveAccess: { permissionMode: "default", sandboxMode: "workspace-write", fullHostAccess: false },
    terminal: null,
    control: { plane: "claude-sdk", capabilities: ["respond"], managerOwned: true, writableLease: true },
    generation: 1,
    runId: null,
    updatedAt: null,
    messages: [],
    queue: [],
  };
}

describe("PendingRequests", () => {
  it("bounds pending forms in their own mobile-scrollable tray", () => {
    render(
      <PendingRequests
        session={sessionWithQuestions()}
        writable
        busy={false}
        onRespond={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("region", { name: "Pending requests" })).toHaveClass(
      "max-h-[min(34dvh,18rem)]",
      "shrink-0",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(screen.getByText("1 waiting")).toBeInTheDocument();
  });

  it("submits every exact provider question atomically", async () => {
    const onRespond = vi.fn(async () => undefined);
    render(
      <PendingRequests
        session={sessionWithQuestions()}
        writable
        busy={false}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "SQLite" }));
    fireEvent.click(screen.getByRole("button", { name: "Backups" }));
    fireEvent.click(screen.getByRole("button", { name: "Encryption" }));
    fireEvent.click(screen.getByRole("button", { name: "Send 2 answers" }));

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond).toHaveBeenCalledWith("request-1", {
      kind: "answers",
      answers: [
        { questionId: "database", value: "", selectedOptions: ["SQLite"] },
        { questionId: "features", value: "", selectedOptions: ["Backups", "Encryption"] },
      ],
    });
  });

  it("keeps a selected Claude option and its typed context in one response", async () => {
    const withContext = sessionWithQuestions();
    withContext.attention[0]!.questions = [{
      id: "database",
      text: "Which database?",
      options: [{ label: "SQLite" }, { label: "Postgres" }],
      multiSelect: false,
      allowFreeText: true,
    }];
    const onRespond = vi.fn(async () => undefined);
    render(
      <PendingRequests
        session={withContext}
        writable
        busy={false}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "SQLite" }));
    fireEvent.change(screen.getByPlaceholderText("Add context (optional)"), {
      target: { value: "Enable WAL mode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("request-1", {
      kind: "answer",
      value: "Enable WAL mode",
      selectedOptions: ["SQLite"],
    }));
  });

  it("does not invent a browser response for an unsupported elicitation form", () => {
    const elicitation = sessionWithQuestions();
    elicitation.attention = [{
      id: "elicitation-1",
      kind: "elicitation",
      summary: "Provider form request",
      title: "More details required",
      respondable: false,
      source: "provider-api",
      confidence: "exact",
    }];
    const onRespond = vi.fn(async () => undefined);

    render(
      <PendingRequests
        session={elicitation}
        writable
        busy={false}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText(/cannot be represented safely/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /allow once/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send answer/i })).not.toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });
});
