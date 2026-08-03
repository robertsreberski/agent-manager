import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type { MessageTransport } from "./rpc.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface UnixWebSocketConnectOptions {
  socketPath: string;
  requestPath?: string;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
}

export class UnixWebSocketTransport implements MessageTransport {
  #socket: Socket;
  #messageListeners = new Set<(message: string) => void>();
  #closeListeners = new Set<(error: Error | null) => void>();
  #buffer = Buffer.alloc(0);
  #fragmentOpcode: number | null = null;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #closed = false;
  #maxMessageBytes: number;

  private constructor(socket: Socket, maxMessageBytes: number) {
    this.#socket = socket;
    this.#maxMessageBytes = maxMessageBytes;
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    socket.on("error", (error) => this.#finish(error));
    socket.on("close", () => this.#finish(null));
  }

  static async connect(
    options: UnixWebSocketConnectOptions,
  ): Promise<UnixWebSocketTransport> {
    const requestPath = options.requestPath ?? "/";
    if (!requestPath.startsWith("/") || /[\r\n]/u.test(requestPath)) {
      throw new Error("WebSocket requestPath must be an absolute HTTP path");
    }
    if (!options.socketPath.startsWith("/")) {
      throw new Error("Codex App Server socket path must be absolute");
    }

    const socket = createConnection({ path: options.socketPath });
    const timeoutMs = options.handshakeTimeoutMs ?? 5_000;
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`)
      .digest("base64");

    const remainder = await new Promise<Buffer>((resolve, reject) => {
      let handshake = Buffer.alloc(0);
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error("Timed out connecting to Codex App Server WebSocket"));
      }, timeoutMs);
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("connect", onConnect);
        socket.off("data", onData);
        socket.off("error", fail);
        socket.off("close", onClose);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onClose = () => fail(
        new Error("Codex App Server closed during WebSocket handshake"),
      );
      const onConnect = () => {
        socket.write([
          `GET ${requestPath} HTTP/1.1`,
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      };
      const onData = (chunk: Buffer) => {
        handshake = Buffer.concat([handshake, chunk]);
        if (handshake.byteLength > 64 * 1024) {
          fail(new Error("Codex App Server WebSocket handshake was too large"));
          return;
        }
        const headerEnd = handshake.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;

        const headerText = handshake.subarray(0, headerEnd).toString("latin1");
        const lines = headerText.split("\r\n");
        if (!/^HTTP\/1\.[01] 101(?:\s|$)/u.test(lines[0] ?? "")) {
          fail(new Error(
            `Codex App Server rejected WebSocket upgrade: ${lines[0] ?? "invalid response"}`,
          ));
          return;
        }
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
          const separator = line.indexOf(":");
          if (separator < 1) continue;
          headers.set(
            line.slice(0, separator).trim().toLowerCase(),
            line.slice(separator + 1).trim(),
          );
        }
        if (headers.get("sec-websocket-accept") !== expectedAccept) {
          fail(new Error("Codex App Server returned an invalid WebSocket accept key"));
          return;
        }
        if (!/(^|,)\s*websocket\s*(,|$)/iu.test(headers.get("upgrade") ?? "")) {
          fail(new Error("Codex App Server did not confirm a WebSocket upgrade"));
          return;
        }

        settled = true;
        cleanup();
        resolve(handshake.subarray(headerEnd + 4));
      };

      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.once("error", fail);
      socket.once("close", onClose);
    });

    const transport = new UnixWebSocketTransport(
      socket,
      options.maxMessageBytes ?? 16 * 1024 * 1024,
    );
    if (remainder.byteLength > 0) transport.#consume(remainder);
    return transport;
  }

  async send(message: string): Promise<void> {
    if (this.#closed) {
      throw new Error("Codex App Server WebSocket is closed");
    }
    const payload = Buffer.from(message, "utf8");
    if (payload.byteLength > this.#maxMessageBytes) {
      throw new Error("Codex App Server WebSocket message exceeds size limit");
    }
    await this.#writeFrame(0x1, payload);
  }

  onMessage(listener: (message: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#writeFrame(0x8, Buffer.from([0x03, 0xe8]));
    } finally {
      this.#socket.end();
      this.#finish(null);
    }
  }

  #consume(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.byteLength >= 2) {
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.#buffer.byteLength < offset + 2) return;
        payloadLength = this.#buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.#buffer.byteLength < offset + 8) return;
        const largeLength = this.#buffer.readBigUInt64BE(offset);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.#protocolError("WebSocket frame is too large");
          return;
        }
        payloadLength = Number(largeLength);
        offset += 8;
      }

      if (payloadLength > this.#maxMessageBytes) {
        this.#protocolError("WebSocket frame exceeds size limit");
        return;
      }
      const maskBytes = masked ? 4 : 0;
      const total = offset + maskBytes + payloadLength;
      if (this.#buffer.byteLength < total) return;

      const mask = masked ? this.#buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(this.#buffer.subarray(offset, total));
      this.#buffer = this.#buffer.subarray(total);
      if (mask) {
        for (let index = 0; index < payload.byteLength; index += 1) {
          payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
        }
      }

      if ((opcode & 0x08) !== 0) {
        if (!final || payloadLength > 125) {
          this.#protocolError("Invalid WebSocket control frame");
          return;
        }
        if (opcode === 0x8) {
          void this.#writeFrame(0x8, payload).finally(() => {
            this.#socket.end();
            this.#finish(null);
          });
        } else if (opcode === 0x9) {
          void this.#writeFrame(0xa, payload);
        }
        continue;
      }

      if (opcode === 0x0) {
        if (this.#fragmentOpcode === null) {
          this.#protocolError("Unexpected WebSocket continuation frame");
          return;
        }
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.byteLength;
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.#fragmentOpcode !== null) {
          this.#protocolError("Interleaved WebSocket data frames");
          return;
        }
        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
        this.#fragmentBytes = payload.byteLength;
      } else {
        this.#protocolError("Unsupported WebSocket opcode");
        return;
      }

      if (this.#fragmentBytes > this.#maxMessageBytes) {
        this.#protocolError("WebSocket message exceeds size limit");
        return;
      }
      if (!final) continue;

      const completeOpcode = this.#fragmentOpcode;
      const message = Buffer.concat(this.#fragments, this.#fragmentBytes);
      this.#fragmentOpcode = null;
      this.#fragments = [];
      this.#fragmentBytes = 0;
      if (completeOpcode !== 0x1) {
        this.#protocolError("Codex App Server sent a binary WebSocket message");
        return;
      }
      const text = message.toString("utf8");
      for (const listener of this.#messageListeners) listener(text);
    }
  }

  async #writeFrame(opcode: number, payload: Buffer): Promise<void> {
    if (this.#socket.destroyed) {
      throw new Error("Codex App Server WebSocket socket is closed");
    }
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.byteLength < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.byteLength;
    } else if (payload.byteLength <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.byteLength, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
    }
    header[0] = 0x80 | opcode;
    const maskedPayload = Buffer.alloc(payload.byteLength);
    for (let index = 0; index < payload.byteLength; index += 1) {
      maskedPayload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    const frame = Buffer.concat([header, mask, maskedPayload]);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#socket.off("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        this.#socket.off("error", onError);
        resolve();
      };
      this.#socket.once("error", onError);
      if (this.#socket.write(frame)) {
        this.#socket.off("error", onError);
        resolve();
      } else {
        this.#socket.once("drain", onDrain);
      }
    });
  }

  #protocolError(message: string): void {
    const error = new Error(message);
    this.#socket.destroy(error);
    this.#finish(error);
  }

  #finish(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener(error);
  }
}
