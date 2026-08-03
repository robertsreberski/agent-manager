import { spawnSync } from "node:child_process";

export const DEFAULT_BACKEND_HOST = "127.0.0.1";
export const DEFAULT_BACKEND_PORT = 43_127;
export const DEFAULT_TAILSCALE_HTTPS_PORT = 9_443;
export const DEFAULT_TAILSCALE_BINARY = "/opt/homebrew/bin/tailscale";

const FUNNEL_PORTS = new Set([443, 8_443, 10_000]);

export interface CommandOutput {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[]): CommandOutput;
}

export const systemCommandRunner: CommandRunner = {
  run(executable, args) {
    const result = spawnSync(executable, [...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  },
};

interface TailscaleStatusJson {
  BackendState?: string;
  Self?: {
    UserID?: number;
    HostName?: string;
    DNSName?: string;
  };
  User?: Record<string, {
    LoginName?: string;
    DisplayName?: string;
  }>;
}

interface TailscaleServeJson {
  TCP?: Record<string, unknown>;
  Web?: Record<string, {
    Handlers?: Record<string, {
      Proxy?: string;
    }>;
  }>;
}

export interface TailscaleIdentity {
  login: string;
  displayName: string | null;
  hostName: string;
  dnsName: string;
}

export interface TailscaleInspection {
  identity: TailscaleIdentity;
  currentProxy: string | null;
  portInUse: boolean;
}

export interface TailscaleRouteOptions {
  tailscaleBinary?: string;
  backendHost?: string;
  backendPort?: number;
  httpsPort?: number;
  expectedIdentity?: {
    login: string;
    dnsName: string;
  };
}

export interface TailscaleInstallResult extends TailscaleInspection {
  changed: boolean;
  url: string;
}

function parseJson<T>(output: CommandOutput, operation: string): T {
  if (output.error || output.status !== 0) {
    const detail = output.error?.message ?? (output.stderr.trim() || `exit ${String(output.status)}`);
    throw new Error(`${operation} failed: ${detail}`);
  }
  try {
    return JSON.parse(output.stdout) as T;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${(error as Error).message}`);
  }
}

function normalizedOptions(options: TailscaleRouteOptions = {}) {
  const httpsPort = options.httpsPort ?? DEFAULT_TAILSCALE_HTTPS_PORT;
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65_535) {
    throw new Error(`Invalid Tailscale HTTPS port: ${String(httpsPort)}`);
  }
  if (FUNNEL_PORTS.has(httpsPort)) {
    throw new Error(
      `Refusing HTTPS port ${httpsPort}; Agent Manager requires a port that Tailscale Funnel cannot publish.`,
    );
  }
  const backendPort = options.backendPort ?? DEFAULT_BACKEND_PORT;
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65_535) {
    throw new Error(`Invalid backend port: ${String(backendPort)}`);
  }
  const backendHost = options.backendHost ?? DEFAULT_BACKEND_HOST;
  if (backendHost !== "127.0.0.1") {
    throw new Error("Tailscale Serve backend must be exactly 127.0.0.1");
  }
  return {
    tailscaleBinary: options.tailscaleBinary ?? DEFAULT_TAILSCALE_BINARY,
    backendHost,
    backendPort,
    httpsPort,
    expectedProxy: `http://${backendHost}:${backendPort}`,
  };
}

export function inspectTailscaleRoute(
  runner: CommandRunner = systemCommandRunner,
  options: TailscaleRouteOptions = {},
): TailscaleInspection {
  const resolved = normalizedOptions(options);
  const status = parseJson<TailscaleStatusJson>(
    runner.run(resolved.tailscaleBinary, ["status", "--json"]),
    "tailscale status",
  );
  if (status.BackendState !== "Running") {
    throw new Error(`Tailscale is not running (state: ${status.BackendState ?? "unknown"})`);
  }
  const userId = status.Self?.UserID;
  const user = userId === undefined ? undefined : status.User?.[String(userId)];
  const login = user?.LoginName?.trim();
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "").trim();
  const hostName = status.Self?.HostName?.trim();
  if (!login || !dnsName || !hostName) {
    throw new Error("Tailscale status did not expose the current user login and device DNS identity");
  }

  const serve = parseJson<TailscaleServeJson>(
    runner.run(resolved.tailscaleBinary, ["serve", "status", "--json"]),
    "tailscale serve status",
  );
  const hostKey = `${dnsName}:${resolved.httpsPort}`;
  const handlers = serve.Web?.[hostKey]?.Handlers;
  const currentProxy = handlers?.["/"]?.Proxy ?? null;
  return {
    identity: {
      login,
      displayName: user?.DisplayName ?? null,
      hostName,
      dnsName,
    },
    currentProxy,
    portInUse: Boolean(serve.TCP?.[String(resolved.httpsPort)]),
  };
}

export function installTailscaleRoute(
  runner: CommandRunner = systemCommandRunner,
  options: TailscaleRouteOptions = {},
): TailscaleInstallResult {
  const resolved = normalizedOptions(options);
  const before = inspectTailscaleRoute(runner, options);
  if (before.currentProxy === resolved.expectedProxy) {
    return {
      ...before,
      changed: false,
      url: `https://${before.identity.dnsName}:${resolved.httpsPort}/`,
    };
  }
  if (before.portInUse || before.currentProxy) {
    throw new Error(
      `Refusing to overwrite existing Tailscale Serve configuration on HTTPS port ${resolved.httpsPort}`,
    );
  }

  const output = runner.run(resolved.tailscaleBinary, [
    "serve",
    "--bg",
    `--https=${resolved.httpsPort}`,
    resolved.expectedProxy,
  ]);
  if (output.error || output.status !== 0) {
    throw new Error(`tailscale serve install failed: ${output.error?.message ?? output.stderr.trim()}`);
  }
  const after = inspectTailscaleRoute(runner, options);
  if (after.currentProxy !== resolved.expectedProxy) {
    throw new Error("Tailscale Serve did not install the expected Agent Manager proxy");
  }
  return {
    ...after,
    changed: true,
    url: `https://${after.identity.dnsName}:${resolved.httpsPort}/`,
  };
}

export function removeTailscaleRoute(
  runner: CommandRunner = systemCommandRunner,
  options: TailscaleRouteOptions = {},
): { changed: boolean } {
  const resolved = normalizedOptions(options);
  const before = inspectTailscaleRoute(runner, options);
  const expectedIdentity = options.expectedIdentity;
  if (!expectedIdentity?.login || !expectedIdentity.dnsName) {
    throw new Error(
      "Refusing to remove the Tailscale route without its persisted login and device DNS identity",
    );
  }
  if (
    before.identity.login !== expectedIdentity.login
    || before.identity.dnsName !== expectedIdentity.dnsName
  ) {
    throw new Error(
      `Refusing to remove the Tailscale route after identity drift (expected ${expectedIdentity.login} on ${expectedIdentity.dnsName}; found ${before.identity.login} on ${before.identity.dnsName})`,
    );
  }
  if (!before.portInUse && !before.currentProxy) return { changed: false };
  if (before.currentProxy !== resolved.expectedProxy) {
    throw new Error("Refusing to remove a Tailscale Serve route not owned by Agent Manager");
  }
  const output = runner.run(resolved.tailscaleBinary, [
    "serve",
    `--https=${resolved.httpsPort}`,
    "--set-path=/",
    "off",
  ]);
  if (output.error || output.status !== 0) {
    throw new Error(`tailscale serve off failed: ${output.error?.message ?? output.stderr.trim()}`);
  }
  const after = inspectTailscaleRoute(runner, options);
  if (
    after.identity.login !== expectedIdentity.login
    || after.identity.dnsName !== expectedIdentity.dnsName
  ) {
    throw new Error("Tailscale identity changed while removing the Agent Manager route");
  }
  // `--set-path=/ off` removes only our root handler. The HTTPS listener may
  // legitimately remain active when the owner has configured another path on
  // the same port, so ownership is discharged once the root route is absent.
  if (after.currentProxy) {
    throw new Error("Tailscale Serve did not remove the expected Agent Manager route");
  }
  return { changed: true };
}
