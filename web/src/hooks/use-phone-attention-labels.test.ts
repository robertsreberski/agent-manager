import { describe, expect, it } from "vitest";
import {
  PHONE_ATTENTION_DETAIL_CONCURRENCY,
  hydratePhoneAttentionLabels,
  phoneAttentionCandidates,
  phoneAttentionKey,
} from "./use-phone-attention-labels";
import type { SelectedAttentionDetailsResponse } from "../lib/api";
import type { SessionView } from "../types";

function attention(id: string, question: string | null = null): SessionView["attention"][number] {
  return {
    id,
    kind: "question",
    summary: null,
    source: "provider-api",
    confidence: "exact",
    details: {
      title: "request_user_input",
      questions: question === null ? null : [{ id: "choice", header: null, text: question, options: [], multiSelect: false, allowFreeText: true, isSecret: false }],
      toolName: "request_user_input",
      inputSummary: null,
      respondable: true,
    },
  };
}

function attentionResponse(
  sessionId: string,
  generation: number,
  entries: ReadonlyArray<{ requestId: string; question?: string; title?: string; toolName?: string }> = [],
): SelectedAttentionDetailsResponse {
  return {
    sessionId,
    generation,
    details: entries.map((entry) => ({
      requestId: entry.requestId,
      kind: "question",
      title: entry.title ?? "Codex needs your answer",
      toolName: entry.toolName ?? null,
      questions: entry.question ? [{ id: "choice", text: entry.question }] : [],
      truncated: false,
    })),
  };
}

describe("phone attention detail hydration", () => {
  it("keys the same session again when its exact request or generation changes", () => {
    const first = phoneAttentionCandidates([{ id: "codex:one", generation: 3, attention: [attention("request-1")] }]);
    const later = phoneAttentionCandidates([{ id: "codex:one", generation: 4, attention: [attention("request-2")] }]);
    expect(first).toEqual([{ sessionId: "codex:one", generation: 3, requestIds: ["request-1"] }]);
    expect(phoneAttentionKey(later)).not.toBe(phoneAttentionKey(first));
    expect(phoneAttentionKey(phoneAttentionCandidates([{
      id: "codex:one",
      generation: 4,
      attention: [attention("request-1")],
    }]))).not.toBe(phoneAttentionKey(first));
  });

  it("keeps every exact wants-you row eligible for authenticated detail hydration", () => {
    const sessions = Array.from({ length: 16 }, (_, index) => ({
      id: `codex:${index}`,
      generation: index,
      attention: [attention(`request-${index}`)],
    }));
    expect(phoneAttentionCandidates(sessions)).toHaveLength(16);
  });

  it("keeps exact non-respondable attention eligible for an honest label", () => {
    const nonRespondable = attention("request-read-only");
    nonRespondable.details!.respondable = false;
    expect(phoneAttentionCandidates([{
      id: "claude:external",
      generation: 1,
      attention: [nonRespondable],
    }])).toEqual([{
      sessionId: "claude:external",
      generation: 1,
      requestIds: ["request-read-only"],
    }]);
  });

  it("hydrates only requested IDs with bounded concurrency and tolerates one failed read", async () => {
    const candidates = phoneAttentionCandidates(Array.from({ length: 7 }, (_, index) => ({
      id: `codex:${index}`,
      generation: index + 1,
      attention: [attention(`request-${index}`)],
    })));
    let active = 0;
    let peak = 0;
    const labels = await hydratePhoneAttentionLabels(candidates, async (sessionId, requestIds) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (sessionId === "codex:3") throw new Error("unavailable");
      const index = Number(sessionId.split(":")[1]);
      expect(requestIds).toEqual([`request-${index}`]);
      return attentionResponse(sessionId, index + 1, [
        { requestId: `request-${index}`, question: `Question ${index}` },
        { requestId: "not-requested", question: "Private other request" },
      ]);
    });
    expect(peak).toBeLessThanOrEqual(PHONE_ATTENTION_DETAIL_CONCURRENCY);
    expect(labels.size).toBe(6);
    expect(labels.get("codex:2")?.get("request-2")).toBe("Question 2");
    expect([...labels.values()].some((session) => session.has("not-requested"))).toBe(false);
  });

  it("hydrates rows beyond the former twelve-session boundary", async () => {
    const candidates = phoneAttentionCandidates(Array.from({ length: 16 }, (_, index) => ({
      id: `codex:${index}`,
      generation: index + 1,
      attention: [attention(`request-${index}`)],
    })));
    const loaded: string[] = [];
    const labels = await hydratePhoneAttentionLabels(candidates, async (sessionId) => {
      loaded.push(sessionId);
      const index = Number(sessionId.split(":")[1]);
      return attentionResponse(sessionId, index + 1, [{
        requestId: `request-${index}`,
        question: `Question ${index}`,
      }]);
    });

    expect(loaded).toHaveLength(16);
    expect(labels.get("codex:15")?.get("request-15")).toBe("Question 15");
  });

  it("drops mismatched sessions, generations, and stale request content", async () => {
    const candidate = phoneAttentionCandidates([{
      id: "codex:one",
      generation: 9,
      attention: [attention("request-current")],
    }]);

    await expect(hydratePhoneAttentionLabels(candidate, async () => attentionResponse(
      "codex:other",
      9,
      [{ requestId: "request-current", question: "Wrong session" }],
    ))).resolves.toEqual(new Map());
    await expect(hydratePhoneAttentionLabels(candidate, async () => attentionResponse(
      "codex:one",
      8,
      [{ requestId: "request-current", question: "Old generation" }],
    ))).resolves.toEqual(new Map());
    await expect(hydratePhoneAttentionLabels(candidate, async () => attentionResponse(
      "codex:one",
      9,
      [{ requestId: "request-stale", question: "Stale private question" }],
    ))).resolves.toEqual(new Map());
  });
});
