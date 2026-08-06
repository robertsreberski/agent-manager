#!/usr/bin/env node

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  addWorkspace,
  addSshHost,
  buildControlledServicePath,
  IncompatibleConfigError,
  defaultPaths,
  executeAttach,
  inspectTailscaleRoute,
  installLaunchAgentFile,
  installTailscaleRoute,
  loadConfig,
  mutateConfig,
  resetOwnedState,
  removeTailscaleRoute,
  removeSshHost,
  removeWorkspace,
  reloadLaunchAgent,
  renderLaunchAgent,
  resolveServiceExecutables,
  runDoctor,
  saveConfig,
  stopLaunchAgent,
  type AgentManagerConfig,
  type AttachSpec,
  type DoctorReport,
  type LaunchAgentOptions,
  type ServiceExecutables,
  type TailscaleInspection,
  type TailscaleInstallResult,
} from "../ops/index.ts";
import {
  runClaudeHookOperation,
  type ClaudeHookInstallRecord,
  type ClaudeHookOperationDependencies,
  type ClaudeHookOperationInput,
  type ClaudeHookOperationResult,
} from "../ops/hooks.ts";
import {
  requestAttachFromControlSocket,
  requestBootstrapFromControlSocket,
  requestHooksReloadFromControlSocket,
  type BootstrapTokenReply,
} from "../server/control-socket.ts";
import { ConfigRemoteHostRegistry } from "../server/remote-host-registry.ts";
import type { AttachInstruction } from "../server/contracts.ts";
import { IncompatibleDatabaseError, ManagerDatabase } from "../server/persistence.ts";
import { installRemoteNode, runNodeBridge } from "../remote/index.ts";
import {
  attachSpecFromInstruction,
  executeLifecycleAttach,
  type AttachLifecycle,
} from "./client.ts";
import { CLI_HELP, parseCliCommand } from "./args.ts";

interface TextWriter {
  write(value: string): unknown;
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
    claudeExecutable?: string;
    tmuxExecutable?: string;
    remoteHosts?: ReadonlyArray<{ id: string; label: string; target: string }>;
    remoteHostRegistry?: {
      list(): Array<{ id: string; label: string; target: string }>;
      add(input: { label: string; target: string }): { id: string; label: string; target: string };
      remove(id: string): boolean;
    };
    configuredHosts?: ReadonlyArray<{ id: string; label: string; target: string }>;
    configuredWorkspaces?: ReadonlyArray<{
      id: string;
      label: string;
      path: string;
      hostId: string;
    }>;
  }): Promise<{
    listen(): Promise<string>;
    close(): Promise<void>;
  }>;
}

