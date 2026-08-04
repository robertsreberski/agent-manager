import { describe, expect, it } from "vitest";

import type { ActivityItem } from "../../types";
import { exactPlanApprovalRequestIds } from "../session-activity";

function item(value: Record<string, unknown>): ActivityItem {
  return value as unknown as ActivityItem;
}

describe("plan approval identity", () => {
  it("uses only the provider request edge and never same-turn proximity", () => {
    const items = [
      item({
        id: "unlinked-plan",
        kind: "plan",
        turnId: "turn-1",
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
        truncated: false,
        approvalRequestId: null,
        approvedAt: null,
        supersededBy: null,
      }),
      item({
        id: "wrong-edge-plan",
        kind: "plan",
        turnId: "turn-1",
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
        truncated: false,
        approvalRequestId: "request-not-current",
        approvedAt: null,
        supersededBy: null,
      }),
      item({
        id: "linked-plan",
        kind: "plan",
        turnId: "another-turn",
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
        truncated: false,
        approvalRequestId: "request-current",
        approvedAt: null,
        supersededBy: null,
      }),
      item({
        id: "same-turn-attention",
        kind: "attention",
        turnId: "turn-1",
        requestId: "request-current",
        attentionKind: "approval",
      }),
    ];

    expect([...exactPlanApprovalRequestIds(
      items,
      new Set(["request-current"]),
    )]).toEqual([["linked-plan", "request-current"]]);
  });

  it("withdraws execute after provider-linked approval", () => {
    const approved = item({
      id: "approved-plan",
      kind: "plan",
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
      truncated: false,
      approvalRequestId: "request-current",
      approvedAt: "2026-08-04T12:01:00.000Z",
      supersededBy: null,
    });
    expect(exactPlanApprovalRequestIds(
      [approved],
      new Set(["request-current"]),
    ).size).toBe(0);
  });
});
