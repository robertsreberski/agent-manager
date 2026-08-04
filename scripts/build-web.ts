import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export interface PublishWebBuildOptions {
  beforeCommit?: (relativePath: string) => Promise<void> | void;
}

export interface BuildAndPublishWebOptions extends PublishWebBuildOptions {
  configFile?: string;
  distDir?: string;
  runBuild?: (stageDir: string, configFile: string) => Promise<void>;
}

interface PreparedFile {
  destinationPath: string;
  relativePath: string;
  temporaryPath: string;
}

async function listBuildFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listBuildFiles(root, relativePath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported entry in staged web build: ${relativePath}`);
    }
    files.push(relativePath);
  }

  return files;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function isServiceWorker(relativePath: string): boolean {
  const path = portablePath(relativePath);
  return path === "sw.js" || path === "service-worker.js";
}

async function prepareFile(
  stageDir: string,
  liveDir: string,
  relativePath: string,
): Promise<PreparedFile> {
  const destinationPath = join(liveDir, relativePath);
  await mkdir(dirname(destinationPath), { recursive: true });

  // Keeping the temporary file beside its destination guarantees that rename()
  // is a same-filesystem atomic replacement, even when dist itself is mounted.
  const temporaryPath = join(
    dirname(destinationPath),
    `.${relativePath.split(sep).at(-1)}.publish-${process.pid}-${randomUUID()}`,
  );
  await copyFile(join(stageDir, relativePath), temporaryPath);
  return { destinationPath, relativePath, temporaryPath };
}

async function commitFile(
  file: PreparedFile,
  beforeCommit: PublishWebBuildOptions["beforeCommit"],
): Promise<void> {
  await beforeCommit?.(portablePath(file.relativePath));
  await rename(file.temporaryPath, file.destinationPath);
}

/**
 * Publish a complete Vite output without ever emptying the live directory.
 *
 * Ordinary files are exposed first, index.html is the atomic application
 * cutover, and service workers are exposed last so a polling browser can never
 * install a worker whose new precache targets are not all live yet.
 */
export async function publishStagedWebBuild(
  stageDir: string,
  liveDir: string,
  options: PublishWebBuildOptions = {},
): Promise<void> {
  const relativePaths = (await listBuildFiles(stageDir)).sort();
  const indexPath = relativePaths.find((path) => portablePath(path) === "index.html");
  if (!indexPath) {
    throw new Error("Staged web build is missing index.html");
  }

  const workerPaths = relativePaths.filter(isServiceWorker);
  if (workerPaths.length === 0) {
    throw new Error("Staged web build is missing a service worker entry");
  }

  const ordinaryPaths = relativePaths.filter(
    (path) => path !== indexPath && !isServiceWorker(path),
  );
  const commitOrder = [...ordinaryPaths, indexPath, ...workerPaths];
  const preparedFiles: PreparedFile[] = [];

  try {
    // Finish every potentially partial copy before changing any live pathname.
    for (const relativePath of commitOrder) {
      preparedFiles.push(await prepareFile(stageDir, liveDir, relativePath));
    }
    for (const file of preparedFiles) {
      await commitFile(file, options.beforeCommit);
    }
  } finally {
    await Promise.all(preparedFiles.map((file) => rm(file.temporaryPath, { force: true })));
  }
}

async function runViteBuild(stageDir: string, configFile: string): Promise<void> {
  const { build } = await import("vite");
  await build({
    configFile,
    build: {
      emptyOutDir: true,
      outDir: stageDir,
    },
  });
}

export async function buildAndPublishWeb(
  options: BuildAndPublishWebOptions = {},
): Promise<void> {
  const distDir = resolve(options.distDir ?? join(repositoryRoot, "dist"));
  const configFile = resolve(options.configFile ?? join(repositoryRoot, "web", "vite.config.ts"));
  const liveDir = join(distDir, "web");
  await mkdir(distDir, { recursive: true });

  // mkdtemp makes concurrent/aborted compiles independent. Only this private
  // directory is ever recursively cleaned; dist/web is an append-only overlay.
  const stageDir = await mkdtemp(join(distDir, ".web-stage-"));
  try {
    await (options.runBuild ?? runViteBuild)(stageDir, configFile);
    await publishStagedWebBuild(stageDir, liveDir, {
      ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
    });
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildAndPublishWeb();
}
