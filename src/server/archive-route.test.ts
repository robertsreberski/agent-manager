import assert from "node:assert/strict";
import { get as httpGet, type IncomingMessage } from "node:http";
import test from "node:test";

import { baseRecord } from "../discovery/observe-values.ts";
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
    control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
  };
}

test("archive routes stay separate from active state while exposing history and facts", async (t) => {
  const archived = archivedSession();
  const active = {
    ...baseRecord("codex", "active-1", Date.parse("2026-08-05T11:00:00.000Z")),
    name: "Active session",
  };
  const requested: Array<{ query: string; cursor: string | null; limit: number }> = [];
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
        transcript: { state: "available", source: "codex-rollout", truncated: false, itemCount: 1, reason: null },
        items: [{
          kind: "message",
          id: "archived-message",
          role: "user",
          text: "searchable archived history",
          label: null,
          createdAt: "2026-08-05T09:00:00.000Z",
          status: "complete",
          correlationId: null,
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
  assert.deepEqual(requested, [{ query: "archive", cursor: "opaque", limit: 50 }]);
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
