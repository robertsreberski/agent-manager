import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../core/types.ts";
import { observeOnlyControl } from "../shared/session.ts";
import type {
  SessionTranscriptReader,
  TranscriptSearchResult,
} from "./transcript.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "local:codex:thread-1",
    provider: "codex",
    providerThreadId: "thread-1",
    providerTreeId: "thread-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Selected session",
    cwd: "/tmp/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: null,
    runtimePid: null,
    startedAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:00:00.000Z",
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
    statusSource: "transcript",
    source: "fixture",
    profile: {
      value: null,
      providerValue: null,
      source: "inferred",
      confidence: "heuristic",
    },
    model: {
      value: null,
      providerValue: null,
      source: "inferred",
      confidence: "heuristic",
    },
    effort: {
      value: null,
      providerValue: null,
      source: "inferred",
      confidence: "heuristic",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      ...observeOnlyControl(),
      plane: "codex-hook-bridge",
      authority: "foreign",
    },
    workspaceIdentity: null,
    generation: 0,
    ...overrides,
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

test("search is authenticated, selected-session-only, bounded, and metadata-only", async (t) => {
  const calls: Array<{ sessionId: string; query: string; limit: number | undefined }> = [];
  const searchResult: TranscriptSearchResult = {
    matches: [{
      messageId: "message-selected",
      role: "assistant",
      createdAt: "2026-08-04T10:01:00.000Z",
      snippet: "Only the selected transcript contains hidden-needle here.",
      matchStart: 38,
      matchEnd: 51,
    }],
    truncated: false,
  };
  const transcriptReader: SessionTranscriptReader = {
    read() {
      throw new Error("the search route must not hydrate a transcript");
    },
    search(selected, query, limit) {
      calls.push({
        sessionId: `${selected.provider}:${selected.providerThreadId}`,
        query,
        limit,
      });
      return searchResult;
    },
  };
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    transcriptReader,
    initialSessions: [
      session(),
      session({
        id: "local:codex:thread-2",
        providerThreadId: "thread-2",
        providerTreeId: "thread-2",
        name: "Unselected session",
      }),
    ],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const selectedPath = `/api/v1/sessions/${encodeURIComponent("local:codex:thread-1")}/search`;

  const unauthenticated = await backend.app.inject({
    method: "GET",
    url: `${selectedPath}?q=hidden-needle&limit=7`,
    headers: { host },
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);
  assert.equal(calls.length, 0);

  const cookie = await authenticatedCookie(backend);
  for (const url of [
    `${selectedPath}?q=x&limit=7`,
    `${selectedPath}?q=${"x".repeat(201)}&limit=7`,
    `${selectedPath}?q=hidden-needle&limit=51`,
  ]) {
    const invalid = await backend.app.inject({
      method: "GET",
      url,
      headers: { host, cookie },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.equal(calls.length, 0);

  const sequenceBeforeSearch = backend.state.events.sequence;
  const response = await backend.app.inject({
    method: "GET",
    url: `${selectedPath}?q=%20%20hidden-needle%20%20&limit=7`,
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), {
    sessionId: "local:codex:thread-1",
    ...searchResult,
  });
  assert.deepEqual(calls, [{
    sessionId: "codex:thread-1",
    query: "hidden-needle",
    limit: 7,
  }]);

  assert.equal(backend.state.events.sequence, sequenceBeforeSearch);
  assert.deepEqual(backend.state.events.replayAfter(sequenceBeforeSearch), {
    events: [],
    gap: false,
  });
  assert.equal(JSON.stringify(backend.state.snapshot()).includes("hidden-needle"), false);
});

test("remote and readerless transcript search return explicit unavailability", async (t) => {
  let searchCalls = 0;
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    transcriptReader: {
      read() {
        throw new Error("unused");
      },
      search() {
        searchCalls += 1;
        return { matches: [], truncated: false };
      },
    },
    initialSessions: [session({
      id: "studio:codex:thread-remote",
      providerThreadId: "thread-remote",
      providerTreeId: "thread-remote",
      hostId: "studio",
      hostLabel: "Studio Mac",
      name: "Remote session",
    })],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);

  const remote = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent("studio:codex:thread-remote")}/search?q=needle`,
    headers: { host, cookie },
  });
  assert.equal(remote.statusCode, 409, remote.body);
  assert.equal(remote.json<{ error: { code: string } }>().error.code, "TRANSCRIPT_SEARCH_UNAVAILABLE");
  assert.equal(searchCalls, 0);

  const readerless = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    initialSessions: [session()],
  });
  t.after(() => readerless.close());
  await readerless.app.ready();
  const readerlessCookie = await authenticatedCookie(readerless);
  const unavailable = await readerless.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent("local:codex:thread-1")}/search?q=needle`,
    headers: { host, cookie: readerlessCookie },
  });
  assert.equal(unavailable.statusCode, 409, unavailable.body);
  assert.equal(
    unavailable.json<{ error: { code: string } }>().error.code,
    "TRANSCRIPT_SEARCH_UNAVAILABLE",
  );
});

test("transcript search is limited to sixty reads per minute", async (t) => {
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    transcriptReader: {
      read() {
        throw new Error("unused");
      },
      search() {
        return { matches: [], truncated: false };
      },
    },
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);
  const url = `/api/v1/sessions/${encodeURIComponent("local:codex:thread-1")}/search?q=needle`;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await backend.app.inject({
      method: "GET",
      url,
      headers: { host, cookie },
    });
    assert.equal(response.statusCode, 200, `attempt ${String(attempt + 1)}: ${response.body}`);
  }
  const limited = await backend.app.inject({
    method: "GET",
    url,
    headers: { host, cookie },
  });
  assert.equal(limited.statusCode, 429, limited.body);
});
