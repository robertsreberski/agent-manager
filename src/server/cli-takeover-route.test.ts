import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import type {
  ActionDispatchResult,
  CreateSessionInput,
  ProviderControlAdapter,
  RequestContext,
  SessionAction,
} from "./contracts.ts";
import type {
  LocalCliInspection,
  LocalCliProcessIdentity,
  LocalCliProcessInspector,
} from "./cli-takeover.ts";
import { ManagerDatabase } from "./persistence.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "local:codex:takeover-thread",
    provider: "codex",
    providerThreadId: "takeover-thread",
    providerTreeId: "takeover-thread",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Foreign Codex CLI",
    cwd: "/workspace/takeover",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: 42,
    runtimePid: 42,
    startedAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:00:00.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "process",
    source: "fixture",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: "gpt-test", providerValue: "gpt-test", source: "provider-cli", confidence: "exact" },
    effort: { value: "high", providerValue: "high", source: "provider-cli", confidence: "exact" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
    workspaceIdentity: null,
    generation: 1,
    ...overrides,
  };
}

const identity: LocalCliProcessIdentity = {
  pid: 42,
  uid: 501,
  executable: "codex",
  startedAt: "Wed Aug 5 10:00:00 2026",
  providerSessionId: "takeover-thread",
  cwd: "/workspace/takeover",
};

class Inspector implements LocalCliProcessInspector {
  inspection: LocalCliInspection = { state: "running", identity };
  inspect(): LocalCliInspection { return structuredClone(this.inspection); }
  terminate(): void { throw new Error("guided takeover must not signal"); }
}

async function headers(backend: Awaited<ReturnType<typeof createAgentManagerServer>>) {
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ csrfToken: string }>();
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  assert.ok(cookie);
  return { host, origin, cookie, "content-type": "application/json", "x-csrf-token": body.csrfToken };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (true) {
    try { assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
}

test("route takeover publishes manager controls only after durable provider adoption", async (t) => {
  const database = new ManagerDatabase();
  database.addWorkspace({ id: "takeover-workspace", label: "Takeover", path: "/workspace/takeover" });
  const inspector = new Inspector();
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let commitStarted = false;
  const adapter: ProviderControlAdapter = {
    async createSession(_input: CreateSessionInput, _context: RequestContext): Promise<SessionView> {
      throw new Error("not used");
    },
    async adoptExternalSession(original, profile, context) {
      assert.equal(profile, "plan");
      assert.equal(context.workspace?.path, original.cwd);
      return session({
        ...original,
        pid: null,
        runtimePid: null,
        profile: { value: profile, providerValue: profile, source: "provider-api", confidence: "exact" },
        control: { plane: "codex-private", authority: "manager", capabilities: ["queue"], withheld: [], takeover: null },
      });
    },
    async commitExternalAdoption(providerSessionId) {
      assert.equal(providerSessionId, "takeover-thread");
      commitStarted = true;
      await commitGate;
      return session({ control: { plane: "codex-private", authority: "manager", capabilities: ["queue"], withheld: [], takeover: null } });
    },
    async performAction(_view: SessionView, _action: SessionAction, _context: RequestContext): Promise<ActionDispatchResult> {
      return { status: "succeeded" };
    },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    database,
    adapters: { codex: adapter },
    initialSessions: [session()],
    cliTakeoverInspector: inspector,
    cliTakeoverTimings: { guidedTimeoutMs: 200, adoptionTimeoutMs: 200, pollIntervalMs: 2 },
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const authenticated = await headers(backend);
  const offered = backend.state.get("local:codex:takeover-thread");
  assert.ok(offered);
  assert.ok(offered.control.capabilities.includes("take-control"));
  assert.equal(offered.control.takeover?.fallbackProfile, "plan");

  const leaseResponse = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/control-lease`,
    headers: authenticated,
    payload: { clientId: "takeover-browser" },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const token = leaseResponse.json<{ lease: { token: string } }>().lease.token;
  const action = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(offered.id)}/actions`,
    headers: { ...authenticated, "x-control-lease": token },
    payload: {
      type: "take-control",
      method: "guided-exit",
      expectedGeneration: offered.generation,
      idempotencyKey: "takeover-route-action",
    },
  });
  assert.equal(action.statusCode, 200, action.body);
  assert.equal(backend.state.get(offered.id)?.control.takeover?.state, "waiting-for-exit");
  assert.equal(backend.state.get(offered.id)?.control.capabilities.includes("queue"), false);

  inspector.inspection = { state: "exited" };
  await waitFor(() => assert.equal(commitStarted, true));
  const committing = backend.state.get(offered.id);
  assert.ok(committing);
  assert.equal(committing.control.takeover?.state, "adopting");
  assert.equal(committing.control.authority, "none");
  assert.equal(committing.control.capabilities.includes("queue"), false);
  assert.equal(database.listManagedSessions().some((record) => record.id === offered.id), true);

  releaseCommit();
  await waitFor(() => assert.equal(backend.state.get(offered.id)?.control.authority, "manager"));
  const adopted = backend.state.get(offered.id);
  assert.ok(adopted?.control.capabilities.includes("queue"));
  assert.equal(adopted?.profile.value, "plan");
});
