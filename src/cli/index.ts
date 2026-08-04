#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildListing,
  formatTable,
  parseArgs,
  type CliOptions,
} from "../core/discovery.ts";
import type { ListingResult } from "../core/types.ts";
import {
  addWorkspace,
  addSshHost,
  assertPanicUnlocked,
  buildControlledServicePath,
  defaultPaths,
  executeAttach,
  engagePanicLock,
  inspectTailscaleRoute,
  installLaunchAgentFile,
  installTailscaleRoute,
  loadConfig,
  mutateConfig,
  panicLockPath,
  removeTailscaleRoute,
  removeSshHost,
  removeWorkspace,
  releasePanicLock,
  renderLaunchAgent,
  resolveServiceExecutables,
  runDoctor,
  type AgentManagerConfig,
  type AttachSpec,
  type DoctorReport,
  type LaunchAgentOptions,
  type ServiceExecutables,
  type TailscaleInspection,
  type TailscaleInstallResult,
} from "../ops/index.ts";
import {
  requestAttachFromControlSocket,
  requestAttachExitedFromControlSocket,
  requestAttachFailedFromControlSocket,
  requestAttachAuthorizeSpawnFromControlSocket,
  requestAttachStartedFromControlSocket,
  requestBootstrapFromControlSocket,
  requestPanicLockFromControlSocket,
  type BootstrapTokenReply,
} from "../server/control-socket.ts";
import type { AttachInstruction } from "../server/contracts.ts";
import { ManagerDatabase } from "../server/persistence.ts";
import { installRemoteNode, runNodeBridge } from "../remote/index.ts";
import {
  attachSpecFromInstruction,
  executeLifecycleAttach,
  type AttachLifecycle,
} from "./client.ts";
import { CLI_HELP, parseCliCommand } from "./args.ts";

const LIST_HELP = `Usage: agent-manager list [options]

List live and recently active local Codex and Claude sessions.

Options:
  --json                  Output the stable JSON envelope instead of a table
  --since <duration>      Include ended sessions updated within this window (default: 15m; 0 = live only)
  --provider <name>       codex, claude, all, or a comma-separated list (default: all)
  --status <statuses>     Filter by comma-separated normalized statuses
  --children              Expand nested subagents; parents show child counts by default
  -h, --help              Show this help`;

interface TextWriter {
  write(value: string): unknown;
}

interface ListingWithOutcome extends ListingResult {
  selectedProviderCount: number;
  successfulProviderCount: number;
}

interface StartedServer {
  address: string;
}

interface ServerModule {
  createAgentManagerServer(options: {
    host: "127.0.0.1";
    port: number;
    tailscaleHosts?: readonly string[];
    tailscaleAllowedLogins?: readonly string[];
    codexExecutable?: string;
    tmuxExecutable?: string;
    remoteHosts?: ReadonlyArray<{ id: string; label: string; target: string }>;
  }): Promise<{
    listen(): Promise<string>;
    close(): Promise<void>;
  }>;
}

