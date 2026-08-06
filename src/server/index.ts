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
  CODEX_PRIVATE_SOCKET_NAME,
  CodexAppServerSupervisor,
  CodexProviderBridge,
} from "../providers/codex/index.ts";
import type { Diagnostic } from "../core/types.ts";
import type { WorkerPort } from "../discovery/index.ts";
import { ensurePrivateRuntimeDirectory, type AgentManagerPaths } from "../ops/config.ts";
import { sweepRetiredCodexHooks } from "../ops/codex-hooks-cleanup.ts";
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
import { closeOwnerInstanceLease, startOwnerInstanceLease } from "./control-socket.ts";

export * from "./auth.ts";
export * from "./activity-observer.ts";
export * from "./contracts.ts";
export * from "./control-socket.ts";
export * from "./controls.ts";
export * from "./persistence.ts";
export * from "./plan-file.ts";
export * from "./preview.ts";
export * from "./remote-host-registry.ts";
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
  claudeExecutable?: string;
  runtimeDirectory?: string;
  configuredHosts?: ReadonlyArray<{ id: string; label: string; target: string }>;
  configuredWorkspaces?: ReadonlyArray<{
    id: string;
    label: string;
    path: string;
    hostId: string;
  }>;
}

function boundedShutdown<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Remove what the retired Codex command-hook plane wrote into the operator's
 * Codex configuration, once, at startup.
 *
 * Draining the durable records is what makes project-scoped installs reachable:
 * nothing else names those files. The user-scope path is swept regardless, so
 * an install whose database was reset is still cleaned up.
 *
 * Every failure here is reported and then tolerated. A hook this misses is
 * inert — its shim posts to a route this build no longer serves and discards
 * the reply — so none of it is worth refusing to start over.
 */
