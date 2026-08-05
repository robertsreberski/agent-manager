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
    // A single-answer question is one radio group, so choosing is a real
    // selection the assistive layer can read back, not a styled label.
    const alpha = screen.getByRole("radio", { name: /Alpha/u });
    expect(alpha).toHaveAttribute("aria-checked", "false");
    fireEvent.click(alpha);
    expect(alpha).toBeChecked();

    // Nothing leaves until every question is answered.
    expect(screen.queryByRole("button", { name: /^Send/u })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const secret = screen.getByLabelText("Secret custom answer");
    expect(secret).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Send 2 answers" })).toBeDisabled();
    fireEvent.change(secret, { target: { value: "hidden" } });
    fireEvent.click(screen.getByRole("button", { name: "Send 2 answers" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("q", {
      kind: "answers",
      answers: [
        { questionId: "one", value: "", selectedOptions: ["Alpha"] },
        { questionId: "two", value: "hidden", selectedOptions: [] },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /Choose/u }));
    expect(screen.getByText("••••••")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
  });

  it("renders uncertain attention without response controls", () => {
    for (const inexact of [
      { ...request, id: null, confidence: "heuristic" as const },
      { ...request, state: "resolved" as const },
      { ...request, source: "transcript" as const },
      { ...request, exposure: "transcript-derived" as const },
      { ...request, truncated: true },
      { ...request, respondable: false },
    ]) {
      const view = render(<QuestionRequest request={inexact} onSubmit={vi.fn()} />);
      expect(screen.getByText(/native provider interface/u)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /send/iu })).not.toBeInTheDocument();
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("keeps described options as full-width rows instead of truncating them into pills", () => {
    const described: ExactQuestionRequest = {
      ...request,
      questions: [{
        id: "plan",
        header: null,
        prompt: "Which plan",
        multiple: false,
        allowFreeText: false,
        secret: false,
        options: [
          { id: "a", label: "Alpha", description: "Rewrites the parser in place", recommended: false },
          { id: "b", label: "Beta", description: "Adds a second parser behind a flag", recommended: false },
        ],
      }],
    };
    render(<QuestionRequest request={described} onSubmit={vi.fn()} />);

    // The description is the part the provider wrote to be read before choosing,
    // so it is on screen in full rather than clipped into a pill.
    expect(screen.getByText("Rewrites the parser in place")).toBeInTheDocument();
    expect(screen.getByText("Adds a second parser behind a flag")).toBeInTheDocument();
    for (const row of screen.getAllByRole("radio")) {
      const label = row.closest("label")!;
      expect(label).not.toHaveClass("rounded-full");
      expect(label).toHaveClass("min-h-[46px]");
      expect(label.className).not.toContain("truncate");
    }
    expect(screen.getByRole("radiogroup", { name: "Which plan" })).toBeInTheDocument();
  });

  it("drives the open question from 1-9, E and Enter, and refuses when two are ambiguous", () => {
    const onSubmit = vi.fn();
    const single: ExactQuestionRequest = {
      ...request,
      questions: [{
        id: "only",
        header: null,
        prompt: "Pick or write",
        multiple: false,
        allowFreeText: true,
        secret: false,
        options: [
          { id: "a", label: "Alpha", description: null, recommended: false },
          { id: "b", label: "Beta", description: null, recommended: false },
        ],
      }],
    };
    const solo = render(<QuestionRequest request={single} onSubmit={onSubmit} />);

    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByRole("radio", { name: /Beta/u })).toBeChecked();

    fireEvent.keyDown(window, { key: "e" });
    expect(screen.getByLabelText("Pick or write custom answer")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByRole("radio", { name: /Alpha/u })).toBeChecked();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("q", {
      kind: "answers",
      answers: [{ questionId: "only", value: "", selectedOptions: ["Alpha"] }],
    });
    solo.unmount();

    // Two live requests make "1" ambiguous, so neither of them claims the key.
    const ambiguous = vi.fn();
    render(<>
      <QuestionRequest request={{ ...single, id: "one" }} onSubmit={ambiguous} />
      <QuestionRequest request={{ ...single, id: "two" }} onSubmit={ambiguous} />
    </>);
    fireEvent.keyDown(window, { key: "1" });
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(ambiguous).not.toHaveBeenCalled();
  });

  it("uses one sticky atomic-submit footer on a phone", () => {
    phoneViewport();
    render(<QuestionRequest request={request} onSubmit={vi.fn()} />);
    const footer = screen.getByLabelText("Question submission");
    expect(footer).toHaveAttribute("data-phone-sticky-footer");
    expect(screen.getByText("2 questions left")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Send 2 answers" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send 2 answers" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Alpha/u }));
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
    expect(screen.getByRole("radio", { name: /Alpha/u }).closest("label")).toHaveClass("min-h-8", "rounded-full");
    desktop.unmount();

    phoneViewport();
    render(<QuestionRequest request={simple} onSubmit={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /Alpha/u }).closest("label")).toHaveClass("min-h-[46px]", "rounded-full");
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

    // `multiple` means one independent checkbox per option, never a radio.
    const alpha = screen.getByRole("checkbox", { name: /Alpha/u });
    const beta = screen.getByRole("checkbox", { name: /Beta/u });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toHaveAttribute("data-compact-control");
    fireEvent.click(screen.getByRole("radio", { name: /Alpha/u }));
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: /Choose.*Alpha/u })).toHaveAttribute("data-compact-control");
  });
});

