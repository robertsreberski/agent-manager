import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { get as httpGet, type IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectCodexHookCommand } from "../src/ops/codex-hooks-config.ts";
import {
  applyCodexHookPlan,
  previewCodexHookInstall,
  readCodexHookSource,
} from "../src/ops/codex-hooks.ts";
import {
  applyClaudeHookSettingsPlan,
  inspectClaudeHookInstall,
  previewClaudeHookInstall,
  readClaudeHookSettings,
  resolveClaudeHookSettingsPath,
} from "../src/ops/hooks.ts";
import { canonicalExecutable } from "../src/ops/executables.ts";
import { generateCodexHookToken } from "../src/providers/codex/codex-hook-auth.ts";
import { parseCodexVersion } from "../src/providers/codex/version.ts";
import { probeCodexHookStatus } from "../src/providers/codex/codex-hook.ts";
import { CLAUDE_CODE_VERSION } from "../src/providers/claude/types.ts";
import { generateHookBearerToken } from "../src/providers/hooks/auth.ts";
import type { SessionRecord } from "../src/core/types.ts";
import type { AgentManagerBackend } from "../src/server/server.ts";
import { createAgentManagerServer } from "../src/server/server.ts";
import { ManagerDatabase } from "../src/server/persistence.ts";
import { sessionRecordId, type Provider } from "../src/shared/session.ts";

const TEMP_PREFIX = "agent-manager-hooks-e2e-";
const COMMAND_TIMEOUT_MS = 180_000;
const AUTH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const CODEX_MARKER = "AGENT_MANAGER_HOOK_E2E_CODEX";
const CLAUDE_MARKER = "AGENT_MANAGER_HOOK_E2E_CLAUDE";
const CLAUDE_ALLOW_PROOF = ".agent-manager-hook-e2e-allow";
const CLAUDE_DENY_PROOF = ".agent-manager-hook-e2e-deny";
const CODEX_PROMPT = `Reply with exactly ${CODEX_MARKER}. Do not use tools.`;
const CLAUDE_PROMPT = [
  "Exercise exactly two separate Bash permission requests in this order.",
  `First use Bash with exactly: /usr/bin/printf 'allowed\\n' > ${CLAUDE_ALLOW_PROOF}`,
  `After that tool finishes, use a second Bash call with exactly: /usr/bin/printf 'denied\\n' > ${CLAUDE_DENY_PROOF}`,
  "Do not combine the commands and do not use any other tool.",
  `The second request will be denied. After it is denied, reply with exactly ${CLAUDE_MARKER}.`,
].join(" ");

export const CODEX_HOOK_TRUST_EXPECT_SCRIPT = String.raw`
set timeout 45
log_user 0
set executable [lindex $argv 0]
set project [lindex $argv 1]
if {$executable eq "" || $project eq ""} {
  puts stderr "codex hook trust interface arguments are missing"
  exit 64
}
spawn -noecho $executable --no-alt-screen --disable apps --disable plugins -C $project
stty rows 40 columns 120 < $spawn_out(slave,name)
set stage "startup"
expect {
  -re {\x1b\[6n} {
    send -- "\033\[1;1R"
    exp_continue
  }
  -re {\x1b\]10;\?\x1b\\} {
    send -- "\033\]10;rgb:ffff/ffff/ffff\007"
    exp_continue
  }
  -re {\x1b\]11;\?\x1b\\} {
    send -- "\033\]11;rgb:0000/0000/0000\007"
    exp_continue
  }
  -re {\x1b\[\?u} {
    send -- "\033\[?0u"
    exp_continue
  }
  -re {\x1b\[c} {
    send -- "\033\[?1;2c"
    exp_continue
  }
  -re {Do.*you.*trust.*contents.*directory\?} {
    set stage "workspace-trust"
    send -- "\r"
    exp_continue
  }
  -re {Hooks.*need.*review} {
    set stage "hook-review"
    send -- "2\r"
    exp_continue
  }
  -re {OpenAI.*Codex} {
    set stage "main-screen"
    after 250
    send -- "\003"
  }
  timeout {
    puts stderr "codex hook trust interface timed out at $stage"
    exit 124
  }
  eof {
    puts stderr "codex hook trust interface exited before completion at $stage"
    exit 70
  }
}
set timeout 10
expect {
  eof {}
  timeout {
    send -- "\003"
    expect {
      eof {}
      timeout {
        puts stderr "codex hook trust interface did not stop"
        exit 124
      }
    }
  }
}
set result [wait]
set exitCode [lindex $result 3]
if {$exitCode != 0} {
  puts stderr "codex hook trust interface exited $exitCode"
  exit $exitCode
}
puts "codex-hook-trust-complete"
`;

export type HookE2eProvider = Provider | "all";
export type HookE2eStatus = "passed" | "skipped" | "failed";

export interface HookE2eArguments {
  provider: HookE2eProvider;
}

export interface HookE2eResult {
  provider: Provider;
  status: HookE2eStatus;
  summary: string;
  evidence: string[];
}

export interface IsolatedWorkspace {
  root: string;
  home: string;
  project: string;
  temporary: string;
  codexHome: string;
  claudeConfig: string;
}

export interface CommandOutput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

