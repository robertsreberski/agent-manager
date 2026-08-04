import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalRequest } from "./ApprovalRequest";
import { QuestionRequest } from "./QuestionRequest";
import type { ExactQuestionRequest } from "./model";

const request: ExactQuestionRequest = {
  id: "q", label: "request_user_input", state: "waiting", source: "provider-api", confidence: "exact", exposure: "provider-exposed", truncated: false, respondable: true,
  questions: [
    { id: "one", header: "First", prompt: "Choose", multiple: false, allowFreeText: false, secret: false, options: [{ id: "a", label: "Alpha", description: "A described option", recommended: true }] },
    { id: "two", header: "Second", prompt: "Secret", multiple: false, allowFreeText: true, secret: true, options: [] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function phoneViewport() {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    media: "(max-width: 900px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe("QuestionRequest", () => {
  it("submits multiple answers atomically and masks the secret summary", async () => {
    const onSubmit = vi.fn();
    render(<QuestionRequest request={request} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const secret = screen.getByLabelText("Secret custom answer");
    expect(secret).toHaveAttribute("type", "password");
    fireEvent.change(secret, { target: { value: "hidden" } });
    fireEvent.click(screen.getByRole("button", { name: "Send 2 answers" }));
    expect(onSubmit).toHaveBeenCalledWith("q", {
      kind: "answers",
      answers: [
        { questionId: "one", value: "", selectedOptions: ["Alpha"] },
        { questionId: "two", value: "hidden", selectedOptions: [] },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /Choose/u }));
    expect(screen.getByText("••••••")).toBeInTheDocument();
  });

  it("renders uncertain attention without response controls", () => {
    render(<QuestionRequest request={{ ...request, id: null, confidence: "heuristic" }} onSubmit={vi.fn()} />);
    expect(screen.getByText(/native provider interface/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/u })).not.toBeInTheDocument();
  });

  it("uses one sticky atomic-submit footer on a phone", () => {
    phoneViewport();
    render(<QuestionRequest request={request} onSubmit={vi.fn()} />);
    const footer = screen.getByLabelText("Question submission");
    expect(footer).toHaveAttribute("data-phone-sticky-footer");
    expect(screen.getByText("2 questions left")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Send 2 answers" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send 2 answers" })).toBeDisabled();
    fireEvent.click(screen.getByText("Alpha"));
    expect(screen.getByText("1 question left")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Secret custom answer"), { target: { value: "hidden" } });
    expect(screen.getByText("All questions answered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send 2 answers" })).toBeEnabled();
  });

  it("gives simple phone options a 46px target without changing their desktop shape", () => {
    const simple = {
      ...request,
      questions: [{ ...request.questions[0]!, options: [{ id: "a", label: "Alpha", description: null, recommended: false }] }],
    };
    const desktop = render(<QuestionRequest request={simple} onSubmit={vi.fn()} />);
    expect(screen.getByText("Alpha").closest("label")).toHaveClass("min-h-8");
    desktop.unmount();

    phoneViewport();
    render(<QuestionRequest request={simple} onSubmit={vi.fn()} />);
    expect(screen.getByText("Alpha").closest("label")).toHaveClass("min-h-[46px]");
  });

  it("keeps provider options and a custom Other answer mutually exclusive", () => {
    const onSubmit = vi.fn();
    const exclusive: ExactQuestionRequest = {
      ...request,
      questions: [{
        id: "choice",
        header: null,
        prompt: "Pick or write",
        multiple: true,
        allowFreeText: true,
        secret: false,
        options: [
          { id: "a", label: "Alpha", description: null, recommended: false },
          { id: "b", label: "Beta", description: null, recommended: false },
        ],
      }],
    };
    render(<QuestionRequest request={exclusive} onSubmit={onSubmit} />);

    const alpha = screen.getByRole("checkbox", { name: /Alpha/u });
    const beta = screen.getByRole("checkbox", { name: /Beta/u });
    const somethingElse = screen.getByRole("button", { name: "Something else…" });
    expect(somethingElse).toHaveClass("rounded-full", "border-dashed");
    expect(somethingElse.parentElement).toHaveClass("flex");
    fireEvent.click(alpha);
    fireEvent.click(beta);
    expect(alpha).toBeChecked();
    expect(beta).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Something else…" }));
    const custom = screen.getByLabelText("Pick or write custom answer");
    expect(custom).toHaveClass("rounded-full", "border-dashed");
    expect(custom).not.toHaveClass("w-full");
    fireEvent.change(custom, { target: { value: "A different answer" } });
    expect(alpha).not.toBeChecked();
    expect(beta).not.toBeChecked();
    expect(custom).toHaveValue("A different answer");

    fireEvent.click(alpha);
    expect(alpha).toBeChecked();
    expect(screen.queryByLabelText("Pick or write custom answer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Something else…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledWith("q", {
      kind: "answers",
      answers: [{ questionId: "choice", value: "", selectedOptions: ["Alpha"] }],
    });
  });

  it("marks compact multi-question navigation for coarse-pointer expansion", () => {
    render(<QuestionRequest request={request} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous" })).toHaveAttribute("data-compact-control");
    expect(screen.getByRole("button", { name: "Next" })).toHaveAttribute("data-compact-control");
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: /Choose.*Alpha/u })).toHaveAttribute("data-compact-control");
  });
});

