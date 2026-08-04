import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const MACOS_ATOMIC_DIRECTORY_SWAP = String.raw`import Darwin
let staged = CommandLine.arguments[1]
let live = CommandLine.arguments[2]
let result = staged.withCString { stagedPath in
  live.withCString { livePath in
    renameatx_np(AT_FDCWD, stagedPath, AT_FDCWD, livePath, UInt32(RENAME_SWAP))
  }
}
if result != 0 {
  perror("renameatx_np")
  exit(1)
}`;

export interface PublishWebBuildOptions {
  beforeCommit?: (relativePath: string) => Promise<void> | void;
}

export interface BuildAndPublishWebOptions extends PublishWebBuildOptions {
  configFile?: string;
  distDir?: string;
  runBuild?: (stageDir: string, configFile: string) => Promise<void>;
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

/**
 * Exchange two same-filesystem directories in one macOS rename operation.
 * Node does not expose renameatx_np/RENAME_SWAP, so the build invokes the
 * platform SDK's pinned Swift entrypoint instead of creating a missing-root
 * window with two ordinary renames.
 */
export async function atomicSwapWebDirectories(stagedDir: string, liveDir: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Atomic web publication requires macOS renameatx_np");
  }
  await execFileAsync("/usr/bin/swift", [
    "-e",
    MACOS_ATOMIC_DIRECTORY_SWAP,
    stagedDir,
    liveDir,
  ], {
    timeout: 15_000,
    maxBuffer: 256 * 1_024,
  });
}

/**
 * Replace the complete Vite output as one directory generation. Old hashed
 * assets never survive a successful build.
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

  const commitOrder = [
    ...relativePaths.filter((path) => path !== indexPath && !isServiceWorker(path)),
    indexPath,
    ...workerPaths,
  ];
  for (const relativePath of commitOrder) await options.beforeCommit?.(portablePath(relativePath));

  if (!existsSync(liveDir)) {
    // First build has no live generation to exchange.
    await rename(stageDir, liveDir);
    return;
  }
  await atomicSwapWebDirectories(stageDir, liveDir);
  // After RENAME_SWAP the old complete generation is at the staging path.
  await rm(stageDir, { recursive: true, force: true });
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

  // mkdtemp makes concurrent/aborted compiles independent. The successful
  // stage becomes dist/web; failed stages are removed.
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
