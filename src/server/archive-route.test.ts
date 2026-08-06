import assert from "node:assert/strict";
import { get as httpGet, type IncomingMessage } from "node:http";
import test from "node:test";

import { baseRecord } from "../discovery/observe-values.ts";
import { observeOnlyControl } from "../shared/session.ts";
import { AGENT_MANAGER_BUILD_ID, WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import type { SessionRecord } from "../shared/session.ts";
import type { ArchivedSessionCatalog } from "./archive-catalog.ts";
import { createAgentManagerServer } from "./server.ts";
import type { SessionTranscriptReader } from "./transcript.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

async function authenticatedHeaders(backend: Awaited<ReturnType<typeof createAgentManagerServer>>) {
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

function archivedSession(): SessionRecord {
  return {
    ...baseRecord("codex", "archive-1", Date.parse("2026-08-05T10:00:00.000Z")),
    archived: true,
    name: "Archived exact session",
    cwd: "/workspace/archive",
    status: "completed",
    providerStatus: "archived",
    statusSource: "provider-cli",
    control: observeOnlyControl(),
  };
}

test("archive routes stay separate from active state while exposing history and facts", async (t) => {
  const archived = archivedSession();
  const active = {
    ...baseRecord("codex", "active-1", Date.parse("2026-08-05T11:00:00.000Z")),
    name: "Active session",
  };
  const requested: Array<{
    query: string;
    cursor: string | null;
    limit: number;
    excludeSessionIds?: ReadonlySet<string>;
  }> = [];
  const catalog: ArchivedSessionCatalog = {
    list(input) {
      requested.push(input);
      return { sessions: [archived], nextCursor: "next", total: 51 };
    },
    get(id) {
      return id === archived.id ? structuredClone(archived) : null;
    },
  };
  const reader: SessionTranscriptReader = {
    read(session) {
      assert.equal(session.providerThreadId, archived.providerThreadId);
      return {
        transcript: { state: "available", source: "codex-rollout", truncated: false, itemCount: 1, reason: null, forked: false },
        items: [{
          kind: "message",
          id: "archived-message",
          role: "user",
          text: "searchable archived history",
          label: null,
          createdAt: "2026-08-05T09:00:00.000Z",
          status: "complete",
          correlationId: null,
          turnId: null,
          memoryCitation: null,
        }],
      };
    },
    search(session, query) {
      assert.equal(session.providerThreadId, archived.providerThreadId);
      assert.equal(query, "archived");
      return { matches: [], truncated: false };
    },
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    initialSessions: [active],
    archivedSessionCatalog: catalog,
    transcriptReader: reader,
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const activeResponse = await backend.app.inject({ method: "GET", url: "/api/v1/sessions", headers });
  assert.equal(activeResponse.statusCode, 200, activeResponse.body);
  assert.deepEqual(activeResponse.json<{ sessions: SessionRecord[] }>().sessions.map((session) => session.id), [active.id]);

  const pageResponse = await backend.app.inject({
    method: "GET",
    url: "/api/v1/archived-sessions?q=archive&cursor=opaque&limit=50",
    headers,
  });
  assert.equal(pageResponse.statusCode, 200, pageResponse.body);
  assert.deepEqual(requested, [{
    query: "archive",
    cursor: "opaque",
    limit: 50,
    excludeSessionIds: new Set([active.id]),
  }]);
  assert.deepEqual(pageResponse.json(), {
    schemaVersion: WIRE_SCHEMA_VERSION,
    buildId: AGENT_MANAGER_BUILD_ID,
    query: "archive",
    sessions: [archived],
    nextCursor: "next",
    total: 51,
  });

  const direct = await backend.app.inject({ method: "GET", url: `/api/v1/archived-sessions/${encodeURIComponent(archived.id)}`, headers });
  assert.equal(direct.statusCode, 200, direct.body);
  assert.equal(direct.json<{ session: SessionRecord }>().session.archived, true);
  const genericRead = await backend.app.inject({ method: "GET", url: `/api/v1/sessions/${encodeURIComponent(archived.id)}`, headers });
  assert.equal(genericRead.statusCode, 200, genericRead.body);

  const facts = await backend.app.inject({ method: "GET", url: `/api/v1/sessions/${encodeURIComponent(archived.id)}/facts?generation=0`, headers });
  assert.equal(facts.statusCode, 200, facts.body);
  assert.deepEqual(facts.json<{ account: unknown }>().account, { available: false, reason: "not-manager-owned" });
  const search = await backend.app.inject({ method: "GET", url: `/api/v1/sessions/${encodeURIComponent(archived.id)}/search?q=archived&limit=20`, headers });
  assert.equal(search.statusCode, 200, search.body);

  const address = new URL(await backend.listen());
  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: `/api/v1/sessions/${encodeURIComponent(archived.id)}/activity/events?clientId=archive-history`,
      headers: { host, cookie: headers.cookie, accept: "text/event-stream" },
    }, resolve);
    request.once("error", reject);
  });
  assert.equal(stream.statusCode, 200);
  const firstEvent = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for archived history")), 1_500);
    stream.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (!buffered.includes("\n\n")) return;
      clearTimeout(timer);
      resolve(buffered);
    });
  });
  stream.destroy();
  const data = firstEvent.match(/data: ([^\n]+)/u)?.[1];
  assert.ok(data);
  const frame = JSON.parse(data) as { type: string; items?: Array<{ kind: string; text?: string }> };
  assert.equal(frame.type, "activity.snapshot");
  assert.ok(frame.items?.some((item) => item.kind === "message" && item.text === "searchable archived history"));

  const lease = await backend.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${encodeURIComponent(archived.id)}/control-lease`,
    headers,
    payload: { clientId: "archive-browser" },
  });
  assert.equal(lease.statusCode, 404, "archived records never enter the mutation state store");
});

test("active session identities are excluded from archived list and direct resolution", async (t) => {
  const active = {
    ...baseRecord("codex", "identity-collision", Date.parse("2026-08-05T11:00:00.000Z")),
    name: "Current active identity",
  };
  const staleArchive: SessionRecord = {
    ...active,
    archived: true,
    presence: "recent",
    status: "completed",
    providerStatus: "archived",
    name: "Stale archived identity",
  };
  const exclusions: ReadonlySet<string>[] = [];
  const catalog: ArchivedSessionCatalog = {
    list(input) {
      const excluded = input.excludeSessionIds ?? new Set<string>();
      exclusions.push(excluded);
      return {
        sessions: excluded.has(staleArchive.id) ? [] : [staleArchive],
        nextCursor: null,
        total: excluded.has(staleArchive.id) ? 0 : 1,
      };
    },
    get(id, excludeSessionIds) {
      const excluded = excludeSessionIds ?? new Set<string>();
      exclusions.push(excluded);
      return id === staleArchive.id && !excluded.has(id) ? staleArchive : null;
    },
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    initialSessions: [active],
    archivedSessionCatalog: catalog,
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);

  const page = await backend.app.inject({ method: "GET", url: "/api/v1/archived-sessions", headers });
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(page.json<{ sessions: SessionRecord[] }>().sessions, []);
  const direct = await backend.app.inject({
    method: "GET",
    url: `/api/v1/archived-sessions/${encodeURIComponent(active.id)}`,
    headers,
  });
  assert.equal(direct.statusCode, 404, direct.body);
  const generic = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent(active.id)}`,
    headers,
  });
  assert.equal(generic.statusCode, 200, generic.body);
  assert.equal(generic.json<{ session: SessionRecord }>().session.name, "Current active identity");
  assert.equal(exclusions.length, 2);
  assert.equal(exclusions.every((excluded) => excluded.has(active.id)), true);
});

