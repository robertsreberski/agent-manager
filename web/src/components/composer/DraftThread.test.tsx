import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceGitContext } from "../../../../src/shared/workspace.ts";
import { DraftThread } from "./DraftThread";
import { newDraftSession, type DraftAction, type DraftSession } from "./draft";

const hosts = [
  { id: "local", label: "This Mac", kind: "local", sshTarget: null, status: "online", statusMessage: null },
  { id: "build", label: "Build box", kind: "ssh", sshTarget: "build", status: "online", statusMessage: null },
] as const;

const repoContext: WorkspaceGitContext = {
  status: "repo",
  repoRoot: "/work/project",
  repoName: "project",
  defaultBranch: "main",
  worktrees: [
    { path: "/work/project", branch: "main", isMain: true, locked: false },
    { path: "/work/project/.worktrees/fix-auth", branch: "fix-auth", isMain: false, locked: false },
  ],
};

function draftThread(overrides: {
  draft?: DraftSession;
  onCompletePath?: (hostId: string, path: string) => Promise<readonly string[]>;
  onLoadGitContext?: (hostId: string, path: string) => Promise<WorkspaceGitContext>;
  dispatch?: (action: DraftAction) => void;
} = {}) {
  const dispatch = overrides.dispatch ?? vi.fn<(action: DraftAction) => void>();
  const view = render(<DraftThread
    draft={overrides.draft ?? newDraftSession({ workspace: { hostId: "local", path: "/work/project" } })}
    hosts={hosts}
    workspaces={[]}
    busy={false}
    mutationsReady
    modelOptions={[]}
    modelOptionsStatus={null}
    dispatch={dispatch}
    onFirstSend={vi.fn()}
    onCompletePath={overrides.onCompletePath ?? (() => Promise.resolve([]))}
    onLoadGitContext={overrides.onLoadGitContext ?? (() => Promise.resolve({ status: "not-a-repo" }))}
  />);
  return { dispatch, view };
}

describe("DraftThread", () => {
  it("lists every configured host and clears the path when the host changes", async () => {
    const { dispatch } = draftThread();

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
    const { dispatch } = draftThread({
      draft: { ...newDraftSession({ workspace: { hostId: "local", path: "/work/project" } }), createState: "failed", error: "The harness refused." },
    });

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
      onCompletePath={() => Promise.resolve([])}
      onLoadGitContext={() => Promise.resolve({ status: "not-a-repo" })}
    />);

    const trigger = screen.getByRole("combobox", { name: /codex/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1 });
    fireEvent.click(trigger);
    // Effort is a radiogroup beside the model list, and only the levels the
    // provider's catalog declared for the selected model are offered.
    expect(screen.getByRole("radio", { name: /ultra/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /medium/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /GPT Live/u }));
    expect(dispatch).toHaveBeenCalledWith({ type: "set-model", model: "gpt-live" });
    expect(screen.queryByText("default-model")).not.toBeInTheDocument();
  });

  it("offers only folders the server confirmed, and ignores an answer for a path since replaced", async () => {
    vi.useFakeTimers();
    try {
      const answers = new Map<string, string[]>([
        ["/work/pro", ["/work/project", "/work/prototype"]],
        ["/work/project", ["/work/project/src"]],
      ]);
      const { dispatch } = draftThread({
        draft: newDraftSession({ workspace: { hostId: "local", path: "/work/pro" } }),
        onCompletePath: (_hostId, path) => Promise.resolve(answers.get(path) ?? []),
      });

      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      const suggestions = screen.getByRole("listbox", { name: "Folder suggestions" });
      expect(suggestions.textContent).toContain("/work/prototype");

      fireEvent.click(screen.getByRole("option", { name: "/work/project" }));
      expect(dispatch).toHaveBeenCalledWith({ type: "set-workspace", workspace: { hostId: "local", path: "/work/project" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks where in a repository to run, and nowhere else", async () => {
    vi.useFakeTimers();
    try {
      const { dispatch } = draftThread({ onLoadGitContext: () => Promise.resolve(repoContext) });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      const worktrees = screen.getByRole("radiogroup", { name: "Worktree" });
      expect(worktrees).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /fix-auth/u })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /main checkout/u })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /No worktree/u })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: /fix-auth/u }));
      expect(dispatch).toHaveBeenCalledWith({
        type: "set-worktree",
        worktree: { kind: "existing", path: "/work/project/.worktrees/fix-auth", branch: "fix-auth" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("has nothing to ask about a folder that is not a repository", async () => {
    vi.useFakeTimers();
    try {
      draftThread({ onLoadGitContext: () => Promise.resolve({ status: "not-a-repo" }) });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(screen.queryByRole("radiogroup", { name: "Worktree" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says plainly when a host cannot manage worktrees", async () => {
    vi.useFakeTimers();
    try {
      draftThread({
        onLoadGitContext: () => Promise.resolve({ status: "unavailable", reason: "Worktrees are managed for local projects only." }),
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(screen.getByText("Worktrees are managed for local projects only.")).toBeInTheDocument();
      expect(screen.queryByRole("radiogroup", { name: "Worktree" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names what a new worktree would create and refuses one that cannot be created", async () => {
    vi.useFakeTimers();
    try {
      const draft = newDraftSession({
        workspace: { hostId: "local", path: "/work/project", worktree: { kind: "new", name: "", repoRoot: "/work/project" } },
      });
      const { dispatch } = draftThread({ draft: { ...draft, text: "Start" }, onLoadGitContext: () => Promise.resolve(repoContext) });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      const name = screen.getByLabelText("New worktree name");
      fireEvent.change(name, { target: { value: "spike" } });
      expect(dispatch).toHaveBeenCalledWith({
        type: "set-worktree",
        worktree: { kind: "new", name: "spike", repoRoot: "/work/project" },
      });
      // An unnamed worktree cannot be created, so the composer cannot send yet.
      expect(screen.getByRole("button", { name: /send/iu })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains a name that is unusable or already taken instead of failing at send", async () => {
    vi.useFakeTimers();
    try {
      const invalid = newDraftSession({
        workspace: { hostId: "local", path: "/work/project", worktree: { kind: "new", name: "../escape", repoRoot: "/work/project" } },
      });
      const { view } = draftThread({ draft: invalid, onLoadGitContext: () => Promise.resolve(repoContext) });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(screen.getByText(/Use letters, numbers/u)).toBeInTheDocument();

      view.rerender(<DraftThread
        draft={newDraftSession({
          workspace: { hostId: "local", path: "/work/project", worktree: { kind: "new", name: "fix-auth", repoRoot: "/work/project" } },
        })}
        hosts={hosts}
        workspaces={[]}
        busy={false}
        mutationsReady
        modelOptions={[]}
        modelOptionsStatus={null}
        dispatch={vi.fn()}
        onFirstSend={vi.fn()}
        onCompletePath={() => Promise.resolve([])}
        onLoadGitContext={() => Promise.resolve(repoContext)}
      />);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(screen.getByText(/already exists/u)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