export interface CliDependencies {
  stdout: TextWriter;
  stderr: TextWriter;
  stdoutColumns: number;
  homeDirectory: string;
  cliEntrypoint: string;
  controlSocketPath: string;
  serviceExecutables(): ServiceExecutables;
  parseListArgs(args: string[]): CliOptions;
  buildListing(options: CliOptions): ListingWithOutcome;
  formatTable(
    sessions: ListingResult["sessions"],
    nowMs: number,
    homeDirectory: string,
    columns: number,
  ): string;
  doctor(): Promise<DoctorReport>;
  loadConfig(): AgentManagerConfig;
  mutateConfig<T>(mutator: (config: AgentManagerConfig) => T): T;
  addWorkspace(config: AgentManagerConfig, path: string): AgentManagerConfig["workspaces"][number];
  addSshHost(config: AgentManagerConfig, input: { name: string; target: string }): AgentManagerConfig["hosts"][number];
  removeWorkspace(config: AgentManagerConfig, id: string): boolean;
  removeSshHost(config: AgentManagerConfig, id: string): boolean;
  persistWorkspace(workspace: AgentManagerConfig["workspaces"][number]): void;
  persistHost(host: AgentManagerConfig["hosts"][number]): void;
  removePersistedWorkspace(id: string): boolean;
  removePersistedHost(id: string): boolean;
  installRemoteNode(target: string): Promise<{ serviceLabel: string }>;
  inspectTailscale(config: AgentManagerConfig): TailscaleInspection;
  installTailscale(config: AgentManagerConfig): TailscaleInstallResult;
  removeTailscale(config: AgentManagerConfig): { changed: boolean };
  renderService(options: LaunchAgentOptions): string;
  installService(options: LaunchAgentOptions): string;
  startServer(options: { host: "127.0.0.1"; port: number }): Promise<StartedServer>;
  requestBootstrap(path: string): Promise<BootstrapTokenReply>;
  requestAttach(path: string, sessionId: string): Promise<{ instruction: AttachInstruction }>;
  requestAttachAuthorizeSpawn(
    path: string,
    sessionId: string,
    handoffId: string,
    spawnNonce: string,
    wrapperPid: number,
  ): Promise<{ ok: true }>;
  requestAttachStarted(
    path: string,
    sessionId: string,
    handoffId: string,
    spawnNonce: string,
    pid: number,
  ): Promise<{ ok: true }>;
  requestAttachExited(path: string, sessionId: string, handoffId: string, exitCode: number | null): Promise<{ ok: true }>;
  requestAttachFailed(path: string, sessionId: string, handoffId: string, error: string): Promise<{ ok: true }>;
  requestPanicLock(path: string): Promise<{ ok: true }>;
  engagePanicLock(): boolean;
  releasePanicLock(): boolean;
  executeAttach(spec: AttachSpec): Promise<number>;
  executeLifecycleAttach(spec: AttachSpec, lifecycle: AttachLifecycle): Promise<number>;
  openBrowser(url: string): Promise<void>;
}

function tailscaleOptions(config: AgentManagerConfig, executables: ServiceExecutables) {
  const allowedLogin = config.tailscale.allowedLogin;
  const dnsName = config.tailscale.dnsName;
  return {
    tailscaleBinary: executables.tailscale,
    backendHost: config.backend.host,
    backendPort: config.backend.port,
    httpsPort: config.tailscale.httpsPort,
    ...(allowedLogin !== null && dnsName !== null
      ? { expectedIdentity: { login: allowedLogin, dnsName } }
      : {}),
  };
}

function syncConfiguredWorkspaces(config: AgentManagerConfig): void {
  const database = new ManagerDatabase(defaultPaths().databaseFile);
  try {
    const configuredHostIds = new Set(config.hosts.map((host) => host.id));
    for (const stored of database.listHosts()) {
      if (stored.kind === "ssh" && !configuredHostIds.has(stored.id)) {
        database.removeHost(stored.id);
      }
    }
    for (const host of config.hosts) {
      database.addHost({ id: host.id, label: host.name, kind: "ssh", sshTarget: host.target });
    }
    for (const workspace of config.workspaces) {
      database.addWorkspace({
        id: workspace.id,
        label: workspace.name,
        path: workspace.path,
        hostId: workspace.hostId,
      });
    }
  } finally {
    database.close();
  }
}

