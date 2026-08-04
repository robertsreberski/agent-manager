import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PendingRequests, QuestionRequestForm } from "./pending-requests";
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
  function reviewRequests() {
    fireEvent.click(screen.getByRole("button", { name: /Needs you/u }));
  }

  it("turns exact inline questions into a compact jump target instead of duplicating their form", () => {
    const onJumpToRequest = vi.fn();
    render(
      <PendingRequests
        session={sessionWithQuestions()}
        exactRequestIds={new Set(["request-1"])}
        writable
        busy={false}
        onJumpToRequest={onJumpToRequest}
        onRespond={vi.fn(async () => undefined)}
      />,
    );

    const bar = screen.getByRole("region", { name: "Pending requests" });
    expect(bar).toHaveClass("shrink-0", "flex");
    expect(within(bar).getByText("Which database?")).toBeInTheDocument();

    reviewRequests();
    expect(onJumpToRequest).toHaveBeenCalledWith("request-1");
    expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /SQLite/u })).not.toBeInTheDocument();
  });

  it("submits every provider question atomically with native radio and checkbox semantics", async () => {
    const onRespond = vi.fn(async () => undefined);
    render(
      <QuestionRequestForm
        request={sessionWithQuestions().attention[0]!}
        writable
        mutationsReady
        canRespond
        busy={false}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Backups" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Encryption" }));
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

  it("keeps single-select Other exclusive and never leaks its synthetic label", async () => {
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
      <QuestionRequestForm
        request={withContext.attention[0]!}
        writable
        mutationsReady
        canRespond
        busy={false}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Other/u }));
    fireEvent.change(screen.getByPlaceholderText("Enter another answer"), {
      target: { value: "DuckDB" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("request-1", {
      kind: "answer",
      value: "DuckDB",
      selectedOptions: [],
    }));
  });

  it("preserves a local draft while taking the writable lease", async () => {
    const request = sessionWithQuestions().attention[0]!;
    request.questions = [request.questions![0]!];
    const onTakeControl = vi.fn();
    const onRespond = vi.fn(async () => undefined);
    const rendered = render(
      <QuestionRequestForm
        request={request}
        writable={false}
        mutationsReady
        canRespond
        busy={false}
        onTakeControl={onTakeControl}
        onRespond={onRespond}
      />,
    );

    const sqlite = screen.getByRole("radio", { name: "SQLite" });
    fireEvent.click(sqlite);
    expect(sqlite).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Take control to answer" }));
    expect(onTakeControl).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <QuestionRequestForm
        request={request}
        writable
        mutationsReady
        canRespond
        busy={false}
        onTakeControl={onTakeControl}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByRole("radio", { name: "SQLite" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("request-1", {
      kind: "answer",
      value: "",
      selectedOptions: ["SQLite"],
    }));
  });

  it("does not leak a toggled-off multi-select Other draft and masks secret custom text", async () => {
    const request = sessionWithQuestions().attention[0]!;
    request.isSecret = true;
    request.questions = [{
      id: "features",
      header: "Extras",
      text: "Which features?",
      options: [{ label: "Backups" }, { label: "Encryption" }],
      multiSelect: true,
      allowFreeText: true,
      isSecret: true,
    }];
    const onRespond = vi.fn(async () => undefined);
    render(
      <QuestionRequestForm
        request={request}
        writable
        mutationsReady
        canRespond
        busy={false}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Backups" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Other/u }));
    const secret = screen.getByLabelText("Which features? answer");
    expect(secret).toHaveAttribute("type", "password");
    fireEvent.change(secret, { target: { value: "Audit log" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Other/u }));
    expect(screen.queryByLabelText("Which features? answer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("request-1", {
      kind: "answer",
      value: "",
      selectedOptions: ["Backups"],
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
        exactRequestIds={new Set(["elicitation-1"])}
        writable
        busy={false}
        onRespond={onRespond}
      />,
    );

    reviewRequests();

    expect(screen.getByText(/cannot be represented safely/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /allow once/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send answer/i })).not.toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("keeps metadata-only requests read-only even when metadata has an exact source and request id", () => {
    const onRespond = vi.fn(async () => undefined);
    render(
      <PendingRequests
        session={sessionWithQuestions()}
        writable
        busy={false}
        onRespond={onRespond}
      />,
    );

    reviewRequests();

    expect(screen.getByText(/Exact request details are still loading/u)).toBeInTheDocument();
    expect(screen.getByText(/Open the provider’s native interface/u)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Which database\?/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SQLite" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send .*answer/u })).not.toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("submits decisions only for exact current activity requests", async () => {
    const approval = sessionWithQuestions();
    approval.attention = [{
      id: "approval-1",
      kind: "approval",
      summary: "Run pnpm check",
      title: "Command approval",
      respondable: true,
      source: "provider-api",
      confidence: "exact",
    }];
    const onRespond = vi.fn(async () => undefined);
    render(
      <PendingRequests
        session={approval}
        exactRequestIds={new Set(["approval-1"])}
        writable
        busy={false}
        onRespond={onRespond}
      />,
    );

    reviewRequests();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("approval-1", {
      kind: "decision",
      decision: "allow",
    }));
  });

  it("keeps response controls disabled while mutations are offline", () => {
    const onRespond = vi.fn(async () => undefined);
    render(
      <QuestionRequestForm
        request={sessionWithQuestions().attention[0]!}
        writable
        mutationsReady={false}
        canRespond
        busy={false}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByRole("button", { name: "Reconnect to answer" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "SQLite" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
    expect(onRespond).not.toHaveBeenCalled();
  });
});
