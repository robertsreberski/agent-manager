import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computeBuildId } from "./build-id.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const inputs = [
  "package.json",
  "pnpm-lock.yaml",
  "tsup.config.ts",
  "scripts/build-id.ts",
  "scripts/build-web.ts",
  "src",
  "web/index.html",
  "web/public",
  "web/src",
  "web/vite.config.ts",
] as const;

test("derives a stable build epoch from runtime inputs only", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "agent-manager-build-id-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const input of inputs) {
    const destination = join(fixture, input);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, input), destination, { recursive: true });
  }

  const first = computeBuildId(fixture);
  assert.match(first, /^am-[a-f0-9]{32}$/u);
  assert.equal(computeBuildId(fixture), first);

  const testFile = join(fixture, "src", "ignored.test.ts");
  writeFileSync(testFile, "test-only change\n");
  assert.equal(computeBuildId(fixture), first);

  const runtimeFile = join(fixture, "src", "shared", "build.ts");
  writeFileSync(runtimeFile, `${readFileSync(runtimeFile, "utf8")}\n// runtime change\n`);
  assert.notEqual(computeBuildId(fixture), first);
});
