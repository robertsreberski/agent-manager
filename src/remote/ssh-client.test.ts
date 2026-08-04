import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { WIRE_SCHEMA_VERSION } from "../shared/wire.ts";
import { localBuildId, REMOTE_BRIDGE_PROTOCOL_VERSION, type NodeBridgeStreamFrame } from "./protocol.ts";
import { SshNodeClient } from "./ssh-client.ts";

function fakeSsh(t: TestContext, source: string): string {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-ssh-client-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ssh.cjs");
  writeFileSync(path, source);
  chmodSync(path, 0o700);
  return path;
}

test("performs strict RPC and selected-session stream multiplexing", async (t) => {
  const executable = fakeSsh(t, `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({type:"hello",protocolVersion:${String(REMOTE_BRIDGE_PROTOCOL_VERSION)},wireSchemaVersion:${String(WIRE_SCHEMA_VERSION)},buildId:${JSON.stringify(localBuildId())}}) + "\\n");
const lines = readline.createInterface({input:process.stdin});
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "rpc") {
    process.stdout.write(JSON.stringify({type:"response",id:message.id,status:200,body:{ok:true}}) + "\\n");
  } else if (message.type === "stream.open") {
    process.stdout.write(JSON.stringify({type:"stream.opened",id:message.id,status:200,body:null}) + "\\n");
    process.stdout.write(JSON.stringify({type:"stream.frame",id:message.id,eventId:"cursor-1",data:{frame:true}}) + "\\n");
  } else if (message.type === "stream.close") {
    process.stdout.write(JSON.stringify({type:"stream.closed",id:message.id,reason:"cancelled",message:null}) + "\\n");
  }
});
`);
  const client = new SshNodeClient({ target: "fixture-host", sshExecutable: executable });
  t.after(() => client.close());
  assert.deepEqual(await client.request({ method: "GET", path: "/api/v1/sessions" }), { ok: true });

  const frames: NodeBridgeStreamFrame[] = [];
  const stream = await client.openActivityStream({
    path: "/api/v1/sessions/local%3Acodex%3Athread/activity/events",
    onFrame: (frame) => frames.push(frame),
    onClose: () => undefined,
  });
  assert.equal(stream.remoteBuildId, localBuildId());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(frames.map((frame) => frame.data), [{ frame: true }]);
  stream.close();
});

test("fails closed before any request on a wire-epoch mismatch", async (t) => {
  const executable = fakeSsh(t, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"hello",protocolVersion:${String(REMOTE_BRIDGE_PROTOCOL_VERSION)},wireSchemaVersion:${String(WIRE_SCHEMA_VERSION - 1)},buildId:"stale"}) + "\\n");
setInterval(() => {}, 1000);
`);
  const client = new SshNodeClient({ target: "fixture-host", sshExecutable: executable });
  t.after(() => client.close());
  await assert.rejects(
    client.request({ method: "GET", path: "/api/v1/sessions" }),
    /build mismatch/,
  );
});

test("fails closed before any request on a remote build mismatch", async (t) => {
  const executable = fakeSsh(t, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"hello",protocolVersion:${String(REMOTE_BRIDGE_PROTOCOL_VERSION)},wireSchemaVersion:${String(WIRE_SCHEMA_VERSION)},buildId:"stale"}) + "\\n");
setInterval(() => {}, 1000);
`);
  const client = new SshNodeClient({ target: "fixture-host", sshExecutable: executable });
  t.after(() => client.close());
  await assert.rejects(
    client.request({ method: "GET", path: "/api/v1/sessions" }),
    /agent-manager host install <target>/,
  );
});
