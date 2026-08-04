import { createInterface } from "node:readline";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import { requestBootstrapFromControlSocket } from "../server/control-socket.ts";
import {
  ActivitySseDecoder,
  assertNodeServiceIdentity,
  localBuildId,
  parseNodeBridgeRequest,
  REMOTE_BRIDGE_MAX_LINE_BYTES,
  REMOTE_BRIDGE_PROTOCOL_VERSION,
  type NodeBridgeRequest,
  type NodeBridgeResponse,
  type NodeBridgeRpcRequest,
  type NodeBridgeStreamClosed,
  type NodeBridgeStreamOpenRequest,
} from "./protocol.ts";
import { WIRE_SCHEMA_VERSION } from "../shared/wire.ts";

function firstCookie(response: Response): string {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
  const cookie = values[0]?.split(";", 1)[0] ?? "";
  if (!cookie.includes("=")) throw new Error("Remote node did not establish an authenticated session");
  return cookie;
}

async function establishNodeSession(controlSocketPath: string): Promise<{
  origin: string;
  cookie: string;
  csrfToken: string;
}> {
  const issued = await requestBootstrapFromControlSocket(controlSocketPath);
  const bootstrap = new URL(issued.bootstrapUrl);
  const fragment = new URLSearchParams(bootstrap.hash.replace(/^#/, ""));
  const secret = fragment.get("bootstrap");
  if (!secret) throw new Error("Remote node bootstrap token is missing");
  const origin = bootstrap.origin;
  const response = await fetch(`${origin}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (!response.ok) throw new Error(`Remote node bootstrap failed (${String(response.status)})`);
  const payload = await response.json() as Record<string, unknown>;
  assertNodeServiceIdentity(payload);
  if (typeof payload.csrfToken !== "string") throw new Error("Remote node CSRF token is missing");
  return { origin, cookie: firstCookie(response), csrfToken: payload.csrfToken };
}

/**
 * Authenticated JSON-lines bridge used only through an owner SSH login. The
 * browser never receives the remote bootstrap cookie or CSRF token.
 */
export async function runNodeBridge(options: {
  controlSocketPath: string;
  input?: Readable;
  output?: Writable;
}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const session = await establishNodeSession(options.controlSocketPath);
  const streams = new Map<string, AbortController>();
  let outputClosed = false;
  const write = async (message: unknown): Promise<void> => {
    if (outputClosed) return;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > REMOTE_BRIDGE_MAX_LINE_BYTES) {
      throw new Error("Remote bridge message exceeded its size limit");
    }
    if (output.write(line)) return;
    await once(output, "drain");
  };
  await write({
    type: "hello",
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    wireSchemaVersion: WIRE_SCHEMA_VERSION,
    buildId: localBuildId(),
  });

  const rpc = async (request: NodeBridgeRpcRequest): Promise<void> => {
    let reply: NodeBridgeResponse;
    try {
      const response = await fetch(`${session.origin}${request.path}`, {
        method: request.method,
        headers: {
          accept: "application/json",
          cookie: session.cookie,
          ...(request.method === "GET"
            ? {}
            : {
                "content-type": "application/json",
                "x-csrf-token": session.csrfToken,
              }),
          ...(request.controlLease ? { "x-control-lease": request.controlLease } : {}),
        },
        ...(request.method !== "GET" && request.body !== undefined
          ? { body: JSON.stringify(request.body) }
          : {}),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = { error: { code: "REMOTE_RESPONSE_INVALID", message: "Remote node returned non-JSON data" } };
        }
      }
      reply = { type: "response", id: request.id, status: response.status, body };
    } catch (error) {
      reply = {
        type: "response",
        id: request.id,
        status: 502,
        body: {
          error: {
            code: "REMOTE_NODE_UNAVAILABLE",
            message: error instanceof Error ? error.message : "Remote node request failed",
          },
        },
      };
    }
    await write(reply);
  };

  const closeMessage = async (
    id: string,
    reason: NodeBridgeStreamClosed["reason"],
    message: string | null,
  ): Promise<void> => {
    streams.delete(id);
    await write({ type: "stream.closed", id, reason, message } satisfies NodeBridgeStreamClosed);
  };

  const stream = async (request: NodeBridgeStreamOpenRequest, controller: AbortController): Promise<void> => {
    try {
      const response = await fetch(`${session.origin}${request.path}`, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          cookie: session.cookie,
          ...(request.lastEventId ? { "last-event-id": request.lastEventId } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) as unknown : null;
        } catch {
          body = { error: { code: "REMOTE_STREAM_INVALID", message: "Remote node returned non-JSON stream error" } };
        }
        await write({ type: "stream.opened", id: request.id, status: response.status, body });
        await closeMessage(request.id, "error", `Remote activity stream failed (${String(response.status)})`);
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("text/event-stream")) {
        await write({
          type: "stream.opened",
          id: request.id,
          status: 502,
          body: { error: { code: "REMOTE_STREAM_INVALID", message: "Remote node did not return an event stream" } },
        });
        await closeMessage(request.id, "error", "Remote node did not return an event stream");
        return;
      }
      await write({ type: "stream.opened", id: request.id, status: response.status, body: null });
      const decoder = new ActivitySseDecoder();
      for await (const chunk of response.body) {
        if (controller.signal.aborted) break;
        for (const event of decoder.push(chunk)) {
          await write({
            type: "stream.frame",
            id: request.id,
            eventId: event.eventId,
            data: event.data,
          });
        }
      }
      if (!controller.signal.aborted) {
        for (const event of decoder.finish()) {
          await write({
            type: "stream.frame",
            id: request.id,
            eventId: event.eventId,
            data: event.data,
          });
        }
      }
      await closeMessage(
        request.id,
        controller.signal.aborted ? "cancelled" : "remote-end",
        null,
      );
    } catch (error) {
      await closeMessage(
        request.id,
        controller.signal.aborted ? "cancelled" : "error",
        controller.signal.aborted
          ? null
          : error instanceof Error ? error.message : "Remote activity stream failed",
      );
    }
  };

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > REMOTE_BRIDGE_MAX_LINE_BYTES) continue;
    let request: NodeBridgeRequest | null = null;
    try {
      request = parseNodeBridgeRequest(JSON.parse(line) as unknown);
    } catch {
      // Malformed input gets a bounded response instead of terminating the node.
    }
    if (!request) {
      await write({ type: "response", id: "invalid", status: 400, body: { error: { code: "BRIDGE_REQUEST_INVALID", message: "Invalid bridge request" } } });
      continue;
    }
    if (request.type === "rpc") {
      void rpc(request).catch(() => undefined);
    } else if (request.type === "stream.open") {
      if (streams.has(request.id)) {
        await write({ type: "stream.opened", id: request.id, status: 409, body: { error: { code: "REMOTE_STREAM_EXISTS", message: "Stream id already exists" } } });
        continue;
      }
      const controller = new AbortController();
      streams.set(request.id, controller);
      void stream(request, controller).catch(() => undefined);
    } else {
      const controller = streams.get(request.id);
      if (controller) controller.abort();
    }
  }
  outputClosed = true;
  for (const controller of streams.values()) controller.abort();
  streams.clear();
}
