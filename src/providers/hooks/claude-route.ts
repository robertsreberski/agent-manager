import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ClaudeHookBridge } from "./claude-bridge.ts";

export const CLAUDE_HOOK_ROUTE = "/api/v1/hooks/claude";
export const CLAUDE_HOOK_BODY_LIMIT = 1_048_576;

declare module "fastify" {
  interface FastifyContextConfig {
    /** The server's global auth hook uses this to bypass browser cookie/CSRF auth only. */
    agentManagerPublicHook?: true;
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function loopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1"
    || value === "::1"
    || value === "::ffff:127.0.0.1";
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

/**
 * Registers the complete provider-specific route handler. The host server must
 * exempt only `agentManagerPublicHook === true` from browser
 * cookie/origin/CSRF checks; this handler still enforces loopback socket + Host,
 * JSON/body limits, and its own bearer digest authentication.
 */
export function registerClaudeHookRoute(
  app: FastifyInstance,
  bridge: ClaudeHookBridge,
): void {
  app.post(CLAUDE_HOOK_ROUTE, {
    bodyLimit: CLAUDE_HOOK_BODY_LIMIT,
    config: { agentManagerPublicHook: true },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("Pragma", "no-cache")
        .header("X-Content-Type-Options", "nosniff");
      if (
        !loopbackAddress(request.raw.socket.remoteAddress)
        || !loopbackHost(request.headers.host)
      ) return empty(reply, 403);
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return empty(reply, 415);
      }

      const abort = new AbortController();
      const onAbort = () => abort.abort();
      request.raw.once("aborted", onAbort);
      reply.raw.once("close", onAbort);
      try {
        const response = await bridge.handle({
          ...(header(request.headers.authorization) === undefined
            ? {}
            : { authorization: header(request.headers.authorization)! }),
          ...(header(request.headers["x-agent-manager-owner"]) === undefined
            ? {}
            : { ownerMarker: header(request.headers["x-agent-manager-owner"])! }),
          body: request.body,
          signal: abort.signal,
        });
        if (response.body === null) return empty(reply, response.statusCode);
        return reply.code(response.statusCode).send(response.body);
      } finally {
        request.raw.off("aborted", onAbort);
        reply.raw.off("close", onAbort);
      }
    },
  });
}
