import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { ActivityHub } from "../activity/index.ts";
import {
  ClaudeProviderControlAdapter,
} from "../providers/claude/index.ts";
import { ClaudeHookSourceArbiter } from "../providers/hooks/index.ts";
import {
  CodexAppServerSupervisor,
  CodexProviderBridge,
  readCodexHookStatus,
} from "../providers/codex/index.ts";
import type { Diagnostic } from "../core/types.ts";
import type { WorkerPort } from "../discovery/index.ts";
import { ensurePrivateRuntimeDirectory, type AgentManagerPaths } from "../ops/config.ts";
import type { ProviderControlAdapters } from "./contracts.ts";
import { ManagerDatabase } from "./persistence.ts";
import { LocalPlanFileReader } from "./plan-file.ts";
import {
  createAgentManagerServer as createRawServer,
  type AgentManagerBackend,
  type AgentManagerServerOptions,
} from "./server.ts";
import { SessionStateStore } from "./state.ts";
import { LocalSessionTranscriptReader } from "./transcript.ts";

export * from "./auth.ts";
export * from "./activity-observer.ts";
export * from "./contracts.ts";
export * from "./control-socket.ts";
export * from "./controls.ts";
export * from "./persistence.ts";
export * from "./plan-file.ts";
export * from "./preview.ts";
export * from "./server.ts";
export * from "./state.ts";
export * from "./transcript.ts";

export interface DefaultServerPaths {
  stateDirectory: string;
  databasePath: string;
  runtimeDirectory: string;
  controlSocketPath: string;
  staticDirectory: string;
}

export function defaultServerPaths(): DefaultServerPaths {
  const stateDirectory = join(homedir(), "Library", "Application Support", "agent-manager");
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  const runtimeDirectory = `/private/tmp/agent-manager-${uid}`;
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const staticDirectory = import.meta.url.endsWith(".ts")
    ? join(moduleDirectory, "..", "..", "dist", "web")
    : join(moduleDirectory, "..", "web");
  return {
    stateDirectory,
    databasePath: join(stateDirectory, "state.sqlite"),
    runtimeDirectory,
    controlSocketPath: join(runtimeDirectory, "control.sock"),
    staticDirectory,
  };
}

export interface ComposedAgentManagerServerOptions extends AgentManagerServerOptions {
  /** Disable only in tests or when embedding custom provider adapters. */
  managedProviders?: boolean;
  codexExecutable?: string;
  runtimeDirectory?: string;
}

function runtimeValidationPaths(
  stateDirectory: string,
  runtimeDirectory: string,
  socketPath: string,
): AgentManagerPaths {
  return {
    dataDirectory: stateDirectory,
    configFile: join(stateDirectory, "config.json"),
    databaseFile: join(stateDirectory, "state.sqlite"),
    auditFile: join(stateDirectory, "audit.jsonl"),
    runtimeDirectory,
    codexSocket: socketPath,
  };
}

/**
 * Production composition factory. Unlike the lower-level server factory this
 * supplies durable paths, the owner control socket, and managed providers.
 */
