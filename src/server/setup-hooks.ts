import { createHash, randomUUID } from "node:crypto";

import { redactActivityText } from "../activity/redaction.ts";
import {
  applyClaudeHookSettingsPlan,
  inspectClaudeHookOperationalStatus,
  previewClaudeHookInstall,
  readClaudeHookSettings,
  resolveClaudeHookSettingsPath,
  type ClaudeHookInstallRecord,
  type ClaudeHookSettingsPlan,
  type ClaudeHookSettingsSource,
} from "../ops/hooks.ts";
import { generateHookBearerToken } from "../providers/hooks/auth.ts";
import type {
  SetupHookApplyResponse,
  SetupHookOffer,
} from "../shared/setup.ts";
import type { ManagerDatabase } from "./persistence.ts";

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEW_TTL_MS = 5 * 60_000;
const APPLIED_RECEIPT_TTL_MS = 60_000;

type HookProvider = "claude";
type HookPlan = ClaudeHookSettingsPlan;
type HookInstallRecord = ClaudeHookInstallRecord & {
  lastSeenAt?: string | null;
};

interface HookPreviewEntry {
  kind: "preview" | "applying";
  provider: HookProvider;
  ownerId: string;
  previewId: string;
  expiresAtMs: number;
  plan: HookPlan;
  previousRecordFingerprint: string | null;
}

interface HookAppliedReceipt {
  kind: "applied";
  provider: HookProvider;
  ownerId: string;
  previewId: string;
  expiresAtMs: number;
  settingsPath: string;
  settingsDigest: string;
  shimPath: string | null;
  shimDigest: string | null;
  recordFingerprint: string;
  authorizationsReloaded: boolean;
}

type HookPreviewState = HookPreviewEntry | HookAppliedReceipt;

export type SetupHookApplyErrorCode =
  | "confirmation-required"
  | "expired"
  | "mismatch"
  | "not-found"
  | "stale";

export class SetupHookApplyError extends Error {
  readonly code: SetupHookApplyErrorCode;

  constructor(
    code: SetupHookApplyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SetupHookApplyError";
    this.code = code;
  }
}

export interface SetupHookManagerOptions {
  database: ManagerDatabase;
  homeDirectory: string;
  endpointOrigin: string;
  nodeExecutable?: string;
  now?: () => Date;
  previewTtlMs?: number;
  onApplied?(): void | Promise<void>;
}

function installCommand(provider: HookProvider): string {
  return `agent-manager hooks install --provider ${provider} --scope user`;
}