async function defaultStartServer(
  options: { host: "127.0.0.1"; port: number },
): Promise<StartedServer> {
  assertPanicUnlocked(defaultPaths());
  const moduleUrl = import.meta.url.endsWith(".ts")
    ? new URL("../server/index.ts", import.meta.url).href
    : new URL("../server/index.js", import.meta.url).href;
  const serverModule = await import(moduleUrl) as ServerModule;
  const config = loadConfig();
  const executables = resolveServiceExecutables();
  syncConfiguredWorkspaces(config);
  const tailscaleDnsName = config.tailscale.dnsName;
  const tailscaleAllowedLogin = config.tailscale.allowedLogin;
  const tailscaleConfigured = tailscaleDnsName !== null
    && tailscaleAllowedLogin !== null;
  const backend = await serverModule.createAgentManagerServer({
    ...options,
    codexExecutable: executables.codex,
    tmuxExecutable: executables.tmux,
    remoteHosts: config.hosts.map((host) => ({
      id: host.id,
      label: host.name,
      target: host.target,
    })),
    ...(tailscaleConfigured
      ? {
          tailscaleHosts: [`${tailscaleDnsName}:${config.tailscale.httpsPort}`],
          tailscaleAllowedLogins: [tailscaleAllowedLogin],
        }
      : {}),
  });
  let address: string;
  try {
    address = await backend.listen();
  } catch (error) {
    await backend.close().catch(() => undefined);
    throw error;
  }
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    void backend.close().catch((error: unknown) => {
      process.stderr.write(`Agent Manager shutdown failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { address };
}

function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/usr/bin/open", [url], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Browser opener terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Browser opener exited with status ${String(code)}`));
        return;
      }
      resolvePromise();
    });
  });
}

function defaultDependencies(): CliDependencies {
  const paths = defaultPaths();
  const cliEntrypoint = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutColumns: process.stdout.columns ?? 160,
    homeDirectory: homedir(),
    cliEntrypoint,
    controlSocketPath: join(paths.runtimeDirectory, "control.sock"),
    serviceExecutables: () => resolveServiceExecutables({
      nodeExecutable: process.execPath,
    }),
    parseListArgs: parseArgs,
    buildListing,
    formatTable,
    doctor: () => {
      const executables = resolveServiceExecutables({ nodeExecutable: process.execPath });
      return runDoctor({
        config: loadConfig(),
        paths,
        serviceExecutables: executables,
        servicePath: buildControlledServicePath(executables),
      });
    },
    loadConfig,
    mutateConfig,
    addWorkspace,
    addSshHost,
    removeWorkspace,
    removeSshHost,
    persistWorkspace: (workspace) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        const conflicting = database.listWorkspaces().find((stored) =>
          stored.hostId === workspace.hostId
          && stored.path === workspace.path
          && stored.id !== workspace.id
        );
        if (conflicting) database.removeWorkspace(conflicting.id);
        database.addWorkspace({
          id: workspace.id,
          label: workspace.name,
          path: workspace.path,
          hostId: workspace.hostId,
        });
      } finally {
        database.close();
      }
    },
    removePersistedWorkspace: (id) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        return database.removeWorkspace(id);
      } finally {
        database.close();
      }
    },
    persistHost: (host) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        database.addHost({ id: host.id, label: host.name, kind: "ssh", sshTarget: host.target });
      } finally {
        database.close();
      }
    },
    removePersistedHost: (id) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        return database.removeHost(id);
      } finally {
        database.close();
      }
    },
    installRemoteNode: (target) => installRemoteNode({ target }),
    inspectTailscale: (config) => {
      const executables = resolveServiceExecutables({ nodeExecutable: process.execPath });
      return inspectTailscaleRoute(undefined, tailscaleOptions(config, executables));
    },
    installTailscale: (config) => {
      const executables = resolveServiceExecutables({ nodeExecutable: process.execPath });
      return installTailscaleRoute(undefined, tailscaleOptions(config, executables));
    },
    removeTailscale: (config) => {
      const executables = resolveServiceExecutables({ nodeExecutable: process.execPath });
      return removeTailscaleRoute(undefined, tailscaleOptions(config, executables));
    },
    renderService: renderLaunchAgent,
    installService: installLaunchAgentFile,
    startServer: defaultStartServer,
    requestBootstrap: requestBootstrapFromControlSocket,
    requestAttach: requestAttachFromControlSocket,
    requestAttachAuthorizeSpawn: requestAttachAuthorizeSpawnFromControlSocket,
    requestAttachStarted: requestAttachStartedFromControlSocket,
    requestAttachExited: requestAttachExitedFromControlSocket,
    requestAttachFailed: requestAttachFailedFromControlSocket,
    requestPanicLock: requestPanicLockFromControlSocket,
    engagePanicLock,
    releasePanicLock,
    executeAttach,
    executeLifecycleAttach,
    openBrowser: defaultOpenBrowser,
  };
}

