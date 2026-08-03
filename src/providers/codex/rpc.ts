import type { JsonObject, JsonRpcId, JsonValue } from "./types.ts";

export interface MessageTransport {
  send(message: string): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: (error: Error | null) => void): () => void;
}

export interface JsonRpcNotification {
  method: string;
  params: JsonObject;
  /** App Server emission time carried by the 0.146 transport envelope. */
  emittedAtMs: number | null;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: JsonValue | undefined;

  constructor(code: number, message: string, data?: JsonValue) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingCall {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function toJsonObject(value: unknown): JsonObject {
  return isObject(value) ? (value as JsonObject) : {};
}

function rpcIdKey(id: JsonRpcId): string {
  return `${typeof id === "number" ? "n" : "s"}:${String(id)}`;
}

export class CodexRpcClient {
  readonly transport: MessageTransport;
  readonly requestTimeoutMs: number;

  #nextId = 1;
  #pending = new Map<string, PendingCall>();
  #notificationListeners = new Set<(value: JsonRpcNotification) => void>();
  #requestListeners = new Set<(value: JsonRpcServerRequest) => void>();
  #closeListeners = new Set<(error: Error | null) => void>();
  #removeMessageListener: (() => void) | null;
  #removeCloseListener: (() => void) | null;
  #closed = false;

  constructor(transport: MessageTransport, requestTimeoutMs = 30_000) {
    this.transport = transport;
    this.requestTimeoutMs = requestTimeoutMs;
    this.#removeMessageListener = transport.onMessage((message) => {
      this.#handleMessage(message);
    });
    this.#removeCloseListener = transport.onClose((error) => {
      this.#handleClose(error);
    });
  }

  async request(
    method: string,
    params: JsonObject = {},
  ): Promise<JsonValue> {
    if (this.#closed) {
      throw new Error("Codex RPC connection is closed");
    }

    const id = this.#nextId++;
    const key = rpcIdKey(id);
    const result = new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(key);
        reject(new Error(`Codex RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.#pending.set(key, { method, resolve, reject, timeout });
    });

    try {
      await this.transport.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }));
    } catch (error) {
      const pending = this.#pending.get(key);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(key);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return result;
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    if (this.#closed) {
      throw new Error("Codex RPC connection is closed");
    }
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      message.params = params;
    }
    await this.transport.send(JSON.stringify(message));
  }

  async respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    if (this.#closed) {
      throw new Error("Codex RPC connection is closed");
    }
    await this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  async respondError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: JsonValue,
  ): Promise<void> {
    if (this.#closed) {
      throw new Error("Codex RPC connection is closed");
    }
    const rpcError: Record<string, unknown> = { code, message };
    if (data !== undefined) {
      rpcError.data = data;
    }
    await this.transport.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: rpcError,
    }));
  }

  onNotification(listener: (value: JsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: (value: JsonRpcServerRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#handleClose(null);
    await this.transport.close();
  }

  #handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObject(message)) return;

    const method = message.method;
    if (typeof method === "string") {
      const notification = {
        method,
        params: toJsonObject(message.params),
        emittedAtMs: typeof message.emittedAtMs === "number" &&
            Number.isFinite(message.emittedAtMs)
          ? message.emittedAtMs
          : null,
      };
      if (isRpcId(message.id)) {
        const request = { ...notification, id: message.id };
        for (const listener of this.#requestListeners) listener(request);
      } else {
        for (const listener of this.#notificationListeners) listener(notification);
      }
      return;
    }

    if (!isRpcId(message.id)) return;
    const key = rpcIdKey(message.id);
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    clearTimeout(pending.timeout);

    if (isObject(message.error)) {
      const code = typeof message.error.code === "number"
        ? message.error.code
        : -32_000;
      const errorMessage = typeof message.error.message === "string"
        ? message.error.message
        : `Codex RPC request failed: ${pending.method}`;
      pending.reject(new CodexRpcError(
        code,
        errorMessage,
        message.error.data as JsonValue | undefined,
      ));
      return;
    }

    pending.resolve((message.result ?? null) as JsonValue);
  }

  #handleClose(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeMessageListener?.();
    this.#removeCloseListener?.();
    this.#removeMessageListener = null;
    this.#removeCloseListener = null;

    const closeError = error ?? new Error("Codex RPC connection closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(closeError);
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(error);
  }
}

export function jsonRpcIdKey(id: JsonRpcId): string {
  return rpcIdKey(id);
}
