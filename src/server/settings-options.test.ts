import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import {
  observeOnlyControl,
  providerControlCoordination,
} from "../shared/session.ts";
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
    archived: false,
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
      coordination: providerControlCoordination("claude"),
      recovery: null,
      capabilities: ["queue", "set-model"],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 0,
    ...overrides,
  };
}

function inertAdapter(
  getSettingsOptions?: ProviderControlAdapter["getSettingsOptions"],
  getCreateSettingsOptions?: ProviderControlAdapter["getCreateSettingsOptions"],
): ProviderControlAdapter {
  return {
    async createSession() {
      return managedSession();
    },
    async performAction(_session: SessionView, _action: SessionAction) {
      return { status: "succeeded" };
    },
    ...(getSettingsOptions ? { getSettingsOptions } : {}),
    ...(getCreateSettingsOptions ? { getCreateSettingsOptions } : {}),
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
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["set-model"],
      withheld: [],
      takeover: null,
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

/*
  A running Codex thread withholds `set-model` for the whole of its turn. The
  route used to refuse the catalog under exactly that condition, which left the
  browser with nothing to render and no reason to state — the model control went
  dead for the duration. Reading is not writing; the browser disables the rows.
*/
test("serves the catalog to a manager-owned session that cannot currently set a model", async (t) => {
  let calls = 0;
  const adapter = inertAdapter(async () => {
    calls += 1;
    return {
      source: "provider-api",
      models: [{ value: "gpt-codex", label: "Codex", description: "Balanced" }],
    };
  });
  const busyCodexSession = managedSession({
    id: "local:codex:managed-busy",
    provider: "codex",
    providerThreadId: "managed-busy",
    providerTreeId: "managed-busy",
    status: "running",
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["queue", "interrupt"],
      withheld: [{ capability: "set-model", reason: "Available when the Codex turn is idle" }],
      takeover: null,
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex: adapter },
    initialSessions: [busyCodexSession],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/sessions/local%3Acodex%3Amanaged-busy/settings-options",
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    available: true,
    source: "provider-api",
    models: [{ value: "gpt-codex", label: "Codex", description: "Balanced" }],
  });
  assert.equal(calls, 1);
});

test("serves a Codex draft catalog without any session", async (t) => {
  let calls = 0;
  const codex = inertAdapter(undefined, async () => {
    calls += 1;
    return {
      source: "provider-api",
      models: [{
        value: "gpt-codex",
        label: "Codex",
        description: "Live provider catalog",
        isDefault: true,
        defaultEffort: "high",
        efforts: ["medium", "high", "xhigh"],
      }],
    };
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex },
    initialSessions: [],
  });
  t.after(() => backend.close());
  await backend.app.ready();

  const unauthenticated = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/codex/settings-options?hostId=local",
    headers: { host },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const cookie = await authenticatedCookie(backend);
  const local = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/codex/settings-options?hostId=local",
    headers: { host, cookie },
  });
  assert.equal(local.statusCode, 200, local.body);
  assert.deepEqual(local.json(), {
    available: true,
    source: "provider-api",
    models: [{
      value: "gpt-codex",
      label: "Codex",
      description: "Live provider catalog",
      isDefault: true,
      defaultEffort: "high",
      efforts: ["medium", "high", "xhigh"],
    }],
  });

  assert.equal(calls, 1);
  assert.deepEqual(backend.state.list(), []);
});

test("validates host identity before reporting remote draft settings as unavailable", async (t) => {
  let calls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { codex: inertAdapter(undefined, async () => {
      calls += 1;
      return { source: "provider-api", models: [] };
    }) },
    initialSessions: [],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const unknown = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/codex/settings-options?hostId=unknown-host",
    headers: { host, cookie },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.deepEqual(unknown.json(), {
    error: { code: "HOST_NOT_FOUND", message: "host is not configured" },
  });

  backend.database.addHost({
    id: "build-host",
    label: "Build host",
    kind: "ssh",
    sshTarget: "owner@build-host",
  });
  const configured = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/codex/settings-options?hostId=build-host",
    headers: { host, cookie },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  assert.deepEqual(configured.json(), {
    available: false,
    reason: "remote-host",
    models: [],
  });
  assert.equal(calls, 0, "remote draft discovery must not consult the local provider");
});