test("archive catalog failures stay typed 503s while genuine misses remain 404s", async (t) => {
  const unavailableId = "local:codex:archive-catalog-unavailable";
  const missingId = "local:codex:archive-genuinely-missing";
  const catalog: ArchivedSessionCatalog = {
    list() {
      return { sessions: [], nextCursor: null, total: 0 };
    },
    get(id) {
      if (id === unavailableId) throw new Error("simulated archive database failure");
      return null;
    },
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    archivedSessionCatalog: catalog,
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const headers = await authenticatedHeaders(backend);
  const suffixes = [
    "",
    "/facts?generation=0",
    "/search?q=history&limit=20",
    "/plans/plan-item",
    "/activity/events?clientId=archive-catalog-error",
  ];

  const directUnavailable = await backend.app.inject({
    method: "GET",
    url: `/api/v1/archived-sessions/${encodeURIComponent(unavailableId)}`,
    headers,
  });
  assert.equal(directUnavailable.statusCode, 503, directUnavailable.body);
  assert.equal(directUnavailable.json<{ error: { code: string } }>().error.code, "ARCHIVE_UNAVAILABLE");

  for (const suffix of suffixes) {
    const unavailable = await backend.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${encodeURIComponent(unavailableId)}${suffix}`,
      headers,
    });
    assert.equal(unavailable.statusCode, 503, `${suffix || "direct session"}: ${unavailable.body}`);
    assert.equal(unavailable.json<{ error: { code: string } }>().error.code, "ARCHIVE_UNAVAILABLE");

    const missing = await backend.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${encodeURIComponent(missingId)}${suffix}`,
      headers,
    });
    assert.equal(missing.statusCode, 404, `${suffix || "direct session"}: ${missing.body}`);
    assert.equal(missing.json<{ error: { code: string } }>().error.code, "SESSION_NOT_FOUND");
  }

  const directMissing = await backend.app.inject({
    method: "GET",
    url: `/api/v1/archived-sessions/${encodeURIComponent(missingId)}`,
    headers,
  });
  assert.equal(directMissing.statusCode, 404, directMissing.body);
  assert.equal(directMissing.json<{ error: { code: string } }>().error.code, "SESSION_NOT_FOUND");
});