function cleanText(value: string, temporaryRoot?: string): string {
  const withoutRoot = temporaryRoot ? value.replaceAll(temporaryRoot, "<temporary-root>") : value;
  return withoutRoot
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-ant|sk-proj)-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .trim();
}

function commandFailure(label: string, output: CommandOutput, root: string): Error {
  const detail = cleanText(output.stderr || output.stdout, root).slice(0, 2_000);
  const cause = output.timedOut
    ? `timed out after ${String(COMMAND_TIMEOUT_MS)}ms`
    : output.outputLimitExceeded
      ? `exceeded ${String(MAX_OUTPUT_BYTES)} output bytes`
      : `exited ${String(output.exitCode)}${output.signal ? ` (${output.signal})` : ""}`;
  return new Error(`${label} ${cause}${detail ? `: ${detail}` : ""}`);
}

function isPathInside(path: string, root: string): boolean {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
}

function assertDisposablePath(path: string, workspace: IsolatedWorkspace, label: string): void {
  if (!isPathInside(path, workspace.root)) {
    throw new Error(`${label} escaped the disposable root`);
  }
}

export function parseHookE2eArguments(argv: readonly string[]): HookE2eArguments {
  let provider: HookE2eProvider = "all";
  let seenProvider = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (index === 0 && argument === "--") continue;
    if (argument !== "--provider") {
      throw new Error(`Unknown hooks E2E option ${argument ?? ""}`);
    }
    if (seenProvider) throw new Error("--provider may be supplied only once");
    const value = argv[index + 1];
    if (value !== "all" && value !== "codex" && value !== "claude") {
      throw new Error("--provider must be all, codex, or claude");
    }
    provider = value;
    seenProvider = true;
    index += 1;
  }
  return { provider };
}

export function hookE2eExitCode(results: readonly HookE2eResult[]): number {
  if (results.some((result) => result.status === "failed")) return 1;
  // A selected provider that could not run is deliberately not a green gate.
  if (results.some((result) => result.status === "skipped")) return 2;
  return results.length > 0 ? 0 : 1;
}

export function codexCliArguments(project: string, prompt = CODEX_PROMPT): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "-c",
    'approval_policy="never"',
    "--sandbox",
    "read-only",
    "--json",
    "--cd",
    project,
    prompt,
  ];
}

export function claudeCliArguments(input: {
  settingsPath: string;
  sessionId: string;
  prompt?: string;
}): string[] {
  return [
    "--print",
    input.prompt ?? CLAUDE_PROMPT,
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--verbose",
    "--no-session-persistence",
    "--session-id",
    input.sessionId,
    "--settings",
    input.settingsPath,
    // The explicit temporary overlay is the only user/project/local settings source.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    "{}",
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "manual",
    "--tools",
    "Bash",
  ];
}

export function codexHookTrustArguments(
  scriptPath: string,
  executable: string,
  project: string,
): string[] {
  return ["-f", scriptPath, executable, project];
}

export function parseCodexThreadId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "thread.started" && typeof value.thread_id === "string") {
        return value.thread_id;
      }
    } catch {
      // A non-JSON diagnostic is not session identity evidence.
    }
  }
  return null;
}

export function parseClaudeAuthStatus(stdout: string): {
  loggedIn: boolean;
  authMethod: string | null;
} | null {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof value.loggedIn !== "boolean") return null;
    return {
      loggedIn: value.loggedIn,
      authMethod: typeof value.authMethod === "string" ? value.authMethod : null,
    };
  } catch {
    return null;
  }
}

export function parseClaudeFinalResult(stdout: string): string | null {
  let result: string | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "result" && typeof value.result === "string") result = value.result;
    } catch {
      // A non-JSON diagnostic is not final assistant-result evidence.
    }
  }
  return result;
}

export function isolatedEnvironment(
  workspace: IsolatedWorkspace,
  provider: Provider,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...base,
    HOME: workspace.home,
    XDG_CONFIG_HOME: join(workspace.home, ".config"),
    XDG_CACHE_HOME: join(workspace.home, ".cache"),
    XDG_DATA_HOME: join(workspace.home, ".local", "share"),
    XDG_STATE_HOME: join(workspace.home, ".local", "state"),
    TMPDIR: workspace.temporary,
    NO_COLOR: "1",
  };
  delete environment.AGENT_MANAGER_SESSION_OWNER;
  if (provider === "codex") {
    environment.CODEX_HOME = workspace.codexHome;
    for (const key of [
      "CODEX_THREAD_ID",
      "CODEX_REMOTE_URL",
      "CODEX_REMOTE_AUTH_TOKEN",
      "CODEX_APP_SERVER_URL",
    ]) delete environment[key];
  } else {
    environment.CLAUDE_CONFIG_DIR = workspace.claudeConfig;
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    environment.DISABLE_AUTOUPDATER = "1";
    environment.DISABLE_TELEMETRY = "1";
    environment.DISABLE_ERROR_REPORTING = "1";
    for (const key of [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_REMOTE",
      "CLAUDE_CODE_REMOTE_CONTROL",
    ]) delete environment[key];
  }
  return environment;
}

