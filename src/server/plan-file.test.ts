import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActivityHub } from "../activity/index.ts";
import type { SessionView } from "../core/types.ts";
import { LocalPlanFileReader } from "./plan-file.ts";
import { createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "local:claude:thread-1",
    provider: "claude",
    providerThreadId: "thread-1",
    providerTreeId: "thread-1",
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: "Plan session",
    cwd: "/tmp/workspace",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "waiting",
    providerStatus: "waiting",
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
    statusSource: "provider-api",
    source: "fixture",
    profile: {
      value: "plan",
      providerValue: "plan",
      source: "provider-api",
      confidence: "exact",
    },
    model: {
      value: null,
      providerValue: null,
      source: "provider-api",
      confidence: "exact",
    },
    effort: {
      value: null,
      providerValue: null,
      source: "provider-api",
      confidence: "exact",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "claude-hook-bridge",
      authority: "foreign",
      capabilities: [],
      withheld: [],
      takeover: null,
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
  const header = response.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

test("registered plan route reads only the current local plan item from a hardened root", async (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "agent-manager-plan-file-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, "plans");
  const outside = join(temporary, "outside.md");
  const valid = join(root, "registered.md");
  const linked = join(root, "linked.md");
  mkdirSync(root, { recursive: true });
  writeFileSync(valid, "# Registered plan\n\nShip exactly this.\n");
  writeFileSync(outside, "# Not registered\n");
  symlinkSync(valid, linked);

  const activityHub = new ActivityHub({ streamEpoch: "plan-file-route" });
  const addPlan = (id: string, path: string | null): void => {
    activityHub.ingest("local:claude:thread-1", "claude", {
      type: "upsert",
      item: {
        id,
        kind: "plan",
        path,
        version: null,
        markdown: "# Provider projection",
        supersededBy: null,
        approvedAt: null,
      },
    });
  };
  addPlan("plan-valid", valid);
  addPlan("plan-no-path", null);
  addPlan("plan-symlink", linked);
  addPlan("plan-outside", outside);
  activityHub.ingest("local:claude:thread-1", "claude", {
    type: "upsert",
    item: { id: "todo-not-plan", kind: "todo", steps: [], added: 0, removed: 0 },
  });

  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    activityHub,
    planFileReader: new LocalPlanFileReader({
      allowedRoots: [root],
      uid: statSync(root).uid,
    }),
    initialSessions: [session()],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const base = `/api/v1/sessions/${encodeURIComponent("local:claude:thread-1")}/plans`;

  const unauthenticated = await backend.app.inject({
    method: "GET",
    url: `${base}/plan-valid`,
    headers: { host },
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

  const cookie = await authenticatedCookie(backend);
  const response = await backend.app.inject({
    method: "GET",
    url: `${base}/plan-valid`,
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), {
    sessionId: "local:claude:thread-1",
    itemId: "plan-valid",
    path: valid,
    markdown: "# Registered plan\n\nShip exactly this.\n",
    truncated: false,
  });

  const unregistered = await backend.app.inject({
    method: "GET",
    url: `${base}/not-registered?path=${encodeURIComponent(valid)}`,
    headers: { host, cookie },
  });
  assert.equal(unregistered.statusCode, 404, unregistered.body);
  assert.equal(unregistered.json<{ error: { code: string } }>().error.code, "PLAN_ITEM_NOT_FOUND");

  const wrongKind = await backend.app.inject({
    method: "GET",
    url: `${base}/todo-not-plan`,
    headers: { host, cookie },
  });
  assert.equal(wrongKind.statusCode, 404, wrongKind.body);

  for (const [itemId, reason] of [
    ["plan-no-path", "no-path"],
    ["plan-symlink", "unreadable"],
    ["plan-outside", "outside-allowed-roots"],
  ] as const) {
    const unavailable = await backend.app.inject({
      method: "GET",
      url: `${base}/${itemId}`,
      headers: { host, cookie },
    });
    assert.equal(unavailable.statusCode, 409, unavailable.body);
    const error = unavailable.json<{
      error: { code: string; details: { reason: string } };
    }>().error;
    assert.equal(error.code, "PLAN_FILE_UNAVAILABLE");
    assert.equal(error.details.reason, reason);
  }
});

test("plan-file reader caps UTF-8 without splitting a code point", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "agent-manager-plan-cap-")));
  try {
    const root = join(temporary, "plans");
    const path = join(root, "unicode.md");
    mkdirSync(root);
    writeFileSync(path, "abcéz");
    const reader = new LocalPlanFileReader({
      allowedRoots: [root],
      uid: statSync(root).uid,
      maxBytes: 5,
    });
    assert.deepEqual(reader.read(path), {
      state: "available",
      markdown: "abcé",
      truncated: true,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("remote plan-file reads are explicitly unavailable", async (t) => {
  const activityHub = new ActivityHub({ streamEpoch: "remote-plan-file" });
  activityHub.ingest("studio:claude:thread-remote", "claude", {
    type: "upsert",
    item: {
      id: "plan-remote",
      kind: "plan",
      path: "/remote/provider/plan.md",
      markdown: "# Remote",
    },
  });
  const backend = await createAgentManagerServer({
    discovery: false,
    staticDir: false,
    activityHub,
    initialSessions: [session({
      id: "studio:claude:thread-remote",
      providerThreadId: "thread-remote",
      providerTreeId: "thread-remote",
      hostId: "studio",
      hostLabel: "Studio Mac",
    })],
  });
  t.after(() => backend.close());
  await backend.app.ready();
  const cookie = await authenticatedCookie(backend);
  const response = await backend.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${encodeURIComponent("studio:claude:thread-remote")}/plans/plan-remote`,
    headers: { host, cookie },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json<{ error: { code: string } }>().error.code, "PLAN_FILE_UNAVAILABLE");
});