describe("ApprovalRequest", () => {
  it("presents a blocking bottom sheet with full-width actions on a phone", () => {
    phoneViewport();
    render(<ApprovalRequest request={{ id: "a", label: "Run command", command: "rm file", reason: null, workspaceRoot: "/work/app", paths: null, writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={vi.fn()} />);
    const sheet = screen.getByRole("dialog", { name: "Run command approval" });
    expect(sheet).toHaveAttribute("data-phone-bottom-sheet");
    expect(document.querySelector(".approval-request__phone-backdrop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow once" }).parentElement).toHaveClass("approval-request__actions");
  });

  it("requires a click outside the workspace", () => {
    const onDecision = vi.fn();
    render(<ApprovalRequest request={{ id: "a", label: "Run command", command: "rm file", reason: null, workspaceRoot: "/work/app", paths: null, writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={onDecision} />);
    expect(screen.getByLabelText("Run command approval")).toHaveAttribute("data-phone-bottom-sheet");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecision).toHaveBeenCalledWith("a", { decision: "allow", persist: false });
  });

  it("allows command-enter only for one unambiguous inside-workspace request", () => {
    const onDecision = vi.fn();
    const inside = { id: "inside", label: "Write file", command: "touch src/a.ts", reason: null, workspaceRoot: "/work/app", paths: ["/work/app/src/a.ts"], writes: ["/work/app/src/a.ts"], network: false, deleteCount: 0, remoteHost: null, sessionsOnHost: null, canPersist: true } as const;
    const { unmount } = render(<ApprovalRequest request={inside} onDecision={onDecision} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onDecision).toHaveBeenCalledWith("inside", { decision: "allow", persist: false });
    expect(screen.getByText("no network")).toBeInTheDocument();
    expect(screen.getByText("deletes 0 files")).toBeInTheDocument();
    unmount();

    const ambiguous = vi.fn();
    render(<><ApprovalRequest request={{ ...inside, id: "one" }} onDecision={ambiguous} /><ApprovalRequest request={{ ...inside, id: "two" }} onDecision={ambiguous} /></>);
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(ambiguous).not.toHaveBeenCalled();
  });

  it("persists only from the provider-backed always-allow button", () => {
    const onDecision = vi.fn();
    render(<ApprovalRequest request={{ id: "a", label: "Write file", command: null, reason: null, workspaceRoot: "/work/app", paths: ["/work/app/a"], writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: true }} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow this class" }));
    expect(onDecision).toHaveBeenCalledWith("a", { decision: "allow", persist: true });
  });

  it("keeps exactly two phone actions while exposing the provider-backed persistent outcome", async () => {
    phoneViewport();
    const onDecision = vi.fn();
    render(<ApprovalRequest request={{ id: "a", label: "Write file", command: null, reason: null, workspaceRoot: "/work/app", paths: ["/work/app/a"], writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: true }} onDecision={onDecision} />);

    const actions = document.querySelector(".approval-request__actions");
    expect(actions?.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /Once/u })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecision).toHaveBeenLastCalledWith("a", { decision: "allow", persist: false });
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled());

    fireEvent.click(screen.getByRole("radio", { name: /Always this class/u }));
    expect(screen.getByRole("button", { name: "Always allow this class" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Always allow this class" }));
    expect(onDecision).toHaveBeenLastCalledWith("a", { decision: "allow", persist: true });
  });

  it("contains phone focus and consumes Escape before underlying application shortcuts", () => {
    phoneViewport();
    const globalKeydown = vi.fn();
    window.addEventListener("keydown", globalKeydown);
    try {
      render(<><button>Underlying control</button><ApprovalRequest request={{ id: "a", label: "Write file", command: "touch /work/app/a", reason: null, workspaceRoot: "/work/app", paths: ["/work/app/a"], writes: ["/work/app/a"], network: false, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={vi.fn()} /></>);
      const sheet = screen.getByRole("dialog", { name: "Write file approval" });
      const disclosure = within(sheet).getByRole("button", { name: /Write file.*inside workspace/u });
      expect(disclosure).toHaveFocus();
      expect(disclosure).toHaveAttribute("data-compact-control");
      expect(within(sheet).getByRole("button", { name: "Deny" })).toHaveAttribute("data-compact-control");
      expect(within(sheet).getByRole("button", { name: "Allow" })).toHaveAttribute("data-compact-control");

      screen.getByRole("button", { name: "Underlying control" }).focus();
      expect(disclosure).toHaveFocus();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(globalKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", globalKeydown);
    }
  });
});
