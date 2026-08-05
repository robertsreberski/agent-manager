import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, get as httpGet, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
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

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function responseFor(port: number, path: string, headers: Record<string, string> = {}): Promise<IncomingMessage> {
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet({ hostname: "127.0.0.1", port, path, headers }, resolve);
    request.once("error", reject);
  });
}

async function responseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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

test("a late drain after backlog overflow cannot reject the suspended pump", async () => {
  const target = new FakeWritable();
  target.writeResults.push(false);
  const failures: SseWriterFailure[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const writer = new OrderedSseWriter(target, {
      maxQueuedBytes: 1,
      onFailure: (reason) => failures.push(reason),
    });

    assert.equal(writer.writeEvent("active frame"), true);
    assert.equal(writer.blocked, true);
    assert.equal(writer.writeEvent("overflow"), false);
    assert.equal(writer.closed, true);

    // The transport can report drain before the route's close callback tears
    // the socket down. That ordering used to dereference a cleared #active.
    target.emit("drain");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(failures, ["backlog-overflow"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("external disposal while blocked tolerates a late drain", async () => {
  const target = new FakeWritable();
  target.writeResults.push(false);
  const failures: SseWriterFailure[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const writer = new OrderedSseWriter(target, {
      onFailure: (reason) => failures.push(reason),
    });
    assert.equal(writer.writeEvent("blocked event"), true);
    assert.equal(writer.blocked, true);

    writer.dispose();
    target.emit("drain");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(writer.closed, true);
    assert.deepEqual(failures, []);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a dead writable closes and reports socket failure on the first event", () => {
  const target = new FakeWritable();
  target.destroyed = true;
  const failures: SseWriterFailure[] = [];
  const writer = new OrderedSseWriter(target, {
    onFailure: (reason) => failures.push(reason),
  });

  assert.equal(writer.writeEvent("event: data\ndata: never written\n\n"), false);
  assert.equal(writer.closed, true);
  assert.deepEqual(failures, ["socket-failure"]);
  assert.equal(target.contents(), "");
});

test("real HTTP backpressure preserves a large event and reconnects after overflow from the last complete id", async (t) => {
  const first = "id: 1\nevent: activity.upsert\ndata: {\"item\":\"first\"}\n\n";
  const second = `id: 2\nevent: activity.snapshot\ndata: ${"s".repeat(320 * 1_024)}\n\n`;
  const done = "id: 3\nevent: done\ndata: {}\n\n";
  const failures: SseWriterFailure[] = [];
  let streamCount = 0;
  let triggerOverflow: (() => void) | null = null;

  const server = createServer((request, response) => {
    if (request.url === "/trigger-overflow") {
      response.end("ok");
      triggerOverflow?.();
      return;
    }
    assert.equal(request.url, "/events");
    streamCount += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    });
    const firstConnection = streamCount === 1;
    const writer = new OrderedSseWriter(response, {
      sliceBytes: 64 * 1_024,
      maxQueuedBytes: firstConnection ? 16 : 1024 * 1_024,
      onFailure: (reason) => {
        failures.push(reason);
        response.destroy();
      },
    });
    response.once("close", () => writer.dispose());

    if (firstConnection) {
      assert.equal(writer.writeEvent(first), true);
      triggerOverflow = () => {
        // The large frame becomes the legal active event and blocks on the
        // real ServerResponse high-water mark. Only the event queued behind it
        // counts against the deliberately tiny backlog bound.
        assert.equal(writer.writeEvent(second), true);
        assert.equal(writer.writeEvent("id: overflow\nevent: queued\ndata: too-large\n\n"), false);
      };
      return;
    }

    assert.equal(request.headers["last-event-id"], "1");
    assert.equal(writer.writeEvent(second), true);
    assert.equal(writer.writeEvent(done), true);
  });
  const port = await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const initial = await responseFor(port, "/events");
  let initialBody = "";
  let overflowTriggered = false;
  await new Promise<void>((resolve, reject) => {
    initial.setEncoding("utf8");
    initial.on("data", (chunk: string) => {
      initialBody += chunk;
      if (!overflowTriggered && initialBody.includes(first)) {
        overflowTriggered = true;
        void responseFor(port, "/trigger-overflow")
          .then(responseBody)
          .catch(reject);
      }
    });
    // Destroying the response after overflow normally emits aborted/error and
    // then close; all are terminal for this intentionally broken connection.
    initial.once("aborted", resolve);
    initial.once("end", resolve);
    initial.once("close", resolve);
    initial.once("error", (error) => {
      if (overflowTriggered) resolve();
      else reject(error);
    });
  });
  assert.equal(overflowTriggered, true);
  assert.equal(initialBody.startsWith(first), true);
  const completeInitialEvents = initialBody.split("\n\n").filter((frame) => frame.endsWith("}"));
  assert.equal(completeInitialEvents.length, 1);
  assert.match(completeInitialEvents[0] ?? "", /^id: 1$/mu);
  assert.deepEqual(failures, ["backlog-overflow"]);

  const resumed = await responseFor(port, "/events", { "last-event-id": "1" });
  // Hold the real client reader briefly so the response necessarily exercises
  // ServerResponse drain before it can deliver the complete 320 KiB event.
  resumed.pause();
  setTimeout(() => resumed.resume(), 20).unref();
  let resumedBody = "";
  await new Promise<void>((resolve, reject) => {
    resumed.setEncoding("utf8");
    resumed.on("data", (chunk: string) => {
      resumedBody += chunk;
      if (Buffer.byteLength(resumedBody, "utf8") >= Buffer.byteLength(second + done, "utf8")) {
        resolve();
        resumed.destroy();
      }
    });
    resumed.once("error", reject);
    resumed.once("end", resolve);
  });
  assert.equal(resumedBody, second + done);
  assert.deepEqual(failures, ["backlog-overflow"]);
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
