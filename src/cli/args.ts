export type CliCommand =
  | { name: "list"; args: string[] }
  | { name: "serve"; host: "127.0.0.1"; port: number }
  | { name: "open"; launchBrowser: boolean }
  | { name: "attach"; sessionId: string }
  | { name: "doctor"; json: boolean }
  | { name: "workspace"; operation: "list" | "add" | "remove"; value?: string }
  | { name: "tailscale"; operation: "install" | "status" | "off" }
  | { name: "service"; operation: "print" | "install" }
  | { name: "panic-lock" }
  | { name: "panic-unlock" }
  | { name: "help" };

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(required(value, "--port requires a value"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

export function parseCliCommand(argv: readonly string[]): CliCommand {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand ?? "list";
  switch (command) {
    case "-h":
    case "--help":
    case "help":
      return { name: "help" };
    case "list":
      return { name: "list", args: rest };
    case "serve": {
      let host: "127.0.0.1" = "127.0.0.1";
      let port = 43_127;
      for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];
        if (argument === "--host") {
          const requested = required(rest[index + 1], "--host requires a value");
          if (requested !== "127.0.0.1") {
            throw new Error("Agent Manager may only bind to 127.0.0.1");
          }
          host = requested;
          index += 1;
        } else if (argument === "--port") {
          port = parsePort(rest[index + 1]);
          index += 1;
        } else {
          throw new Error(`Unknown serve option: ${String(argument)}`);
        }
      }
      return { name: "serve", host, port };
    }
    case "open":
      if (rest.length > 1 || (rest[0] && rest[0] !== "--no-browser")) {
        throw new Error("Usage: agent-manager open [--no-browser]");
      }
      return { name: "open", launchBrowser: rest[0] !== "--no-browser" };
    case "attach":
      if (rest.length !== 1) throw new Error("Usage: agent-manager attach <session-id>");
      return { name: "attach", sessionId: required(rest[0], "Session id is required") };
    case "doctor":
      if (rest.length > 1 || (rest[0] && rest[0] !== "--json")) {
        throw new Error("Usage: agent-manager doctor [--json]");
      }
      return { name: "doctor", json: rest[0] === "--json" };
    case "workspace": {
      const operation = rest[0];
      if (operation === "list" && rest.length === 1) return { name: "workspace", operation };
      if ((operation === "add" || operation === "remove") && rest.length === 2) {
        return { name: "workspace", operation, value: required(rest[1], "Workspace value required") };
      }
      throw new Error("Usage: agent-manager workspace list|add <path>|remove <id>");
    }
    case "tailscale": {
      const operation = rest[0];
      if ((operation === "install" || operation === "status" || operation === "off") && rest.length === 1) {
        return { name: "tailscale", operation };
      }
      throw new Error("Usage: agent-manager tailscale install|status|off");
    }
    case "service": {
      const operation = rest[0];
      if ((operation === "print" || operation === "install") && rest.length === 1) {
        return { name: "service", operation };
      }
      throw new Error("Usage: agent-manager service print|install");
    }
    case "panic-lock":
      if (rest.length > 0) throw new Error("Usage: agent-manager panic-lock");
      return { name: "panic-lock" };
    case "panic-unlock":
      if (rest.length > 0) throw new Error("Usage: agent-manager panic-unlock");
      return { name: "panic-unlock" };
    default:
      // Preserve the original script's convenient option-first invocation.
      if (command.startsWith("-")) return { name: "list", args: [command, ...rest] };
      throw new Error(`Unknown command: ${command}`);
  }
}

export const CLI_HELP = `Agent Manager local cockpit

Usage:
  agent-manager list [agent-sessions options]
  agent-manager serve [--host 127.0.0.1] [--port 43127]
  agent-manager open [--no-browser]
  agent-manager attach <session-id>
  agent-manager doctor [--json]
  agent-manager workspace list|add <path>|remove <id>
  agent-manager tailscale install|status|off
  agent-manager service print|install
  agent-manager panic-lock
  agent-manager panic-unlock

Controls are capability-gated. Existing external sessions remain attach-only.
`;