test("does not borrow a manager-owned session for legacy draft catalogs", async (t) => {
  let selectedSessionId: string | null = null;
  const claude = inertAdapter(async (session) => {
    selectedSessionId = session.id;
    return {
      source: "provider-api",
      models: [{ value: "sonnet", label: "Sonnet", description: "Balanced" }],
    };
  });
  const remote = managedSession({
    id: "build-host:claude:managed-remote",
    providerThreadId: "managed-remote",
    providerTreeId: "managed-remote",
    hostId: "build-host",
    hostLabel: "Build host",
  });
  const foreign = managedSession({
    id: "local:claude:foreign",
    providerThreadId: "foreign",
    providerTreeId: "foreign",
    control: {
      ...observeOnlyControl(),
      plane: "resume-only",
      authority: "foreign",
      capabilities: ["set-model"],
    },
  });
  const managed = managedSession();
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { claude },
    initialSessions: [remote, foreign, managed],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/claude/settings-options?hostId=local",
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    available: false,
    reason: "unsupported-provider",
    models: [],
  });
  assert.equal(selectedSessionId, null);
});

test("distinguishes unavailable providers from unsupported draft catalogs", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: { claude: inertAdapter() },
    initialSessions: [],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const unavailable = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/codex/settings-options?hostId=local",
    headers: { host, cookie },
  });
  assert.equal(unavailable.statusCode, 200, unavailable.body);
  assert.deepEqual(unavailable.json(), {
    available: false,
    reason: "provider-unavailable",
    models: [],
  });

  const unsupported = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/claude/settings-options?hostId=local",
    headers: { host, cookie },
  });
  assert.equal(unsupported.statusCode, 200, unsupported.body);
  assert.deepEqual(unsupported.json(), {
    available: false,
    reason: "unsupported-provider",
    models: [],
  });
});

test("degrades a synchronously failing direct draft catalog", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    adapters: {
      codex: inertAdapter(undefined, () => {
        throw new Error("provider process is unavailable");
      }),
    },
    initialSessions: [],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/codex/settings-options?hostId=local",
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    available: false,
    reason: "provider-unavailable",
    models: [],
  });
});

test("aborts and releases a provider draft lookup at its deadline", async (t) => {
  let active = false;
  let cancelled = false;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    providerSettingsOptionsTimeoutMs: 10,
    adapters: {
      codex: inertAdapter(undefined, async (requestContext) => {
        active = true;
        return await new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            cancelled = true;
            active = false;
            const reason = requestContext.signal.reason;
            reject(reason instanceof Error ? reason : new Error("catalog cancelled"));
          };
          requestContext.signal.addEventListener("abort", abort, { once: true });
          if (requestContext.signal.aborted) abort();
        });
      }),
    },
    initialSessions: [],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const response = await backend.app.inject({
    method: "GET",
    url: "/api/v1/providers/codex/settings-options?hostId=local",
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    available: false,
    reason: "provider-unavailable",
    models: [],
  });
  assert.equal(cancelled, true, "the provider receives the deadline abort");
  assert.equal(active, false, "the provider releases its in-flight lookup");
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
      ...observeOnlyControl(),
      plane: "resume-only",
      authority: "foreign",
      capabilities: ["resume"],
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
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["set-model"],
      withheld: [],
      takeover: null,
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

/*
  A fresh managed session is always mid-turn — creation requires an initial
  message — and every streamed message bumps its generation. A catalog is
  thread-scoped provider data, not generation-scoped record data, so churn in
  unrelated fields must not withdraw it; only a change of identity or ownership
  may.
*/
test("serves the catalog even when unrelated session state changes during the provider read", async (t) => {
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
    available: true,
    source: "provider-api",
    models: [{ value: "sonnet", label: "Sonnet", description: "Balanced" }],
  });
});

test("withdraws a catalog when the session leaves manager ownership during the provider read", async (t) => {
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
  backend.state.upsert({
    ...current,
    control: { ...current.control, plane: "resume-only", authority: "foreign" },
  });
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

test("withdraws a catalog when the session disappears during the provider read", async (t) => {
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
  assert.ok(backend.state.remove("local:claude:managed-1"));
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
