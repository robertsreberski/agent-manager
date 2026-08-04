import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import tsupConfig from "../../tsup.config.ts";
import { cacheControlForResponse, createAgentManagerServer } from "./server.ts";

const host = "127.0.0.1:43127";

test("classifies sensitive and versioned responses conservatively", () => {
  assert.equal(cacheControlForResponse("/api/v1/sessions", 200, "application/json"), "no-store");
  assert.equal(cacheControlForResponse("/auth/session", 200, "application/json"), "no-store");
  assert.equal(cacheControlForResponse("/healthz", 200, "application/json"), "no-store");
  assert.equal(cacheControlForResponse("/events", 200, "text/event-stream"), "no-store");
  assert.equal(cacheControlForResponse("/sw.js", 200, "text/javascript"), "no-cache");
  assert.equal(
    cacheControlForResponse("/manifest.webmanifest", 200, "application/manifest+json"),
    "public, max-age=0, must-revalidate",
  );
  assert.equal(
    cacheControlForResponse("/assets/index-AbCd1234.js", 200, "text/javascript"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(cacheControlForResponse("/assets/index-AbCd1234.js", 404, "application/json"), "no-store");
});

test("serves the PWA shell with route-specific cache and same-origin worker policy", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-manager-pwa-static-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Fixture</title>");
  writeFileSync(join(directory, "manifest.webmanifest"), "{}");
  writeFileSync(join(directory, "sw.js"), "self.addEventListener('fetch', () => undefined);");
  writeFileSync(join(directory, "assets", "index-AbCd1234.js"), "export {};");

  const backend = await createAgentManagerServer({ discovery: false, staticDir: directory });
  t.after(async () => {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await backend.app.ready();

  const request = (url: string, accept?: string) => backend.app.inject({
    method: "GET",
    url,
    headers: { host, ...(accept ? { accept } : {}) },
  });

  const html = await request("/", "text/html");
  assert.equal(html.statusCode, 200, html.body);
  assert.equal(html.headers["cache-control"], "public, max-age=0, must-revalidate");
  assert.match(html.headers["content-security-policy"] ?? "", /connect-src 'self'/u);
  assert.match(html.headers["content-security-policy"] ?? "", /manifest-src 'self'/u);
  assert.match(html.headers["content-security-policy"] ?? "", /worker-src 'self'/u);

  const manifest = await request("/manifest.webmanifest");
  assert.equal(manifest.statusCode, 200, manifest.body);
  assert.equal(manifest.headers["cache-control"], "public, max-age=0, must-revalidate");

  const worker = await request("/sw.js");
  assert.equal(worker.statusCode, 200, worker.body);
  assert.equal(worker.headers["cache-control"], "no-cache");
  assert.equal(worker.headers["service-worker-allowed"], "/");

  const asset = await request("/assets/index-AbCd1234.js");
  assert.equal(asset.statusCode, 200, asset.body);
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");

  const health = await request("/api/v1/healthz", "application/json");
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.headers["cache-control"], "no-store");
});

test("the server-only build cleanup preserves dist/web", () => {
  const config = tsupConfig as { clean?: boolean | string[] };
  assert.deepEqual(config.clean, ["!web/**"]);
});
