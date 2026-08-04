import assert from "node:assert/strict";
import test from "node:test";

import { parseCliCommand } from "./args.ts";

test("parses safe cockpit commands", () => {
  assert.deepEqual(parseCliCommand([]), { name: "list", args: [] });
  assert.deepEqual(parseCliCommand(["doctor", "--json"]), { name: "doctor", json: true });
  assert.deepEqual(parseCliCommand(["workspace", "add", "/tmp/project"]), {
    name: "workspace",
    operation: "add",
    value: "/tmp/project",
  });
  assert.deepEqual(parseCliCommand(["serve", "--port", "43127"]), {
    name: "serve",
    host: "127.0.0.1",
    port: 43_127,
  });
  assert.deepEqual(parseCliCommand(["panic-unlock"]), { name: "panic-unlock" });
  assert.deepEqual(parseCliCommand(["host", "add", "Studio Mac", "robert@studio.local"]), {
    name: "host",
    operation: "add",
    label: "Studio Mac",
    target: "robert@studio.local",
  });
  assert.deepEqual(parseCliCommand(["host", "install", "robert@studio.local"]), {
    name: "host",
    operation: "install",
    value: "robert@studio.local",
  });
  assert.deepEqual(parseCliCommand(["node", "bridge"]), { name: "node", operation: "bridge" });
});

test("refuses broad listeners and malformed mutations", () => {
  assert.throws(() => parseCliCommand(["serve", "--host", "0.0.0.0"]), /127\.0\.0\.1/);
  assert.throws(() => parseCliCommand(["attach", "one", "two"]), /Usage/);
  assert.throws(() => parseCliCommand(["tailscale", "reset"]), /install\|status\|off/);
  assert.throws(() => parseCliCommand(["host", "add", "missing-target"]), /Usage/);
});
