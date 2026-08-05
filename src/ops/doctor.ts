import { accessSync, constants, existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
} from "../providers/claude/types.ts";
import type { AgentManagerConfig, AgentManagerPaths } from "./config.ts";
import { defaultConfig, defaultPaths } from "./config.ts";
import {
  buildControlledServicePath,
  canonicalExecutable,
  resolveServiceExecutables,
  type ServiceExecutables,
} from "./executables.ts";
import {
  DEFAULT_TAILSCALE_BINARY,
  inspectTailscaleRoute,
  systemCommandRunner,
  type CommandRunner,
} from "./tailscale.ts";

export type DoctorLevel = "pass" | "warning" | "failure";

export interface DoctorCheck {
  name: string;
  level: DoctorLevel;
  detail: string;
  blocksControl: boolean;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  runner?: CommandRunner;
  config?: AgentManagerConfig;
  paths?: AgentManagerPaths;
  serviceExecutables?: ServiceExecutables;
  servicePath?: string;
}

function versionCheck(
  runner: CommandRunner,
  name: string,
  executable: string,
  args: readonly string[],
  supported: RegExp,
  expected: string,
): DoctorCheck {
  const result = runner.run(executable, args);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.error || result.status !== 0) {
    return {
      name,
      level: "failure",
      detail: result.error?.message ?? (output || `exit ${String(result.status)}`),
      blocksControl: true,
    };
  }
  if (!supported.test(output)) {
    return {
      name,
      level: "warning",
      detail: `Found ${output || "unknown version"}; semantic controls target ${expected}`,
      blocksControl: true,
    };
  }
  return { name, level: "pass", detail: output, blocksControl: false };
}

async function portCheck(host: string, port: number): Promise<DoctorCheck> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      resolve({
        name: "backend-port",
        level: "warning",
        detail: `${host}:${port} is already in use (${error.message})`,
        blocksControl: false,
      });
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => {
        resolve({
          name: "backend-port",
          level: "pass",
          detail: `${host}:${port} is available`,
          blocksControl: false,
        });
      });
    });
  });
}

function storageCheck(paths: AgentManagerPaths): DoctorCheck {
  try {
    const target = existsSync(paths.dataDirectory) ? paths.dataDirectory : dirname(paths.dataDirectory);
    accessSync(target, constants.R_OK | constants.W_OK);
    if (existsSync(paths.dataDirectory)) {
      const mode = statSync(paths.dataDirectory).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          name: "private-storage",
          level: "failure",
          detail: `${paths.dataDirectory} permissions are ${mode.toString(8)}; expected 700`,
          blocksControl: true,
        };
      }
    }
    return {
      name: "private-storage",
      level: "pass",
      detail: existsSync(paths.dataDirectory)
        ? `${paths.dataDirectory} is private and writable`
        : `${paths.dataDirectory} can be created`,
      blocksControl: false,
    };
  } catch (error) {
    return {
      name: "private-storage",
      level: "failure",
      detail: (error as Error).message,
      blocksControl: true,
    };
  }
}

function serviceEnvironmentCheck(
  executables: ServiceExecutables,
  servicePath: string,
): DoctorCheck {
  try {
    const expectedPath = buildControlledServicePath(executables);
    if (servicePath !== expectedPath) {
      throw new Error("configured service PATH does not match the canonical executable set");
    }
    for (const [name, executable] of Object.entries(executables)) {
      const canonical = canonicalExecutable(name, {
        configured: executable,
        path: servicePath,
      });
      if (canonical !== executable) {
        throw new Error(`${name} executable is not canonical`);
      }
    }
    return {
      name: "service-environment",
      level: "pass",
      detail: `Controlled PATH with ${Object.keys(executables).length} canonical executables`,
      blocksControl: false,
    };
  } catch (error) {
    return {
      name: "service-environment",
      level: "failure",
      detail: (error as Error).message,
      blocksControl: true,
    };
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const runner = options.runner ?? systemCommandRunner;
  const config = options.config ?? defaultConfig();
  const paths = options.paths ?? defaultPaths();
  let serviceExecutables: ServiceExecutables | null = null;
  let serviceEnvironmentFailure: DoctorCheck | null = null;
  try {
    serviceExecutables = options.serviceExecutables ?? resolveServiceExecutables({
      nodeExecutable: process.execPath,
      ...(options.servicePath ? { path: options.servicePath } : {}),
      env: process.env,
    });
  } catch (error) {
    serviceEnvironmentFailure = {
      name: "service-environment",
      level: "failure",
      detail: (error as Error).message,
      blocksControl: true,
    };
  }
  const servicePath = serviceExecutables
    ? options.servicePath ?? buildControlledServicePath(serviceExecutables)
    : options.servicePath ?? "";
  const checks: DoctorCheck[] = [
    ...(serviceExecutables
      ? [serviceEnvironmentCheck(serviceExecutables, servicePath)]
      : serviceEnvironmentFailure ? [serviceEnvironmentFailure] : []),
    ...(serviceExecutables
      ? [
          versionCheck(
            runner,
            "node",
            serviceExecutables.node,
            ["--version"],
            /^v24\./u,
            "Node 24.x",
          ),
          versionCheck(
            runner,
            "codex",
            serviceExecutables.codex,
            ["--version"],
            /\b0\.146\./u,
            "Codex CLI 0.146.x",
          ),
          versionCheck(
            runner,
            "claude",
            serviceExecutables.claude,
            ["--version"],
            new RegExp(`\\b${CLAUDE_CODE_VERSION.replaceAll(".", "\\.")}\\b`, "u"),
            `Claude Code ${CLAUDE_CODE_VERSION} / Agent SDK ${CLAUDE_AGENT_SDK_VERSION}`,
          ),
          versionCheck(
            runner,
            "tmux",
            serviceExecutables.tmux,
            ["-V"],
            /\btmux 3\.6/u,
            "tmux 3.6.x",
          ),
        ]
      : []),
    storageCheck(paths),
    await portCheck(config.backend.host, config.backend.port),
  ];

  try {
    const inspection = inspectTailscaleRoute(runner, {
      tailscaleBinary: serviceExecutables?.tailscale ?? DEFAULT_TAILSCALE_BINARY,
      backendHost: config.backend.host,
      backendPort: config.backend.port,
      httpsPort: config.tailscale.httpsPort,
    });
    checks.push({
      name: "tailscale",
      level: inspection.currentProxy === `http://${config.backend.host}:${config.backend.port}`
        ? "pass"
        : "warning",
      detail: inspection.currentProxy
        ? `HTTPS route currently targets ${inspection.currentProxy}`
        : `Running as ${inspection.identity.login}; Agent Manager route is not installed`,
      blocksControl: false,
    });
  } catch (error) {
    checks.push({
      name: "tailscale",
      level: "warning",
      detail: (error as Error).message,
      blocksControl: false,
    });
  }

  return {
    ok: !checks.some((check) => check.level === "failure" || check.blocksControl),
    generatedAt: new Date().toISOString(),
    checks,
  };
}