export async function createIsolatedWorkspace(): Promise<IsolatedWorkspace> {
  const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  await chmod(root, 0o700);
  const workspace: IsolatedWorkspace = {
    root,
    home: join(root, "home"),
    project: join(root, "project"),
    temporary: join(root, "tmp"),
    codexHome: join(root, "home", ".codex"),
    claudeConfig: join(root, "home", ".claude"),
  };
  await Promise.all([
    mkdir(workspace.home, { recursive: true, mode: 0o700 }),
    mkdir(workspace.project, { recursive: true, mode: 0o700 }),
    mkdir(workspace.temporary, { recursive: true, mode: 0o700 }),
    mkdir(workspace.codexHome, { recursive: true, mode: 0o700 }),
    mkdir(workspace.claudeConfig, { recursive: true, mode: 0o700 }),
  ]);
  return workspace;
}

export async function removeIsolatedWorkspace(workspace: IsolatedWorkspace): Promise<void> {
  if (
    !isAbsolute(workspace.root)
    || basename(workspace.root).length <= TEMP_PREFIX.length
    || !basename(workspace.root).startsWith(TEMP_PREFIX)
    || !isPathInside(workspace.home, workspace.root)
    || !isPathInside(workspace.project, workspace.root)
  ) {
    throw new Error("Refusing to remove an unrecognized hooks E2E root");
  }
  await rm(workspace.root, { recursive: true, force: true });
}

export async function copyRegularCredential(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error("Credential source must be a regular non-symlink file");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationInfo = await lstat(destination);
  if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile()) {
    throw new Error("Credential copy is not a regular file");
  }
}

function stopChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the exact child when its process group has already exited.
    }
  }
  child.kill(signal);
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  },
): Promise<CommandOutput> {
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let outputLimitExceeded = false;
  let outputBytes = 0;
  let forceTimer: NodeJS.Timeout | null = null;
  const maximum = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const append = (channel: "stdout" | "stderr", chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const accepted = bytes.subarray(0, Math.max(0, maximum - outputBytes));
    const text = accepted.toString("utf8");
    if (channel === "stdout") stdout += text;
    else stderr += text;
    outputBytes += accepted.byteLength;
    if (accepted.byteLength !== bytes.byteLength) {
      outputLimitExceeded = true;
      stopChild(child);
      forceTimer ??= setTimeout(() => stopChild(child, "SIGKILL"), 2_000);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  const abort = (): void => {
    stopChild(child);
    forceTimer ??= setTimeout(() => stopChild(child, "SIGKILL"), 2_000);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stopChild(child);
    forceTimer ??= setTimeout(() => stopChild(child, "SIGKILL"), 2_000);
  }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  timer.unref();
  try {
    return await new Promise<CommandOutput>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolvePromise({ exitCode, signal, stdout, stderr, timedOut, outputLimitExceeded });
      });
    });
  } finally {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function executableFor(provider: Provider, environment: NodeJS.ProcessEnv): string {
  const configured = provider === "codex"
    ? environment.AGENT_MANAGER_CODEX_EXECUTABLE
    : environment.AGENT_MANAGER_CLAUDE_EXECUTABLE;
  return canonicalExecutable(provider, {
    ...(configured ? { configured } : {}),
    path: environment.PATH ?? "",
  });
}

async function loopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a disposable loopback port");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return address.port;
}

function externalSession(provider: Provider, providerSessionId: string, cwd: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: sessionRecordId("local", provider, providerSessionId),
    provider,
    providerThreadId: providerSessionId,
    providerTreeId: providerSessionId,
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "Disposable hooks E2E",
    name: `Disposable ${provider} hooks E2E`,
    cwd,
    kind: "batch",
    archived: false,
    presence: "recent",
    status: "completed",
    providerStatus: "completed",
    pid: null,
    runtimePid: null,
    startedAt: now,
    updatedAt: now,
    childSummary: {
      total: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    },
    statusSource: "hook",
    source: "hook",
    profile: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    model: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    effort: { value: null, providerValue: null, source: "inferred", confidence: "heuristic" },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "observe-only",
      authority: "none",
      capabilities: [],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 0,
  };
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (signal?.aborted) throw new Error(`Aborted while waiting for ${label}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

interface CockpitAuthHeaders {
  host: string;
  origin: string;
  cookie: string;
  "content-type": "application/json";
  "x-csrf-token": string;
}

export interface ClaudePermissionExerciseResult<T> {
  provider: T;
  requestIds: [string, string];
  decisions: ["allow", "deny"];
}

async function authenticateDisposableCockpit(
  backend: AgentManagerBackend,
  origin: string,
): Promise<CockpitAuthHeaders> {
  const url = new URL(origin);
  const response = await backend.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { host: url.host, origin, "content-type": "application/json" },
    payload: { secret: backend.auth.bootstrapSecret },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Disposable cockpit bootstrap exited ${String(response.statusCode)}`);
  }
  const cookieHeader = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
  const csrfToken = response.json<{ csrfToken?: unknown }>().csrfToken;
  if (!cookie || typeof csrfToken !== "string" || csrfToken.length === 0) {
    throw new Error("Disposable cockpit bootstrap did not return bounded browser credentials");
  }
  return {
    host: url.host,
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": csrfToken,
  };
}

