import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActivityHub } from "../activity/index.ts";
import {
  CodexManagedAdapter,
  CodexProviderBridge,
} from "../providers/codex/index.ts";
import type { MessageTransport } from "../providers/codex/rpc.ts";
import type {
  JsonObject,
  JsonValue,
} from "../providers/codex/types.ts";
import { ManagerDatabase } from "./persistence.ts";
import { createAgentManagerServer } from "./server.ts";
import { SessionStateStore } from "./state.ts";

type RpcHandler = (params: JsonObject) => JsonValue | Promise<JsonValue>;

class RestartTransport implements MessageTransport {
  readonly methods: string[] = [];
  readonly handlers = new Map<string, RpcHandler>();
  #messageListeners = new Set<(message: string) => void>();
  #closeListeners = new Set<(error: Error | null) => void>();

  constructor() {
    this.handlers.set("initialize", () => ({
      codexHome: "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "codex-app-server/0.146.7",
    }));
  }

  async send(raw: string): Promise<void> {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (typeof message.method === "string") this.methods.push(message.method);
    if (typeof message.method !== "string" ||
        (typeof message.id !== "string" && typeof message.id !== "number")) return;
    const handler = this.handlers.get(message.method);
    queueMicrotask(async () => {
      const result = handler
        ? await handler((message.params ?? {}) as JsonObject)
        : null;
      const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      for (const listener of this.#messageListeners) listener(response);
    });
  }

  async close(): Promise<void> {
    for (const listener of this.#closeListeners) listener(null);
  }

  onMessage(listener: (message: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }
}

const host = "127.0.0.1:43127";
const origin = "http://127.0.0.1:43127";

async function authenticatedHeaders(
  backend: Awaited<ReturnType<typeof createAgentManagerServer>>,
) {
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ csrfToken: string }>();
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)
    ?.split(";", 1)[0];
  assert.ok(cookie);
  return {
    host,
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": body.csrfToken,
  };
}

async function waitFor(assertion: () => void, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function openActivityStream(
  address: URL,
  cookie: string,
  clientId: string,
): Promise<IncomingMessage> {
  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet({
      hostname: address.hostname,
      port: Number(address.port),
      path: `/api/v1/sessions/local:codex:thread-restart/activity/events?clientId=${clientId}`,
      headers: { host, cookie, accept: "text/event-stream" },
    }, resolve);
    request.once("error", reject);
  });
  assert.equal(stream.statusCode, 200);
  await once(stream, "data");
  return stream;
}

