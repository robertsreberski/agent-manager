import { describe, expect, it } from "vitest";
import { decideOfflineFlush, enqueueOfflineMessage, type OfflineMessage, type OutboxSessionState } from "./offline-outbox";
import { EMPTY_NOTIFICATION_STATE, exactWantsYouSessionCount, reduceNotifications, type NotificationPreferences, type NotificationSession } from "./notifications";

const preferences: NotificationPreferences = { blocked: true, finished: true, stalled: true, includeSessionName: false, quiet: false };
const session: NotificationSession = { id: "codex:one", name: "Secret name", status: "running", updatedAt: "2026-08-04T12:00:00Z", requestIds: [], todo: null };
const fresh = { collectionFresh: true } as const;

describe("notification reducer", () => {
  it("counts exact wants-you sessions for the app badge, not their request rows", () => {
    expect(exactWantsYouSessionCount([
      { requestIds: ["question", "approval"] },
      { requestIds: ["another-question"] },
      { requestIds: [] },
    ])).toBe(2);
  });

  it("does not notify the baseline and emits only new exact request ids", () => {
    const baseline = reduceNotifications({ state: EMPTY_NOTIFICATION_STATE, sessions: [{ ...session, requestIds: ["old"] }], preferences, now: 0, awaySince: null, ...fresh });
    expect(baseline.notifications).toEqual([]);
    const next = reduceNotifications({ state: baseline.state, sessions: [{ ...session, requestIds: ["old", "new"] }], preferences, now: 1, awaySince: null, ...fresh });
    expect(next.notifications).toMatchObject([{ kind: "blocked", requestId: "new", body: "An agent is waiting for a response." }]);
  });

  it("waits for the first successful fresh collection and makes all of it a silent baseline", () => {
    const stale = reduceNotifications({
      state: EMPTY_NOTIFICATION_STATE,
      sessions: [{ ...session, status: "completed", requestIds: ["arrived-during-startup"] }],
      preferences,
      now: 1,
      awaySince: 1,
      collectionFresh: false,
    });
    expect(stale.state).toBe(EMPTY_NOTIFICATION_STATE);
    expect(stale.notifications).toEqual([]);
    expect(stale.nextDeadline).toBeNull();

    const freshBaseline = reduceNotifications({
      state: stale.state,
      sessions: [{ ...session, status: "completed", requestIds: ["arrived-during-startup"] }],
      preferences,
      now: 2,
      awaySince: 1,
      collectionFresh: true,
    });
    expect(freshBaseline.state.initialized).toBe(true);
    expect(freshBaseline.notifications).toEqual([]);

    const next = reduceNotifications({
      state: freshBaseline.state,
      sessions: [{ ...session, status: "completed", requestIds: ["arrived-during-startup", "new"] }],
      preferences,
      now: 3,
      awaySince: 1,
      collectionFresh: true,
    });
    expect(next.notifications).toMatchObject([{ kind: "blocked", requestId: "new" }]);
  });

  it("waits for five continuous away minutes before finished", () => {
    const baseline = reduceNotifications({ state: EMPTY_NOTIFICATION_STATE, sessions: [session], preferences, now: 0, awaySince: null, ...fresh });
    const finished = { ...session, status: "completed" as const, updatedAt: "2026-08-04T12:01:00Z" };
    const pending = reduceNotifications({ state: baseline.state, sessions: [finished], preferences, now: 10, awaySince: 10, ...fresh });
    expect(pending.notifications).toEqual([]);
    expect(pending.nextDeadline).toBe(300_010);
    expect(reduceNotifications({ state: pending.state, sessions: [finished], preferences, now: 300_010, awaySince: 10, ...fresh }).notifications[0]).toMatchObject({ kind: "finished" });
  });

  it("keeps a present completion pending and starts its timer when the page becomes hidden", () => {
    const baseline = reduceNotifications({ state: EMPTY_NOTIFICATION_STATE, sessions: [session], preferences, now: 0, awaySince: null, ...fresh });
    const finished = { ...session, status: "completed" as const, updatedAt: "2026-08-04T12:01:00Z" };
    const present = reduceNotifications({ state: baseline.state, sessions: [finished], preferences, now: 10, awaySince: null, ...fresh });
    expect(present.notifications).toEqual([]);
    expect(present.nextDeadline).toBeNull();
    const hidden = reduceNotifications({ state: present.state, sessions: [finished], preferences, now: 20, awaySince: 20, ...fresh });
    expect(hidden.nextDeadline).toBe(300_020);
    expect(reduceNotifications({ state: hidden.state, sessions: [finished], preferences, now: 300_020, awaySince: 20, ...fresh }).notifications).toMatchObject([{ kind: "finished" }]);
  });

  it("resets the continuous-absence window on meaningful interaction", () => {
    const baseline = reduceNotifications({ state: EMPTY_NOTIFICATION_STATE, sessions: [session], preferences, now: 0, awaySince: 0, ...fresh });
    const finished = { ...session, status: "completed" as const, updatedAt: "2026-08-04T12:01:00Z" };
    const pending = reduceNotifications({ state: baseline.state, sessions: [finished], preferences, now: 1, awaySince: 0, ...fresh });
    const interacted = reduceNotifications({ state: pending.state, sessions: [finished], preferences, now: 200_000, awaySince: 200_000, ...fresh });
    expect(interacted.nextDeadline).toBe(500_000);
    expect(reduceNotifications({ state: interacted.state, sessions: [finished], preferences, now: 300_000, awaySince: 200_000, ...fresh }).notifications).toEqual([]);
    expect(reduceNotifications({ state: interacted.state, sessions: [finished], preferences, now: 500_000, awaySince: 200_000, ...fresh }).notifications).toMatchObject([{ kind: "finished" }]);
  });

  it("notifies a fresh moved active todo only when it crosses nine minutes", () => {
    const start = Date.parse("2026-08-04T12:00:00Z");
    const active = { ...session, todo: { active: true, hasMoved: true, lastTransitionAt: "2026-08-04T12:00:00Z" } };
    const baseline = reduceNotifications({ state: EMPTY_NOTIFICATION_STATE, sessions: [active], preferences, now: start, awaySince: start, ...fresh });
    expect(baseline.nextDeadline).toBe(start + 540_000);
    const stalled = reduceNotifications({ state: baseline.state, sessions: [active], preferences, now: start + 540_000, awaySince: start, ...fresh });
    expect(stalled.notifications).toMatchObject([{ kind: "stalled", body: "An agent has a stalled todo." }]);
    expect(reduceNotifications({ state: baseline.state, sessions: [active], preferences, now: start + 540_000, awaySince: start, collectionFresh: false }).notifications).toEqual([]);
  });
});

