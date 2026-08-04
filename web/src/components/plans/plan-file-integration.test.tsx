import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_SCHEMA_VERSION, type ActivityPlanItem } from "../../types";
import { CockpitApi } from "../../lib/api";
import { renderActivityData, type ActivityDataControls } from "../session-activity";

describe("plan file activity integration", () => {
  it("loads a path-backed artifact only through CockpitApi session and item identities", async () => {
    const item: ActivityPlanItem = {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      id: "plan/current",
      sessionId: "local:claude:thread/one",
      provider: "claude",
      turnId: "turn-1",
      parentId: null,
      seq: 4,
      revision: 1,
      state: "complete",
      startedAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:01.000Z",
      completedAt: "2026-08-04T12:00:01.000Z",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
      truncated: false,
      kind: "plan",
      path: "/Users/local/.claude/plans/current.md",
      version: null,
      markdown: "# Inline callback payload",
      supersededBy: null,
      approvalRequestId: null,
      approvedAt: null,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionId: item.sessionId,
      itemId: item.id,
      path: item.path,
      markdown: "# Strict file response\n\nFilesystem content.",
      truncated: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });
    const controls: ActivityDataControls = {
      attention: {
        exactRequestIds: new Set(), mutationsReady: true, canRespond: false, busy: false,
        workspaceRoot: "/work/app", remoteHost: null, sessionsOnHost: null,
        onRespond: vi.fn(async () => undefined),
      },
      files: {
        sessionId: item.sessionId, canOpenEditor: false, workspaceRoot: "/work/app",
        readKeys: new Set(), onReadChange: vi.fn(),
      },
      plans: {
        requestIds: new Map(), mutationsReady: true, canRespond: false, busy: false,
        loadFile: (itemId) => api.planFile(item.sessionId, itemId),
        onRespond: vi.fn(async () => undefined),
      },
      queue: { canRemove: false, busy: false, onRemove: vi.fn(async () => undefined) },
    };
    render(<>{renderActivityData("agent-manager.plan", item, controls)}</>);

    fireEvent.click(screen.getByRole("button", { name: "Open plan document" }));
    const view = await screen.findByRole("dialog", { name: "Plan document" });
    expect(within(view).getByRole("heading", { name: "Strict file response" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Aclaude%3Athread%2Fone/plans/plan%2Fcurrent",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
