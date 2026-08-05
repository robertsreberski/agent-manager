import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CockpitSessionView } from "../../lib/cockpit-view";
import { toBoardSession, type BoardSession } from "../board/model";
import { SelectionBar } from "./SelectionBar";

function session(id: string, capabilities: CockpitSessionView["control"]["capabilities"]): BoardSession {
  return toBoardSession({
    id,
    provider: "codex",
    name: id,
    hostId: "local",
    hostLabel: "This Mac",
    remote: false,
    cwd: "/work/app",
    workspaceIdentity: { repoRoot: "/work/app", repoName: "app", worktreePath: "/work/app", linked: false, branch: "main", detached: false, dirtyCount: 0, ahead: null, behind: null },
    activity: "idle",
    attention: [],
    updatedAt: "2026-08-04T12:00:00Z",
    control: { plane: "codex-private", authority: "manager", capabilities, withheld: [] },
    profile: null,
    model: null,
    effort: null,
    todo: null,
  });
}

describe("SelectionBar", () => {
  it("keeps a mixed outcome visible after the completed action clears selection", async () => {
    const supported = session("supported", ["archive"]);
    const unsupported = session("unsupported", []);
    const onAction = vi.fn(async (_action: string, _applicable: readonly BoardSession[]) => ({ succeeded: 1, unsupported: 1, failed: 0 }));

    function Harness() {
      const [sessions, setSessions] = useState<readonly BoardSession[]>([supported, unsupported]);
      return <SelectionBar
        sessions={sessions}
        onClear={() => setSessions([])}
        onAction={async (action, applicable) => {
          const outcome = await onAction(action, applicable);
          setSessions([]);
          return outcome;
        }}
      />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "archive 1" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Archived 1 · 1 not supported · 0 failed"));
    expect(screen.queryByRole("button", { name: /archive/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByLabelText("Selected sessions")).not.toBeInTheDocument();
  });

  it("names what each action will skip instead of silently narrowing the selection", () => {
    const running = { ...session("running", ["archive", "delete"]), activity: "running" as const, boardState: "working" as const };
    const idle = session("idle", ["archive", "delete"]);

    render(<SelectionBar sessions={[running, idle]} onClear={vi.fn()} onAction={vi.fn(() => ({ succeeded: 0, unsupported: 0, failed: 0 }))} />);

    expect(screen.getByLabelText("Selected sessions")).toHaveTextContent("1 running (cannot delete)");
    expect(screen.getByRole("button", { name: "archive" })).not.toHaveAttribute("title");
    expect(screen.getByRole("button", { name: "delete 1" }))
      .toHaveAttribute("title", "1 not supported; running sessions cannot be deleted");
  });
});
