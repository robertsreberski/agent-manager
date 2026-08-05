import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_SCHEMA_VERSION, type ActivityAttentionItem, type ActivityPlanItem } from "../../types";
import { CockpitApi } from "../../lib/api";
import { renderActivityData, type ActivityDataControls } from "../session-activity";

const planItem: ActivityPlanItem = {
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

describe("plan file activity integration", () => {
  it("loads a path-backed artifact only through CockpitApi session and item identities", async () => {
    const item: ActivityPlanItem = { ...planItem };
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
        planOwnedRequestIds: new Set<string>(),
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
      queue: { canRemove: false, busy: false, withheldReason: null },
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

  it("answers a plan approval on the plan, not through a second permission card", () => {
    const attention: ActivityAttentionItem = {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      id: "attention/plan",
      sessionId: "local:claude:thread/one",
      provider: "claude",
      turnId: "turn-1",
      parentId: null,
      seq: 5,
      revision: 1,
      state: "waiting",
      startedAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:01.000Z",
      completedAt: null,
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
      truncated: false,
      kind: "attention",
      requestId: "plan-request",
      attentionKind: "approval",
      title: "Claude wants to leave plan mode",
      summary: null,
      questions: [],
      approvalFacts: null,
      resolved: false,
      respondable: true,
      isSecret: false,
    };
    const controls: ActivityDataControls = {
      attention: {
        exactRequestIds: new Set(["plan-request"]), mutationsReady: true, canRespond: true, busy: false,
        planOwnedRequestIds: new Set(["plan-request"]),
        workspaceRoot: "/work/app", remoteHost: null, sessionsOnHost: null,
        onRespond: vi.fn(async () => undefined),
      },
      files: {
        sessionId: attention.sessionId, canOpenEditor: false, workspaceRoot: "/work/app",
        readKeys: new Set(), onReadChange: vi.fn(),
      },
      plans: {
        requestIds: new Map([["plan/owned", "plan-request"]]),
        mutationsReady: true, canRespond: true, busy: false,
        loadFile: vi.fn(async () => { throw new Error("unused"); }),
        onRespond: vi.fn(async () => undefined),
      },
      queue: { canRemove: false, busy: false, withheldReason: null },
    };

    const plan: ActivityPlanItem = {
      ...planItem,
      id: "plan/owned",
      approvalRequestId: "plan-request",
      approvedAt: null,
      state: "waiting",
    };
    const owned = render(<>
      {renderActivityData("agent-manager.plan", plan, controls)}
      {renderActivityData("agent-manager.attention", attention, controls)}
    </>);

    // Exactly one surface answers the request, and it is the one with the plan
    // attached. A second card asks the same question again — and on phone it is
    // a modal sheet that covers the plan it is asking about.
    expect(screen.getByRole("button", { name: /execute this plan/iu })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /allow once/iu })).not.toBeInTheDocument();
    expect(screen.queryByText(/not safely representable/u)).not.toBeInTheDocument();
    owned.unmount();

    // A session that cannot respond gets no controls on the plan either, so the
    // approval card stays: the request must never lose every surface at once.
    render(<>
      {renderActivityData("agent-manager.plan", plan, {
        ...controls,
        plans: { ...controls.plans, canRespond: false },
      })}
      {renderActivityData("agent-manager.attention", attention, {
        ...controls,
        attention: { ...controls.attention, canRespond: false },
      })}
    </>);
    expect(screen.queryByRole("button", { name: /execute this plan/iu })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /allow once/iu })).toBeInTheDocument();
  });
});
