import { useEffect, useMemo, useRef, useState } from "react";
import type { SelectedTodoDetailResponse } from "../lib/api";
import type { TodoProgressView } from "../lib/cockpit-view";
import type { SessionView } from "../types";

export const TODO_DETAIL_CONCURRENCY = 3;
const EMPTY_TODO_DETAILS: ReadonlyMap<string, TodoProgressView> = new Map();

type SessionTodoSource = Pick<SessionView, "id" | "generation" | "todoProgress">;

export interface TodoDetailCandidate {
  sessionId: string;
  generation: number;
  completed: number;
  total: number;
}

interface CachedTodoDetail {
  key: string;
  todo: TodoProgressView;
}

export function todoDetailCandidates(sessions: readonly SessionTodoSource[]): TodoDetailCandidate[] {
  return sessions.flatMap((session) => session.todoProgress && session.todoProgress.total > 0
    ? [{
        sessionId: session.id,
        generation: session.generation,
        completed: session.todoProgress.completed,
        total: session.todoProgress.total,
      }]
    : []);
}

export function todoDetailCandidateKey(candidate: TodoDetailCandidate): string {
  return JSON.stringify([
    candidate.sessionId,
    candidate.generation,
    candidate.completed,
    candidate.total,
  ]);
}

export function todoDetailsKey(candidates: readonly TodoDetailCandidate[]): string {
  return JSON.stringify(candidates.map(todoDetailCandidateKey));
}

function projectTodoDetail(
  candidate: TodoDetailCandidate,
  response: SelectedTodoDetailResponse,
): TodoProgressView | null {
  if (
    response.sessionId !== candidate.sessionId
    || response.generation !== candidate.generation
  ) return null;
  if (
    response.todo
    && (
      response.todo.completed !== candidate.completed
      || response.todo.total !== candidate.total
    )
  ) return null;
  return {
    completed: candidate.completed,
    total: candidate.total,
    current: response.todo?.current ?? null,
  };
}

export async function hydrateTodoDetails(
  candidates: readonly TodoDetailCandidate[],
  loadTodoDetail: (sessionId: string) => Promise<SelectedTodoDetailResponse>,
  concurrency = TODO_DETAIL_CONCURRENCY,
): Promise<ReadonlyMap<string, TodoProgressView>> {
  const details = new Map<string, TodoProgressView>();
  if (candidates.length === 0) return details;
  const workerCount = Math.min(candidates.length, Math.max(1, Math.floor(concurrency)));
  let cursor = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!;
      try {
        // This per-session read is the only board-wide todo content edge.
        // The global snapshot and replay remain counts-only.
        const projected = projectTodoDetail(
          candidate,
          await loadTodoDetail(candidate.sessionId),
        );
        if (projected) details.set(candidate.sessionId, projected);
      } catch {
        // The counts-only card remains truthful when one detail read fails.
      }
    }
  });
  await Promise.all(workers);
  return details;
}

export function useTodoDetails(
  sessions: readonly SessionTodoSource[],
  authenticatedAndFresh: boolean,
  loadTodoDetail: (sessionId: string) => Promise<SelectedTodoDetailResponse>,
): ReadonlyMap<string, TodoProgressView> {
  const candidates = useMemo(() => todoDetailCandidates(sessions), [sessions]);
  const key = todoDetailsKey(candidates);
  const cache = useRef(new Map<string, CachedTodoDetail>());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!authenticatedAndFresh) {
      if (cache.current.size > 0) {
        cache.current.clear();
        setRevision((value) => value + 1);
      }
      return;
    }

    const currentIds = new Set(candidates.map((candidate) => candidate.sessionId));
    for (const sessionId of cache.current.keys()) {
      if (!currentIds.has(sessionId)) cache.current.delete(sessionId);
    }
    const pending = candidates.filter((candidate) => (
      cache.current.get(candidate.sessionId)?.key !== todoDetailCandidateKey(candidate)
    ));
    if (pending.length === 0) return;

    let cancelled = false;
    void hydrateTodoDetails(pending, loadTodoDetail).then((details) => {
      if (cancelled) return;
      for (const candidate of pending) {
        const todo = details.get(candidate.sessionId);
        if (!todo) continue;
        cache.current.set(candidate.sessionId, {
          key: todoDetailCandidateKey(candidate),
          todo,
        });
      }
      setRevision((value) => value + 1);
    });
    return () => { cancelled = true; };
  }, [authenticatedAndFresh, key, loadTodoDetail]);

  return useMemo(() => {
    if (!authenticatedAndFresh) return EMPTY_TODO_DETAILS;
    const current = new Map<string, TodoProgressView>();
    for (const candidate of candidates) {
      const cached = cache.current.get(candidate.sessionId);
      if (cached?.key === todoDetailCandidateKey(candidate)) {
        current.set(candidate.sessionId, cached.todo);
      }
    }
    return current;
  }, [authenticatedAndFresh, candidates, key, revision]);
}