async function openDisposableCockpitStream(
  origin: string,
  cookie: string,
  clientId: string,
): Promise<IncomingMessage> {
  const url = new URL(origin);
  const response = await new Promise<IncomingMessage>((resolvePromise, reject) => {
    const request = httpGet({
      hostname: url.hostname,
      port: Number(url.port),
      path: `/api/v1/events?clientId=${encodeURIComponent(clientId)}`,
      headers: { host: url.host, cookie, accept: "text/event-stream" },
    }, resolvePromise);
    request.once("error", reject);
  });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`Disposable cockpit event stream exited ${String(response.statusCode)}`);
  }
  await new Promise<void>((resolvePromise, reject) => {
    const fail = (error: Error): void => {
      clearTimeout(timer);
      response.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("Timed out opening disposable cockpit event stream")),
      5_000,
    );
    timer.unref();
    response.once("data", () => {
      clearTimeout(timer);
      response.removeListener("error", fail);
      resolvePromise();
    });
    response.once("error", fail);
  });
  return response;
}

async function driveClaudePermissionDecisions(input: {
  backend: AgentManagerBackend;
  providerSessionId: string;
  headers: CockpitAuthHeaders;
  clientId: string;
  timeoutMs: number;
  signal: AbortSignal;
  progress: { completed: number };
}): Promise<{ requestIds: [string, string]; decisions: ["allow", "deny"] }> {
  const sessionId = sessionRecordId("local", "claude", input.providerSessionId);
  const requestIds: string[] = [];
  let leaseToken: string | null = null;
  try {
    for (const decision of ["allow", "deny"] as const) {
      await waitFor(
        `Claude ${decision} PermissionRequest`,
        () => input.backend.state.get(sessionId)?.attention.some(
          (attention) => attention.source === "hook"
            && attention.id !== null
            && !requestIds.includes(attention.id),
        ) === true,
        input.timeoutMs,
        input.signal,
      );
      const waiting = input.backend.state.get(sessionId);
      const attention = waiting?.attention.find(
        (candidate) => candidate.source === "hook"
          && candidate.id !== null
          && !requestIds.includes(candidate.id),
      );
      if (
        !waiting
        || !attention
        || attention.id === null
        || waiting.control.plane !== "claude-hook-bridge"
        || waiting.control.authority !== "foreign"
        || !waiting.control.capabilities.includes("respond")
      ) {
        throw new Error(`Claude ${decision} request did not expose the exact foreign response plane`);
      }
      const projected = input.backend.activityHub.snapshot(sessionId)?.items.find(
        (item) => item.kind === "attention" && item.requestId === attention.id,
      );
      if (
        !projected
        || projected.kind !== "attention"
        || projected.title !== "Claude requests Bash"
        || projected.resolved
        || !projected.respondable
      ) {
        throw new Error(`Claude ${decision} request was not an exact held Bash PermissionRequest`);
      }
      requestIds.push(attention.id);

      const leaseReply: { statusCode: number; json(): unknown } = await input.backend.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/control-lease`,
        headers: {
          ...input.headers,
          ...(leaseToken ? { "x-control-lease": leaseToken } : {}),
        },
        payload: { clientId: input.clientId, ttlSeconds: 300 },
      });
      if (leaseReply.statusCode !== 200) {
        throw new Error(`Claude ${decision} control lease exited ${String(leaseReply.statusCode)}`);
      }
      const nextLeaseToken: unknown = (leaseReply.json() as { lease?: { token?: unknown } }).lease?.token;
      if (typeof nextLeaseToken !== "string" || nextLeaseToken.length === 0) {
        throw new Error(`Claude ${decision} control lease did not return a token`);
      }
      leaseToken = nextLeaseToken;

      const action = await input.backend.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
        headers: { ...input.headers, "x-control-lease": nextLeaseToken },
        payload: {
          type: "respond",
          requestId: attention.id,
          response: decision === "allow"
            ? { kind: "decision", decision: "allow" }
            : { kind: "decision", decision: "deny", reason: "Denied by the disposable E2E cockpit" },
          expectedGeneration: waiting.generation,
          idempotencyKey: `claude-hook-e2e-${decision}-${randomUUID()}`,
        },
      });
      const status = action.json<{ action?: { status?: unknown } }>().action?.status;
      if (action.statusCode !== 200 || status !== "succeeded") {
        throw new Error(`Claude ${decision} cockpit response exited ${String(action.statusCode)}`);
      }
      input.progress.completed += 1;
      await waitFor(
        `resolved Claude ${decision} PermissionRequest`,
        () => {
          const item = input.backend.activityHub.snapshot(sessionId)?.items.find(
            (candidate) => candidate.kind === "attention" && candidate.requestId === attention.id,
          );
          return item?.kind === "attention" && item.resolved;
        },
        5_000,
        input.signal,
      );
    }
    if (requestIds.length !== 2 || requestIds[0] === requestIds[1]) {
      throw new Error("Claude did not expose two distinct held permission requests");
    }
    return { requestIds: [requestIds[0]!, requestIds[1]!], decisions: ["allow", "deny"] };
  } finally {
    if (leaseToken) {
      await input.backend.app.inject({
        method: "DELETE",
        url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/control-lease`,
        headers: { ...input.headers, "x-control-lease": leaseToken },
      }).catch(() => undefined);
    }
  }
}

