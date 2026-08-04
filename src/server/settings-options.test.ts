import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import type {
  ProviderControlAdapter,
  SessionAction,
} from "./contracts.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function managedSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "local:claude:managed-1",
    provider: "claude",
    providerThreadId: "managed-1",
    providerTreeId: "managed-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Managed Claude",
    cwd: "/tmp/workspace",
    kind: "interactive",
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: 123,
    runtimePid: 123,
    startedAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    childSummary: {
      total: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    },
    statusSource: "provider-api",
    source: "fixture",
    profile: {
      value: "execute",
      providerValue: "acceptEdits",
      source: "provider-api",
      confidence: "exact",
    },
    model: {
      value: "current-only",
      providerValue: "current-only",
      source: "provider-api",
      confidence: "exact",
    },
    effort: {
      value: "high",
      providerValue: "high",
      source: "provider-api",
      confidence: "exact",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "claude-sdk",
      authority: "manager",
      capabilities: ["queue", "set-model"],
      withheld: [],
    },
    workspaceIdentity: null,
    generation: 0,
    ...overrides,
  };
}

function inertAdapter(
  getSettingsOptions?: ProviderControlAdapter["getSettingsOptions"],
): ProviderControlAdapter {
  return {
    async createSession() {
      return managedSession();
    },
    async performAction(_session: SessionView, _action: SessionAction) {
      return { status: "succeeded" };
    },
    ...(getSettingsOptions ? { getSettingsOptions } : {}),
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
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

test("serves an authenticated Codex catalog with provider-declared model efforts", async (t) => {
  let calls = 0;
  const adapter = inertAdapter(async () => {
    calls += 1;
    return {
      source: "provider-api",
      models: [{
        value: "gpt-codex",
        label: "Codex",
        description: "Balanced",
        isDefault: true,
        defaultEffort: "medium",
        efforts: ["low", "medium", "high"],
      }],
    };
  });
  const codexSession = managedSession({
    id: "local:codex:managed-1",
    provider: "codex",
    providerThreadId: "managed-1",
    providerTreeId: "managed-1",
    control: {
      plane: "codex-private",
      authority: "manager",
      capabilities: ["set-model"],
      withheld: [],
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex: adapter },
    initialSessions: [codexSession],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  const unauthenticated = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Acodex%3Amanaged-1/settings-options",
    headers: { host },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const cookie = await authenticatedCookie(backend);
  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Acodex%3Amanaged-1/settings-options",
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    available: true,
    source: "provider-api",
    models: [{
      value: "gpt-codex",
      label: "Codex",
      description: "Balanced",
      isDefault: true,
      defaultEffort: "medium",
      efforts: ["low", "medium", "high"],
    }],
  });
  assert.equal(calls, 1);
});

test("reports remote, foreign, unsupported, and failed catalogs as explicitly unavailable", async (t) => {
  let claudeCalls = 0;
  const claude = inertAdapter(async () => {
    claudeCalls += 1;
    return {
      source: "provider-api",
      models: [{ value: "x".repeat(257), label: "Too long", description: null }],
    };
  });
  const foreign = managedSession({
    id: "local:claude:foreign-1",
    providerThreadId: "foreign-1",
    providerTreeId: "foreign-1",
    control: {
      plane: "resume-only",
      authority: "foreign",
      capabilities: ["resume"],
      withheld: [],
    },
  });
  const unsupported = managedSession({
    id: "local:codex:managed-2",
    provider: "codex",
    providerThreadId: "managed-2",
    providerTreeId: "managed-2",
    control: {
      plane: "codex-private",
      authority: "manager",
      capabilities: ["set-model"],
      withheld: [],
    },
  });
  const remote = managedSession({
    id: "other-mac:claude:managed-3",
    providerThreadId: "managed-3",
    providerTreeId: "managed-3",
    hostId: "other-mac",
    hostLabel: "Other Mac",
  });
  const malformed = managedSession({
    id: "local:claude:managed-bad",
    providerThreadId: "managed-bad",
    providerTreeId: "managed-bad",
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { claude, codex: inertAdapter() },
    initialSessions: [foreign, unsupported, remote, malformed],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  for (const [id, reason] of [
    [foreign.id, "not-manager-owned"],
    [unsupported.id, "unsupported-provider"],
    [remote.id, "remote-session"],
    [malformed.id, "provider-unavailable"],
  ] as const) {
    const response = await backend.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${encodeURIComponent(id)}/settings-options`,
      headers: { host, cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { available: false, reason, models: [] });
  }
  assert.equal(claudeCalls, 1, "only the local manager-owned Claude session reaches the adapter");
});

test("withdraws a catalog when session generation changes during the provider read", async (t) => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let resolveOptions!: (options: {
    source: "provider-api";
    models: Array<{ value: string; label: string; description: string | null }>;
  }) => void;
  const pendingOptions = new Promise<{
    source: "provider-api";
    models: Array<{ value: string; label: string; description: string | null }>;
  }>((resolve) => {
    resolveOptions = resolve;
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: {
      claude: inertAdapter(async () => {
        markStarted();
        return pendingOptions;
      }),
    },
    initialSessions: [managedSession()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const responsePromise = backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Aclaude%3Amanaged-1/settings-options",
    headers: { host, cookie },
  });
  await started;
  const current = backend.state.get("local:claude:managed-1");
  assert.ok(current);
  backend.state.upsert({ ...current, name: "Changed during lookup" });
  resolveOptions({
    source: "provider-api",
    models: [{ value: "sonnet", label: "Sonnet", description: "Balanced" }],
  });

  const response = await responsePromise;
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    available: false,
    reason: "provider-unavailable",
    models: [],
  });
});

test("bounds a hung live provider catalog lookup", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: {
      claude: inertAdapter(async () => await new Promise<never>(() => undefined)),
    },
    initialSessions: [managedSession()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Aclaude%3Amanaged-1/settings-options",
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    available: false,
    reason: "provider-unavailable",
    models: [],
  });
});
