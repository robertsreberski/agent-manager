import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActivityHub } from "../activity/hub.ts";
import type { SessionRecord } from "../core/types.ts";
import { defaultPaths } from "../ops/config.ts";
import { observeOnlyControl } from "../shared/session.ts";
import { ConfigRemoteHostRegistry } from "./remote-host-registry.ts";
import { createAgentManagerServer } from "./server.ts";
import { unknownSandbox } from "../shared/session.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function remoteSession(hostId: string): SessionRecord {
  return {
    sandbox: unknownSandbox(),
    id: `${hostId}:codex:remote-thread`,
    provider: "codex",
    providerThreadId: "remote-thread",
    providerTreeId: "remote-thread",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId,
    hostLabel: "Old host",
    name: "Remote session",
    cwd: "/srv/project",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: null,
    runtimePid: null,
    startedAt: "2026-08-05T08:00:00.000Z",
    updatedAt: "2026-08-05T08:00:01.000Z",
    childSummary: { total: 0, running: 0, waiting: 0, idle: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 },
    statusSource: "provider-api",
    source: "fixture",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    effort: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: observeOnlyControl(),
    workspaceIdentity: null,
    generation: 1,
  };
}

async function authenticatedHeaders(
  backend: Awaited<ReturnType<typeof createAgentManagerServer>>,
): Promise<Record<string, string>> {
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
  return {
    host,
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": response.json<{ csrfToken: string }>().csrfToken,
  };
}

test("web host registration is config-backed, live, retry-safe, and cleans removed host state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-web-host-"));
  const paths = defaultPaths(root, process.getuid?.() ?? 501);
  const registry = new ConfigRemoteHostRegistry(paths, { timeoutMs: 100 });
  const oldHost = registry.add({ label: "Old host", target: "old@example.test" });
  const activityHub = new ActivityHub();
  const observed = remoteSession(oldHost.id);
  activityHub.ingest(observed.id, observed.provider, {
    type: "upsert",
    item: {
      id: "remote-history",
      kind: "lifecycle",
      event: "turn-started",
      level: "info",
      title: "Remote history",
      details: null,
      state: "complete",
    },
  });
  let backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 43_127,
    databasePath: paths.databaseFile,
    homeDirectory: root,
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    remoteHostRegistry: registry,
    activityHub,
    initialSessions: [observed],
    remotePollIntervalMs: 60_000,
    sshExecutable: "/usr/bin/false",
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  await backend.app.ready();
  const authenticated = await authenticatedHeaders(backend);

  const missingCsrf = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hosts",
    headers: { host, origin, cookie: authenticated.cookie, "content-type": "application/json" },
    payload: { label: "Build", target: "dev@build.example" },
  });
  assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);

  const invalid = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hosts",
    headers: authenticated,
    payload: { label: "Build", target: "not a valid ssh target" },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.match(invalid.body, /HOST_INVALID/u);

  const added = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hosts",
    headers: authenticated,
    payload: { label: "Build host", target: "dev@build.example" },
  });
  assert.equal(added.statusCode, 200, added.body);
  const registered = added.json<{ host: { id: string; label: string; sshTarget: string; kind: string } }>().host;
  assert.equal(registered.label, "Build host");
  assert.equal(registered.sshTarget, "dev@build.example");
  assert.equal(registered.kind, "ssh");
  assert.equal(registry.list().some((candidate) => candidate.id === registered.id), true);
  assert.equal(backend.database.getHost(registered.id)?.sshTarget, "dev@build.example");

  const replayed = await backend.app.inject({
    method: "POST",
    url: "/api/v1/hosts",
    headers: authenticated,
    payload: { label: "A different label cannot replace it", target: "dev@build.example" },
  });
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.equal(replayed.json<{ host: { id: string; label: string } }>().host.id, registered.id);
  assert.equal(replayed.json<{ host: { id: string; label: string } }>().host.label, "Build host");

  const deleteHeaders = {
    host: authenticated.host,
    origin: authenticated.origin,
    cookie: authenticated.cookie,
    "x-csrf-token": authenticated["x-csrf-token"],
  };

  const removed = await backend.app.inject({
    method: "DELETE",
    url: `/api/v1/hosts/${encodeURIComponent(oldHost.id)}`,
    headers: deleteHeaders,
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { removed: true });
  assert.equal(registry.list().some((candidate) => candidate.id === oldHost.id), false);
  assert.equal(backend.database.getHost(oldHost.id), null);
  assert.equal(backend.state.get(observed.id), null);
  assert.equal(activityHub.snapshot(observed.id), null);

  const repeatedDelete = await backend.app.inject({
    method: "DELETE",
    url: `/api/v1/hosts/${encodeURIComponent(oldHost.id)}`,
    headers: deleteHeaders,
  });
  assert.equal(repeatedDelete.statusCode, 200, repeatedDelete.body);
  assert.deepEqual(repeatedDelete.json(), { removed: true });

  await backend.close();
  backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 43_127,
    databasePath: paths.databaseFile,
    homeDirectory: root,
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    remoteHostRegistry: registry,
    remotePollIntervalMs: 60_000,
    sshExecutable: "/usr/bin/false",
  });
  await backend.app.ready();
  const restartedAuth = await authenticatedHeaders(backend);
  const hosts = await backend.app.inject({
    method: "GET",
    url: "/api/v1/hosts",
    headers: { host, cookie: restartedAuth.cookie },
  });
  assert.equal(hosts.statusCode, 200, hosts.body);
  const ids = hosts.json<{ hosts: Array<{ id: string }> }>().hosts.map((candidate) => candidate.id);
  assert.equal(ids.includes(registered.id), true);
  assert.equal(ids.includes(oldHost.id), false);
});
