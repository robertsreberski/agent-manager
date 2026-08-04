import { randomUUID } from "node:crypto";

import { redactActivityText } from "../activity/redaction.ts";
import {
  inspectCodexHookOperationalStatus,
  previewCodexHookInstall,
  readCodexHookSource,
} from "../ops/codex-hooks.ts";
import {
  inspectClaudeHookOperationalStatus,
  previewClaudeHookInstall,
  readClaudeHookSettings,
  resolveClaudeHookSettingsPath,
} from "../ops/hooks.ts";
import { generateCodexHookToken } from "../providers/codex/codex-hook-auth.ts";
import type { CodexHookStatus } from "../providers/codex/codex-hook.ts";
import { renderCodexHookCommand } from "../providers/codex/codex-hook-shim.ts";
import { generateHookBearerToken } from "../providers/hooks/auth.ts";
import type { SetupHookOffer } from "../shared/setup.ts";
import type { ManagerDatabase } from "./persistence.ts";

export interface SetupHookManagerOptions {
  database: ManagerDatabase;
  homeDirectory: string;
  endpointOrigin: string;
  nodeExecutable?: string;
  now?: () => Date;
  codexTrustStatus?(
    settingsPath: string,
    expectedCommand: string,
  ): CodexHookStatus | null | Promise<CodexHookStatus | null>;
}

function installCommand(provider: "claude" | "codex"): string {
  return `agent-manager hooks install --provider ${provider} --scope user`;
}

function redactExactDiff(diff: string, secret: string): string {
  return redactActivityText(diff
    .replaceAll(secret, "[REDACTED]")
    .replace(/Bearer [^"\\\s]+/gu, "Bearer [REDACTED]"));
}

export class SetupHookManager {
  #database: ManagerDatabase;
  #homeDirectory: string;
  #endpointOrigin: string;
  #nodeExecutable: string;
  #now: () => Date;
  #codexTrustStatus: NonNullable<SetupHookManagerOptions["codexTrustStatus"]> | null;

  constructor(options: SetupHookManagerOptions) {
    this.#database = options.database;
    this.#homeDirectory = options.homeDirectory;
    this.#endpointOrigin = options.endpointOrigin.replace(/\/$/u, "");
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#now = options.now ?? (() => new Date());
    this.#codexTrustStatus = options.codexTrustStatus ?? null;
  }

  async offers(): Promise<{ claude: SetupHookOffer; codex: SetupHookOffer }> {
    const [claude, codex] = await Promise.all([
      this.#claudeOffer(),
      this.#codexOffer(),
    ]);
    return { claude, codex };
  }

  async #claudeOffer(): Promise<SetupHookOffer> {
    const settingsPath = resolveClaudeHookSettingsPath({ scope: "user", homeDirectory: this.#homeDirectory });
    const source = await readClaudeHookSettings(settingsPath);
    const record = this.#database.getClaudeHookInstallRecord(settingsPath);
    const status = inspectClaudeHookOperationalStatus({
      source,
      record,
      lastSeenAt: record?.lastSeenAt ?? null,
    });
    const current = record !== null
      && record.endpoint === `${this.#endpointOrigin}/api/v1/hooks/claude`
      && status.configuration?.state === "current";
    if (current) {
      return {
        provider: "claude",
        state: status.state,
        settingsPath,
        command: installCommand("claude"),
        changed: false,
        diff: "",
        notice: null,
      };
    }
    const token = generateHookBearerToken();
    const plan = previewClaudeHookInstall({
      ...source,
      endpoint: `${this.#endpointOrigin}/api/v1/hooks/claude`,
      bearerToken: token,
      installId: record?.id ?? randomUUID(),
      now: this.#now(),
      ...(record ? { previousRecord: record } : {}),
    });
    return {
      provider: "claude",
      state: status.state,
      settingsPath,
      command: installCommand("claude"),
      changed: plan.changed,
      diff: redactExactDiff(plan.diff, token),
      notice: null,
    };
  }

  async #codexOffer(): Promise<SetupHookOffer> {
    const source = await readCodexHookSource({ scope: "user", homeDirectory: this.#homeDirectory });
    const record = this.#database.getCodexHookInstallRecord(source.settingsPath);
    const expectedCommand = record?.command ?? renderCodexHookCommand(source.shimPath);
    let trust: CodexHookStatus | null = null;
    if (this.#codexTrustStatus) {
      try {
        trust = await this.#codexTrustStatus(source.settingsPath, expectedCommand);
      } catch {
        // Setup remains a read-only offer when the live provider probe is
        // unavailable. A configured hook stays conservatively untrusted.
      }
    }
    const status = inspectCodexHookOperationalStatus({
      source,
      record,
      trust,
      lastSeenAt: record?.lastSeenAt ?? null,
    });
    const current = record !== null
      && record.endpoint === `${this.#endpointOrigin}/api/v1/hooks/codex`
      && record.command === renderCodexHookCommand(source.shimPath)
      && status.configuration?.state === "current";
    if (current) {
      return {
        provider: "codex",
        state: status.state,
        settingsPath: source.settingsPath,
        command: installCommand("codex"),
        changed: false,
        diff: "",
        notice: status.state === "awaiting-trust"
          ? "Open /hooks in Codex and trust the exact Agent Manager command hook."
          : null,
      };
    }
    const token = generateCodexHookToken();
    const plan = previewCodexHookInstall({
      source,
      endpoint: `${this.#endpointOrigin}/api/v1/hooks/codex`,
      bearerToken: token,
      installId: record?.id ?? randomUUID(),
      nodeExecutable: this.#nodeExecutable,
      now: this.#now(),
      ...(record ? { previousRecord: record } : {}),
    });
    return {
      provider: "codex",
      state: status.state,
      settingsPath: source.settingsPath,
      command: installCommand("codex"),
      changed: plan.changed,
      diff: redactExactDiff(plan.diff, token),
      notice: plan.shimNotice,
    };
  }
}
