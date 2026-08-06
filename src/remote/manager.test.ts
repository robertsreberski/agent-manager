import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ActivityHub, ACTIVITY_SCHEMA_VERSION } from "../activity/index.ts";
import { providerControlCoordination } from "../shared/session.ts";
import { AGENT_MANAGER_BUILD_ID, WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import {
  RemoteHostManager,
  type RemoteHostClient,
  type RemoteHostDefinition,
} from "./manager.ts";
import { localBuildId, REMOTE_BRIDGE_PROTOCOL_VERSION } from "./protocol.ts";

const AT = "2026-08-04T12:00:00.000Z";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function remoteSession() {
  return {
    id: "local:codex:thread-1",
    provider: "codex",
    providerThreadId: "thread-1",
    providerTreeId: "tree-1",
    parentId: "local:codex:parent-thread",
    providerTurnId: null,
    depth: 1,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Remote fixture",
    cwd: "/remote/worktree",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "running",
    providerStatus: "running",
    pid: 42,
    runtimePid: 42,
    startedAt: AT,
    updatedAt: AT,
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
    profile: { value: "execute", providerValue: "default", source: "provider-api", confidence: "exact" },
    sandbox: { value: { mode: "workspace-write", networkAccess: false }, providerValue: "workspace-write;network=false", source: "provider-api", confidence: "exact" },
    model: { value: "gpt-fixture", providerValue: "gpt-fixture", source: "provider-api", confidence: "exact" },
    effort: { value: "medium", providerValue: "medium", source: "provider-api", confidence: "exact" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "codex-private",
      authority: "manager",
      coordination: providerControlCoordination("codex"),
      recovery: null,
      capabilities: ["steer"],
      withheld: [],
      peers: [],
      takeover: null,
    },
    workspaceIdentity: {
      repoRoot: "/remote/repo",
      repoName: "repo",
      worktreePath: "/remote/worktree",
      linked: true,
      branch: "feature/remote",
      detached: false,
      dirtyCount: 3,
      ahead: null,
      behind: null,
      insertions: 312,
      deletions: 87,
    },
    generation: 7,
  } as const;
}

function remoteSnapshot(threadId: string, name: string) {
  return {
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    generatedAt: AT,
    seq: 1,
    stale: false,
    sessions: [{
      ...remoteSession(),
      id: `local:codex:${threadId}`,
      providerThreadId: threadId,
      providerTreeId: threadId,
      parentId: null,
      name,
    }],
    diagnostics: [],
  };
}

function deferredPollingClients(): {
  factory: (definition: RemoteHostDefinition) => RemoteHostClient;
  requests: Map<string, Deferred<unknown>[]>;
  closed: string[];
} {
  const requests = new Map<string, Deferred<unknown>[]>();
  const closed: string[] = [];
  return {
    requests,
    closed,
    factory: (definition) => ({
      request<T>(): Promise<T> {
        const pending = deferred<unknown>();
        const targetRequests = requests.get(definition.target) ?? [];
        targetRequests.push(pending);
        requests.set(definition.target, targetRequests);
        return pending.promise as Promise<T>;
      },
      async openActivityStream() {
        throw new Error("activity stream not configured for polling test");
      },
      close() {
        closed.push(definition.target);
      },
    }),
  };
}

function fakeRemote(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-remote-manager-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "ssh.cjs");
  const snapshot = {
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    generatedAt: AT,
    seq: 1,
    stale: false,
    sessions: [remoteSession()],
    diagnostics: [],
  };
  const workspace = {
    id: "workspace-1",
    label: "worktree",
    path: "/remote/worktree",
    hostId: "local",
    hostLabel: "This Mac",
    hostKind: "local",
    remoteWorkspaceId: null,
    createdAt: AT,
    lastOpenedAt: null,
    repoRoot: "/remote/repo",
    repoName: "repo",
    workspaceIdentity: remoteSession().workspaceIdentity,
  };
  const activity = {
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    streamEpoch: "remote-activity",
    sessionId: "local:codex:thread-1",
    provider: "codex",
    seq: 1,
    cursor: "remote-activity:local:codex:thread-1:1",
    at: AT,
    type: "activity.snapshot",
    items: [{
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      id: "message-1",
      sessionId: "local:codex:thread-1",
      provider: "codex",
      correlationId: null,
      turnId: "turn-1",
      parentId: null,
      seq: 1,
      revision: 1,
      state: "running",
      startedAt: AT,
      updatedAt: AT,
      completedAt: null,
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
      truncated: false,
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: "Remote activity",
      label: null,
      memoryCitation: null,
    }],
    truncated: false,
  };
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({type:"hello",protocolVersion:${String(REMOTE_BRIDGE_PROTOCOL_VERSION)},wireSchemaVersion:${String(WIRE_SCHEMA_VERSION)},buildId:${JSON.stringify(localBuildId())}}) + "\\n");
const lines = readline.createInterface({input:process.stdin});
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "rpc") {
    let body;
    if (message.path === "/api/v1/sessions") body = ${JSON.stringify(snapshot)};
    else if (message.path === "/api/v1/workspaces/resolve") body = {workspace:${JSON.stringify(workspace)}};
    else if (message.method === "POST" && message.path.endsWith("/control-lease")) {
      body = {lease:{token:"remote-resume-lease",expiresAt:"2099-01-01T00:00:00.000Z"}};
    }
    else if (message.method === "POST" && message.path.endsWith("/actions")) {
      body = message.controlLease === "remote-resume-lease"
        && message.body?.type === "resume"
        && message.body?.expectedGeneration === 7
        ? {action:{status:"succeeded"}}
        : {action:{status:"failed"}};
    }
    else body = {error:{code:"NOT_FOUND",message:"fixture route missing"}};
    process.stdout.write(JSON.stringify({type:"response",id:message.id,status:body.error ? 404 : 200,body}) + "\\n");
  } else if (message.type === "stream.open") {
    process.stdout.write(JSON.stringify({type:"stream.opened",id:message.id,status:200,body:null}) + "\\n");
    process.stdout.write(JSON.stringify({type:"stream.frame",id:message.id,eventId:${JSON.stringify(activity.cursor)},data:${JSON.stringify(activity)}}) + "\\n");
  }
});
`);
  chmodSync(executable, 0o700);
  return executable;
}

test("strictly remaps remote app identity while preserving remote workspace facts", async (t) => {
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Studio Mac",
    target: "studio-host",
  }], { sshExecutable: fakeRemote(t) });
  t.after(() => manager.dispose());

  const sessions = await manager.listSessions("studio");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "studio:codex:thread-1");
  assert.equal(sessions[0]?.providerThreadId, "thread-1");
  assert.equal(sessions[0]?.providerTreeId, "tree-1");
  assert.equal(sessions[0]?.parentId, "studio:codex:parent-thread");
  assert.equal(sessions[0]?.hostId, "studio");
  assert.equal(sessions[0]?.hostLabel, "Studio Mac");
  assert.deepEqual(sessions[0]?.workspaceIdentity, remoteSession().workspaceIdentity);

  const workspace = await manager.resolveWorkspace("studio", "/remote/worktree");
  assert.equal(workspace.remoteWorkspaceId, "workspace-1");
  assert.equal(workspace.workspaceIdentity?.branch, "feature/remote");
});

test("relays selected remote activity as a stream rather than polling history", async (t) => {
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Studio Mac",
    target: "studio-host",
  }], { sshExecutable: fakeRemote(t) });
  t.after(() => manager.dispose());
  const [session] = await manager.listSessions("studio");
  assert.ok(session);
  const hub = new ActivityHub({ streamEpoch: "local" });
  const release = manager.acquireActivity(session.id, hub, session.provider);
  t.after(release);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const item = hub.snapshot(session.id)?.items[0];
  assert.equal(item?.sessionId, "studio:codex:thread-1");
  assert.equal(item?.kind === "message" ? item.text : null, "Remote activity");
});

test("proxies semantic resume with the remote generation and writer lease", async (t) => {
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Studio Mac",
    target: "studio-host",
  }], { sshExecutable: fakeRemote(t) });
  t.after(() => manager.dispose());
  const [session] = await manager.listSessions("studio");
  assert.ok(session);

  const result = await manager.performAction(session.id, {
    type: "resume",
    // The remote manager must replace this local projection generation.
    expectedGeneration: 999,
    idempotencyKey: "remote-resume-action",
  });
  assert.equal(result.status, "succeeded");
});

test("reconcile treats a target change as remove plus add and clears routing immediately", async (t) => {
  const closed: string[] = [];
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Old Studio",
    target: "old-studio",
  }], {
    clientFactory: (definition) => ({
      async request<T>(): Promise<T> {
        const thread = definition.target === "old-studio" ? "old-thread" : "new-thread";
        return remoteSnapshot(thread, definition.label) as T;
      },
      async openActivityStream() {
        throw new Error("activity stream not configured for reconcile test");
      },
      close() {
        closed.push(definition.target);
      },
    }),
  });
  t.after(() => manager.dispose());

  const [oldSession] = await manager.listSessions("studio");
  assert.ok(oldSession);
  assert.deepEqual(manager.reconcile([{
    id: "studio",
    label: "New Studio",
    target: "new-studio",
  }]), [oldSession.id]);
  assert.deepEqual(closed, ["old-studio"]);
  assert.deepEqual(manager.states(), [{
    id: "studio",
    label: "New Studio",
    target: "new-studio",
    status: "unknown",
    statusMessage: null,
  }]);
  await assert.rejects(
    manager.session(oldSession.id),
    /Remote session routing information is unavailable/u,
  );

  const [newSession] = await manager.listSessions("studio");
  assert.equal(newSession?.id, "studio:codex:new-thread");
});

test("reconcile adds, relabels, and deletes definitions through one seam", () => {
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Studio",
    target: "studio",
  }]);
  try {
    assert.deepEqual(manager.reconcile([{
      id: "studio",
      label: "Studio renamed",
      target: "studio",
    }, {
      id: "builder",
      label: "Builder",
      target: "builder",
    }]), []);
    assert.deepEqual(manager.states().map(({ id, label }) => ({ id, label })), [{
      id: "studio",
      label: "Studio renamed",
    }, {
      id: "builder",
      label: "Builder",
    }]);

    assert.deepEqual(manager.reconcile([{
      id: "builder",
      label: "Builder",
      target: "builder",
    }]), []);
    assert.deepEqual(manager.states().map((host) => host.id), ["builder"]);
  } finally {
    manager.dispose();
  }
});

test("a removed and re-added host ignores completion from its stale target epoch", async (t) => {
  const clients = deferredPollingClients();
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Old Studio",
    target: "old-studio",
  }], { clientFactory: clients.factory, pollIntervalMs: 60_000 });
  t.after(() => manager.dispose());
  const applied: string[] = [];
  const diagnostics: string[] = [];
  manager.start({
    onSessions: (_hostId, sessions) => applied.push(sessions[0]?.name ?? "empty"),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
  });
  assert.equal(clients.requests.get("old-studio")?.length, 1);

  manager.reconcile([{
    id: "studio",
    label: "New Studio",
    target: "new-studio",
  }]);
  assert.equal(clients.requests.get("new-studio")?.length, 1);
  clients.requests.get("new-studio")?.[0]?.resolve(remoteSnapshot("new-thread", "new result"));
  await tick();
  assert.deepEqual(applied, ["new result"]);

  clients.requests.get("old-studio")?.[0]?.resolve(remoteSnapshot("old-thread", "stale result"));
  await tick();
  assert.deepEqual(applied, ["new result"]);
  await assert.rejects(
    manager.session("studio:codex:old-thread"),
    /Remote session routing information is unavailable/u,
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(manager.states()[0]?.target, "new-studio");
  assert.equal(manager.states()[0]?.status, "online");
});

test("remove and re-add fences an old completion even for the same definition object", async (t) => {
  const clients = deferredPollingClients();
  const definition = { id: "studio", label: "Studio", target: "studio" } as const;
  const manager = new RemoteHostManager([definition], {
    clientFactory: clients.factory,
    pollIntervalMs: 60_000,
  });
  t.after(() => manager.dispose());
  const applied: string[] = [];
  manager.start({
    onSessions: (_hostId, sessions) => applied.push(sessions[0]?.name ?? "empty"),
  });
  assert.equal(clients.requests.get("studio")?.length, 1);

  manager.reconcile([]);
  manager.reconcile([definition]);
  assert.equal(clients.requests.get("studio")?.length, 2);
  clients.requests.get("studio")?.[1]?.resolve(remoteSnapshot("new-thread", "new epoch"));
  await tick();
  clients.requests.get("studio")?.[0]?.resolve(remoteSnapshot("old-thread", "old epoch"));
  await tick();

  assert.deepEqual(applied, ["new epoch"]);
});

test("a stale transport rejection cannot close or mark the replacement client offline", async (t) => {
  const clients = deferredPollingClients();
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Old Studio",
    target: "old-studio",
  }], { clientFactory: clients.factory, pollIntervalMs: 60_000 });
  t.after(() => manager.dispose());
  const diagnostics: string[] = [];
  manager.start({
    onSessions: () => undefined,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
  });
  manager.reconcile([{
    id: "studio",
    label: "New Studio",
    target: "new-studio",
  }]);
  clients.requests.get("new-studio")?.[0]?.resolve(remoteSnapshot("new-thread", "new result"));
  await tick();
  clients.requests.get("old-studio")?.[0]?.reject(new Error("old transport failed late"));
  await tick();

  assert.deepEqual(clients.closed, ["old-studio"]);
  assert.deepEqual(diagnostics, []);
  assert.equal(manager.states()[0]?.status, "online");
});

test("a cached lease cannot report acquisition after its host is reconciled away", async (t) => {
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Studio Mac",
    target: "studio-host",
  }], { sshExecutable: fakeRemote(t) });
  t.after(() => manager.dispose());
  const [session] = await manager.listSessions("studio");
  assert.ok(session);
  await manager.acquireControl(session.id);

  const pending = manager.acquireControl(session.id);
  manager.reconcile([]);
  await assert.rejects(pending, /Remote host changed while the request was in flight/u);
});

test("a slow poll is not overlapped by the next interval", async (t) => {
  const clients = deferredPollingClients();
  const manager = new RemoteHostManager([{
    id: "studio",
    label: "Studio",
    target: "studio",
  }], { clientFactory: clients.factory, pollIntervalMs: 1_000 });
  t.after(() => manager.dispose());
  manager.start({ onSessions: () => undefined });
  assert.equal(clients.requests.get("studio")?.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(clients.requests.get("studio")?.length, 1);
});