describe("offline outbox", () => {
  const baseline: OutboxSessionState = { id: "codex:one", providerTurnId: "turn-1", profile: "execute", sandbox: { mode: "workspace-write", networkAccess: false }, status: "running", exactRequestIds: [], capabilities: ["queue", "steer"], generation: 1 };
  const message: OfflineMessage = { id: "m", sessionId: baseline.id, text: "continue", delivery: "queue", idempotencyKey: "same", baseline, queuedAt: "2026-08-04T12:00:00Z" };
  it("refreshes only the generation when material state is unchanged", () => {
    expect(decideOfflineFlush(message, { ...baseline, generation: 8 })).toEqual({ kind: "send", generation: 8 });
  });
  it("returns text for review after every material boundary", () => {
    expect(decideOfflineFlush(message, { ...baseline, providerTurnId: "turn-2" })).toMatchObject({ kind: "review" });
    expect(decideOfflineFlush(message, { ...baseline, profile: "plan" })).toMatchObject({ kind: "review" });
    expect(decideOfflineFlush(message, { ...baseline, sandbox: { mode: "danger-full-access", networkAccess: true } })).toMatchObject({ kind: "review" });
    expect(decideOfflineFlush(message, { ...baseline, exactRequestIds: ["q"] })).toMatchObject({ kind: "review" });
    expect(decideOfflineFlush(message, { ...baseline, status: "completed" })).toMatchObject({ kind: "review" });
    expect(decideOfflineFlush({
      ...message,
      baseline: { ...baseline, status: "waiting" },
    }, { ...baseline, status: "idle", generation: 8 })).toMatchObject({ kind: "review" });
    expect(decideOfflineFlush({
      ...message,
      baseline: { ...baseline, status: "idle" },
    }, { ...baseline, status: "running", generation: 8 })).toMatchObject({ kind: "review" });
    expect(decideOfflineFlush({
      ...message,
      baseline: { ...baseline, status: "waiting" },
    }, { ...baseline, status: "waiting", generation: 8 })).toEqual({ kind: "send", generation: 8 });
    expect(decideOfflineFlush(message, null)).toMatchObject({ kind: "missing" });
  });
  it("deduplicates the ephemeral queue", () => {
    expect(enqueueOfflineMessage([message], { ...message, id: "duplicate" })).toEqual([message]);
  });
});
