import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
} from "./types.ts";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const execFileAsync = promisify(execFile);
const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 5_000;

interface ClaudeSdkModule {
  query(params: ClaudeSdkQueryParams): ClaudeSdkQuery;
}

async function readClaudeCodeVersion(executable: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(executable, ["--version"], {
      encoding: "utf8",
      timeout: CLAUDE_VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1_024,
    }));
  } catch (error) {
    throw new Error(`Could not verify Claude Code executable ${executable}`, {
      cause: error,
    });
  }
  const version = /^([0-9]+\.[0-9]+\.[0-9]+)\b/u.exec(stdout.trim())?.[1];
  if (!version) {
    throw new Error(`Claude Code executable returned an unrecognized version: ${stdout.trim()}`);
  }
  if (version !== CLAUDE_CODE_VERSION) {
    throw new Error(`Unsupported Claude Code ${version}; expected ${CLAUDE_CODE_VERSION}`);
  }
  return version;
}

/**
 * Loads the pinned SDK lazily. Importing the discovery or HTTP layers does not
 * start Claude and does not even require the optional native SDK package to be
 * loaded. `package.json` must pin this to exactly 0.3.220.
 */
export async function loadClaudeSdkRuntime(options: {
  claudeCodeExecutable?: string;
} = {}): Promise<ClaudeSdkRuntime> {
  const claudeCodeVersion = options.claudeCodeExecutable
    ? await readClaudeCodeVersion(options.claudeCodeExecutable)
    : null;
  const sdk = (await import(SDK_PACKAGE)) as unknown as ClaudeSdkModule;
  if (typeof sdk.query !== "function") {
    throw new Error(`${SDK_PACKAGE} does not export query()`);
  }

  return {
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    claudeCodeVersion,
    ...(options.claudeCodeExecutable
      ? { claudeCodeExecutable: options.claudeCodeExecutable }
      : {}),
    createQuery: (params) => sdk.query(params),
    randomUUID,
    now: () => new Date(),
  };
}
