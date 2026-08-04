import { AGENT_MANAGER_BUILD_ID, WIRE_SCHEMA_VERSION } from "../shared/wire.ts";

export const REMOTE_BRIDGE_PROTOCOL_VERSION = 2 as const;
export const REMOTE_BRIDGE_MAX_LINE_BYTES = 3 * 1_024 * 1_024;
export const REMOTE_BRIDGE_MAX_EVENT_BYTES = 2 * 1_024 * 1_024;

export function localBuildId(): string {
  return AGENT_MANAGER_BUILD_ID;
}

export class RemoteBridgeUpgradeRequiredError extends Error {
  readonly code = "REMOTE_UPGRADE_REQUIRED" as const;
  readonly received: {
    protocolVersion: number | null;
    wireSchemaVersion: number | null;
    buildId: string | null;
  };

  constructor(
    received: {
      protocolVersion: number | null;
      wireSchemaVersion: number | null;
      buildId: string | null;
    },
  ) {
    super(
      `Remote node build mismatch; expected bridge ${String(REMOTE_BRIDGE_PROTOCOL_VERSION)}, wire ${String(WIRE_SCHEMA_VERSION)}, build ${localBuildId()}; received bridge ${received.protocolVersion === null ? "missing" : String(received.protocolVersion)}, wire ${received.wireSchemaVersion === null ? "missing" : String(received.wireSchemaVersion)}, build ${received.buildId ?? "missing"}. Run \`agent-manager host install <target>\` from this controller before reconnecting.`,
    );
    this.name = "RemoteBridgeUpgradeRequiredError";
    this.received = received;
  }
}

export interface NodeBridgeHello {
  type: "hello";
  protocolVersion: typeof REMOTE_BRIDGE_PROTOCOL_VERSION;
  wireSchemaVersion: typeof WIRE_SCHEMA_VERSION;
  buildId: string;
}

/** Validate the daemon contacted by the independently launched node bridge. */
export function assertNodeServiceIdentity(value: unknown): void {
  const service = plainRecord(value);
  if (
    !service
    || service.wireSchemaVersion !== WIRE_SCHEMA_VERSION
    || service.buildId !== localBuildId()
  ) {
    throw new RemoteBridgeUpgradeRequiredError({
      protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
      wireSchemaVersion: typeof service?.wireSchemaVersion === "number" ? service.wireSchemaVersion : null,
      buildId: typeof service?.buildId === "string" ? service.buildId : null,
    });
  }
}

export interface NodeBridgeRpcRequest {
  type: "rpc";
  id: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  controlLease?: string;
}

export interface NodeBridgeStreamOpenRequest {
  type: "stream.open";
  id: string;
  path: string;
  lastEventId?: string;
}

export interface NodeBridgeStreamCloseRequest {
  type: "stream.close";
  id: string;
}

export type NodeBridgeRequest =
  | NodeBridgeRpcRequest
  | NodeBridgeStreamOpenRequest
  | NodeBridgeStreamCloseRequest;

export interface NodeBridgeResponse {
  type: "response";
  id: string;
  status: number;
  body: unknown;
}

export interface NodeBridgeStreamOpened {
  type: "stream.opened";
  id: string;
  status: number;
  body: unknown;
}

export interface NodeBridgeStreamFrame {
  type: "stream.frame";
  id: string;
  eventId: string;
  data: unknown;
}

export interface NodeBridgeStreamClosed {
  type: "stream.closed";
  id: string;
  reason: "remote-end" | "cancelled" | "error";
  message: string | null;
}

export type NodeBridgeMessage =
  | NodeBridgeHello
  | NodeBridgeResponse
  | NodeBridgeStreamOpened
  | NodeBridgeStreamFrame
  | NodeBridgeStreamClosed;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function safeApiPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 8_192
    && value.startsWith("/api/v1/")
    && !value.includes("\0")
    && !value.includes("\r")
    && !value.includes("\n")
    && !value.includes("#");
}

function safeStreamPath(value: unknown): value is string {
  if (!safeApiPath(value)) return false;
  let url: URL;
  try {
    url = new URL(value, "http://bridge.invalid");
  } catch {
    return false;
  }
  if (!/^\/api\/v1\/sessions\/[^/]{1,768}\/activity\/events$/u.test(url.pathname)) return false;
  return [...url.searchParams.keys()].every((key) => key === "clientId");
}

function safeEventId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 1_024
    && !/[\0\r\n]/u.test(value);
}

export function parseNodeBridgeRequest(value: unknown): NodeBridgeRequest | null {
  const input = plainRecord(value);
  if (!input || !safeId(input.id)) return null;
  if (input.type === "rpc") {
    if (!exactKeys(input, ["type", "id", "method", "path"], ["body", "controlLease"])) return null;
    if (
      (input.method !== "GET" && input.method !== "POST" && input.method !== "DELETE")
      || !safeApiPath(input.path)
      || (input.controlLease !== undefined && typeof input.controlLease !== "string")
      || (input.method === "GET" && Object.hasOwn(input, "body"))
    ) return null;
    return input as unknown as NodeBridgeRpcRequest;
  }
  if (input.type === "stream.open") {
    if (!exactKeys(input, ["type", "id", "path"], ["lastEventId"])) return null;
    if (!safeStreamPath(input.path)) return null;
    if (input.lastEventId !== undefined && !safeEventId(input.lastEventId)) return null;
    return input as unknown as NodeBridgeStreamOpenRequest;
  }
  if (input.type === "stream.close") {
    return exactKeys(input, ["type", "id"])
      ? input as unknown as NodeBridgeStreamCloseRequest
      : null;
  }
  return null;
}

