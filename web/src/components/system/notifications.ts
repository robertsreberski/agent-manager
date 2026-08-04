export interface NotificationSession {
  id: string;
  name: string;
  status: "running" | "waiting" | "idle" | "completed" | "failed" | "interrupted" | "unknown";
  updatedAt: string;
  /** Only exact, provider-exposed, unresolved stable request ids. */
  requestIds: readonly string[];
  todo: { active: boolean; hasMoved: boolean; lastTransitionAt: string | null } | null;
}

export interface NotificationPreferences {
  blocked: boolean;
  finished: boolean;
  stalled: boolean;
  includeSessionName: boolean;
  quiet: boolean;
}

interface PendingFinished {
  completionKey: string;
  awaySince: number | null;
}

export interface NotificationReducerState {
  initialized: boolean;
  knownRequestIds: readonly string[];
  previousStatus: Readonly<Record<string, NotificationSession["status"]>>;
  previousStalled: Readonly<Record<string, boolean>>;
  pendingFinished: Readonly<Record<string, PendingFinished>>;
  notifiedFinished: readonly string[];
  notifiedStalled: readonly string[];
}

export type CockpitNotification =
  | { kind: "blocked"; sessionId: string; requestId: string; title: string; body: string; silent: boolean }
  | { kind: "finished"; sessionId: string; completionKey: string; title: string; body: string; silent: boolean }
  | { kind: "stalled"; sessionId: string; stallKey: string; title: string; body: string; silent: boolean };

export const EMPTY_NOTIFICATION_STATE: NotificationReducerState = {
  initialized: false,
  knownRequestIds: [],
  previousStatus: {},
  previousStalled: {},
  pendingFinished: {},
  notifiedFinished: [],
  notifiedStalled: [],
};

/** The badge is a triage count of sessions, never a count of request rows. */
export function exactWantsYouSessionCount(
  sessions: readonly Pick<NotificationSession, "requestIds">[],
): number {
  return sessions.reduce(
    (count, session) => count + (session.requestIds.length > 0 ? 1 : 0),
    0,
  );
}

const FINISHED_AWAY_MS = 5 * 60_000;
const TODO_STALL_MS = 9 * 60_000;

