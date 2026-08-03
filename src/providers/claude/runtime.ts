import { randomUUID } from "node:crypto";

import {
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
} from "./types.ts";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

interface ClaudeSdkModule {
  query(params: ClaudeSdkQueryParams): ClaudeSdkQuery;
}

/**
 * Loads the pinned SDK lazily. Importing the discovery or HTTP layers does not
 * start Claude and does not even require the optional native SDK package to be
 * loaded. `package.json` must pin this to exactly 0.3.220.
 */
export async function loadClaudeSdkRuntime(): Promise<ClaudeSdkRuntime> {
  const sdk = (await import(SDK_PACKAGE)) as unknown as ClaudeSdkModule;
  if (typeof sdk.query !== "function") {
    throw new Error(`${SDK_PACKAGE} does not export query()`);
  }

  return {
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    createQuery: (params) => sdk.query(params),
    randomUUID,
    now: () => new Date(),
  };
}
