import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { UnixWebSocketTransport } from "./unix-websocket.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  assert.ok(payload.byteLength < 126);
  return Buffer.concat([
    Buffer.from([0x81, payload.byteLength]),
    payload,
  ]);
}

function clientTextFrame(buffer: Buffer): { text: string; bytes: number; masked: boolean } | null {
  if (buffer.byteLength < 6) return null;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < 8) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  }
  if (!masked || buffer.byteLength < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return { text: payload.toString("utf8"), bytes: offset + length, masked };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("performs a standards-compliant WebSocket handshake over a Unix socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manager-ws-"));
  const socketPath = join(directory, "fake-codex.sock");
  const serverSocket: { current: Socket | null } = { current: null };
  let requestHead = "";
  let incoming = Buffer.alloc(0);
  const receivedFrame: {
    current: { text: string; bytes: number; masked: boolean } | null;
  } = { current: null };

  const server = createServer((socket) => {
    serverSocket.current = socket;
    let handshaking = true;
    socket.on("data", (chunk: Buffer) => {
      if (handshaking) {
        incoming = Buffer.concat([incoming, chunk]);
        const end = incoming.indexOf("\r\n\r\n");
        if (end < 0) return;
        requestHead = incoming.subarray(0, end).toString("latin1");
        const key = /^Sec-WebSocket-Key:\s*(.+)$/imu.exec(requestHead)?.[1]?.trim();
        assert.ok(key);
        const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
        socket.write([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"));
        incoming = incoming.subarray(end + 4);
        handshaking = false;
      } else {
        incoming = Buffer.concat([incoming, chunk]);
      }
      receivedFrame.current = clientTextFrame(incoming);
    });
  });

  try {
    await listen(server, socketPath);
    const transport = await UnixWebSocketTransport.connect({ socketPath });
    assert.match(requestHead, /^GET \/ HTTP\/1\.1/mu);
    assert.match(requestHead, /^Upgrade: websocket$/imu);

    await transport.send('{"jsonrpc":"2.0","method":"initialized"}');
    for (let count = 0; count < 50 && !receivedFrame.current; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const frame = receivedFrame.current;
    assert.ok(frame);
    assert.equal(frame.masked, true);
    assert.equal(frame.text, '{"jsonrpc":"2.0","method":"initialized"}');

    const message = new Promise<string>((resolve) => transport.onMessage(resolve));
    serverSocket.current?.write(
      serverFrame('{"jsonrpc":"2.0","method":"thread/started"}'),
    );
    assert.equal(await message, '{"jsonrpc":"2.0","method":"thread/started"}');
    await transport.close();
  } finally {
    serverSocket.current?.destroy();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a fake server with an invalid WebSocket accept key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manager-ws-invalid-"));
  const socketPath = join(directory, "fake-codex.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Accept: invalid",
        "",
        "",
      ].join("\r\n"));
    });
  });
  try {
    await listen(server, socketPath);
    await assert.rejects(
      UnixWebSocketTransport.connect({ socketPath }),
      /invalid WebSocket accept key/u,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