test("a full backend and provider restart re-adopts only the persisted private Codex identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-codex-restart-"));
  const databasePath = join(root, "state.sqlite");
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  try {
    const firstDatabase = new ManagerDatabase(databasePath);
    const firstBackend = await createAgentManagerServer({
      database: firstDatabase,
      discovery: false,
      staticDir: false,
      editorLauncher: false,
    });
    firstDatabase.addWorkspace({
      id: "workspace-restart",
      label: "Restart workspace",
      path: workspacePath,
    });
    firstDatabase.upsertManagedSession({
      id: "local:codex:thread-restart",
      provider: "codex",
      providerSessionId: "thread-restart",
      workspaceId: "workspace-restart",
      metadata: {
        managerRequestId: "manager-request-restart",
        name: "Restored manager name",
        profile: "execute",
        model: null,
        effort: null,
        hostId: "local",
      },
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:00.000Z",
    });
    firstDatabase.upsertManagedSession({
      id: "local:codex:missing-after-offline-delete",
      provider: "codex",
      providerSessionId: "missing-after-offline-delete",
      workspaceId: "workspace-restart",
      metadata: {
        managerRequestId: "manager-request-missing",
        name: "Removed while manager was offline",
        profile: "plan",
        model: null,
        effort: null,
        hostId: "local",
      },
      createdAt: "2026-08-03T08:05:00.000Z",
      updatedAt: "2026-08-03T08:05:00.000Z",
    });
    await firstBackend.close();

    const database = new ManagerDatabase(databasePath);
    const state = new SessionStateStore();
    const activityHub = new ActivityHub({ streamEpoch: "provider-restart" });
    const transport = new RestartTransport();
    const thread = () => ({
      cwd: workspacePath,
      model: "gpt-5.6",
      reasoningEffort: "high",
      thread: {
        id: "thread-restart",
        sessionId: "tree-restart",
        parentThreadId: null,
        cwd: workspacePath,
        name: "Native provider name",
        source: "agent-manager",
        status: { type: "idle" },
        turns: [],
      },
    }) satisfies JsonObject;
    transport.handlers.set("thread/list", () => {
      throw new Error("thread/list must not run during managed recovery");
    });
    transport.handlers.set("thread/read", thread);
    transport.handlers.set("thread/resume", thread);
    transport.handlers.set("turn/start", () => ({
      turn: { id: "turn-after-restart", status: "inProgress", items: [] },
    }));
    transport.handlers.set("turn/interrupt", () => ({}));
    transport.handlers.set("thread/unsubscribe", () => ({}));
    const adapter = new CodexManagedAdapter({
      transport,
      socketPath: join(root, "codex.sock"),
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      createId: () => "post-restart-message",
    });
    await adapter.initialize();
    const bridge = new CodexProviderBridge({
      adapter,
      resolveWorkspace: (workspaceId) => database.getWorkspace(workspaceId)?.path ?? null,
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      onSessionChanged: (session) => state.upsert(session),
      onSessionRemoved: (managerSessionId) => {
        database.removeManagedSession(managerSessionId);
        state.remove(managerSessionId);
        activityHub.clearSession(managerSessionId);
      },
      onActivity: (managerSessionId, mutation) => {
        activityHub.ingest(managerSessionId, "codex", mutation);
      },
    });
    const backend = await createAgentManagerServer({
      host: "127.0.0.1",
      port: 0,
      allowedHosts: [host],
      allowedOrigins: [origin],
      database,
      state,
      activityHub,
      adapters: { codex: bridge },
      discovery: false,
      staticDir: false,
      editorLauncher: false,
    });
    const streams = new Set<IncomingMessage>();
    try {
      const address = new URL(await backend.listen());
      const recovered = backend.state.get("local:codex:thread-restart");
      assert.ok(recovered);
      assert.equal(recovered.name, "Restored manager name");
      assert.equal(recovered.providerTreeId, "tree-restart");
      assert.equal(recovered.cwd, workspacePath);
      assert.equal(recovered.control.plane, "codex-private");
      assert.equal(recovered.control.authority, "manager");
      assert.equal(backend.state.get("local:codex:official-cli-thread"), null);
      assert.equal(backend.state.get("local:codex:missing-after-offline-delete"), null);
      assert.deepEqual(
        database.listManagedSessions().map((record) => record.id).sort(),
        [
          "local:codex:missing-after-offline-delete",
          "local:codex:thread-restart",
        ],
      );
      assert.deepEqual(transport.methods, [
        "initialize",
        "initialized",
        "thread/read",
        "thread/read",
      ]);

      const headers = await authenticatedHeaders(backend);
      const unloadedLease = await backend.app.inject({
        method: "POST",
        url: "/api/v1/sessions/local:codex:thread-restart/control-lease",
        headers,
        payload: { clientId: "restart-browser" },
      });
      assert.equal(unloadedLease.statusCode, 409, unloadedLease.body);
      assert.equal(transport.methods.includes("turn/start"), false);

      const firstSelection = await openActivityStream(address, headers.cookie, "restart-tab-one");
      streams.add(firstSelection);
      const secondSelection = await openActivityStream(address, headers.cookie, "restart-tab-two");
      streams.add(secondSelection);
      assert.equal(transport.methods.filter((method) => method === "thread/resume").length, 1);

      const selected = backend.state.get("local:codex:thread-restart");
      assert.ok(selected);
      assert.ok(selected.control.capabilities.includes("queue"));
      const leaseResponse = await backend.app.inject({
        method: "POST",
        url: "/api/v1/sessions/local:codex:thread-restart/control-lease",
        headers,
        payload: { clientId: "restart-browser" },
      });
      assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
      const lease = leaseResponse.json<{ lease: { token: string } }>().lease;
      const actionHeaders = { ...headers, "x-control-lease": lease.token };
      const sendResponse = await backend.app.inject({
        method: "POST",
        url: "/api/v1/sessions/local:codex:thread-restart/actions",
        headers: actionHeaders,
        payload: {
          type: "send",
          delivery: "queue",
          text: "Explicit action after restart",
          expectedGeneration: selected.generation,
          idempotencyKey: "restart-send-action",
        },
      });
      assert.equal(sendResponse.statusCode, 200, sendResponse.body);
      assert.equal(transport.methods.filter((method) => method === "turn/start").length, 1);

      firstSelection.destroy();
      streams.delete(firstSelection);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(transport.methods.filter((method) => method === "thread/unsubscribe").length, 0);
      secondSelection.destroy();
      streams.delete(secondSelection);
      await waitFor(() => {
        assert.equal(
          transport.methods.filter((method) => method === "thread/unsubscribe").length,
          1,
        );
      }, "last selected Codex client to release its native subscription");
      const deselected = backend.state.get("local:codex:thread-restart");
      assert.ok(deselected);
      assert.deepEqual(deselected.control.capabilities, []);

      const thirdSelection = await openActivityStream(address, headers.cookie, "restart-tab-three");
      streams.add(thirdSelection);
      assert.equal(transport.methods.filter((method) => method === "thread/resume").length, 2);

      const active = backend.state.get("local:codex:thread-restart");
      assert.ok(active);
      const endResponse = await backend.app.inject({
        method: "POST",
        url: "/api/v1/sessions/local:codex:thread-restart/actions",
        headers: actionHeaders,
        payload: {
          type: "end",
          expectedGeneration: active.generation,
          idempotencyKey: "restart-end-action",
        },
      });
      assert.equal(endResponse.statusCode, 200, endResponse.body);
      assert.equal(backend.state.get("local:codex:thread-restart"), null);
      assert.deepEqual(
        database.listManagedSessions().map((record) => record.id),
        ["local:codex:missing-after-offline-delete"],
      );
      thirdSelection.destroy();
      streams.delete(thirdSelection);
      backend.replaceSessions([]);
      assert.equal(backend.state.get("local:codex:thread-restart"), null);
    } finally {
      for (const stream of streams) stream.destroy();
      await backend.close();
      await adapter.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