async function sweepRetiredCodexHookInstalls(
  database: ManagerDatabase,
  diagnostics: Diagnostic[],
  /*
    The configured home, never `homedir()` directly. This function edits files
    the operator owns, so a test that composes a server against a temporary home
    must have its sweep land there — reaching for the real home instead would
    rewrite the developer's own Codex configuration from a test run.
  */
  homeDirectory: string,
): Promise<void> {
  try {
    const recorded = database.takeRetiredCodexHookInstalls();
    const reports = await sweepRetiredCodexHooks({ homeDirectory, recorded });
    // A successful removal is silent. `Diagnostic` carries only `warning` and
    // `error`, and housekeeping that worked is neither; only a leftover the
    // operator now has to remove by hand is worth their attention.
    for (const report of reports) {
      if (!report.error) continue;
      diagnostics.push({
        provider: "codex",
        level: "warning",
        message: `Could not clean retired Agent Manager hooks from ${report.settingsPath}: ${report.error}. Remove the agent-manager entries by hand if Codex still runs them.`,
      });
    }
  } catch (error) {
    diagnostics.push({
      provider: "codex",
      level: "warning",
      message: `Retired Codex hook cleanup did not run: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
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
    claudeExecutable,
    configuredHosts,
    configuredWorkspaces,
    runtimeDirectory = paths.runtimeDirectory,
    ...serverOptions
  } = options;
  const shutdownTimeoutMs = Math.max(250, serverOptions.shutdownTimeoutMs ?? 5_000);
  // The raw server owns the enclosing shutdown deadline. Leave it enough time
  // to observe this callback settling and finish its own resource finalizers.
  const shutdownCallbackTimeoutMs = Math.max(100, shutdownTimeoutMs - 100);
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
      join(codexRuntimeDirectory, CODEX_PRIVATE_SOCKET_NAME),
    ));
  }
  // This atomic kernel-owned bind is deliberately the first stateful runtime
  // operation. A losing dev/service process must fail before opening the
  // database or starting either provider.
  const instanceLease = await startOwnerInstanceLease(join(runtimeDirectory, "instance.sock"));
  let instanceLeaseRelease: Promise<void> | null = null;
  const releaseInstanceLease = (): Promise<void> => {
    instanceLeaseRelease ??= closeOwnerInstanceLease(instanceLease);
    return instanceLeaseRelease;
  };
  const ownedAdapters = new Set<NonNullable<ProviderControlAdapters[keyof ProviderControlAdapters]>>();
  let activityHubForCleanup: ActivityHub | null = null;
  let databaseForCleanup: ManagerDatabase | null = null;
  let codexSupervisor: CodexAppServerSupervisor | null = null;
  try {
  const state = serverOptions.state ?? new SessionStateStore({
    replayCapacity: serverOptions.replayCapacity ?? 512,
  });
  const activityHub = serverOptions.activityHub ?? new ActivityHub();
  activityHubForCleanup = activityHub;
  const database = serverOptions.database
    ?? new ManagerDatabase(serverOptions.databasePath ?? paths.databasePath);
  databaseForCleanup = database;
  if (configuredHosts || configuredWorkspaces) {
    const hostIds = new Set((configuredHosts ?? []).map((host) => host.id));
    for (const stored of database.listHosts()) {
      if (stored.kind === "ssh" && !hostIds.has(stored.id)) database.removeHost(stored.id);
    }
    for (const host of configuredHosts ?? []) {
      database.addHost({
        id: host.id,
        label: host.label,
        kind: "ssh",
        sshTarget: host.target,
      });
    }
    for (const workspace of configuredWorkspaces ?? []) {
      database.addWorkspace({
        id: workspace.id,
        label: workspace.label,
        path: workspace.path,
        hostId: workspace.hostId,
      });
    }
  }
  const adapters: ProviderControlAdapters = { ...(serverOptions.adapters ?? {}) };
  const claudeHookSourceArbiter = serverOptions.claudeHookSourceArbiter
    ?? new ClaudeHookSourceArbiter();
  const planFileReader = serverOptions.planFileReader ?? new LocalPlanFileReader({ runtimeDirectory });
  const transcriptReader = serverOptions.transcriptReader ?? new LocalSessionTranscriptReader();
  const diagnostics: Diagnostic[] = [...(serverOptions.initialDiagnostics ?? [])];
  /*
    The Codex command-hook plane is retired: it could never gate anything, and
    the App Server already reports exact events for managed threads. Sweep what
    it wrote out of the operator's Codex config once, here, while the durable
    records that name the project-scoped files still exist.

    Best-effort by construction. A hook we fail to remove is inert — its shim
    posts to an endpoint this build no longer serves and discards the reply —
    so nothing about it justifies refusing to start.
  */
  await sweepRetiredCodexHookInstalls(database, diagnostics, serverOptions.homeDirectory ?? homedir());
  let backendForRecovery: AgentManagerBackend | null = null;
  let activeCodexBridge: CodexProviderBridge | null = null;
  let retiredCodexBridge: CodexProviderBridge | null = null;

  if (managedProviders && !adapters.claude) {
    const claudeAdapter = new ClaudeProviderControlAdapter({
      hookSourceArbiter: claudeHookSourceArbiter,
      ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
      onSessionChanged: (session) => {
        state.upsert(session);
        try {
          const persisted = database.listManagedSessions().find(
            (record) => record.id === session.id && record.provider === "claude",
          );
          if (!persisted) return;
          const nextMetadata = {
            ...persisted.metadata,
            name: session.name,
            profile: session.profile.value,
            model: session.model.value,
            effort: session.effort.value,
            managerControl: session.providerStatus === "closed"
              ? persisted.metadata.managerControl ?? "active"
              : "active",
            ...(session.control.authority === "manager"
              ? {
                  ownership: "manager-exclusive",
                  nativeOwner: null,
                  handoffId: null,
                  recovery: null,
                }
              : {}),
          };
          if (JSON.stringify(nextMetadata) === JSON.stringify(persisted.metadata)) return;
          database.upsertManagedSession({
            ...persisted,
            metadata: nextMetadata,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          state.addDiagnostic({
            provider: "claude",
            level: "error",
            message: `Claude session ${session.id} changed, but its durable settings could not be updated: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
      onManagerControlStopped: (managerSessionId) => {
        const persisted = database.listManagedSessions().find(
          (record) => record.id === managerSessionId && record.provider === "claude",
        );
        if (!persisted) {
          throw new Error("durable Claude identity is unavailable after manager control stopped");
        }
        database.upsertManagedSession({
          ...persisted,
          metadata: {
            ...persisted.metadata,
            managerControl: "stopped",
            recovery: null,
          },
          updatedAt: new Date().toISOString(),
        });
      },
      onSessionLost: (managerSessionId, reason) => {
        try {
          state.remove(managerSessionId);
          backendForRecovery?.recoverManagedProvider("claude");
        } catch (error) {
          state.addDiagnostic({
            provider: "claude",
            level: "error",
            message: `Claude session ${managerSessionId} lost manager control (${reason}), but recovery could not start: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
      onActivity: (managerSessionId, mutation) => {
        activityHub.ingest(managerSessionId, "claude", mutation);
      },
    });
    adapters.claude = claudeAdapter;
    ownedAdapters.add(claudeAdapter);
  }

  const createCodexBridge = (
    managedAdapter: Awaited<ReturnType<CodexAppServerSupervisor["start"]>>,
  ): CodexProviderBridge => {
    const codexBridge = new CodexProviderBridge({
      adapter: managedAdapter,
      resolveWorkspace: (workspaceId, context) => {
        if (context.workspace?.id === workspaceId) return context.workspace.path;
        return database.getWorkspace(workspaceId)?.path ?? null;
      },
      onSessionChanged: (session) => {
        if (activeCodexBridge !== codexBridge || adapters.codex !== codexBridge) return;
        state.upsert(session);
        try {
          const persisted = database.listManagedSessions().find(
            (record) => record.id === session.id && record.provider === "codex",
          );
          if (!persisted) return;
          const nextMetadata = {
            ...persisted.metadata,
            name: session.name,
            profile: session.profile.value,
            model: session.model.value,
            effort: session.effort.value,
            ownership: "shared",
            recovery: null,
          };
          if (JSON.stringify(nextMetadata) === JSON.stringify(persisted.metadata)) return;
          database.upsertManagedSession({
            ...persisted,
            metadata: nextMetadata,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          state.addDiagnostic({
            provider: "codex",
            level: "error",
            message: `Codex session ${session.id} changed, but its durable settings could not be updated: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
      onSessionRemoved: (managerSessionId, reason) => {
        if (activeCodexBridge !== codexBridge || adapters.codex !== codexBridge) return;
        backendForRecovery?.cancelManagedRecovery(managerSessionId);
        state.remove(managerSessionId);
        // Archiving moves the same conversation to a read-only catalog. Its
        // selected drawer and transcript observer keep the existing bounded
        // hub; end/delete are identity termination and still clear it.
        if (reason !== "archived") activityHub.clearSession(managerSessionId);
        try {
          database.removeManagedSession(managerSessionId);
        } catch (error) {
          state.addDiagnostic({
            provider: "codex",
            level: "error",
            message: `Codex session ${managerSessionId} reached lifecycle state ${reason}, but its durable manager identity could not be removed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
      onActivity: (managerSessionId, mutation) => {
        activityHub.ingest(managerSessionId, "codex", mutation);
      },
    });
    return codexBridge;
  };

  const publishCodexBridge = (
    managedAdapter: Awaited<ReturnType<CodexAppServerSupervisor["start"]>>,
  ): CodexProviderBridge => {
    // Construct while inactive: every callback above is fenced by the active
    // slot, so a constructor/publication failure cannot leak provider events.
    const replacement = createCodexBridge(managedAdapter);
    const previous = activeCodexBridge ?? retiredCodexBridge;
    try {
      previous?.dispose();
    } catch (error) {
      replacement.dispose();
      throw error;
    }
    if (previous) ownedAdapters.delete(previous);

    // Initial startup and manual terminal-failure retry already have a
    // supervisor-published adapter, so this pointer swap can commit directly.
    adapters.codex = replacement;
    activeCodexBridge = replacement;
    retiredCodexBridge = null;
    ownedAdapters.add(replacement);
    return replacement;
  };

  if (managedProviders && !adapters.codex) {
    codexSupervisor = new CodexAppServerSupervisor({
      runtimeDir: codexRuntimeDirectory,
      ...(codexExecutable === undefined ? {} : { codexExecutable }),
    });
    codexSupervisor.onUnexpectedExit(() => {
      const previous = activeCodexBridge;
      activeCodexBridge = null;
      if (previous) retiredCodexBridge = previous;
      if (previous && adapters.codex === previous) delete adapters.codex;
      backendForRecovery?.recoverManagedProvider("codex");
    });
    codexSupervisor.onRecovered((managedAdapter) => {
      const replacement = createCodexBridge(managedAdapter);
      let committed = false;
      return {
        rollback: () => {
          if (committed) {
            if (activeCodexBridge === replacement) activeCodexBridge = null;
            if (adapters.codex === replacement) delete adapters.codex;
            ownedAdapters.delete(replacement);
          }
          replacement.dispose();
        },
        commit: () => {
          const previous = activeCodexBridge ?? retiredCodexBridge;
          adapters.codex = replacement;
          activeCodexBridge = replacement;
          retiredCodexBridge = null;
          ownedAdapters.add(replacement);
          committed = true;
          if (previous) {
            try {
              previous.dispose();
            } catch {
              // The retired bridge is already runtime-dead; publication stays live.
            }
            ownedAdapters.delete(previous);
          }
          try {
            backendForRecovery?.recoverManagedProvider("codex");
          } catch (error) {
            // Catalog/state recovery cannot roll back a live bridge publication.
            try {
              state.addDiagnostic({
                provider: "codex",
                level: "error",
                message: `Managed Codex sessions could not begin recovery after runtime replacement: ${error instanceof Error ? error.message : String(error)}`,
              });
            } catch {
              // Diagnostic publication is best effort at this already-live boundary.
            }
          }
        },
      };
    });
    codexSupervisor.onRecoveryFailed((event) => {
      const retired = retiredCodexBridge;
      retiredCodexBridge = null;
      if (retired) {
        try {
          retired.dispose();
        } catch (error) {
          try {
            state.addDiagnostic({
              provider: "codex",
              level: "error",
              message: `The retired Codex bridge could not be fully disposed after terminal runtime failure: ${error instanceof Error ? error.message : String(error)}`,
            });
          } catch {
            // Terminal cleanup remains best effort even if diagnostics fail.
          }
        } finally {
          ownedAdapters.delete(retired);
        }
      }
      state.addDiagnostic({
        provider: "codex",
        level: "error",
        message: `Managed Codex runtime could not reconnect after ${String(event.attempts)} attempts: ${event.lastError}`,
      });
    });
    try {
      const managedAdapter = await codexSupervisor.start();
      publishCodexBridge(managedAdapter);
    } catch (error) {
      diagnostics.push({
        provider: "codex",
        level: "warning",
        message: `Managed Codex controls are unavailable: ${error instanceof Error ? error.message : "startup failed"}`,
      });
    }
  }

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
    const backend = await createRawServer({
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
      ...(codexSupervisor
        ? { codexSharedSocketPath: codexSupervisor.socketPath }
        : {}),
      staticDir: serverOptions.staticDir ?? paths.staticDirectory,
      initialDiagnostics: diagnostics,
      discovery,
      ensureManagedProvider: async (provider) => {
        await serverOptions.ensureManagedProvider?.(provider);
        if (provider !== "codex" || !codexSupervisor) return;
        const managedAdapter = await codexSupervisor.ensureRunning();
        if (activeCodexBridge && adapters.codex === activeCodexBridge) return;
        publishCodexBridge(managedAdapter);
      },
      onShutdown: async () => {
        const errors: unknown[] = [];
        try {
          const tasks: Promise<unknown>[] = [];
          if (codexSupervisor) {
            // This supervisor owns only the private app-server child. Codex
            // threads remain shared and external Codex CLIs are never killed.
            tasks.push(boundedShutdown(
              Promise.resolve().then(() => codexSupervisor?.stop()),
              shutdownCallbackTimeoutMs,
              "managed Codex shutdown",
            ));
          }
          if (serverOptions.onShutdown) {
            tasks.push(boundedShutdown(
              Promise.resolve().then(() => serverOptions.onShutdown?.()),
              shutdownCallbackTimeoutMs,
              "user shutdown callback",
            ));
          }
          const results = await Promise.allSettled(tasks);
          for (const result of results) {
            if (result.status === "rejected") errors.push(result.reason);
          }
        } finally {
          try {
            await releaseInstanceLease();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "composed runtime shutdown was incomplete");
        }
      },
    });
    backendForRecovery = backend;
    const rawListen = backend.listen.bind(backend);
    backend.listen = async () => {
      try {
        return await rawListen();
      } catch (error) {
        await releaseInstanceLease().catch(() => undefined);
        throw error;
      }
    };
    const rawClose = backend.close.bind(backend);
    backend.close = async () => {
      try {
        await rawClose();
      } finally {
        // The raw cleanup can fail before reaching onShutdown (for example, a
        // synchronously throwing embedder adapter). Never strand the lease.
        await releaseInstanceLease();
      }
    };
    return backend;
  } catch (error) {
    try {
      const cleanupTasks = [...ownedAdapters].map((adapter) => boundedShutdown(
        Promise.resolve().then(() => adapter.dispose?.()),
        shutdownCallbackTimeoutMs,
        "provider startup cleanup",
      ));
      if (codexSupervisor) {
        cleanupTasks.push(boundedShutdown(
          Promise.resolve().then(() => codexSupervisor?.stop()),
          shutdownCallbackTimeoutMs,
          "managed Codex startup cleanup",
        ));
      }
      await Promise.allSettled(cleanupTasks);
      try {
        activityHubForCleanup?.dispose();
      } catch {
        // Preserve the startup failure while still releasing durable resources.
      }
      try {
        databaseForCleanup?.close();
      } catch {
        // Preserve the startup failure while still releasing the owner lease.
      }
    } finally {
      await releaseInstanceLease().catch(() => undefined);
    }
    throw error;
  }
}

async function runStandalone(): Promise<void> {
  let backend: AgentManagerBackend | null = null;
  let shutdownRequested = false;
  let closing = false;
  const shutdown = (): void => {
    shutdownRequested = true;
    if (!backend || closing) return;
    closing = true;
    void backend.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    backend = await createAgentManagerServer();
    if (shutdownRequested) {
      await backend.close();
      return;
    }
    const address = await backend.listen();
    process.stdout.write(`Agent Manager listening at ${address}\n`);
    process.stdout.write("Run `agent-manager open` to issue a one-time browser link.\n");
  } catch (error) {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await backend?.close().catch(() => undefined);
    throw error;
  }
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