function redactExactDiff(diff: string, secret: string): string {
  return redactActivityText(diff
    .replaceAll(secret, "[REDACTED]")
    .replace(/Bearer [^"\\\s]+/gu, "Bearer [REDACTED]"));
}

function contentDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function recordFingerprint(record: HookInstallRecord | null): string | null {
  if (record === null) return null;
  const { lastSeenAt: _lastSeenAt, ...identity } = record;
  return JSON.stringify(identity);
}

function unchangedOffer(input: {
  provider: HookProvider;
  state: SetupHookOffer["state"];
  settingsPath: string;
  notice: string | null;
}): SetupHookOffer {
  return {
    ...input,
    command: installCommand(input.provider),
    changed: false,
    diff: "",
    previewId: null,
    expiresAt: null,
  };
}

export class SetupHookManager {
  #database: ManagerDatabase;
  #homeDirectory: string;
  #endpointOrigin: string;
  #nodeExecutable: string;
  #now: () => Date;
  #previewTtlMs: number;
  #onApplied: NonNullable<SetupHookManagerOptions["onApplied"]>;
  #previews = new Map<HookProvider, HookPreviewState>();
  #expiryTimers = new Map<HookProvider, NodeJS.Timeout>();
  #operations = new Map<HookProvider, Promise<void>>();

  constructor(options: SetupHookManagerOptions) {
    this.#database = options.database;
    this.#homeDirectory = options.homeDirectory;
    this.#endpointOrigin = options.endpointOrigin.replace(/\/$/u, "");
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#now = options.now ?? (() => new Date());
    this.#previewTtlMs = Math.min(
      MAX_PREVIEW_TTL_MS,
      Math.max(1, options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS),
    );
    this.#onApplied = options.onApplied ?? (() => undefined);
  }

  async offers(ownerId: string): Promise<{ claude: SetupHookOffer }> {
    return { claude: await this.#serialized("claude", () => this.#claudeOffer(ownerId)) };
  }

  async apply(input: {
    ownerId: string;
    provider: HookProvider;
    previewId: string;
    confirmed: boolean;
  }): Promise<SetupHookApplyResponse> {
    if (!input.confirmed) {
      throw new SetupHookApplyError(
        "confirmation-required",
        "hook installation requires explicit confirmation",
      );
    }
    return this.#serialized(input.provider, () => this.#applyLocked(input));
  }

  clear(): void {
    for (const timer of this.#expiryTimers.values()) clearTimeout(timer);
    this.#expiryTimers.clear();
    this.#previews.clear();
  }

  #discard(provider: HookProvider): void {
    const timer = this.#expiryTimers.get(provider);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(provider);
    this.#previews.delete(provider);
  }

  #storeNewPreview(entry: HookPreviewEntry): void {
    this.#discard(entry.provider);
    this.#previews.set(entry.provider, entry);
    this.#scheduleExpiry(entry.provider, entry.previewId, entry.expiresAtMs);
  }

  #scheduleExpiry(provider: HookProvider, previewId: string, expiresAtMs: number): void {
    const previous = this.#expiryTimers.get(provider);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.#previews.get(provider)?.previewId === previewId) {
        this.#previews.delete(provider);
      }
      this.#expiryTimers.delete(provider);
    }, Math.max(1, expiresAtMs - this.#nowMs()));
    timer.unref();
    this.#expiryTimers.set(provider, timer);
  }

  async #serialized<T>(provider: HookProvider, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(provider) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#operations.set(provider, tail);
    try {
      return await result;
    } finally {
      if (this.#operations.get(provider) === tail) this.#operations.delete(provider);
    }
  }

  #nowMs(): number {
    const value = this.#now().getTime();
    if (!Number.isFinite(value)) throw new Error("setup hook clock returned an invalid date");
    return value;
  }

  #newPreview(
    provider: HookProvider,
    ownerId: string,
    plan: HookPlan,
    previousRecord: HookInstallRecord | null,
  ): HookPreviewEntry {
    const entry: HookPreviewEntry = {
      kind: "preview",
      provider,
      ownerId,
      previewId: randomUUID(),
      expiresAtMs: this.#nowMs() + this.#previewTtlMs,
      plan,
      previousRecordFingerprint: recordFingerprint(previousRecord),
    };
    this.#storeNewPreview(entry);
    return entry;
  }

  #previewOffer(
    input: Omit<SetupHookOffer, "previewId" | "expiresAt">,
    entry: HookPreviewEntry,
  ): SetupHookOffer {
    return {
      ...input,
      previewId: entry.previewId,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
    };
  }

  #usablePreview(
    provider: HookProvider,
    ownerId: string,
    previousRecord: HookInstallRecord | null,
    source: ClaudeHookSettingsSource,
  ): HookPreviewEntry | null {
    const entry = this.#previews.get(provider);
    if (!entry || entry.kind !== "preview") return null;
    if (entry.expiresAtMs <= this.#nowMs()) {
      this.#discard(provider);
      return null;
    }
    if (
      entry.ownerId !== ownerId
      || entry.previousRecordFingerprint !== recordFingerprint(previousRecord)
      || !this.#sourceMatchesPlan(source, entry.plan, "before")
    ) {
      this.#discard(provider);
      return null;
    }
    return entry;
  }

  #sourceMatchesPlan(
    source: ClaudeHookSettingsSource,
    plan: HookPlan,
    side: "before" | "after",
  ): boolean {
    return source.settingsPath === plan.settingsPath
      && source.settingsText === plan[side]
      && (side === "after" || source.settingsExisted === plan.beforeExisted);
  }

  async #claudeOffer(ownerId: string): Promise<SetupHookOffer> {
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
      return unchangedOffer({
        provider: "claude",
        state: status.state,
        settingsPath,
        notice: null,
      });
    }

    let entry = this.#usablePreview("claude", ownerId, record, source);
    if (!entry) {
      const token = generateHookBearerToken();
      const plan = previewClaudeHookInstall({
        ...source,
        endpoint: `${this.#endpointOrigin}/api/v1/hooks/claude`,
        bearerToken: token,
        installId: record?.id ?? randomUUID(),
        now: this.#now(),
        ...(record ? { previousRecord: record } : {}),
      });
      entry = this.#newPreview("claude", ownerId, plan, record);
    }
    const plan = entry.plan as ClaudeHookSettingsPlan;
    return this.#previewOffer({
      provider: "claude",
      state: status.state,
      settingsPath,
      command: installCommand("claude"),
      changed: plan.changed,
      diff: redactExactDiff(plan.diff, this.#claudePlanSecret(plan) ?? "__no_hook_secret__"),
      notice: null,
    }, entry);
  }

  #claudePlanSecret(plan: ClaudeHookSettingsPlan): string | null {
    const match = /Bearer ([^"\\\s]+)/u.exec(plan.after);
    return match?.[1] ?? null;
  }

  #entryForApply(provider: HookProvider, ownerId: string, previewId: string): HookPreviewState {
    const entry = this.#previews.get(provider);
    if (!entry || entry.previewId !== previewId) {
      const other = [...this.#previews.values()].find((candidate) => candidate.previewId === previewId);
      throw new SetupHookApplyError(
        other ? "mismatch" : "not-found",
        other
          ? "hook preview belongs to another provider"
          : "hook preview is no longer available; refresh setup before retrying",
      );
    }
    if (entry.ownerId !== ownerId) {
      throw new SetupHookApplyError("mismatch", "hook preview belongs to another authenticated browser session");
    }
    if (entry.expiresAtMs <= this.#nowMs()) {
      this.#discard(provider);
      throw new SetupHookApplyError("expired", "hook preview expired; refresh setup before retrying");
    }
    return entry;
  }

  async #applyLocked(input: {
    ownerId: string;
    provider: HookProvider;
    previewId: string;
    confirmed: boolean;
  }): Promise<SetupHookApplyResponse> {
    const entry = this.#entryForApply(input.provider, input.ownerId, input.previewId);
    if (entry.kind === "applied") {
      if (!(await this.#appliedReceiptIsCurrent(entry))) {
        this.#discard(input.provider);
        throw new SetupHookApplyError("stale", "installed hook changed after apply; refresh setup before retrying");
      }
      if (!entry.authorizationsReloaded) {
        await this.#onApplied();
        this.#previews.set(input.provider, { ...entry, authorizationsReloaded: true });
      }
      return {
        provider: input.provider,
        outcome: "already-applied",
        hook: await this.#claudeOffer(input.ownerId),
      };
    }
    if (entry.kind === "applying") {
      throw new SetupHookApplyError("stale", "hook preview is already being applied");
    }

    const applying: HookPreviewEntry = { ...entry, kind: "applying" };
    const expiryTimer = this.#expiryTimers.get(input.provider);
    if (expiryTimer) clearTimeout(expiryTimer);
    this.#expiryTimers.delete(input.provider);
    this.#previews.set(input.provider, applying);
    let committed = false;
    try {
      if (!(await this.#previewIsCurrent(applying))) {
        throw new SetupHookApplyError("stale", "hook files or install identity changed after preview");
      }
      await applyClaudeHookSettingsPlan(applying.plan, { confirmed: true });
      this.#database.upsertClaudeHookInstallRecord(applying.plan.record);
      let receipt = this.#receiptFor(applying.plan, applying);
      this.#previews.set(input.provider, receipt);
      this.#scheduleExpiry(input.provider, receipt.previewId, receipt.expiresAtMs);
      committed = true;
      await this.#onApplied();
      receipt = { ...receipt, authorizationsReloaded: true };
      this.#previews.set(input.provider, receipt);
      const hook = await this.#claudeOffer(input.ownerId);
      return { provider: input.provider, outcome: "applied", hook };
    } catch (error) {
      if (!committed) this.#discard(input.provider);
      if (error instanceof SetupHookApplyError) throw error;
      if (error instanceof Error && /changed after preview|disappeared after preview/u.test(error.message)) {
        throw new SetupHookApplyError("stale", "hook files changed after preview; refresh setup before retrying");
      }
      throw error;
    }
  }

  async #previewIsCurrent(entry: HookPreviewEntry): Promise<boolean> {
    const plan = entry.plan;
    const record = this.#database.getClaudeHookInstallRecord(plan.settingsPath);
    const source = await readClaudeHookSettings(plan.settingsPath);
    return entry.previousRecordFingerprint === recordFingerprint(record)
      && this.#sourceMatchesPlan(source, plan, "before");
  }

  #receiptFor(plan: HookPlan, entry: HookPreviewEntry): HookAppliedReceipt {
    return {
      kind: "applied",
      provider: plan.provider,
      ownerId: entry.ownerId,
      previewId: entry.previewId,
      expiresAtMs: Math.max(entry.expiresAtMs, this.#nowMs() + APPLIED_RECEIPT_TTL_MS),
      settingsPath: plan.settingsPath,
      settingsDigest: contentDigest(plan.after),
      shimPath: null,
      shimDigest: null,
      recordFingerprint: recordFingerprint(plan.record)!,
      authorizationsReloaded: false,
    };
  }

  async #appliedReceiptIsCurrent(receipt: HookAppliedReceipt): Promise<boolean> {
    const record = this.#database.getClaudeHookInstallRecord(receipt.settingsPath);
    const source = await readClaudeHookSettings(receipt.settingsPath);
    return recordFingerprint(record) === receipt.recordFingerprint
      && contentDigest(source.settingsText) === receipt.settingsDigest;
  }
}