export interface CliDependencies {
  stdout: TextWriter;
  stderr: TextWriter;
  homeDirectory: string;
  cliEntrypoint: string;
  controlSocketPath: string;
  currentDirectory: string;
  serviceExecutables(): ServiceExecutables;
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
  prepareServiceState(config: AgentManagerConfig): void;
  stopService(): void;
  resetOwnedState(): readonly string[];
  recreateOwnedState(): AgentManagerConfig;
  reloadService(destination: string): void;
  waitForService(port: number): Promise<void>;
  operateClaudeHook(
    input: ClaudeHookOperationInput,
    dependencies: ClaudeHookOperationDependencies,
  ): Promise<ClaudeHookOperationResult>;
  loadClaudeHookRecord(settingsPath: string): ClaudeHookInstallRecord | null;
  saveClaudeHookRecord(record: ClaudeHookInstallRecord): void;
  removeClaudeHookRecord(recordId: string): void;
  claudeHookLastSeen(recordId: string): string | null;
  reloadHookAuthorizations(path: string): Promise<{ ok: true }>;
  confirmHookChange(): Promise<boolean>;
  startServer(options: { host: "127.0.0.1"; port: number }): Promise<StartedServer>;
  requestBootstrap(path: string): Promise<BootstrapTokenReply>;
  requestAttach(path: string, sessionId: string): Promise<{ instruction: AttachInstruction }>;
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
  let backend: Awaited<ReturnType<ServerModule["createAgentManagerServer"]>> | null = null;
  let shutdownRequested = false;
  let closing = false;
  const close = (): void => {
    shutdownRequested = true;
    if (!backend || closing) return;
    closing = true;
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    void backend.close().catch((error: unknown) => {
      process.stderr.write(`Agent Manager shutdown failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  };
  // Install lifecycle handling before provider composition so a deployment
  // signal cannot strand a partially initialized Claude or Codex child.
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const moduleUrl = import.meta.url.endsWith(".ts")
    ? new URL("../server/index.ts", import.meta.url).href
    : new URL("../server/index.js", import.meta.url).href;
  const serverModule = await import(moduleUrl) as ServerModule;
  const config = loadConfig();
  const executables = resolveServiceExecutables();
  const tailscaleDnsName = config.tailscale.dnsName;
  const tailscaleAllowedLogin = config.tailscale.allowedLogin;
  const tailscaleConfigured = tailscaleDnsName !== null
    && tailscaleAllowedLogin !== null;
  try {
    backend = await serverModule.createAgentManagerServer({
      ...options,
      codexExecutable: executables.codex,
      claudeExecutable: executables.claude,
      tmuxExecutable: executables.tmux,
      remoteHosts: config.hosts.map((host) => ({
        id: host.id,
        label: host.name,
        target: host.target,
      })),
      remoteHostRegistry: new ConfigRemoteHostRegistry(defaultPaths()),
      configuredHosts: config.hosts.map((host) => ({
        id: host.id,
        label: host.name,
        target: host.target,
      })),
      configuredWorkspaces: config.workspaces.map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
        path: workspace.path,
        hostId: workspace.hostId,
      })),
      ...(tailscaleConfigured
        ? {
            tailscaleHosts: [`${tailscaleDnsName}:${config.tailscale.httpsPort}`],
            tailscaleAllowedLogins: [tailscaleAllowedLogin],
          }
        : {}),
    });
    if (shutdownRequested) {
      await backend.close();
      throw new Error("Agent Manager startup was cancelled by a termination signal");
    }
    const address = await backend.listen();
    return { address };
  } catch (error) {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    await backend?.close().catch(() => undefined);
    throw error;
  }
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

interface ServiceHealthResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface WaitForStableServiceOptions {
  request?: (url: string) => Promise<ServiceHealthResponse>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  stableMs?: number;
  pollMs?: number;
}

/** Require a healthy window so an asynchronous startup crash cannot pass deploy. */
export async function waitForStableService(
  port: number,
  options: WaitForStableServiceOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const pollMs = options.pollMs ?? 125;
  // launchd may honor the LaunchAgent throttle window after replacing a
  // previously crash-looping build. Deployment should wait through that
  // bounded OS handoff instead of reporting failure just before recovery.
  const deadline = now() + (options.timeoutMs ?? 30_000);
  const requiredStableMs = options.stableMs ?? 1_500;
  const request = options.request ?? (async (url: string) => await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(750),
  }));
  let healthySince: number | null = null;
  let lastError = "service did not answer";
  while (now() < deadline) {
    try {
      const response = await request(`http://127.0.0.1:${String(port)}/api/v1/healthz`);
      if (response.ok) {
        const body = await response.json();
        if (typeof body === "object" && body !== null && "ok" in body && body.ok === true) {
          healthySince ??= now();
          if (now() - healthySince >= requiredStableMs) return;
          await sleep(pollMs);
          continue;
        }
      }
      lastError = `health returned ${String(response.status)}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    healthySince = null;
    await sleep(pollMs);
  }
  throw new Error(`Agent Manager did not remain healthy after restart: ${lastError}`);
}

async function defaultWaitForService(port: number): Promise<void> {
  await waitForStableService(port);
}

function defaultDependencies(): CliDependencies {
  const paths = defaultPaths();
  const cliEntrypoint = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    homeDirectory: homedir(),
    cliEntrypoint,
    controlSocketPath: join(paths.runtimeDirectory, "control.sock"),
    currentDirectory: process.cwd(),
    serviceExecutables: () => resolveServiceExecutables({
      nodeExecutable: process.execPath,
    }),
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
    prepareServiceState: syncConfiguredWorkspaces,
    stopService: stopLaunchAgent,
    resetOwnedState: () => resetOwnedState(paths),
    recreateOwnedState: () => {
      const config = loadConfig(paths);
      saveConfig(config, paths);
      syncConfiguredWorkspaces(config);
      return config;
    },
    reloadService: (destination) => reloadLaunchAgent(destination),
    waitForService: defaultWaitForService,
    operateClaudeHook: runClaudeHookOperation,
    loadClaudeHookRecord: (settingsPath) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        return database.getClaudeHookInstallRecord(settingsPath);
      } finally {
        database.close();
      }
    },
    saveClaudeHookRecord: (record) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        database.upsertClaudeHookInstallRecord(record);
      } finally {
        database.close();
      }
    },
    removeClaudeHookRecord: (recordId) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        database.removeClaudeHookInstallRecord(recordId);
      } finally {
        database.close();
      }
    },
    claudeHookLastSeen: (recordId) => {
      const database = new ManagerDatabase(paths.databaseFile);
      try {
        return database.listClaudeHookInstallRecords()
          .find((record) => record.id === recordId)?.lastSeenAt ?? null;
      } finally {
        database.close();
      }
    },
    reloadHookAuthorizations: requestHooksReloadFromControlSocket,
    confirmHookChange: async () => {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error("Hook settings changes require an interactive terminal or explicit --yes");
      }
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await prompt.question("Apply this exact settings change? [y/N] ");
        return /^(?:y|yes)$/iu.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
    startServer: defaultStartServer,
    requestBootstrap: requestBootstrapFromControlSocket,
    requestAttach: requestAttachFromControlSocket,
    executeAttach,
    executeLifecycleAttach,
    openBrowser: defaultOpenBrowser,
  };
}

async function dispatchClaudeHook(
  command: Extract<ReturnType<typeof parseCliCommand>, { name: "hooks" }>,
  deps: CliDependencies,
): Promise<void> {
  const common = {
    operation: command.operation,
    scope: command.scope,
    homeDirectory: deps.homeDirectory,
    ...(command.scope === "project" ? { projectDirectory: deps.currentDirectory } : {}),
  } as const;
  const input: ClaudeHookOperationInput = command.operation === "install"
    ? {
        ...common,
        operation: "install",
        endpoint: `http://127.0.0.1:${String(deps.loadConfig().backend.port)}/api/v1/hooks/claude`,
      }
    : command.operation === "uninstall"
      ? { ...common, operation: "uninstall" }
      : { ...common, operation: "status" };
  const result = await deps.operateClaudeHook(input, {
    loadRecord: deps.loadClaudeHookRecord,
    saveRecord: deps.saveClaudeHookRecord,
    removeRecord: deps.removeClaudeHookRecord,
    lastSeenAt: deps.claudeHookLastSeen,
    showPreview: (plan) => {
      const exactDiff = plan.diff.trimEnd();
      if (exactDiff.length > 0) writeLine(deps.stdout, exactDiff);
    },
    confirm: () => command.yes ? true : deps.confirmHookChange(),
  });
  writeLine(deps.stdout, `Claude hooks (${command.scope}): ${result.status.state}`);
  writeLine(deps.stdout, `Settings: ${result.status.settingsPath}`);
  if (result.status.lastSeenAt) writeLine(deps.stdout, `Last event: ${result.status.lastSeenAt}`);
  if (result.operation !== "status") writeLine(deps.stdout, `Outcome: ${result.outcome}`);
  if (result.operation !== "status" && result.outcome !== "cancelled") {
    try {
      await deps.reloadHookAuthorizations(deps.controlSocketPath);
    } catch {
      writeLine(
        deps.stderr,
        "Hook settings are saved; start or restart Agent Manager before expecting cockpit events.",
      );
    }
  }
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

function isExistingAbsoluteDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function recoverCodexAttachWorkingDirectory(
  instruction: AttachInstruction,
  spec: AttachSpec,
  currentDirectory: string,
): { spec: AttachSpec; warning: string | null } {
  if (instruction.kind !== "codex-remote") return { spec, warning: null };
  const instructedDirectory = instruction.cwd;
  if (!instructedDirectory || !isAbsolute(instructedDirectory)) {
    throw new Error("Codex attach instruction must use an absolute working directory");
  }
  if (isExistingAbsoluteDirectory(instructedDirectory)) {
    return { spec, warning: null };
  }
  if (!isExistingAbsoluteDirectory(currentDirectory)) {
    throw new Error(
      `Codex session working directory ${JSON.stringify(instructedDirectory)} is unavailable, and current directory ${JSON.stringify(currentDirectory)} is not an existing absolute directory`,
    );
  }
  return {
    spec: { ...spec, cwd: currentDirectory },
    warning: `Codex session working directory ${JSON.stringify(instructedDirectory)} is unavailable; using current directory ${JSON.stringify(currentDirectory)} for this CLI join. The pinned executable, thread ID, and shared App Server socket are unchanged.`,
  };
}

function printDoctor(report: DoctorReport, deps: CliDependencies): void {
  for (const check of report.checks) {
    const suffix = check.blocksControl ? " (controls blocked)" : "";
    writeLine(deps.stdout, `${check.level.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}${suffix}`);
  }
  writeLine(deps.stdout, report.ok ? "Agent Manager is ready." : "Agent Manager requires attention.");
}

function serviceOptions(config: AgentManagerConfig, deps: CliDependencies): LaunchAgentOptions {
  return {
    executables: deps.serviceExecutables(),
    cliEntrypoint: deps.cliEntrypoint,
    homeDirectory: deps.homeDirectory,
    backendPort: config.backend.port,
  };
}

function isColdCutoverError(error: unknown): error is IncompatibleConfigError | IncompatibleDatabaseError {
  return error instanceof IncompatibleConfigError || error instanceof IncompatibleDatabaseError;
}

function prepareInstalledServiceState(deps: CliDependencies): {
  config: AgentManagerConfig;
  coldCutover: boolean;
} {
  try {
    const config = deps.loadConfig();
    deps.prepareServiceState(config);
    return { config, coldCutover: false };
  } catch (error) {
    if (!isColdCutoverError(error)) throw error;
  }

  // The old process may still own SQLite handles. Unload only this tool's
  // exact per-user LaunchAgent before deleting its bounded state files.
  deps.stopService();
  deps.resetOwnedState();
  return { config: deps.recreateOwnedState(), coldCutover: true };
}

async function dispatch(argv: readonly string[], deps: CliDependencies): Promise<number> {
  const command = parseCliCommand(argv);
  switch (command.name) {
    case "help":
      writeLine(deps.stdout, CLI_HELP);
      return 0;
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
      /*
        `attach` hands over a provider command and nothing else. It used to drive
        an ownership handoff: authorize the spawn with a nonce, report the child's
        pid, then report its exit so the manager could reclaim the session. A
        joined CLI runs beside the manager's own writer, so there is no ownership
        to authorize and no exit to report.
      */
      const reply = await deps.requestAttach(deps.controlSocketPath, command.sessionId);
      if (reply.instruction.kind === "manager-cli") {
        throw new Error("Manager CLI attach instructions are browser-only");
      }
      let spec = attachSpecFromInstruction(reply.instruction, deps.serviceExecutables());
      const recovered = recoverCodexAttachWorkingDirectory(
        reply.instruction,
        spec,
        deps.currentDirectory,
      );
      spec = recovered.spec;
      if (reply.instruction.warning) writeLine(deps.stderr, reply.instruction.warning);
      if (recovered.warning) writeLine(deps.stderr, recovered.warning);
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
    case "hooks": {
      if (command.scope === "project") {
        writeLine(
          deps.stderr,
          "Project hooks point at this machine-local Agent Manager service and will not work on another machine.",
        );
      }
      if (command.provider === "codex") {
        writeLine(
          deps.stderr,
          "Codex hooks are retired. Agent Manager reads Codex sessions through the App Server, and any hooks it installed are removed automatically on start.",
        );
        return 1;
      }
      await dispatchClaudeHook(command, deps);
      return 0;
    }
    case "service": {
      if (command.operation === "print") {
        const config = deps.loadConfig();
        const options = serviceOptions(config, deps);
        deps.stdout.write(deps.renderService(options));
        return 0;
      }
      const prepared = prepareInstalledServiceState(deps);
      const config = prepared.config;
      const options = serviceOptions(config, deps);
      const destination = deps.installService(options);
      deps.reloadService(destination);
      await deps.waitForService(config.backend.port);
      if (prepared.coldCutover) {
        writeLine(deps.stdout, "Recreated incompatible Agent Manager config and database state for the current schema.");
      }
      writeLine(deps.stdout, `Installed, restarted, and healthy: ${destination}`);
      return 0;
    }
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