function terminal(status: NotificationSession["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export function todoStallKey(session: NotificationSession, now: number, collectionFresh: boolean): string | null {
  const todo = session.todo;
  if (!collectionFresh || !todo?.active || !todo.hasMoved || !todo.lastTransitionAt) return null;
  const transition = Date.parse(todo.lastTransitionAt);
  if (!Number.isFinite(transition) || now - transition < TODO_STALL_MS) return null;
  return `${session.id}:${todo.lastTransitionAt}`;
}

function nextTodoDeadline(session: NotificationSession, now: number, collectionFresh: boolean): number | null {
  const todo = session.todo;
  if (!collectionFresh || !todo?.active || !todo.hasMoved || !todo.lastTransitionAt) return null;
  const transition = Date.parse(todo.lastTransitionAt);
  if (!Number.isFinite(transition)) return null;
  const deadline = transition + TODO_STALL_MS;
  return deadline > now ? deadline : null;
}

export function reduceNotifications(input: {
  state: NotificationReducerState;
  sessions: readonly NotificationSession[];
  preferences: NotificationPreferences;
  now: number;
  awaySince: number | null;
  collectionFresh: boolean;
}): { state: NotificationReducerState; notifications: CockpitNotification[]; nextDeadline: number | null } {
  const { state, sessions, preferences, now, awaySince, collectionFresh } = input;
  const requestIds = sessions.flatMap((session) => session.requestIds.map((requestId) => `${session.id}:${requestId}`));
  const statuses = Object.fromEntries(sessions.map((session) => [session.id, session.status]));
  const stalled = Object.fromEntries(sessions.map((session) => [session.id, todoStallKey(session, now, collectionFresh) !== null]));
  if (!state.initialized) {
    // Connecting, cached, and stale collections are not a trustworthy
    // notification edge. The first successful fresh collection establishes
    // the complete baseline and is intentionally silent.
    if (!collectionFresh) {
      return { state, notifications: [], nextDeadline: null };
    }
    const baselineStalls = sessions.flatMap((session) => todoStallKey(session, now, collectionFresh) ?? []);
    const deadlines = preferences.stalled ? sessions.flatMap((session) => nextTodoDeadline(session, now, collectionFresh) ?? []) : [];
    return {
      state: { ...state, initialized: true, knownRequestIds: requestIds, previousStatus: statuses, previousStalled: stalled, notifiedStalled: baselineStalls },
      notifications: [],
      nextDeadline: deadlines.length > 0 ? Math.min(...deadlines) : null,
    };
  }

  const known = new Set(state.knownRequestIds);
  const notifiedFinished = new Set(state.notifiedFinished);
  const notifiedStalled = new Set(state.notifiedStalled);
  const pending = { ...state.pendingFinished };
  const notifications: CockpitNotification[] = [];
  const deadlines: number[] = [];

  for (const session of sessions) {
    for (const requestId of session.requestIds) {
      const requestKey = `${session.id}:${requestId}`;
      if (!known.has(requestKey) && preferences.blocked) {
        notifications.push({
          kind: "blocked",
          sessionId: session.id,
          requestId,
          title: "Agent Manager needs you",
          body: preferences.includeSessionName ? `${session.name} is waiting for a response.` : "An agent is waiting for a response.",
          silent: preferences.quiet,
        });
      }
      known.add(requestKey);
    }

    const previous = state.previousStatus[session.id];
    if (previous === "running" && terminal(session.status)) {
      pending[session.id] = { completionKey: `${session.id}:${session.updatedAt}:${session.status}`, awaySince };
    } else if (!terminal(session.status)) {
      delete pending[session.id];
    }
    let completion = pending[session.id];
    if (completion && completion.awaySince !== awaySince) {
      completion = { ...completion, awaySince };
      pending[session.id] = completion;
    }
    if (completion && completion.awaySince !== null && preferences.finished) {
      const deadline = completion.awaySince + FINISHED_AWAY_MS;
      if (now >= deadline && !notifiedFinished.has(completion.completionKey)) {
        notifications.push({
          kind: "finished",
          sessionId: session.id,
          completionKey: completion.completionKey,
          title: "A session finished",
          body: preferences.includeSessionName ? `${session.name} has finished.` : "An agent has finished.",
          silent: preferences.quiet,
        });
        notifiedFinished.add(completion.completionKey);
        delete pending[session.id];
      } else if (!notifiedFinished.has(completion.completionKey)) {
        deadlines.push(deadline);
      }
    }

    const stallKey = todoStallKey(session, now, collectionFresh);
    if (stallKey && !state.previousStalled[session.id] && !notifiedStalled.has(stallKey) && preferences.stalled) {
      notifications.push({
        kind: "stalled",
        sessionId: session.id,
        stallKey,
        title: "A session stalled",
        body: preferences.includeSessionName ? `${session.name} has a stalled todo.` : "An agent has a stalled todo.",
        silent: preferences.quiet,
      });
      notifiedStalled.add(stallKey);
    }
    const stallDeadline = preferences.stalled ? nextTodoDeadline(session, now, collectionFresh) : null;
    if (stallDeadline !== null) deadlines.push(stallDeadline);
  }

  return {
    state: {
      initialized: true,
      knownRequestIds: [...known],
      previousStatus: statuses,
      previousStalled: stalled,
      pendingFinished: pending,
      notifiedFinished: [...notifiedFinished],
      notifiedStalled: [...notifiedStalled],
    },
    notifications,
    nextDeadline: deadlines.length > 0 ? Math.min(...deadlines) : null,
  };
}

export function notificationOpenTarget(notification: CockpitNotification): string {
  return `/?session=${encodeURIComponent(notification.sessionId)}`;
}
