import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import { CodexRpcClient, type MessageTransport } from "./rpc.ts";
import type { JsonObject, JsonValue } from "./types.ts";

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export type CodexHookEvent = typeof CODEX_HOOK_EVENTS[number];

export interface CodexHookInput {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string;
  event: CodexHookEvent;
  model: string | null;
  permissionMode: string | null;
  agentId: string | null;
  agentType: string | null;
  turnId: string | null;
  toolName: string | null;
  toolUseId: string | null;
  toolInput: JsonValue;
  raw: JsonObject;
}

export type CodexHookTrustState =
  | "absent"
  | "awaiting-trust"
  | "trusted"
  | "disabled"
  | "invalid";

export interface CodexHookStatus {
  state: CodexHookTrustState;
  reason: string;
  installedEvents: readonly CodexHookEvent[];
}

const EVENT_SET = new Set<string>(CODEX_HOOK_EVENTS);
const RPC_EVENT_TO_HOOK_EVENT = new Map<string, CodexHookEvent>(
  CODEX_HOOK_EVENTS.map((event) => [event[0]!.toLowerCase() + event.slice(1), event]),
);
const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_TEXT = 262_144;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

class CodexHookProbeTransport implements MessageTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #messageListeners = new Set<(message: string) => void>();
  readonly #closeListeners = new Set<(error: Error | null) => void>();
  #buffer = "";
  #stderrTail = "";
  #closed = false;

  constructor(executable: string, environment: NodeJS.ProcessEnv = process.env) {
    this.#child = spawn(executable, ["app-server", "--stdio"], {
      env: environment,
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-4_096);
    });
    this.#child.once("error", (error) => this.#finish(error));
    this.#child.once("exit", (code, signal) => {
      if (this.#closed) return;
      const detail = this.#stderrTail.trim();
      const reason = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      this.#finish(new Error(
        `Codex hook status probe exited with ${reason}${detail ? `: ${detail}` : ""}`,
      ));
    });
  }

  send(message: string): Promise<void> {
    if (this.#closed || this.#child.stdin.destroyed) {
      return Promise.reject(new Error("Codex hook status probe is closed"));
    }
    return new Promise<void>((resolveSend, rejectSend) => {
      this.#child.stdin.write(`${message}\n`, "utf8", (error) => {
        if (error) rejectSend(error);
        else resolveSend();
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
    }
  }

  onMessage(listener: (message: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  #onData(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
      this.#finish(new Error("Codex hook status response exceeded 8 MiB"));
      this.#child.kill("SIGTERM");
      return;
    }
    while (true) {
      const lineEnd = this.#buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const line = this.#buffer.slice(0, lineEnd).trim();
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      if (!line) continue;
      for (const listener of this.#messageListeners) listener(line);
    }
  }

  #finish(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener(error);
  }
}

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Codex hook ${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredText(value: JsonObject, field: string, max = MAX_TEXT): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > max) {
    throw new Error(`Codex hook ${field} must be a bounded non-empty string`);
  }
  return candidate;
}

function optionalText(value: JsonObject, field: string, max = MAX_TEXT): string | null {
  const candidate = value[field];
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate !== "string" || candidate.length > max) {
    throw new Error(`Codex hook ${field} must be a bounded string or null`);
  }
  return candidate;
}

export function parseCodexHookInput(raw: string | Buffer): CodexHookInput {
  const bytes = Buffer.isBuffer(raw) ? raw.byteLength : Buffer.byteLength(raw, "utf8");
  if (bytes === 0 || bytes > MAX_HOOK_INPUT_BYTES) {
    throw new Error("Codex hook input must be non-empty and at most 1 MiB");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.toString());
  } catch {
    throw new Error("Codex hook input must be valid JSON");
  }
  const value = record(decoded, "input");
  const event = requiredText(value, "hook_event_name", 64);
  if (!EVENT_SET.has(event)) throw new Error(`Unsupported Codex hook event: ${event}`);
  const transcriptPath = optionalText(value, "transcript_path", 32_768);
  const permissionMode = optionalText(value, "permission_mode", 128);
  const agentId = optionalText(value, "agent_id", 512);
  const agentType = optionalText(value, "agent_type", 512);
  const turnId = optionalText(value, "turn_id", 512);
  const toolName = optionalText(value, "tool_name", 512);
  const toolUseId = optionalText(value, "tool_use_id", 512);
  const hasToolInput = Object.hasOwn(value, "tool_input");
  const toolInput = value.tool_input ?? null;
  if (["PreToolUse", "PermissionRequest", "PostToolUse"].includes(event)) {
    if (!turnId || !toolName || !hasToolInput) {
      throw new Error(`Codex ${event} hook requires turn_id, tool_name, and tool_input`);
    }
  }
  if ((event === "PreToolUse" || event === "PostToolUse") && !toolUseId) {
    throw new Error(`Codex ${event} hook requires tool_use_id`);
  }
  if ((event === "SubagentStart" || event === "SubagentStop") && (!agentId || !agentType)) {
    throw new Error(`Codex ${event} hook requires agent_id and agent_type`);
  }
  return Object.freeze({
    sessionId: requiredText(value, "session_id", 512),
    transcriptPath,
    cwd: requiredText(value, "cwd", 32_768),
    event: event as CodexHookEvent,
    model: event === "SessionEnd"
      ? optionalText(value, "model", 512)
      : requiredText(value, "model", 512),
    permissionMode,
    agentId,
    agentType,
    turnId,
    toolName,
    toolUseId,
    toolInput,
    raw: structuredClone(value),
  });
}

