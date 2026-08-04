import type {
  Diagnostic,
  SessionRecord,
} from "../shared/session.ts";
import { WIRE_SCHEMA_VERSION } from "../shared/wire.ts";

export * from "../shared/session.ts";

export interface ListingResult {
  schemaVersion: typeof WIRE_SCHEMA_VERSION;
  generatedAt: string;
  recentWindowSeconds: number;
  sessions: SessionRecord[];
  diagnostics: Diagnostic[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error: Error | null;
}

export interface Runtime {
  now(): number;
  homeDir: string;
  env: Record<string, string | undefined>;
  run(command: string, args: string[], timeoutMs?: number): CommandResult;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  startedAtMs: number | null;
  tty: string;
  state: string;
  command: string;
  executable: string;
}

export interface AdapterResult {
  sessions: SessionRecord[];
  diagnostics: Diagnostic[];
  succeeded: boolean;
}