describe("ApprovalRequest", () => {
  it("presents a blocking bottom sheet with full-width actions on a phone", async () => {
    phoneViewport();
    render(<ApprovalRequest request={{ id: "a", label: "Run command", command: "rm file", reason: null, workspaceRoot: "/work/app", paths: null, writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={vi.fn()} />);
    const sheet = await screen.findByRole("dialog", { name: "Run command approval" });
    expect(sheet).toHaveAttribute("data-phone-bottom-sheet");
    // The sheet is a real layer now: it brings its own scrim rather than an
    // `aria-hidden` decoration that no interaction could ever reach.
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeInTheDocument();
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

  it("allows on Enter, as frame 8a prints, for one unambiguous inside-workspace request", () => {
    const onDecision = vi.fn();
    const inside = { id: "inside", label: "Write file", command: "touch src/a.ts", reason: null, workspaceRoot: "/work/app", paths: ["/work/app/src/a.ts"], writes: ["/work/app/src/a.ts"], network: false, deleteCount: 0, remoteHost: null, sessionsOnHost: null, canPersist: true } as const;
    const { unmount } = render(<ApprovalRequest request={inside} onDecision={onDecision} />);
    expect(screen.getByText("↵ allow", { exact: false })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onDecision).toHaveBeenCalledWith("inside", { decision: "allow", persist: false });
    expect(screen.getByText("no network")).toBeInTheDocument();
    // Frame 8a emphasises the value inside the fact, so the row is two elements.
    expect(screen.getByText("deletes", { exact: false })).toHaveTextContent("deletes 0 files");
    unmount();

    // ⌘↵ keeps working for anyone who learned it during the ⌘↵-only period.
    const legacy = vi.fn();
    const legacyRender = render(<ApprovalRequest request={{ ...inside, id: "legacy" }} onDecision={legacy} />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(legacy).toHaveBeenCalledWith("legacy", { decision: "allow", persist: false });
    legacyRender.unmount();

    // Two on screen is ambiguous, and a bare Enter must not pick one.
    const ambiguous = vi.fn();
    render(<><ApprovalRequest request={{ ...inside, id: "one" }} onDecision={ambiguous} /><ApprovalRequest request={{ ...inside, id: "two" }} onDecision={ambiguous} /></>);
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(ambiguous).not.toHaveBeenCalled();
  });

  it("never binds Enter on a command that leaves the workspace or the machine", () => {
    // The bare-Enter binding is only safe because it is tier-1 only. A command
    // that leaves the worktree needs a deliberate click, always.
    const onDecision = vi.fn();
    render(<ApprovalRequest request={{ id: "outside", label: "Delete", command: "rm -rf /tmp/x", reason: null, workspaceRoot: "/work/app", paths: ["/tmp/x"], writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={onDecision} />);

    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("names a delete target only when the provider's own payload supports it", () => {
    // Frame 9a-3's headline. Spec 07 R7 forbids inventing a count and permits
    // naming a path the tool input gave, so the headline appears for one and
    // stays silent for the other.
    const named = render(<ApprovalRequest request={{ id: "a", label: "Delete", command: "rm -rf ~/.cache", reason: null, workspaceRoot: "/work/app", paths: ["/work/app/.cache"], writes: [], network: null, deleteCount: 1, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={vi.fn()} />);
    expect(document.querySelector("[data-approval-headline]"))
      .toHaveTextContent("Allow this command to delete /work/app/.cache?");
    named.unmount();

    render(<ApprovalRequest request={{ id: "b", label: "Delete", command: "rm -rf build", reason: null, workspaceRoot: "/work/app", paths: ["/work/app/build"], writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={vi.fn()} />);
    expect(document.querySelector("[data-approval-headline]")).toBeNull();
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
    const scope = screen.getByRole("radiogroup", { name: "Approval scope" });
    expect(within(scope).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /Once/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Always this class/u })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecision).toHaveBeenLastCalledWith("a", { decision: "allow", persist: false });
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled());

    fireEvent.click(screen.getByRole("radio", { name: /Always this class/u }));
    expect(screen.getByRole("radio", { name: /Once/u })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Always allow this class" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Always allow this class" }));
    expect(onDecision).toHaveBeenLastCalledWith("a", { decision: "allow", persist: true });
  });

  it("contains phone focus and collapses on Escape without ever dismissing the request", async () => {
    phoneViewport();
    render(<><button>Underlying control</button><ApprovalRequest request={{ id: "a", label: "Write file", command: "touch /work/app/a", reason: null, workspaceRoot: "/work/app", paths: ["/work/app/a"], writes: ["/work/app/a"], network: false, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false }} onDecision={vi.fn()} /></>);
    const sheet = await screen.findByRole("dialog", { name: "Write file approval" });
    const disclosure = within(sheet).getByRole("button", { name: /Write file.*inside workspace/u });
    await waitFor(() => expect(disclosure).toHaveFocus());
    expect(disclosure).toHaveAttribute("data-compact-control");
    expect(within(sheet).getByRole("button", { name: "Deny" })).toHaveAttribute("data-compact-control");
    expect(within(sheet).getByRole("button", { name: "Allow" })).toHaveAttribute("data-compact-control");

    (screen.getByText("Underlying control") as HTMLButtonElement).focus();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));

    // An approval is answered, never dismissed: Escape folds the detail away and
    // the sheet — with the request still unanswered — stays on screen.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(disclosure).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getByRole("dialog", { name: "Write file approval" })).toBeInTheDocument();
  });
});
