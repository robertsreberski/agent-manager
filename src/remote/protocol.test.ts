import assert from "node:assert/strict";
import test from "node:test";

import { WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import {
  ActivitySseDecoder,
  assertNodeServiceIdentity,
  localBuildId,
  parseNodeBridgeHello,
  parseNodeBridgeRequest,
  REMOTE_BRIDGE_PROTOCOL_VERSION,
} from "./protocol.ts";

test("requires the exact bridge, wire, and build before accepting a remote node", () => {
  const hello = parseNodeBridgeHello({
    type: "hello",
    protocolVersion: REMOTE_BRIDGE_PROTOCOL_VERSION,
    wireSchemaVersion: WIRE_SCHEMA_VERSION,
    buildId: localBuildId(),
  });
  assert.equal(hello.buildId, localBuildId());
  assert.throws(() => parseNodeBridgeHello({
    ...hello,
    buildId: "remote-different-build",
  }), /host install <target>/u);
  assert.throws(() => parseNodeBridgeHello({
    ...hello,
    wireSchemaVersion: WIRE_SCHEMA_VERSION - 1,
  }), /build mismatch/);
  assert.throws(() => parseNodeBridgeHello({
    ...hello,
    compatibility: true,
  }), /build mismatch/);
});

test("accepts only selected-session activity streams and strict RPC envelopes", () => {
  assert.deepEqual(parseNodeBridgeRequest({
    type: "stream.open",
    id: "stream-1",
    path: "/api/v1/sessions/local%3Acodex%3Athread/activity/events?clientId=controller",
    lastEventId: "epoch:session:2",
  }), {
    type: "stream.open",
    id: "stream-1",
    path: "/api/v1/sessions/local%3Acodex%3Athread/activity/events?clientId=controller",
    lastEventId: "epoch:session:2",
  });
  assert.equal(parseNodeBridgeRequest({
    type: "stream.open",
    id: "stream-2",
    path: "/api/v1/events",
  }), null);
  assert.equal(parseNodeBridgeRequest({
    type: "rpc",
    id: "rpc-1",
    method: "GET",
    path: "/api/v1/sessions",
    body: {},
  }), null);
  assert.equal(parseNodeBridgeRequest({
    type: "rpc",
    id: "rpc-1",
    method: "GET",
    path: "/api/v1/sessions",
  })?.type, "rpc");
});

test("requires the running remote daemon to match the bridge before hello", () => {
  assert.doesNotThrow(() => assertNodeServiceIdentity({
    authenticated: true,
    wireSchemaVersion: WIRE_SCHEMA_VERSION,
    buildId: localBuildId(),
  }));
  assert.throws(() => assertNodeServiceIdentity({
    authenticated: true,
    wireSchemaVersion: WIRE_SCHEMA_VERSION,
    buildId: "stale-service",
  }), /host install <target>/u);
  assert.throws(() => assertNodeServiceIdentity({ authenticated: true }), /build mismatch/u);
});

test("decodes chunked CRLF SSE without accepting missing ids or unbounded data", () => {
  const decoder = new ActivitySseDecoder();
  const chunks = [
    Buffer.from(": heartbeat\r\nid: cursor-1\r\nda"),
    Buffer.from("ta: {\"type\":\"activity.snapshot\"}\r\n\r\n"),
  ];
  assert.deepEqual(decoder.push(chunks[0]!), []);
  assert.deepEqual(decoder.push(chunks[1]!), [{
    eventId: "cursor-1",
    data: { type: "activity.snapshot" },
  }]);
  assert.deepEqual(decoder.finish(), []);

  const missing = new ActivitySseDecoder();
  assert.throws(
    () => missing.push(Buffer.from("data: {}\n\n")),
    /omitted its event id/,
  );
});
