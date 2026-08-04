import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkCutover,
  EXPECTED_DEPLOY_SCRIPT,
  EXPECTED_PACKAGE_FILES,
  MAX_PACKED_PACKAGE_BYTES,
  OBSOLETE_PRODUCT_FILES,
  packedPackageViolations,
  REQUIRED_PACKED_FILES,
} from "./verify-cutover.ts";

const CURRENT_HASHED_FILES = [
  "dist/chunk-AAAAAAAA.js",
  "dist/chunk-BBBBBBBB.js",
  "dist/chunk-CCCCCCCC.js",
  "dist/web/assets/index-AbCd1234.css",
  "dist/web/assets/index-EfGh5678.js",
  "dist/web/assets/workbox-window.prod.es5-IjKl9012.js",
] as const;

function packedFiles(): Array<{ path: string }> {
  return [
    ...REQUIRED_PACKED_FILES,
    ...CURRENT_HASHED_FILES,
    "README.md",
    "SECURITY.md",
    "package.json",
  ].map((path) => ({ path }));
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-manager-cutover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(join(root, "package.json"), JSON.stringify({
    private: true,
    files: EXPECTED_PACKAGE_FILES,
    scripts: { dev: "vite", check: "node --test", deploy: EXPECTED_DEPLOY_SCRIPT },
  }));
  await write(join(root, "src", "index.ts"), "export const profile = 'full-access';\n");
  await write(join(root, "web", "src", "index.tsx"), "export const App = () => null;\n");
  return root;
}

test("accepts the strict personal-tool cutover", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await checkCutover({ root, trackedFiles: [] }), []);
});

test("reports each explicitly obsolete product file", async (t) => {
  const root = await fixture(t);
  for (const path of OBSOLETE_PRODUCT_FILES) await write(join(root, path), "obsolete\n");

  const violations = await checkCutover({ root, trackedFiles: [] });
  assert.deepEqual(
    violations.filter((item) => item.code === "obsolete-file").map((item) => item.path),
    [...OBSOLETE_PRODUCT_FILES].sort(),
  );
});

test("finds exact old product literals and public fields in production code", async (t) => {
  const root = await fixture(t);
  await write(join(root, "src", "legacy.ts"), [
    "const oldModeAction = 'set-mode';",
    "const oldAccessAction = `set-access`;",
    "const oldPlanValue = 'planning';",
    "const oldRunValue = \"execution\";",
    "interface OldView { accessMode: string }",
    "const oldAccess = input.effectiveAccess;",
    "const quoted = { 'accessMode': 'old' };",
    "const indexed = input['effectiveAccess'];",
    "interface OldActivity { hasSnapshot: boolean }",
    "const oldSnapshot = input.hasSnapshot;",
    "const oldSystemPrefix = '[System] ';",
    "const oldToolPrefix = `[Tool: ${'exec'}] `;",
  ].join("\n"));

  const violations = await checkCutover({ root, trackedFiles: [] });
  assert.deepEqual(
    violations.filter((item) => item.path === "src/legacy.ts").map((item) => item.code),
    [
      "legacy-literal",
      "legacy-literal",
      "legacy-literal",
      "legacy-literal",
      "legacy-public-field",
      "legacy-public-field",
      "legacy-public-field",
      "legacy-public-field",
      "legacy-public-field",
      "legacy-public-field",
      "legacy-literal",
      "legacy-literal",
    ],
  );
});

test("ignores comments, descriptive strings, tests, and local-only variable names", async (t) => {
  const root = await fixture(t);
  await write(join(root, "src", "current.ts"), [
    "// 'set-mode' and accessMode describe removed history only.",
    "/* effectiveAccess: 'execution' */",
    "const accessMode = 'provider-internal';",
    "const description = 'execution profile';",
  ].join("\n"));
  await write(join(root, "src", "current.test.ts"), "const old = 'set-mode';\n");

  const violations = await checkCutover({ root, trackedFiles: [] });
  assert.equal(violations.some((item) => item.path.startsWith("src/current")), false);
});

test("reports tracked dogfood without rejecting ordinary untracked paths", async (t) => {
  const root = await fixture(t);
  const violations = await checkCutover({
    root,
    trackedFiles: ["README.md", "dogfood-output/run/screenshot.png"],
  });

  assert.deepEqual(
    violations.filter((item) => item.code === "tracked-dogfood").map((item) => item.path),
    ["dogfood-output/run/screenshot.png"],
  );
});

test("reports release-only tracked artifacts without rejecting ordinary CI", async (t) => {
  const root = await fixture(t);
  const violations = await checkCutover({
    root,
    trackedFiles: [
      ".github/workflows/ci.yml",
      ".github/workflows/npm-publish.yml",
      "CHANGELOG.md",
      "scripts/release-package.ts",
    ],
  });

  assert.deepEqual(
    violations.filter((item) => item.code === "release-artifact").map((item) => item.path),
    [".github/workflows/npm-publish.yml", "CHANGELOG.md", "scripts/release-package.ts"],
  );
});

test("requires private exact package files and rejects release ceremony", async (t) => {
  const root = await fixture(t);
  await write(join(root, "package.json"), JSON.stringify({
    private: false,
    files: ["dist", "src"],
    scripts: {
      release: "npm publish",
      ship: "gh release create v1",
      deploy: EXPECTED_DEPLOY_SCRIPT,
    },
  }));

  const violations = await checkCutover({ root, trackedFiles: [] });
  assert.deepEqual(
    violations.filter((item) => item.path.startsWith("package.json")).map((item) => item.code),
    ["package-files", "package-private", "release-script", "release-script"],
  );
});

test("requires one explicit deployment path without lifecycle hooks", async (t) => {
  const root = await fixture(t);
  await write(join(root, "package.json"), JSON.stringify({
    private: true,
    files: EXPECTED_PACKAGE_FILES,
    scripts: {
      predeploy: "pnpm check",
      deploy: "node scripts/deploy-release.js",
    },
  }));

  const violations = await checkCutover({ root, trackedFiles: [] });
  assert.deepEqual(
    violations.filter((item) => item.code === "deploy-script").map((item) => item.path),
    ["package.json#scripts.deploy", "package.json#scripts.predeploy"],
  );
});

test("accepts one bounded runtime package and rejects maps, extras and excess size", () => {
  const required = packedFiles();
  assert.deepEqual(packedPackageViolations(JSON.stringify([{
    size: MAX_PACKED_PACKAGE_BYTES,
    files: required,
  }])), []);

  const violations = packedPackageViolations(JSON.stringify([{
    size: MAX_PACKED_PACKAGE_BYTES + 1,
    files: [...required, { path: "dist/server/index.js.map" }, { path: "docs/specs/00-overview.md" }],
  }]));
  assert.deepEqual(
    violations.map((item) => item.code),
    ["package-artifact", "package-artifact", "package-budget"],
  );
});

test("rejects arbitrary dist files and duplicate hashed generations", () => {
  const violations = packedPackageViolations(JSON.stringify([{
    size: 100_000,
    files: [
      ...packedFiles(),
      { path: "dist/arbitrary-stale.bin" },
      { path: "dist/chunk-DDDDDDDD.js" },
      { path: "dist/web/assets/index-ZyXw9876.js" },
    ],
  }]));

  assert.deepEqual(
    violations.map(({ path, code }) => ({ path, code })),
    [
      { path: "dist/arbitrary-stale.bin", code: "package-artifact" },
      { path: "dist/chunk-<hash>.js", code: "package-artifact" },
      { path: "dist/web/assets/index-<hash>.js", code: "package-artifact" },
    ],
  );
});
