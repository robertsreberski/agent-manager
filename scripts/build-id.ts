import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const BUILD_INPUTS = [
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

function portable(path: string): string {
  return path.split(sep).join("/");
}

function isRuntimeInput(path: string): boolean {
  return !/(?:^|\/)\.[^/]+/u.test(path)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

function filesBelow(root: string, input: string): string[] {
  const absolute = join(root, input);
  const entry = statSync(absolute);
  if (entry.isFile()) return [absolute];
  if (!entry.isDirectory()) throw new Error(`Unsupported build input: ${input}`);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((child) => {
    const next = join(absolute, child.name);
    const path = portable(relative(root, next));
    if (!isRuntimeInput(path)) return [];
    if (child.isDirectory()) return filesBelow(root, path);
    if (!child.isFile()) throw new Error(`Unsupported build input: ${path}`);
    return [next];
  });
}

/**
 * One deterministic epoch for every independently emitted runtime artifact.
 * It intentionally hashes source inputs, not git state, package versions, or
 * wall-clock time, so a clean build needs no release ceremony.
 */
export function computeBuildId(repositoryRoot = defaultRepositoryRoot): string {
  const root = resolve(repositoryRoot);
  const files = BUILD_INPUTS.flatMap((input) => filesBelow(root, input))
    .sort((left, right) => portable(relative(root, left)).localeCompare(portable(relative(root, right))));
  const hash = createHash("sha256");
  for (const file of files) {
    const path = portable(relative(root, file));
    hash.update(String(Buffer.byteLength(path, "utf8")));
    hash.update(":");
    hash.update(path);
    hash.update("\0");
    const contents = readFileSync(file);
    hash.update(String(contents.byteLength));
    hash.update(":");
    hash.update(contents);
    hash.update("\0");
  }
  return `am-${hash.digest("hex").slice(0, 32)}`;
}
