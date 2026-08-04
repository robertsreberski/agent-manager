import { parentPort } from "node:worker_threads";

import { scanObservedSessions } from "../core/discovery.ts";
import type {
  DiscoveryScanFailure,
  DiscoveryScanRequest,
  DiscoveryScanResult,
} from "./protocol.ts";

if (!parentPort) {
  throw new Error("The discovery worker must run in a worker thread");
}

parentPort.on("message", (request: DiscoveryScanRequest) => {
  if (
    request.type !== "scan"
    || !Number.isSafeInteger(request.id)
    || !Number.isFinite(request.recentWindowSeconds)
    || request.recentWindowSeconds < 0
  ) {
    return;
  }

  try {
    const listing = scanObservedSessions({
      recentWindowSeconds: request.recentWindowSeconds,
      providers: new Set(["codex", "claude"]),
    });
    const response: DiscoveryScanResult = {
      type: "result",
      id: request.id,
      generatedAt: listing.generatedAt,
      sessions: listing.sessions,
      diagnostics: listing.diagnostics,
    };
    parentPort?.postMessage(response);
  } catch (error) {
    const response: DiscoveryScanFailure = {
      type: "error",
      id: request.id,
      generatedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
    parentPort?.postMessage(response);
  }
});
