import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import {
  observeOnlyControl,
  providerControlCoordination,
} from "../shared/session.ts";
import type { AvailableSessionAccountFacts } from "../shared/session-facts.ts";
import type { ProviderControlAdapter, SessionAction } from "./contracts.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "local:codex:managed-1",
    provider: "codex",
    providerThreadId: "managed-1",
    providerTreeId: "managed-1",
    parentId: null,
    providerTurnId: "turn-1",
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Managed Codex",
    cwd: "/tmp/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "running",
    providerStatus: "running",
    pid: 123,
    runtimePid: 123,
    startedAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:01:00.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "provider-api",
    source: "fixture",
    profile: { value: "execute", providerValue: "default", source: "provider-api", confidence: "exact" },
    model: { value: "gpt-5.6", providerValue: "gpt-5.6", source: "provider-api", confidence: "exact" },
    effort: { value: "high", providerValue: "high", source: "provider-api", confidence: "exact" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "attach"],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 0,
    ...overrides,
  };
}

const accountFacts: AvailableSessionAccountFacts = {
  available: true,
  source: "provider-api",
  usage: {
    summary: {
      lifetimeTokens: 12_345,
      peakDailyTokens: 2_345,
      longestRunningTurnSec: 90,
      currentStreakDays: 3,
      longestStreakDays: 7,
    },
    recentDays: [{ date: "2026-08-04", tokens: 321 }],
  },
  rateLimits: [{
    label: "Codex",
    planType: "plus",
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_775_000_000 },
    secondary: null,
    spendControlReached: false,
  }],
};

function adapter(
  getAccountFacts?: ProviderControlAdapter["getAccountFacts"],
): ProviderControlAdapter {
  return {
    async createSession() { return session(); },
    async performAction(_session: SessionView, _action: SessionAction) { return { status: "succeeded" }; },
    ...(getAccountFacts ? { getAccountFacts } : {}),
  };
}

async function authenticatedCookie(
  backend: Awaited<ReturnType<typeof createAgentManagerServer>>,
): Promise<string> {
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const value = response.headers["set-cookie"];
  const cookie = (Array.isArray(value) ? value[0] : value)?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

test("serves strict selected-session turn and Codex account facts", async (t) => {
  let calls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex: adapter(async () => { calls += 1; return accountFacts; }) },
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const current = backend.state.get("local:codex:managed-1");
  assert.ok(current);
  backend.activityHub.ingest(current.id, "codex", {
    type: "upsert",
    item: {
      id: "usage-turn-1",
      kind: "usage",
      turnId: "turn-1",
      scope: "turn",
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 20,
      reasoningTokens: 10,
      totalTokens: 150,
      costUsd: 0.0123,
    },
  });

  const unauthenticated = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(current.id)}/facts?generation=${current.generation}`,
    headers: { host },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const cookie = await authenticatedCookie(backend);
  const response = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(current.id)}/facts?generation=${current.generation}`,
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    sessionId: current.id,
    generation: current.generation,
    turnUsage: {
      turnId: "turn-1",
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 20,
      reasoningTokens: 10,
      totalTokens: 150,
      costUsd: 0.0123,
    },
    account: accountFacts,
  });
  assert.equal(calls, 1);
});

test("reports unknown, remote, foreign, unsupported and failed account facts truthfully", async (t) => {
  let calls = 0;
  const sessions = [
    session({ id: "remote:codex:r", hostId: "remote", providerThreadId: "r" }),
    session({ id: "local:codex:f", providerThreadId: "f", control: { ...observeOnlyControl(), plane: "resume-only", authority: "foreign", capabilities: ["resume"] } }),
    session({ id: "local:claude:c", provider: "claude", providerThreadId: "c", control: { plane: "claude-sdk", authority: "manager", coordination: providerControlCoordination("claude"), recovery: null, capabilities: [], withheld: [], takeover: null } }),
    session({ id: "local:codex:n", providerThreadId: "n" }),
  ];
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex: adapter(async () => { calls += 1; return { available: true, source: "provider-api", usage: { private: "credential" } } as never; }) },
    initialSessions: sessions,
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  for (const [id, reason] of [
    [sessions[0]!.id, "remote-session"],
    [sessions[1]!.id, "not-manager-owned"],
    [sessions[2]!.id, "unsupported-provider"],
    [sessions[3]!.id, "provider-unavailable"],
  ] as const) {
    const current = backend.state.get(id);
    assert.ok(current);
    const response = await backend.app.inject({ method: "GET", url: `/api/v1/sessions/${encodeURIComponent(id)}/facts?generation=${current.generation}`, headers: { host, cookie } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { sessionId: id, generation: current.generation, turnUsage: null, account: { available: false, reason } });
    assert.doesNotMatch(response.body, /credential|private/u);
  }
  assert.equal(calls, 1);
});

test("bounds provider reads and rejects stale generations before and after the read", async (t) => {
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let resolveFacts!: (facts: AvailableSessionAccountFacts) => void;
  const pending = new Promise<AvailableSessionAccountFacts>((resolve) => { resolveFacts = resolve; });
  let calls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    sessionFactsTimeoutMs: 10,
    adapters: { codex: adapter(async () => {
      calls += 1;
      start();
      return calls === 1 ? pending : new Promise<AvailableSessionAccountFacts>(() => undefined);
    }) },
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);
  const current = backend.state.get("local:codex:managed-1");
  assert.ok(current);

  const stale = await backend.app.inject({ method: "GET", url: `/api/v1/sessions/${encodeURIComponent(current.id)}/facts?generation=${current.generation + 1}`, headers: { host, cookie } });
  assert.equal(stale.statusCode, 409, stale.body);

  const inFlight = backend.app.inject({ method: "GET", url: `/api/v1/sessions/${encodeURIComponent(current.id)}/facts?generation=${current.generation}`, headers: { host, cookie } });
  await started;
  backend.state.upsert({ ...current, name: "Changed while reading" });
  resolveFacts(accountFacts);
  const changed = await inFlight;
  assert.equal(changed.statusCode, 409, changed.body);

  const latest = backend.state.get(current.id);
  assert.ok(latest);
  const timedOut = await backend.app.inject({ method: "GET", url: `/api/v1/sessions/${encodeURIComponent(latest.id)}/facts?generation=${latest.generation}`, headers: { host, cookie } });
  assert.equal(timedOut.statusCode, 200, timedOut.body);
  assert.deepEqual(timedOut.json().account, { available: false, reason: "provider-unavailable" });
});