export function codexNoDecisionHookOutput(): JsonObject {
  return {};
}

export function evaluateCodexHookStatus(
  response: unknown,
  expectedCommand: string,
  requiredEvents: readonly CodexHookEvent[] = CODEX_HOOK_EVENTS,
): CodexHookStatus {
  const root = record(response, "hooks/list response");
  if (!Array.isArray(root.data)) throw new Error("Codex hooks/list response data must be an array");
  const matches: JsonObject[] = [];
  const errors: string[] = [];
  for (const rawEntry of root.data) {
    const entry = record(rawEntry, "hooks/list entry");
    if (Array.isArray(entry.errors)) {
      for (const rawError of entry.errors) {
        const error = record(rawError, "hook error");
        if (typeof error.message === "string") errors.push(error.message);
      }
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const rawHook of entry.hooks) {
      const hook = record(rawHook, "hook metadata");
      if (hook.command === expectedCommand) matches.push(hook);
    }
  }
  if (errors.length > 0) {
    return { state: "invalid", reason: errors.join("; ").slice(0, 1_000), installedEvents: [] };
  }
  if (matches.length === 0) {
    return { state: "absent", reason: "Codex command hooks are not installed", installedEvents: [] };
  }
  if (matches.some((hook) => hook.handlerType !== "command")) {
    return { state: "invalid", reason: "Only Codex command hooks are executable", installedEvents: [] };
  }
  const installedEvents = [...new Set(matches.flatMap((hook) =>
    typeof hook.eventName === "string"
      ? EVENT_SET.has(hook.eventName)
        ? [hook.eventName as CodexHookEvent]
        : RPC_EVENT_TO_HOOK_EVENT.has(hook.eventName)
          ? [RPC_EVENT_TO_HOOK_EVENT.get(hook.eventName)!]
          : []
      : []
  ))];
  const missing = requiredEvents.filter((event) => !installedEvents.includes(event));
  if (missing.length > 0) {
    return {
      state: "invalid",
      reason: `Codex hook installation is missing: ${missing.join(", ")}`,
      installedEvents,
    };
  }
  if (matches.some((hook) => hook.enabled !== true)) {
    return { state: "disabled", reason: "Codex command hooks are disabled", installedEvents };
  }
  if (matches.some((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified")) {
    return {
      state: "awaiting-trust",
      reason: "Open /hooks in Codex and trust the current command hook definition",
      installedEvents,
    };
  }
  if (matches.some((hook) => hook.trustStatus !== "trusted" && hook.trustStatus !== "managed")) {
    return { state: "invalid", reason: "Codex returned an unknown hook trust state", installedEvents };
  }
  return { state: "trusted", reason: "Codex command hooks are installed and trusted", installedEvents };
}

export async function readCodexHookStatus(
  rpc: CodexRpcClient,
  cwds: readonly string[],
  expectedCommand: string,
  requiredEvents?: readonly CodexHookEvent[],
): Promise<CodexHookStatus> {
  const result = await rpc.request("hooks/list", { cwds: [...cwds] });
  return evaluateCodexHookStatus(result, expectedCommand, requiredEvents);
}

/**
 * Read hook enable/trust state from a disposable stdio App Server. This does
 * not connect to, start, stop, or mutate the user's shared daemon.
 */
export async function probeCodexHookStatus(options: {
  codexExecutable: string;
  cwds: readonly string[];
  expectedCommand: string;
  timeoutMs?: number;
  /** Optional isolated environment for a disposable CODEX_HOME probe. */
  environment?: NodeJS.ProcessEnv;
  connect?: () => MessageTransport | Promise<MessageTransport>;
}): Promise<CodexHookStatus> {
  if (!options.codexExecutable || /[\r\n]/u.test(options.codexExecutable)) {
    throw new Error("Codex hook status executable must be a bounded path");
  }
  if (!options.connect && !isAbsolute(options.codexExecutable)) {
    throw new Error("Codex hook status executable must be absolute");
  }
  if (
    options.cwds.length === 0
    || options.cwds.length > 32
    || options.cwds.some((cwd) => !isAbsolute(cwd) || /[\r\n]/u.test(cwd))
  ) {
    throw new Error("Codex hook status requires 1-32 absolute working directories");
  }
  if (!options.expectedCommand || options.expectedCommand.length > 32_768) {
    throw new Error("Codex hook status expected command is invalid");
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error("Codex hook status timeout must be 250-30000 milliseconds");
  }
  const transport = options.connect
    ? await options.connect()
    : new CodexHookProbeTransport(options.codexExecutable, options.environment);
  const rpc = new CodexRpcClient(transport, timeoutMs);
  try {
    await rpc.request("initialize", {
      clientInfo: {
        name: "agent-manager-hook-status",
        version: "0.3.1",
        title: "Agent Manager hook status",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    await rpc.notify("initialized");
    return await readCodexHookStatus(
      rpc,
      options.cwds,
      options.expectedCommand,
    );
  } finally {
    await rpc.close().catch(() => undefined);
  }
}
