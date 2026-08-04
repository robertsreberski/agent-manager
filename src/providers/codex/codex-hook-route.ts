import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { CodexHookBridge } from "./codex-hook-bridge.ts";

export const CODEX_HOOK_ROUTE = "/api/v1/hooks/codex";
export const CODEX_HOOK_BODY_LIMIT = 1_048_576;

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function loopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function loopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === "/"
      && parsed.search.length === 0
      && parsed.hash.length === 0
      && ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function empty(reply: FastifyReply, statusCode: number): FastifyReply {
  return reply.code(statusCode).send();
}

/** Registers the Codex-only loopback ingress. Browser auth is bypassed only at the host layer. */
export function registerCodexHookRoute(app: FastifyInstance, bridge: CodexHookBridge): void {
  app.post(CODEX_HOOK_ROUTE, {
    bodyLimit: CODEX_HOOK_BODY_LIMIT,
    config: { agentManagerPublicHook: true },
    handler: (request: FastifyRequest, reply: FastifyReply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("Pragma", "no-cache")
        .header("X-Content-Type-Options", "nosniff");
      if (!loopbackAddress(request.raw.socket.remoteAddress) || !loopbackHost(request.headers.host)) {
        return empty(reply, 403);
      }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return empty(reply, 415);
      }
      const response = bridge.handle({
        ...(header(request.headers.authorization) === undefined
          ? {}
          : { authorization: header(request.headers.authorization)! }),
        body: request.body,
      });
      if (response.body === null) return empty(reply, response.statusCode);
      return reply.code(response.statusCode).send(response.body);
    },
  });
}