function dependencies(overrides: Partial<CliDependencies>): CliDependencies {
  return { ...defaultDependencies(), ...overrides };
}

function writeLine(writer: TextWriter, value = ""): void {
  writer.write(`${value}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicListing(listing: ListingWithOutcome): ListingResult {
  return {
    version: listing.version,
    generatedAt: listing.generatedAt,
    recentWindowSeconds: listing.recentWindowSeconds,
    sessions: listing.sessions,
    diagnostics: listing.diagnostics,
  };
}

function runList(args: string[], deps: CliDependencies): number {
  const options = deps.parseListArgs(args);
  if (options.help) {
    writeLine(deps.stdout, LIST_HELP);
    return 0;
  }
  const listing = deps.buildListing(options);
  if (options.json) {
    writeLine(deps.stdout, JSON.stringify(publicListing(listing), null, 2));
  } else {
    writeLine(
      deps.stdout,
      deps.formatTable(
        listing.sessions,
        Date.parse(listing.generatedAt),
        deps.homeDirectory,
        deps.stdoutColumns,
      ),
    );
    for (const diagnostic of listing.diagnostics) {
      writeLine(deps.stderr, `${diagnostic.level} [${diagnostic.provider}] ${diagnostic.message}`);
    }
  }
  return listing.selectedProviderCount > 0 && listing.successfulProviderCount === 0 ? 2 : 0;
}

function printDoctor(report: DoctorReport, deps: CliDependencies): void {
  for (const check of report.checks) {
    const suffix = check.blocksControl ? " (controls blocked)" : "";
    writeLine(deps.stdout, `${check.level.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}${suffix}`);
  }
  writeLine(deps.stdout, report.ok ? "Agent Manager is ready." : "Agent Manager requires attention.");
}

function serviceOptions(config: AgentManagerConfig, deps: CliDependencies): LaunchAgentOptions {
  const paths = defaultPaths(deps.homeDirectory);
  return {
    executables: deps.serviceExecutables(),
    cliEntrypoint: deps.cliEntrypoint,
    homeDirectory: deps.homeDirectory,
    panicLockFile: panicLockPath(paths),
    backendPort: config.backend.port,
  };
}

async function dispatch(argv: readonly string[], deps: CliDependencies): Promise<number> {
  const command = parseCliCommand(argv);
  switch (command.name) {
    case "help":
      writeLine(deps.stdout, CLI_HELP);
      return 0;
    case "list":
      return runList(command.args, deps);
    case "serve": {
      const server = await deps.startServer({ host: command.host, port: command.port });
      writeLine(deps.stdout, `Agent Manager listening at ${server.address}`);
      writeLine(deps.stdout, "Run `agent-manager open` to create a fresh local browser link.");
      return 0;
    }
    case "open": {
      const bootstrap = await deps.requestBootstrap(deps.controlSocketPath);
      if (!bootstrap.bootstrapUrl) throw new Error("The running server did not return a bootstrap URL");
      if (command.launchBrowser) {
        await deps.openBrowser(bootstrap.bootstrapUrl);
        writeLine(deps.stdout, "Opened Agent Manager in the default browser.");
      } else {
        writeLine(deps.stdout, bootstrap.bootstrapUrl);
      }
      return 0;
    }
    case "node":
      await runNodeBridge({ controlSocketPath: deps.controlSocketPath });
      return 0;
    case "attach": {
      const reply = await deps.requestAttach(deps.controlSocketPath, command.sessionId);
      const handoffId = reply.instruction.handoffId;
      const spawnNonce = reply.instruction.spawnNonce;
      let spec: AttachSpec;
      try {
        if (reply.instruction.kind === "manager-cli") {
          throw new Error("Manager CLI attach instructions are browser-only");
        }
        spec = attachSpecFromInstruction(reply.instruction, deps.serviceExecutables());
      } catch (error) {
        if (handoffId) {
          await deps.requestAttachFailed(
            deps.controlSocketPath,
            command.sessionId,
            handoffId,
            errorMessage(error),
          ).catch(() => undefined);
        }
        throw error;
      }
      if (reply.instruction.warning) writeLine(deps.stderr, reply.instruction.warning);
      if (reply.instruction.kind === "claude-resume" && !handoffId) {
        throw new Error("Claude attach instruction is missing its ownership handoff id");
      }
      if (handoffId) {
        if (!spawnNonce) {
          await deps.requestAttachFailed(
            deps.controlSocketPath,
            command.sessionId,
            handoffId,
            "attach instruction is missing its pre-spawn nonce",
          ).catch(() => undefined);
          throw new Error("Attach instruction is missing its pre-spawn authorization nonce");
        }
        try {
          await deps.requestAttachAuthorizeSpawn(
            deps.controlSocketPath,
            command.sessionId,
            handoffId,
            spawnNonce,
            process.pid,
          );
        } catch (error) {
          await deps.requestAttachFailed(
            deps.controlSocketPath,
            command.sessionId,
            handoffId,
            `pre-spawn authorization failed: ${errorMessage(error)}`,
          ).catch(() => undefined);
          throw error;
        }
        return await deps.executeLifecycleAttach(spec, {
          started: async (pid) => {
            await deps.requestAttachStarted(
              deps.controlSocketPath,
              command.sessionId,
              handoffId,
              spawnNonce,
              pid,
            );
          },
          exited: async (exitCode) => {
            await deps.requestAttachExited(
              deps.controlSocketPath,
              command.sessionId,
              handoffId,
              exitCode,
            );
          },
          failed: async (message) => {
            await deps.requestAttachFailed(
              deps.controlSocketPath,
              command.sessionId,
              handoffId,
              message,
            );
          },
        });
      }
      return await deps.executeAttach(spec);
    }
    case "doctor": {
      const report = await deps.doctor();
      if (command.json) writeLine(deps.stdout, JSON.stringify(report, null, 2));
      else printDoctor(report, deps);
      return report.ok ? 0 : 2;
    }
    case "workspace": {
      if (command.operation === "list") {
        const config = deps.loadConfig();
        if (config.workspaces.length === 0) {
          writeLine(deps.stdout, "No configured workspaces.");
        } else {
          for (const workspace of config.workspaces) {
            writeLine(deps.stdout, `${workspace.id}\t${workspace.name}\t${workspace.path}`);
          }
        }
        return 0;
      }
      if (command.operation === "add") {
        const workspace = deps.mutateConfig((config) =>
          deps.addWorkspace(config, command.value!)
        );
        deps.persistWorkspace(workspace);
        writeLine(deps.stdout, `${workspace.id}\t${workspace.name}\t${workspace.path}`);
        return 0;
      }
      const removed = deps.mutateConfig((config) =>
        deps.removeWorkspace(config, command.value!)
      );
      if (!removed) {
        throw new Error(`Unknown workspace id: ${command.value!}`);
      }
      deps.removePersistedWorkspace(command.value!);
      writeLine(deps.stdout, `Removed workspace ${command.value!}.`);
      return 0;
    }
    case "host": {
      if (command.operation === "list") {
        const config = deps.loadConfig();
        if (config.hosts.length === 0) {
          writeLine(deps.stdout, "No configured SSH hosts.");
        } else {
          for (const host of config.hosts) {
            writeLine(deps.stdout, `${host.id}\t${host.name}\t${host.target}`);
          }
        }
        return 0;
      }
      if (command.operation === "add") {
        const host = deps.mutateConfig((config) => deps.addSshHost(config, {
          name: command.label,
          target: command.target,
        }));
        deps.persistHost(host);
        writeLine(deps.stdout, `${host.id}\t${host.name}\t${host.target}`);
        writeLine(deps.stdout, "Ensure Agent Manager is installed and its service is running on this host.");
        writeLine(deps.stdout, "A running cockpit will discover this host automatically.");
        return 0;
      }
      if (command.operation === "install") {
        const installed = await deps.installRemoteNode(command.value!);
        writeLine(deps.stdout, `Installed and started ${installed.serviceLabel} on ${command.value!}.`);
        return 0;
      }
      const removed = deps.mutateConfig((config) => deps.removeSshHost(config, command.value!));
      if (!removed) throw new Error(`Unknown SSH host id: ${command.value!}`);
      deps.removePersistedHost(command.value!);
      writeLine(deps.stdout, `Removed SSH host ${command.value!}.`);
      return 0;
    }
    case "tailscale": {
      if (command.operation === "status") {
        const config = deps.loadConfig();
        const result = deps.inspectTailscale(config);
        writeLine(deps.stdout, `Identity: ${result.identity.login}`);
        writeLine(deps.stdout, `Device: ${result.identity.dnsName}`);
        writeLine(deps.stdout, result.currentProxy
          ? `HTTPS ${config.tailscale.httpsPort} -> ${result.currentProxy}`
          : `No Agent Manager route on HTTPS ${config.tailscale.httpsPort}.`);
        return 0;
      }
      if (command.operation === "install") {
        const result = deps.mutateConfig((config) => {
          const installed = deps.installTailscale(config);
          config.tailscale.allowedLogin = installed.identity.login;
          config.tailscale.dnsName = installed.identity.dnsName;
          return installed;
        });
        writeLine(deps.stdout, result.changed ? `Installed ${result.url}` : `Already installed: ${result.url}`);
        writeLine(deps.stdout, "Restart Agent Manager to activate Tailscale identity authentication.");
        return 0;
      }
      const result = deps.mutateConfig((config) => {
        if (config.tailscale.allowedLogin === null || config.tailscale.dnsName === null) {
          throw new Error(
            "Refusing to remove the Tailscale route without its persisted login and device DNS identity",
          );
        }
        const removed = deps.removeTailscale(config);
        config.tailscale.allowedLogin = null;
        config.tailscale.dnsName = null;
        return removed;
      });
      writeLine(deps.stdout, result.changed ? "Removed the Agent Manager Tailscale route." : "No Agent Manager route was installed.");
      writeLine(deps.stdout, "Restart Agent Manager to remove the Tailscale identity from its allowlist.");
      return 0;
    }
    case "service": {
      const config = deps.loadConfig();
      const options = serviceOptions(config, deps);
      if (command.operation === "print") {
        deps.stdout.write(deps.renderService(options));
        return 0;
      }
      const destination = deps.installService(options);
      writeLine(deps.stdout, `Installed ${destination}`);
      writeLine(deps.stdout, `Load it explicitly with: launchctl bootstrap gui/${String(process.getuid?.() ?? 0)} ${JSON.stringify(destination)}`);
      return 0;
    }
    case "panic-lock": {
      deps.engagePanicLock();
      try {
        await deps.requestPanicLock(deps.controlSocketPath);
      } catch (error) {
        throw new Error(
          `Persistent panic lock is engaged, but live control-plane cleanup was incomplete: ${errorMessage(error)}`,
        );
      }
      writeLine(deps.stdout, "Agent Manager control plane locked persistently. Agent sessions were left running.");
      return 0;
    }
    case "panic-unlock":
      if (deps.releasePanicLock()) {
        writeLine(deps.stdout, "Released the persistent panic lock; launchd may restart Agent Manager.");
      } else {
        writeLine(deps.stdout, "Agent Manager panic lock was not engaged.");
      }
      return 0;
  }
}

export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = dependencies(overrides);
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    writeLine(deps.stderr, errorMessage(error));
    return 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