export async function exerciseClaudeAllowAndDeny<T>(input: {
  backend: AgentManagerBackend;
  origin: string;
  providerSessionId: string;
  runProvider(signal: AbortSignal): Promise<T>;
  timeoutMs?: number;
}): Promise<ClaudePermissionExerciseResult<T>> {
  const headers = await authenticateDisposableCockpit(input.backend, input.origin);
  const clientId = `hooks-e2e-${randomUUID()}`;
  const stream = await openDisposableCockpitStream(input.origin, headers.cookie, clientId);
  const abort = new AbortController();
  const progress = { completed: 0 };
  try {
    const providerPromise = Promise.resolve().then(() => input.runProvider(abort.signal)).then(
      (provider) => {
        if (progress.completed < 2) abort.abort();
        return provider;
      },
      (error) => {
        abort.abort();
        throw error;
      },
    );
    const decisionsPromise = driveClaudePermissionDecisions({
      backend: input.backend,
      providerSessionId: input.providerSessionId,
      headers,
      clientId,
      timeoutMs: input.timeoutMs ?? 120_000,
      signal: abort.signal,
      progress,
    }).catch((error) => {
      abort.abort();
      throw error;
    });
    const [providerResult, decisionResult] = await Promise.allSettled([
      providerPromise,
      decisionsPromise,
    ]);
    if (decisionResult.status === "rejected") throw decisionResult.reason;
    if (providerResult.status === "rejected") throw providerResult.reason;
    return {
      provider: providerResult.value,
      requestIds: decisionResult.value.requestIds,
      decisions: decisionResult.value.decisions,
    };
  } finally {
    abort.abort();
    stream.destroy();
  }
}

function verifyProjectedSession(
  backend: AgentManagerBackend,
  provider: Provider,
  providerSessionId: string,
  prompt: string,
  cwd: string,
): { itemCount: number; sequence: number } {
  const id = sessionRecordId("local", provider, providerSessionId);
  const snapshot = backend.activityHub.snapshot(id);
  if (!snapshot || snapshot.provider !== provider) {
    throw new Error(`${provider} hook did not create its disposable activity session`);
  }
  const exact = snapshot.items.filter(
    (item) => item.source === "provider-api"
      && item.confidence === "exact"
      && item.exposure === "provider-exposed",
  );
  if (!exact.some((item) => item.kind === "lifecycle")) {
    throw new Error(`${provider} hook did not project an exact lifecycle item`);
  }
  if (!exact.some((item) => item.kind === "message" && item.role === "user" && item.text === prompt)) {
    throw new Error(`${provider} hook did not project the exact disposable prompt`);
  }
  backend.replaceSessions([externalSession(provider, providerSessionId, cwd)]);
  const session = backend.state.get(id);
  if (!session || session.providerThreadId !== providerSessionId || session.cwd !== cwd) {
    throw new Error(`${provider} hook activity did not correlate to the disposable backend session`);
  }
  return { itemCount: snapshot.items.length, sequence: snapshot.seq };
}

function skipped(provider: Provider, summary: string, evidence: string[]): HookE2eResult {
  return { provider, status: "skipped", summary, evidence };
}

