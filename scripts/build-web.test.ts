import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  atomicSwapWebDirectories,
  buildAndPublishWeb,
  publishStagedWebBuild,
} from "./build-web.ts";

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-manager-web-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("atomically exchanges complete web directories on macOS", async (t) => {
  const root = await fixture(t);
  const staged = join(root, "staged");
  const live = join(root, "live");
  await Promise.all([
    write(join(staged, "generation.txt"), "new"),
    write(join(live, "generation.txt"), "old"),
  ]);

  await atomicSwapWebDirectories(staged, live);

  assert.equal(await read(join(live, "generation.txt")), "new");
  assert.equal(await read(join(staged, "generation.txt")), "old");
});

test("publishes one exact web generation in browser-safe validation order", async (t) => {
  const root = await fixture(t);
  const stageDir = join(root, "dist", ".web-stage-fixture");
  const liveDir = join(root, "dist", "web");
  await Promise.all([
    write(join(stageDir, "assets", "index-new.js"), "new asset"),
    write(join(stageDir, "manifest.webmanifest"), "new manifest"),
    write(join(stageDir, "index.html"), "new index"),
    write(join(stageDir, "sw.js"), "new worker"),
    write(join(liveDir, "assets", "index-old.js"), "old asset"),
    write(join(liveDir, "index.html"), "old index"),
    write(join(liveDir, "sw.js"), "old worker"),
  ]);

  const committed: string[] = [];
  await publishStagedWebBuild(stageDir, liveDir, {
    beforeCommit(relativePath) {
      committed.push(relativePath);
    },
  });

  assert.deepEqual(committed, [
    "assets/index-new.js",
    "manifest.webmanifest",
    "index.html",
    "sw.js",
  ]);
  assert.equal(await read(join(liveDir, "index.html")), "new index");
  assert.equal(await read(join(liveDir, "sw.js")), "new worker");
  assert.equal(await read(join(liveDir, "assets", "index-new.js")), "new asset");
  assert.equal(existsSync(join(liveDir, "assets", "index-old.js")), false);

  const liveEntries = await readdir(liveDir, { recursive: true });
  assert.equal(liveEntries.some((entry) => entry.includes(".publish-")), false);
});

test("does not cut over HTML or the worker when ordinary publication fails", async (t) => {
  const root = await fixture(t);
  const stageDir = join(root, "stage");
  const liveDir = join(root, "live");
  await Promise.all([
    write(join(stageDir, "assets", "index-new.js"), "new asset"),
    write(join(stageDir, "manifest.webmanifest"), "new manifest"),
    write(join(stageDir, "index.html"), "new index"),
    write(join(stageDir, "sw.js"), "new worker"),
    write(join(liveDir, "assets", "index-old.js"), "old asset"),
    write(join(liveDir, "index.html"), "old index"),
    write(join(liveDir, "sw.js"), "old worker"),
  ]);

  await assert.rejects(
    publishStagedWebBuild(stageDir, liveDir, {
      beforeCommit(relativePath) {
        if (relativePath === "manifest.webmanifest") {
          throw new Error("simulated publish failure");
        }
      },
    }),
    /simulated publish failure/u,
  );

  assert.equal(await read(join(liveDir, "index.html")), "old index");
  assert.equal(await read(join(liveDir, "sw.js")), "old worker");
  assert.equal(await read(join(liveDir, "assets", "index-old.js")), "old asset");
  const liveEntries = await readdir(liveDir, { recursive: true });
  assert.equal(liveEntries.some((entry) => entry.includes(".publish-")), false);
});

test("build failure cleans only its unique stage and leaves the live release intact", async (t) => {
  const root = await fixture(t);
  const distDir = join(root, "dist");
  const liveDir = join(distDir, "web");
  const serverBundle = join(distDir, "server", "index.js");
  await Promise.all([
    write(join(liveDir, "assets", "index-old.js"), "old asset"),
    write(join(liveDir, "index.html"), "old index"),
    write(join(liveDir, "sw.js"), "old worker"),
    write(serverBundle, "server bundle"),
  ]);

  let stageDir = "";
  await assert.rejects(
    buildAndPublishWeb({
      distDir,
      async runBuild(outputDir) {
        stageDir = outputDir;
        assert.equal(dirname(outputDir), distDir);
        assert.match(basename(outputDir), /^\.web-stage-/u);
        await write(join(outputDir, "index.html"), "partial index");
        throw new Error("simulated Vite failure");
      },
    }),
    /simulated Vite failure/u,
  );

  assert.notEqual(stageDir, "");
  assert.equal(existsSync(stageDir), false);
  assert.equal(await read(join(liveDir, "index.html")), "old index");
  assert.equal(await read(join(liveDir, "sw.js")), "old worker");
  assert.equal(await read(join(liveDir, "assets", "index-old.js")), "old asset");
  assert.equal(await read(serverBundle), "server bundle");
});

test("successful builds replace old web assets without cleaning sibling dist files", async (t) => {
  const root = await fixture(t);
  const distDir = join(root, "dist");
  const liveDir = join(distDir, "web");
  const serverBundle = join(distDir, "server", "index.js");
  await Promise.all([
    write(join(liveDir, "assets", "index-old.js"), "old asset"),
    write(join(liveDir, "index.html"), "old index"),
    write(join(liveDir, "sw.js"), "old worker"),
    write(serverBundle, "server bundle"),
  ]);

  let stageDir = "";
  await buildAndPublishWeb({
    distDir,
    async runBuild(outputDir) {
      stageDir = outputDir;
      await Promise.all([
        write(join(outputDir, "assets", "index-new.js"), "new asset"),
        write(join(outputDir, "index.html"), "new index"),
        write(join(outputDir, "sw.js"), "new worker"),
      ]);
    },
  });

  assert.equal(existsSync(stageDir), false);
  assert.equal(await read(join(liveDir, "index.html")), "new index");
  assert.equal(await read(join(liveDir, "sw.js")), "new worker");
  assert.equal(await read(join(liveDir, "assets", "index-new.js")), "new asset");
  assert.equal(existsSync(join(liveDir, "assets", "index-old.js")), false);
  assert.equal(await read(serverBundle), "server bundle");
});