test("archived transcript polling retains its selected identity when catalog reads fail", async (t) => {
  const archived = {
    ...archivedSession(),
    status: "running" as const,
    providerStatus: "running",
  };
  let catalogReads = 0;
  let transcriptReads = 0;
  const catalog: ArchivedSessionCatalog = {
    list() {
      return { sessions: [archived], nextCursor: null, total: 1 };
    },
    get(id) {
      if (id !== archived.id) return null;
      catalogReads += 1;
      if (catalogReads >= 3) throw new Error("simulated transient polling failure");
      return structuredClone(archived);
    },
  };
  const reader: SessionTranscriptReader = {
    read(session) {
      transcriptReads += 1;
      assert.equal(session.providerThreadId, archived.providerThreadId);
      return {
        transcript: {
          state: "available",
          source: "codex-rollout",
          truncated: false,
          itemCount: 1,
          reason: null,
          forked: false,
        },
        items: [{
          kind: "message",
          id: `archived-message-${transcriptReads}`,
          role: "assistant",
          text: `archived poll ${transcriptReads}`,
          label: null,
          createdAt: `2026-08-05T09:00:0${transcriptReads}.000Z`,
          status: "complete",
          correlationId: null,
          turnId: null,
          memoryCitation: null,
        }],
      };
    },
  };
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [host],
    allowedOrigins: [origin],
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    archivedSessionCatalog: catalog,
    transcriptReader: reader,
  });
  const streams = new Set<IncomingMessage>();
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await backend.close();
  });
  const address = new URL(await backend.listen());
  const headers = await authenticatedHeaders(backend);
  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: `/api/v1/sessions/${encodeURIComponent(archived.id)}/activity/events?clientId=archive-polling`,
      headers: { host, cookie: headers.cookie, accept: "text/event-stream" },
    }, resolve);
    request.once("error", reject);
  });
  streams.add(stream);
  assert.equal(stream.statusCode, 200);

  const readEvent = async (label: string): Promise<string> => await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_500);
    stream.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString("utf8"));
    });
    stream.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.match(await readEvent("initial archived transcript"), /archived poll 1/u);
  const polled = await readEvent("archived transcript after catalog failure");
  assert.match(polled, /archived poll 2/u);
  assert.ok(catalogReads >= 3);
  assert.ok(transcriptReads >= 2);
});
