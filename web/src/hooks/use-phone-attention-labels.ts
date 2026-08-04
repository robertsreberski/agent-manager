import { useEffect, useMemo, useState } from "react";
import { usePhoneViewport } from "./use-phone-viewport";
import type { SelectedAttentionDetailsResponse } from "../lib/api";
import type { SessionView } from "../types";

export const PHONE_ATTENTION_DETAIL_CONCURRENCY = 3;
const EMPTY_PHONE_ATTENTION_LABELS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();

type SessionAttentionSource = Pick<SessionView, "id" | "generation" | "attention">;

export interface PhoneAttentionCandidate {
  sessionId: string;
  generation: number;
  requestIds: readonly string[];
}

export interface HydratedPhoneAttention {
  key: string;
  labels: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export function phoneAttentionCandidates(
  sessions: readonly SessionAttentionSource[],
): PhoneAttentionCandidate[] {
  return sessions.flatMap((session) => {
    const requestIds = [...new Set(session.attention.flatMap((attention) => attention.id !== null
      && attention.confidence === "exact"
      ? [attention.id]
      : []))].sort();
    return requestIds.length > 0 ? [{ sessionId: session.id, generation: session.generation, requestIds }] : [];
  });
}

export function phoneAttentionKey(candidates: readonly PhoneAttentionCandidate[]): string {
  return JSON.stringify(candidates.map((candidate) => [
    candidate.sessionId,
    candidate.generation,
    candidate.requestIds,
  ]));
}

function exactAttentionLabels(
  response: SelectedAttentionDetailsResponse,
  requestedIds: readonly string[],
): ReadonlyMap<string, string> {
  const requested = new Set(requestedIds);
  const labels = new Map<string, string>();
  for (const detail of response.details) {
    if (!requested.has(detail.requestId)) continue;
    const prompt = detail.questions.find((question) => question.text.trim().length > 0)?.text;
    const label = prompt ?? detail.toolName ?? detail.title;
    if (label) labels.set(detail.requestId, label);
  }
  return labels;
}

export async function hydratePhoneAttentionLabels(
  candidates: readonly PhoneAttentionCandidate[],
  loadAttentionDetails: (
    sessionId: string,
    requestIds: readonly string[],
  ) => Promise<SelectedAttentionDetailsResponse>,
  concurrency = PHONE_ATTENTION_DETAIL_CONCURRENCY,
): Promise<ReadonlyMap<string, ReadonlyMap<string, string>>> {
  const labels = new Map<string, ReadonlyMap<string, string>>();
  if (candidates.length === 0) return labels;
  const workerCount = Math.min(candidates.length, Math.max(1, Math.floor(concurrency)));
  let cursor = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!;
      try {
        // This authenticated, per-session endpoint is the only place request
        // content is read. Collection state and SSE remain metadata-only.
        const response = await loadAttentionDetails(candidate.sessionId, candidate.requestIds);
        if (response.sessionId !== candidate.sessionId || response.generation !== candidate.generation) {
          continue;
        }
        const exact = exactAttentionLabels(response, candidate.requestIds);
        if (exact.size > 0) labels.set(candidate.sessionId, exact);
      } catch {
        // Keep the metadata-only board row usable when one detail read fails.
      }
    }
  });
  await Promise.all(workers);
  return labels;
}

export function usePhoneAttentionLabels(
  sessions: readonly SessionAttentionSource[],
  authenticatedAndFresh: boolean,
  loadAttentionDetails: (
    sessionId: string,
    requestIds: readonly string[],
  ) => Promise<SelectedAttentionDetailsResponse>,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const phone = usePhoneViewport();
  const candidates = useMemo(() => phoneAttentionCandidates(sessions), [sessions]);
  const key = phoneAttentionKey(candidates);
  const [hydrated, setHydrated] = useState<HydratedPhoneAttention>(() => ({ key: "", labels: new Map() }));

  useEffect(() => {
    if (!phone || !authenticatedAndFresh || candidates.length === 0) return;
    let cancelled = false;
    void hydratePhoneAttentionLabels(candidates, loadAttentionDetails).then((labels) => {
      if (!cancelled) setHydrated({ key, labels });
    });
    return () => { cancelled = true; };
  }, [authenticatedAndFresh, key, loadAttentionDetails, phone]);

  // A changed request set invalidates the old content synchronously, before the
  // replacement detail request completes. This prevents a later request in the
  // same session from briefly showing the previous question.
  return phone && authenticatedAndFresh && hydrated.key === key ? hydrated.labels : EMPTY_PHONE_ATTENTION_LABELS;
}
