import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { requestBootstrapFromControlSocket } from "../server/control-socket.ts";

export interface NodeBridgeRequest {
  id: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  controlLease?: string;
}

export interface NodeBridgeResponse {
  id: string;
  status: number;
  body: unknown;
}

function safeRequest(value: unknown): NodeBridgeRequest | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<NodeBridgeRequest>;
  if (
    typeof input.id !== "string"
    || input.id.length < 1
    || input.id.length > 128
    || !/^[A-Za-z0-9._:-]+$/u.test(input.id)
    || (input.method !== "GET" && input.method !== "POST" && input.method !== "DELETE")
    || typeof input.path !== "string"
    || input.path.length > 8_192
    || !input.path.startsWith("/api/v1/")
    || input.path.includes("\0")
    || (input.controlLease !== undefined && typeof input.controlLease !== "string")
  ) return null;
  return input as NodeBridgeRequest;
}

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
  output.write(`${JSON.stringify({ type: "ready", protocol: 1 })}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > 2 * 1_024 * 1_024) continue;
    let request: NodeBridgeRequest | null = null;
    try {
      request = safeRequest(JSON.parse(line) as unknown);
    } catch {
      // Malformed input gets a bounded response instead of terminating the node.
    }
    if (!request) {
      output.write(`${JSON.stringify({ id: "invalid", status: 400, body: { error: { code: "BRIDGE_REQUEST_INVALID", message: "Invalid bridge request" } } })}\n`);
      continue;
    }
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
      const reply: NodeBridgeResponse = { id: request.id, status: response.status, body };
      output.write(`${JSON.stringify(reply)}\n`);
    } catch (error) {
      const reply: NodeBridgeResponse = {
        id: request.id,
        status: 502,
        body: {
          error: {
            code: "REMOTE_NODE_UNAVAILABLE",
            message: error instanceof Error ? error.message : "Remote node request failed",
          },
        },
      };
      output.write(`${JSON.stringify(reply)}\n`);
    }
  }
}