export function parseNodeBridgeHello(value: unknown): NodeBridgeHello {
  const hello = plainRecord(value);
  if (
    !hello
    || !exactKeys(hello, ["type", "protocolVersion", "wireSchemaVersion", "buildId"])
    || hello.type !== "hello"
    || typeof hello.buildId !== "string"
    || hello.buildId.length < 1
    || hello.buildId.length > 128
  ) {
    throw new RemoteBridgeUpgradeRequiredError({
      protocolVersion: typeof hello?.protocolVersion === "number" ? hello.protocolVersion : null,
      wireSchemaVersion: typeof hello?.wireSchemaVersion === "number" ? hello.wireSchemaVersion : null,
      buildId: typeof hello?.buildId === "string" ? hello.buildId : null,
    });
  }
  if (
    hello.protocolVersion !== REMOTE_BRIDGE_PROTOCOL_VERSION
    || hello.wireSchemaVersion !== WIRE_SCHEMA_VERSION
    || hello.buildId !== localBuildId()
  ) {
    throw new RemoteBridgeUpgradeRequiredError({
      protocolVersion: typeof hello.protocolVersion === "number" ? hello.protocolVersion : null,
      wireSchemaVersion: typeof hello.wireSchemaVersion === "number" ? hello.wireSchemaVersion : null,
      buildId: hello.buildId,
    });
  }
  return hello as unknown as NodeBridgeHello;
}

export function parseNodeBridgeMessage(value: unknown): NodeBridgeMessage | null {
  const message = plainRecord(value);
  if (!message || typeof message.type !== "string") return null;
  if (message.type === "hello") {
    try {
      return parseNodeBridgeHello(message);
    } catch {
      return null;
    }
  }
  if (!safeId(message.id)) return null;
  if (message.type === "response" || message.type === "stream.opened") {
    if (
      !exactKeys(message, ["type", "id", "status", "body"])
      || !Number.isInteger(message.status)
      || (message.status as number) < 100
      || (message.status as number) > 599
    ) return null;
    return message as unknown as NodeBridgeResponse | NodeBridgeStreamOpened;
  }
  if (message.type === "stream.frame") {
    if (!exactKeys(message, ["type", "id", "eventId", "data"]) || !safeEventId(message.eventId)) return null;
    return message as unknown as NodeBridgeStreamFrame;
  }
  if (message.type === "stream.closed") {
    if (
      !exactKeys(message, ["type", "id", "reason", "message"])
      || (message.reason !== "remote-end" && message.reason !== "cancelled" && message.reason !== "error")
      || (message.message !== null && typeof message.message !== "string")
    ) return null;
    return message as unknown as NodeBridgeStreamClosed;
  }
  return null;
}

export interface DecodedSseEvent {
  eventId: string;
  data: unknown;
}

/** Incremental, bounded decoder for the small SSE subset emitted by the server. */
export class ActivitySseDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #pending = "";
  #eventId = "";
  #data: string[] = [];
  #eventBytes = 0;

  push(chunk: Uint8Array): DecodedSseEvent[] {
    let decoded: string;
    try {
      decoded = this.#decoder.decode(chunk, { stream: true });
    } catch {
      throw new Error("Remote activity stream contained invalid UTF-8");
    }
    this.#pending += decoded;
    if (Buffer.byteLength(this.#pending, "utf8") > REMOTE_BRIDGE_MAX_EVENT_BYTES) {
      throw new Error("Remote activity stream event exceeded its size limit");
    }
    const events: DecodedSseEvent[] = [];
    while (true) {
      const newline = this.#pending.indexOf("\n");
      if (newline < 0) break;
      let line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = this.#line(line);
      if (event) events.push(event);
    }
    return events;
  }

  finish(): DecodedSseEvent[] {
    let tail: string;
    try {
      tail = this.#decoder.decode();
    } catch {
      throw new Error("Remote activity stream ended with invalid UTF-8");
    }
    if (tail) this.#pending += tail;
    const events: DecodedSseEvent[] = [];
    if (this.#pending.length > 0) {
      let line = this.#pending;
      this.#pending = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = this.#line(line);
      if (event) events.push(event);
    }
    const final = this.#line("");
    if (final) events.push(final);
    return events;
  }

  #line(line: string): DecodedSseEvent | null {
    this.#eventBytes += Buffer.byteLength(line, "utf8") + 1;
    if (this.#eventBytes > REMOTE_BRIDGE_MAX_EVENT_BYTES) {
      throw new Error("Remote activity stream event exceeded its size limit");
    }
    if (line === "") {
      const data = this.#data.join("\n");
      const eventId = this.#eventId;
      this.#data = [];
      this.#eventBytes = 0;
      if (!data) return null;
      if (!safeEventId(eventId)) throw new Error("Remote activity stream omitted its event id");
      try {
        return { eventId, data: JSON.parse(data) as unknown };
      } catch {
        throw new Error("Remote activity stream contained invalid JSON");
      }
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      if (!safeEventId(value)) throw new Error("Remote activity stream event id is invalid");
      this.#eventId = value;
    } else if (field === "data") {
      this.#data.push(value);
    }
    return null;
  }
}
