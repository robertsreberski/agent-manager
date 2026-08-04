import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ActivityHub, ACTIVITY_SCHEMA_VERSION } from "../activity/index.ts";
import { AGENT_MANAGER_BUILD_ID, WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import { RemoteHostManager } from "./manager.ts";
import { localBuildId, REMOTE_BRIDGE_PROTOCOL_VERSION } from "./protocol.ts";

const AT = "2026-08-04T12:00:00.000Z";

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
    model: { value: "gpt-fixture", providerValue: "gpt-fixture", source: "provider-api", confidence: "exact" },
    effort: { value: "medium", providerValue: "medium", source: "provider-api", confidence: "exact" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: { plane: "codex-private", authority: "manager", capabilities: ["steer"], withheld: [] },
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
    },
    generation: 7,
  } as const;
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