export async function createAgentManagerServer(
  options: ComposedAgentManagerServerOptions = {},
): Promise<AgentManagerBackend> {
  const paths = defaultServerPaths();
  const {
    managedProviders = true,
    codexExecutable,
    runtimeDirectory = paths.runtimeDirectory,
    ...serverOptions
  } = options;
  const controlSocketPath = serverOptions.controlSocketPath ?? join(runtimeDirectory, "control.sock");
  ensurePrivateRuntimeDirectory(runtimeValidationPaths(
    paths.stateDirectory,
    runtimeDirectory,
    join(runtimeDirectory, "runtime.sock"),
  ));
  if (dirname(controlSocketPath) !== runtimeDirectory) {
    ensurePrivateRuntimeDirectory(runtimeValidationPaths(
      paths.stateDirectory,
      dirname(controlSocketPath),
      controlSocketPath,
    ));
  }
  const codexRuntimeDirectory = join(runtimeDirectory, "codex");
  if (managedProviders && !serverOptions.adapters?.codex) {
    ensurePrivateRuntimeDirectory(runtimeValidationPaths(
      paths.stateDirectory,
      codexRuntimeDirectory,
      join(codexRuntimeDirectory, "codex-app-server.sock"),
    ));
  }
  const state = serverOptions.state ?? new SessionStateStore({
    replayCapacity: serverOptions.replayCapacity ?? 512,
  });
  const activityHub = serverOptions.activityHub ?? new ActivityHub();
  const database = serverOptions.database
    ?? new ManagerDatabase(serverOptions.databasePath ?? paths.databasePath);
  const adapters: ProviderControlAdapters = { ...(serverOptions.adapters ?? {}) };
  const claudeHookSourceArbiter = serverOptions.claudeHookSourceArbiter
    ?? new ClaudeHookSourceArbiter();
  const planFileReader = serverOptions.planFileReader ?? new LocalPlanFileReader({ runtimeDirectory });
  const transcriptReader = serverOptions.transcriptReader ?? new LocalSessionTranscriptReader();
  const diagnostics: Diagnostic[] = [...(serverOptions.initialDiagnostics ?? [])];
  let codexSupervisor: CodexAppServerSupervisor | null = null;
  let codexHookTrustStatus = serverOptions.codexHookTrustStatus;

  if (managedProviders && !adapters.claude) {
    adapters.claude = new ClaudeProviderControlAdapter({
      hookSourceArbiter: claudeHookSourceArbiter,
      onSessionChanged: (session) => state.upsert(session),
      onActivity: (managerSessionId, mutation) => {
        activityHub.ingest(managerSessionId, "claude", mutation);
      },
    });
  }

  if (managedProviders && !adapters.codex) {
    codexSupervisor = new CodexAppServerSupervisor({
      runtimeDir: codexRuntimeDirectory,
      ...(codexExecutable === undefined ? {} : { codexExecutable }),
    });
    codexSupervisor.onUnexpectedExit((event) => {
      const exit = event.signal ?? (event.code === null ? "unknown status" : `code ${event.code}`);
      state.addDiagnostic({
        provider: "codex",
        level: "error",
        message: `Managed Codex runtime exited unexpectedly (${exit}); manager controls are unavailable.`,
      });
    });
    try {
      const managedAdapter = await codexSupervisor.start();
      codexHookTrustStatus ??= (settingsPath, expectedCommand) => readCodexHookStatus(
        managedAdapter.rpc,
        [dirname(dirname(settingsPath))],
        expectedCommand,
      );
      adapters.codex = new CodexProviderBridge({
        adapter: managedAdapter,
        resolveWorkspace: (workspaceId, context) => {
          if (context.workspace?.id === workspaceId) return context.workspace.path;
          return database.getWorkspace(workspaceId)?.path ?? null;
        },
        onSessionChanged: (session) => state.upsert(session),
        onSessionRemoved: (managerSessionId, reason) => {
          try {
            database.removeManagedSession(managerSessionId);
          } catch (error) {
            state.addDiagnostic({
              provider: "codex",
              level: "error",
              message: `Codex session ${managerSessionId} reached lifecycle state ${reason}, but its durable manager identity could not be removed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          state.remove(managerSessionId);
          // Archiving moves the same conversation to a read-only catalog. Its
          // selected drawer and transcript observer keep the existing bounded
          // hub; end/delete are identity termination and still clear it.
          if (reason !== "archived") activityHub.clearSession(managerSessionId);
        },
        onActivity: (managerSessionId, mutation) => {
          activityHub.ingest(managerSessionId, "codex", mutation);
        },
      });
    } catch (error) {
      diagnostics.push({
        provider: "codex",
        level: "warning",
        message: `Managed Codex controls are unavailable: ${error instanceof Error ? error.message : "startup failed"}`,
      });
      codexSupervisor = null;
    }
  }

  try {
    const discovery = serverOptions.discovery === false
      ? false
      : {
          ...(serverOptions.discovery ?? {}),
          workerFactory: serverOptions.discovery?.workerFactory ?? (() => new Worker(new URL(
            import.meta.url.endsWith(".ts") ? "../discovery/worker.ts" : "../discovery/worker.js",
            import.meta.url,
          ), {
            // File-backed Workers reject flags that are valid only for the
            // parent's eval/stdin entrypoint. Preserve real loaders such as
            // tsx while dropping those inherited diagnostic-only flags.
            execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
            ...(serverOptions.tmuxExecutable === undefined
              ? {}
              : {
                  env: {
                    ...process.env,
                    AGENT_MANAGER_TMUX_EXECUTABLE: serverOptions.tmuxExecutable,
                  },
                }),
          }) as WorkerPort),
        };
    return await createRawServer({
      ...serverOptions,
      state,
      activityHub,
      claudeHookSourceArbiter,
      database,
      adapters,
      planFileReader,
      transcriptReader,
      databasePath: serverOptions.databasePath ?? paths.databasePath,
      controlSocketPath,
      staticDir: serverOptions.staticDir ?? paths.staticDirectory,
      initialDiagnostics: diagnostics,
      discovery,
      ...(codexHookTrustStatus ? { codexHookTrustStatus } : {}),
      onShutdown: async () => {
        await codexSupervisor?.stop();
        await serverOptions.onShutdown?.();
      },
    });
  } catch (error) {
    await codexSupervisor?.stop().catch(() => undefined);
    activityHub.dispose();
    database.close();
    throw error;
  }
}

async function runStandalone(): Promise<void> {
  const backend = await createAgentManagerServer();
  const address = await backend.listen();
  process.stdout.write(`Agent Manager listening at ${address}\n`);
  process.stdout.write("Run `agent-manager open` to issue a one-time browser link.\n");
  const shutdown = (): void => {
    void backend.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entrypoint === import.meta.url) {
  void runStandalone().catch((error) => {
    process.stderr.write(`Unable to start Agent Manager: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
