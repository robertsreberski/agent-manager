import type { Diagnostic, SessionRecord } from "../core/types.ts";

export interface DiscoveryScanRequest {
  type: "scan";
  id: number;
  recentWindowSeconds: number;
}

export interface DiscoveryScanResult {
  type: "result";
  id: number;
  generatedAt: string;
  sessions: SessionRecord[];
  diagnostics: Diagnostic[];
}

export interface DiscoveryScanFailure {
  type: "error";
  id: number;
  generatedAt: string;
  message: string;
}

export type DiscoveryWorkerMessage = DiscoveryScanResult | DiscoveryScanFailure;