async function prepareCodexAuthentication(
  executable: string,
  workspace: IsolatedWorkspace,
  environment: NodeJS.ProcessEnv,
  baseEnvironment: NodeJS.ProcessEnv,
): Promise<{ ready: boolean; evidence: string }> {
  const accessToken = baseEnvironment.CODEX_ACCESS_TOKEN;
  const apiKey = baseEnvironment.OPENAI_API_KEY;
  if (accessToken || apiKey) {
    const login = await runCommand(
      executable,
      ["login", accessToken ? "--with-access-token" : "--with-api-key"],
      {
        cwd: workspace.project,
        env: environment,
        timeoutMs: AUTH_TIMEOUT_MS,
        stdin: `${accessToken ?? apiKey ?? ""}\n`,
        maxOutputBytes: 256 * 1_024,
      },
    );
    if (login.exitCode !== 0 || login.timedOut || login.outputLimitExceeded) {
      return { ready: false, evidence: `isolated token login exited ${String(login.exitCode)}` };
    }
    delete environment.CODEX_ACCESS_TOKEN;
    delete environment.OPENAI_API_KEY;
  } else {
    const sourceHome = baseEnvironment.CODEX_HOME?.trim()
      ? baseEnvironment.CODEX_HOME
      : join(homedir(), ".codex");
    if (!isAbsolute(sourceHome)) {
      return { ready: false, evidence: "ambient CODEX_HOME is not an absolute credential source" };
    }
    try {
      await copyRegularCredential(
        join(sourceHome, "auth.json"),
        join(workspace.codexHome, "auth.json"),
      );
    } catch (error) {
      return {
        ready: false,
        evidence: `no copyable regular Codex auth.json: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const status = await runCommand(executable, ["login", "status"], {
    cwd: workspace.project,
    env: environment,
    timeoutMs: AUTH_TIMEOUT_MS,
    maxOutputBytes: 256 * 1_024,
  });
  return {
    ready: status.exitCode === 0 && !status.timedOut && !status.outputLimitExceeded,
    evidence: status.exitCode === 0
      ? "isolated `codex login status` succeeded using only a temporary credential copy"
      : `isolated \`codex login status\` exited ${String(status.exitCode)}`,
  };
}

async function prepareClaudeAuthentication(
  executable: string,
  workspace: IsolatedWorkspace,
  environment: NodeJS.ProcessEnv,
  baseEnvironment: NodeJS.ProcessEnv,
): Promise<{ ready: boolean; evidence: string }> {
  const envCredential = Boolean(
    baseEnvironment.ANTHROPIC_API_KEY || baseEnvironment.CLAUDE_CODE_OAUTH_TOKEN,
  );
  let copiedCredential = false;
  if (!envCredential) {
    const sourceConfig = baseEnvironment.CLAUDE_CONFIG_DIR?.trim()
      ? baseEnvironment.CLAUDE_CONFIG_DIR
      : join(homedir(), ".claude");
    if (isAbsolute(sourceConfig)) {
      try {
        await copyRegularCredential(
          join(sourceConfig, ".credentials.json"),
          join(workspace.claudeConfig, ".credentials.json"),
        );
        copiedCredential = true;
      } catch {
        // The isolated status below is the decisive provider evidence.
      }
    }
  }
  const status = await runCommand(executable, ["auth", "status", "--json"], {
    cwd: workspace.project,
    env: environment,
    timeoutMs: AUTH_TIMEOUT_MS,
    maxOutputBytes: 256 * 1_024,
  });
  const parsed = parseClaudeAuthStatus(status.stdout);
  const portable = envCredential || copiedCredential;
  if (!portable) {
    return {
      ready: false,
      evidence: `isolated \`claude auth status\` reported loggedIn=${String(parsed?.loggedIn ?? false)}; no API/OAuth env or regular .credentials.json could be isolated`,
    };
  }
  return {
    ready: status.exitCode === 0 && parsed?.loggedIn === true,
    evidence: parsed?.loggedIn === true
      ? `isolated \`claude auth status\` succeeded (${parsed.authMethod ?? "unknown method"})`
      : `isolated \`claude auth status\` exited ${String(status.exitCode)} with loggedIn=${String(parsed?.loggedIn ?? false)}`,
  };
}

async function createBackend(input: {
  port: number;
  origin: string;
  workspace: IsolatedWorkspace;
  database: ManagerDatabase;
  initialSessions?: readonly SessionRecord[];
}): Promise<AgentManagerBackend> {
  const backend = await createAgentManagerServer({
    host: "127.0.0.1",
    port: input.port,
    publicOrigin: input.origin,
    hookEndpointOrigin: input.origin,
    allowedHosts: [`127.0.0.1:${String(input.port)}`],
    allowedOrigins: [input.origin],
    homeDirectory: input.workspace.home,
    database: input.database,
    discovery: false,
    staticDir: false,
    editorLauncher: false,
    ...(input.initialSessions ? { initialSessions: input.initialSessions } : {}),
  });
  await backend.listen();
  return backend;
}

async function runCodexGate(baseEnvironment: NodeJS.ProcessEnv): Promise<HookE2eResult> {
  let executable: string;
  try {
    executable = executableFor("codex", baseEnvironment);
  } catch (error) {
    return skipped("codex", "Codex CLI is unavailable", [error instanceof Error ? error.message : String(error)]);
  }
  const workspace = await createIsolatedWorkspace();
  let backend: AgentManagerBackend | null = null;
  let database: ManagerDatabase | null = null;
  try {
    const environment = isolatedEnvironment(workspace, "codex", baseEnvironment);
    const versionOutput = await runCommand(executable, ["--version"], {
      cwd: workspace.project,
      env: environment,
      timeoutMs: AUTH_TIMEOUT_MS,
      maxOutputBytes: 64 * 1_024,
    });
    const version = parseCodexVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.exitCode !== 0 || version === null) {
      throw commandFailure("Codex version probe", versionOutput, workspace.root);
    }
    if (!version.startsWith("0.146.")) {
      throw new Error(`Codex ${version} is outside the pinned 0.146.x hook contract`);
    }
    const authentication = await prepareCodexAuthentication(
      executable,
      workspace,
      environment,
      baseEnvironment,
    );
    if (!authentication.ready) {
      return skipped("codex", "Codex authentication cannot be exercised in an isolated home", [
        `CLI: ${version}`,
        authentication.evidence,
      ]);
    }

    const port = await loopbackPort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const endpoint = `${origin}/api/v1/hooks/codex`;
    const source = await readCodexHookSource({ scope: "user", homeDirectory: workspace.home });
    const plan = previewCodexHookInstall({
      source,
      endpoint,
      bearerToken: generateCodexHookToken(),
      installId: `e2e-${randomUUID()}`,
      nodeExecutable: process.execPath,
    });
    assertDisposablePath(plan.settingsPath, workspace, "Codex settings");
    assertDisposablePath(plan.shimPath, workspace, "Codex shim");
    await applyCodexHookPlan(plan, { confirmed: true });
    const [settingsText, shimInfo] = await Promise.all([
      readFile(plan.settingsPath, "utf8"),
      lstat(plan.shimPath),
    ]);
    if (inspectCodexHookCommand(settingsText, plan.record.command).state !== "current") {
      throw new Error("Generated disposable Codex hook settings are not current");
    }
    if (shimInfo.isSymbolicLink() || !shimInfo.isFile() || (shimInfo.mode & 0o777) !== 0o700) {
      throw new Error("Generated disposable Codex shim is not a mode-0700 regular file");
    }

    const awaitingTrust = await probeCodexHookStatus({
      codexExecutable: executable,
      cwds: [workspace.project],
      expectedCommand: plan.record.command,
      environment,
    });
    if (awaitingTrust.state !== "awaiting-trust") {
      throw new Error(`Disposable Codex hook unexpectedly began in ${awaitingTrust.state} state`);
    }
    const trustScriptPath = join(workspace.root, "codex-hook-trust.exp");
    assertDisposablePath(trustScriptPath, workspace, "Codex trust script");
    await writeFile(trustScriptPath, CODEX_HOOK_TRUST_EXPECT_SCRIPT, { mode: 0o600 });
    const trust = await runCommand("/usr/bin/expect", codexHookTrustArguments(
      trustScriptPath,
      executable,
      workspace.project,
    ), {
      cwd: workspace.project,
      env: { ...environment, TERM: "xterm-256color" },
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1_024,
    });
    if (
      trust.exitCode !== 0
      || trust.timedOut
      || trust.outputLimitExceeded
      || trust.stdout.trim() !== "codex-hook-trust-complete"
    ) {
      throw commandFailure("Codex disposable hook trust review", trust, workspace.root);
    }
    const trusted = await probeCodexHookStatus({
      codexExecutable: executable,
      cwds: [workspace.project],
      expectedCommand: plan.record.command,
      environment,
    });
    if (trusted.state !== "trusted") {
      throw new Error(`Codex hooks/list reported ${trusted.state} after disposable trust review`);
    }

    database = new ManagerDatabase();
    database.upsertCodexHookInstallRecord(plan.record);
    backend = await createBackend({ port, origin, workspace, database });
    const provider = await runCommand(executable, codexCliArguments(workspace.project), {
      cwd: workspace.project,
      env: environment,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (provider.exitCode !== 0 || provider.timedOut || provider.outputLimitExceeded) {
      throw commandFailure("Codex disposable provider run", provider, workspace.root);
    }
    if (!provider.stdout.includes(CODEX_MARKER)) {
      throw new Error("Codex disposable run did not return its unique completion marker");
    }
    const providerSessionId = parseCodexThreadId(provider.stdout);
    if (!providerSessionId) throw new Error("Codex JSON stream did not expose thread.started identity");
    await waitFor("Codex authenticated hook receipt", () =>
      database?.getCodexHookInstallRecord(plan.settingsPath)?.lastSeenAt !== null
    );
    const receipt = database.getCodexHookInstallRecord(plan.settingsPath)?.lastSeenAt;
    if (!receipt) throw new Error("Codex backend did not persist an authenticated hook receipt");
    const projection = verifyProjectedSession(
      backend,
      "codex",
      providerSessionId,
      CODEX_PROMPT,
      workspace.project,
    );
    return {
      provider: "codex",
      status: "passed",
      summary: "real Codex CLI invoked the generated shim and projected authenticated activity",
      evidence: [
        `CLI: ${version} (${executable})`,
        authentication.evidence,
        "isolation: temporary HOME/CODEX_HOME/XDG/TMP/project; disposable trust review plus local ephemeral provider run; no remote daemon",
        "hook: generated temporary settings plus a mode-0700 shim; real hook review changed hooks/list from awaiting-trust to trusted; no trust bypass",
        `backend: authenticated receipt ${receipt}; session ${providerSessionId}; ${String(projection.itemCount)} items / sequence ${String(projection.sequence)}`,
        "cleanup: only the generated temporary root is removed",
      ],
    };
  } finally {
    if (backend) await backend.close();
    else database?.close();
    await removeIsolatedWorkspace(workspace);
  }
}

async function runClaudeGate(baseEnvironment: NodeJS.ProcessEnv): Promise<HookE2eResult> {
  let executable: string;
  try {
    executable = executableFor("claude", baseEnvironment);
  } catch (error) {
    return skipped("claude", "Claude CLI is unavailable", [error instanceof Error ? error.message : String(error)]);
  }
  const workspace = await createIsolatedWorkspace();
  let backend: AgentManagerBackend | null = null;
  let database: ManagerDatabase | null = null;
  try {
    const environment = isolatedEnvironment(workspace, "claude", baseEnvironment);
    const versionOutput = await runCommand(executable, ["--version"], {
      cwd: workspace.project,
      env: environment,
      timeoutMs: AUTH_TIMEOUT_MS,
      maxOutputBytes: 64 * 1_024,
    });
    const version = parseCodexVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.exitCode !== 0 || version === null) {
      throw commandFailure("Claude version probe", versionOutput, workspace.root);
    }
    if (version !== CLAUDE_CODE_VERSION) {
      throw new Error(`Claude ${version} is outside the pinned ${CLAUDE_CODE_VERSION} hook contract`);
    }
    const authentication = await prepareClaudeAuthentication(
      executable,
      workspace,
      environment,
      baseEnvironment,
    );
    if (!authentication.ready) {
      return skipped("claude", "Claude authentication cannot be exercised in an isolated home", [
        `CLI: ${version}`,
        authentication.evidence,
      ]);
    }

    const providerSessionId = randomUUID();
    const port = await loopbackPort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const endpoint = `${origin}/api/v1/hooks/claude`;
    const settingsPath = resolveClaudeHookSettingsPath({
      scope: "user",
      homeDirectory: workspace.home,
    });
    const source = await readClaudeHookSettings(settingsPath);
    const plan = previewClaudeHookInstall({
      ...source,
      endpoint,
      bearerToken: generateHookBearerToken(),
      installId: `e2e-${randomUUID()}`,
    });
    assertDisposablePath(plan.settingsPath, workspace, "Claude settings");
    await applyClaudeHookSettingsPlan(plan, { confirmed: true });
    const settingsText = await readFile(plan.settingsPath, "utf8");
    if (inspectClaudeHookInstall(settingsText, plan.record).state !== "current") {
      throw new Error("Generated disposable Claude hook settings are not current");
    }

    database = new ManagerDatabase();
    database.upsertClaudeHookInstallRecord(plan.record);
    backend = await createBackend({
      port,
      origin,
      workspace,
      database,
      initialSessions: [externalSession("claude", providerSessionId, workspace.project)],
    });
    const exercised = await exerciseClaudeAllowAndDeny({
      backend,
      origin,
      providerSessionId,
      runProvider: (signal) => runCommand(executable, claudeCliArguments({
        settingsPath: plan.settingsPath,
        sessionId: providerSessionId,
      }), {
        cwd: workspace.project,
        env: environment,
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      }),
    });
    const provider = exercised.provider;
    if (provider.exitCode !== 0 || provider.timedOut || provider.outputLimitExceeded) {
      throw commandFailure("Claude disposable provider run", provider, workspace.root);
    }
    if (parseClaudeFinalResult(provider.stdout)?.trim() !== CLAUDE_MARKER) {
      throw new Error("Claude disposable run did not return its exact final completion marker");
    }
    const allowProof = await readFile(join(workspace.project, CLAUDE_ALLOW_PROOF), "utf8").catch(
      () => null,
    );
    if (allowProof !== "allowed\n") {
      throw new Error("Claude allow response did not execute the first disposable Bash command");
    }
    try {
      await lstat(join(workspace.project, CLAUDE_DENY_PROOF));
      throw new Error("Claude deny response allowed the second disposable Bash command to execute");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await waitFor("Claude authenticated hook receipt", () =>
      database?.getClaudeHookInstallRecord(plan.settingsPath)?.lastSeenAt !== null
    );
    const receipt = database.getClaudeHookInstallRecord(plan.settingsPath)?.lastSeenAt;
    if (!receipt) throw new Error("Claude backend did not persist an authenticated hook receipt");
    const projection = verifyProjectedSession(
      backend,
      "claude",
      providerSessionId,
      CLAUDE_PROMPT,
      workspace.project,
    );
    const exactResolved = backend.activityHub.snapshot(
      sessionRecordId("local", "claude", providerSessionId),
    )?.items.filter((item) =>
      item.kind === "attention"
      && item.resolved
      && exercised.requestIds.includes(item.requestId)
    ) ?? [];
    if (exactResolved.length !== 2) {
      throw new Error("Claude did not project both cockpit permission decisions as resolved");
    }
    return {
      provider: "claude",
      status: "passed",
      summary: "real Claude CLI exposed held PermissionRequests that the cockpit allowed and denied",
      evidence: [
        `CLI: ${version} (${executable})`,
        authentication.evidence,
        "isolation: temporary HOME/CLAUDE_CONFIG_DIR/XDG/TMP/project, explicit settings-only overlay, no persistence/background/remote control/global settings",
        "permissions: two real Bash PermissionRequests answered through browser auth + control lease + action API; allow proof exists and deny proof does not",
        `backend: authenticated receipt ${receipt}; session ${providerSessionId}; ${String(projection.itemCount)} items / sequence ${String(projection.sequence)}`,
        "cleanup: only the generated temporary root is removed",
      ],
    };
  } finally {
    if (backend) await backend.close();
    else database?.close();
    await removeIsolatedWorkspace(workspace);
  }
}

export async function runHookE2eProvider(
  provider: Provider,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<HookE2eResult> {
  try {
    return provider === "codex"
      ? await runCodexGate(baseEnvironment)
      : await runClaudeGate(baseEnvironment);
  } catch (error) {
    return {
      provider,
      status: "failed",
      summary: `${provider} real hook E2E failed`,
      evidence: [cleanText(error instanceof Error ? error.message : String(error))],
    };
  }
}

function printResult(result: HookE2eResult): void {
  process.stdout.write(`${result.status.toUpperCase()} ${result.provider}: ${result.summary}\n`);
  for (const item of result.evidence) process.stdout.write(`  - ${item}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseHookE2eArguments(argv);
  const providers: Provider[] = options.provider === "all"
    ? ["codex", "claude"]
    : [options.provider];
  const results: HookE2eResult[] = [];
  for (const provider of providers) {
    const result = await runHookE2eProvider(provider);
    results.push(result);
    printResult(result);
  }
  const exitCode = hookE2eExitCode(results);
  const passed = results.filter((result) => result.status === "passed").length;
  const skippedCount = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;
  process.stdout.write(
    `HOOKS E2E ${exitCode === 0 ? "COMPLETE" : "INCOMPLETE"}: ${String(passed)} passed, ${String(skippedCount)} skipped, ${String(failed)} failed\n`,
  );
  return exitCode;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
