import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { OrderedSseWriter, type SseWriterFailure } from "./sse-writer.ts";

class FakeWritable extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly chunks: Buffer[] = [];
  readonly writeResults: boolean[] = [];

  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    return this.writeResults.shift() ?? true;
  }

  contents(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for SSE writer");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("streams a snapshot larger than 256 KiB in ordered 64 KiB slices across drain", async () => {
  const target = new FakeWritable();
  target.writeResults.push(false);
  const failures: SseWriterFailure[] = [];
  const writer = new OrderedSseWriter(target, { onFailure: (reason) => failures.push(reason) });
  const snapshot = `id: 1\nevent: snapshot\ndata: ${"s".repeat(320 * 1_024)}\n\n`;

  assert.equal(writer.writeEvent(snapshot), true);
  assert.equal(writer.blocked, true);
  assert.equal(target.chunks.length, 1);
  assert.equal(target.chunks[0]?.byteLength, 64 * 1_024);

  target.emit("drain");
  await waitFor(() => target.contents().length === snapshot.length);
  assert.equal(target.contents(), snapshot);
  assert.ok(target.chunks.every((chunk) => chunk.byteLength <= 64 * 1_024));
  assert.deepEqual(failures, []);
});

test("preserves complete activity-upsert boundaries while the socket is blocked", async () => {
  const target = new FakeWritable();
  target.writeResults.push(false);
  const writer = new OrderedSseWriter(target, { onFailure: assert.fail });
  const first = `id: 2\nevent: activity.upsert\ndata: ${"a".repeat(280 * 1_024)}\n\n`;
  const second = "id: 3\nevent: activity.upsert\ndata: {\"item\":\"second\"}\n\n";

  assert.equal(writer.writeEvent(first), true);
  assert.equal(writer.writeEvent(second), true);
  target.emit("drain");
  await waitFor(() => target.contents().length === first.length + second.length);

  assert.equal(target.contents(), first + second);
});

test("allows the active event regardless of size but closes on more than 4 MiB queued", () => {
  const target = new FakeWritable();
  target.writeResults.push(false);
  const failures: SseWriterFailure[] = [];
  const writer = new OrderedSseWriter(target, { onFailure: (reason) => failures.push(reason) });

  assert.equal(writer.writeEvent("x".repeat(5 * 1_024 * 1_024)), true);
  assert.equal(writer.writeEvent("y".repeat(4 * 1_024 * 1_024)), true);
  assert.equal(writer.writeEvent("z"), false);
  assert.deepEqual(failures, ["backlog-overflow"]);
  assert.equal(writer.closed, true);
});

test("drops heartbeats during backpressure and keeps the healthy transfer open", async () => {
  const target = new FakeWritable();
  target.writeResults.push(false);
  const failures: SseWriterFailure[] = [];
  const writer = new OrderedSseWriter(target, { onFailure: (reason) => failures.push(reason) });

  assert.equal(writer.writeEvent("event: data\ndata: one\n\n"), true);
  assert.equal(writer.writeHeartbeat(), false);
  target.emit("drain");
  await waitFor(() => !writer.blocked);

  assert.equal(target.contents(), "event: data\ndata: one\n\n");
  assert.deepEqual(failures, []);
});

test("fails a socket that does not drain within the configured timeout", async () => {
  const target = new FakeWritable();
  target.writeResults.push(false);
  const failures: SseWriterFailure[] = [];
  const writer = new OrderedSseWriter(target, {
    drainTimeoutMs: 15,
    onFailure: (reason) => failures.push(reason),
  });

  assert.equal(writer.writeEvent("event: data\ndata: blocked\n\n"), true);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(failures, ["drain-timeout"]);
  assert.equal(writer.closed, true);
});
