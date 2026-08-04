import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  digestCodexHookToken,
  generateCodexHookToken,
  type CodexHookAuthorizationRecord,
} from "../providers/codex/codex-hook-auth.ts";
import type { CodexHookStatus } from "../providers/codex/codex-hook.ts";
import {
  assertCodexHookEndpoint,
  renderCodexHookCommand,
  renderCodexHookShim,
} from "../providers/codex/codex-hook-shim.ts";
import {
  addCodexHookCommand,
  codexHookSettingsDiff,
  containsAgentManagerCodexShim,
  inspectCodexHookCommand,
  removeCodexHookCommand,
  type CodexHookConfigurationStatus,
} from "./codex-hooks-config.ts";

export const CODEX_HOOK_INSTALL_SCHEMA_VERSION = 1 as const;

export interface CodexHookInstallRecord extends CodexHookAuthorizationRecord {
  schemaVersion: typeof CODEX_HOOK_INSTALL_SCHEMA_VERSION;
  endpoint: string;
  command: string;
  shimDigest: string;
}

export type CodexHookScope = "user" | "project";
export type CodexHookOperation = "status" | "install" | "uninstall";
export type CodexHookOperationalState =
  | "absent"
  | "installed-unseen"
  | "active"
  | "stale-token-schema"
  | "awaiting-trust"
  | "untrusted"
  | "provider-disabled";

export interface CodexHookSource {
  settingsPath: string;
  settingsText: string;
  settingsExisted: boolean;
  shimPath: string;
  shimText: string | null;
}

export interface CodexHookOperationalStatus {
  state: CodexHookOperationalState;
  settingsPath: string;
  shimPath: string;
  configuration: CodexHookConfigurationStatus | null;
  trust: CodexHookStatus | null;
  lastSeenAt: string | null;
}

export interface CodexHookPlan {
  provider: "codex";
  action: "install" | "uninstall";
  settingsPath: string;
  before: string;
  after: string;
  beforeExisted: boolean;
  shimPath: string;
  shimBefore: string | null;
  /** Contains the generated bearer token and must never be printed. */
  secretShimAfter: string | null;
  changed: boolean;
  diff: string;
  shimNotice: string;
  record: CodexHookInstallRecord;
}

interface CodexHookOperationInputBase {
  scope: CodexHookScope;
  homeDirectory: string;
  projectDirectory?: string;
}

export type CodexHookOperationInput =
  | (CodexHookOperationInputBase & { operation: "status" })
  | (CodexHookOperationInputBase & { operation: "uninstall" })
  | (CodexHookOperationInputBase & { operation: "install"; endpoint: string });

export interface CodexHookOperationDependencies {
  loadRecord(settingsPath: string): CodexHookInstallRecord | null | Promise<CodexHookInstallRecord | null>;
  saveRecord(record: CodexHookInstallRecord): void | Promise<void>;
  removeRecord(recordId: string): void | Promise<void>;
  trustStatus?(settingsPath: string, expectedCommand: string): CodexHookStatus | null | Promise<CodexHookStatus | null>;
  lastSeenAt?(recordId: string): string | null | Promise<string | null>;
  showPreview?(plan: CodexHookPlan): void | Promise<void>;
  confirm?(plan: CodexHookPlan): boolean | Promise<boolean>;
  generateBearerToken?: () => string;
  randomUUID?: () => string;
  now?: () => Date;
  nodeExecutable?: string;
}

export type CodexHookOperationResult =
  | { operation: "status"; outcome: "inspected"; status: CodexHookOperationalStatus; plan: null }
  | {
      operation: "install" | "uninstall";
      outcome: "applied" | "unchanged" | "cancelled";
      status: CodexHookOperationalStatus;
      plan: CodexHookPlan | null;
    };

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function absoluteDirectory(value: string, label: string): string {
  const path = resolve(value);
  if (!isAbsolute(value) || path !== value) throw new Error(`${label} must be an absolute normalized path`);
  return path;
}

export function resolveCodexHookPaths(input: {
  scope: CodexHookScope;
  homeDirectory: string;
  projectDirectory?: string;
}): { settingsPath: string; shimPath: string } {
  const home = absoluteDirectory(input.homeDirectory, "Codex hook home directory");
  const dataDirectory = join(home, "Library", "Application Support", "agent-manager", "hooks");
  if (input.scope === "user") {
    return {
      settingsPath: join(home, ".codex", "hooks.json"),
      shimPath: join(dataDirectory, "codex-user-hook.mjs"),
    };
  }
  if (!input.projectDirectory) throw new Error("Project-local Codex hooks require a project directory");
  const project = absoluteDirectory(input.projectDirectory, "Codex hook project directory");
  const suffix = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return {
    settingsPath: join(project, ".codex", "hooks.json"),
    shimPath: join(dataDirectory, `codex-project-${suffix}-hook.mjs`),
  };
}

async function readRegular(path: string): Promise<{ text: string; mode: number } | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${path} must be a regular non-symlink file`);
    }
    return { text: await readFile(path, "utf8"), mode: stats.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readCodexHookSource(input: {
  scope: CodexHookScope;
  homeDirectory: string;
  projectDirectory?: string;
}): Promise<CodexHookSource> {
  const paths = resolveCodexHookPaths(input);
  const settings = await readRegular(paths.settingsPath);
  const shim = await readRegular(paths.shimPath);
  return {
    ...paths,
    settingsText: settings?.text ?? "",
    settingsExisted: settings !== null,
    shimText: shim?.text ?? null,
  };
}

export function inspectCodexHookOperationalStatus(input: {
  source: CodexHookSource;
  record: CodexHookInstallRecord | null;
  trust?: CodexHookStatus | null;
  lastSeenAt?: string | null;
}): CodexHookOperationalStatus {
  const base = {
    settingsPath: input.source.settingsPath,
    shimPath: input.source.shimPath,
    trust: input.trust ?? null,
    lastSeenAt: input.lastSeenAt ?? null,
  };
  if (input.trust?.state === "disabled") {
    return { ...base, state: "provider-disabled", configuration: null };
  }
  if (!input.record) {
    return {
      ...base,
      state: containsAgentManagerCodexShim(input.source.settingsText) ? "untrusted" : "absent",
      configuration: null,
    };
  }
  const record = input.record;
  if (record.schemaVersion !== CODEX_HOOK_INSTALL_SCHEMA_VERSION ||
      record.settingsPath !== input.source.settingsPath || record.shimPath !== input.source.shimPath ||
      input.source.shimText === null || digest(input.source.shimText) !== record.shimDigest) {
    return { ...base, state: "stale-token-schema", configuration: null };
  }
  const configuration = inspectCodexHookCommand(input.source.settingsText, record.command);
  if (configuration.state === "missing") return { ...base, state: "absent", configuration };
  if (configuration.state !== "current") return { ...base, state: "stale-token-schema", configuration };
  if (!input.trust || input.trust.state === "awaiting-trust") {
    return { ...base, state: "awaiting-trust", configuration };
  }
  if (input.trust.state !== "trusted") {
    return { ...base, state: "untrusted", configuration };
  }
  const seen = Date.parse(input.lastSeenAt ?? "");
  const installed = Date.parse(record.createdAt);
  if (Number.isFinite(seen) && Number.isFinite(installed) && seen >= installed) {
    return { ...base, state: "active", configuration };
  }
  return {
    ...base,
    state: "installed-unseen",
    configuration,
  };
}

export function previewCodexHookInstall(input: {
  source: CodexHookSource;
  endpoint: string;
  bearerToken: string;
  installId: string;
  nodeExecutable: string;
  previousRecord?: CodexHookInstallRecord;
  now?: Date;
}): CodexHookPlan {
  const endpoint = assertCodexHookEndpoint(input.endpoint);
  digestCodexHookToken(input.bearerToken);
  if (input.previousRecord && (
    input.previousRecord.provider !== "codex" ||
    input.previousRecord.schemaVersion !== CODEX_HOOK_INSTALL_SCHEMA_VERSION ||
    input.previousRecord.settingsPath !== input.source.settingsPath ||
    input.previousRecord.shimPath !== input.source.shimPath ||
    input.previousRecord.command !== renderCodexHookCommand(input.source.shimPath)
  )) {
    throw new Error("Codex hook install record is stale or targets another scope");
  }
  const command = renderCodexHookCommand(input.source.shimPath);
  // The deterministic shim path is owned by Agent Manager. Remove any orphaned
  // copy first so a database failure after file replacement can be retried
  // without duplicating all event handlers.
  const withoutPrevious = removeCodexHookCommand(
    input.source.settingsText.trim() ? input.source.settingsText : "{}\n",
    command,
  );
  const after = addCodexHookCommand(withoutPrevious, command);
  const secretShimAfter = renderCodexHookShim({
    endpoint,
    bearerToken: input.bearerToken,
    nodeExecutable: input.nodeExecutable,
  });
  const record: CodexHookInstallRecord = {
    id: input.installId,
    provider: "codex",
    schemaVersion: CODEX_HOOK_INSTALL_SCHEMA_VERSION,
    tokenDigest: digestCodexHookToken(input.bearerToken),
    createdAt: (input.now ?? new Date()).toISOString(),
    settingsPath: input.source.settingsPath,
    shimPath: input.source.shimPath,
    endpoint,
    command,
    shimDigest: digest(secretShimAfter),
  };
  return {
    provider: "codex",
    action: "install",
    settingsPath: input.source.settingsPath,
    before: input.source.settingsText,
    after,
    beforeExisted: input.source.settingsExisted,
    shimPath: input.source.shimPath,
    shimBefore: input.source.shimText,
    secretShimAfter,
    changed: input.source.settingsText !== after || input.source.shimText !== secretShimAfter,
    diff: codexHookSettingsDiff(input.source.settingsPath, input.source.settingsText, after),
    shimNotice: `Create or replace ${input.source.shimPath} (mode 0700; bearer token redacted)`,
    record,
  };
}

export function previewCodexHookUninstall(input: {
  source: CodexHookSource;
  record: CodexHookInstallRecord;
}): CodexHookPlan {
  if (input.record.provider !== "codex" ||
      input.record.schemaVersion !== CODEX_HOOK_INSTALL_SCHEMA_VERSION ||
      input.record.settingsPath !== input.source.settingsPath ||
      input.record.shimPath !== input.source.shimPath ||
    input.record.command !== renderCodexHookCommand(input.source.shimPath)) {
    throw new Error("Codex hook install record targets another scope");
  }
  if (input.source.shimText !== null && digest(input.source.shimText) !== input.record.shimDigest) {
    throw new Error("Codex hook shim was modified; refusing to delete it");
  }
  const after = removeCodexHookCommand(input.source.settingsText, input.record.command);
  return {
    provider: "codex",
    action: "uninstall",
    settingsPath: input.source.settingsPath,
    before: input.source.settingsText,
    after,
    beforeExisted: input.source.settingsExisted,
    shimPath: input.source.shimPath,
    shimBefore: input.source.shimText,
    secretShimAfter: null,
    changed: input.source.settingsText !== after || input.source.shimText !== null,
    diff: codexHookSettingsDiff(input.source.settingsPath, input.source.settingsText, after),
    shimNotice: `Remove ${input.source.shimPath}`,
    record: structuredClone(input.record),
  };
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`Codex hook parent ${dirname(path)} must be a non-symlink directory`);
  }
  const temporary = join(dirname(path), `.${basename(path)}.agent-manager-${process.pid}-${Date.now()}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function applyCodexHookPlan(
  plan: CodexHookPlan,
  options: { confirmed: boolean },
): Promise<void> {
  if (!options.confirmed) throw new Error("Codex hook settings change requires explicit confirmation");
  if (!plan.changed) return;
  const settings = await readRegular(plan.settingsPath);
  const shim = await readRegular(plan.shimPath);
  if ((settings?.text ?? "") !== plan.before || (shim?.text ?? null) !== plan.shimBefore) {
    throw new Error("Codex hook files changed after preview; generate a new diff");
  }
  if (plan.action === "install") {
    if (plan.secretShimAfter === null) throw new Error("Codex install plan has no shim");
    await atomicWrite(plan.shimPath, plan.secretShimAfter, 0o700);
    await atomicWrite(plan.settingsPath, plan.after, settings?.mode ?? 0o600);
    return;
  }
  await atomicWrite(plan.settingsPath, plan.after, settings?.mode ?? 0o600);
  if (shim) await unlink(plan.shimPath);
}

async function statusFor(
  source: CodexHookSource,
  record: CodexHookInstallRecord | null,
  dependencies: CodexHookOperationDependencies,
): Promise<CodexHookOperationalStatus> {
  const trust = dependencies.trustStatus
    ? await dependencies.trustStatus(
        source.settingsPath,
        record?.command ?? renderCodexHookCommand(source.shimPath),
      )
    : null;
  const lastSeenAt = record && dependencies.lastSeenAt
    ? await dependencies.lastSeenAt(record.id)
    : null;
  return inspectCodexHookOperationalStatus({ source, record, trust, lastSeenAt });
}

export async function runCodexHookOperation(
  input: CodexHookOperationInput,
  dependencies: CodexHookOperationDependencies,
): Promise<CodexHookOperationResult> {
  const source = await readCodexHookSource(input);
  const record = await dependencies.loadRecord(source.settingsPath);
  if (input.operation === "status") {
    return {
      operation: "status",
      outcome: "inspected",
      status: await statusFor(source, record, dependencies),
      plan: null,
    };
  }
  if (input.operation === "uninstall") {
    if (!record) {
      return {
        operation: "uninstall",
        outcome: "unchanged",
        status: await statusFor(source, null, dependencies),
        plan: null,
      };
    }
    const plan = previewCodexHookUninstall({ source, record });
    if (!plan.changed) {
      await dependencies.removeRecord(record.id);
      return { operation: "uninstall", outcome: "unchanged", status: await statusFor(source, null, dependencies), plan };
    }
    if (!dependencies.showPreview || !dependencies.confirm) {
      throw new Error("Codex hook uninstall requires exact diff preview and terminal confirmation handlers");
    }
    await dependencies.showPreview(plan);
    if (!await dependencies.confirm(plan)) {
      return { operation: "uninstall", outcome: "cancelled", status: await statusFor(source, record, dependencies), plan };
    }
    await applyCodexHookPlan(plan, { confirmed: true });
    await dependencies.removeRecord(record.id);
    const after = { ...source, settingsText: plan.after, shimText: null };
    return { operation: "uninstall", outcome: "applied", status: await statusFor(after, null, dependencies), plan };
  }

  if (record && record.provider === "codex" &&
      record.schemaVersion === CODEX_HOOK_INSTALL_SCHEMA_VERSION &&
      record.settingsPath === source.settingsPath && record.shimPath === source.shimPath &&
      record.command === renderCodexHookCommand(source.shimPath) &&
      record.endpoint === assertCodexHookEndpoint(input.endpoint) &&
      inspectCodexHookCommand(source.settingsText, record.command).state === "current" &&
      source.shimText !== null && digest(source.shimText) === record.shimDigest) {
    return { operation: "install", outcome: "unchanged", status: await statusFor(source, record, dependencies), plan: null };
  }
  const bearerToken = (dependencies.generateBearerToken ?? generateCodexHookToken)();
  const plan = previewCodexHookInstall({
    source,
    endpoint: input.endpoint,
    bearerToken,
    installId: record?.id ?? (dependencies.randomUUID ?? randomUUID)(),
    nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
    ...(record ? { previousRecord: record } : {}),
    now: (dependencies.now ?? (() => new Date()))(),
  });
  if (!dependencies.showPreview || !dependencies.confirm) {
    throw new Error("Codex hook install requires exact diff preview and terminal confirmation handlers");
  }
  await dependencies.showPreview(plan);
  if (!await dependencies.confirm(plan)) {
    return { operation: "install", outcome: "cancelled", status: await statusFor(source, record, dependencies), plan };
  }
  await applyCodexHookPlan(plan, { confirmed: true });
  await dependencies.saveRecord(plan.record);
  const after = { ...source, settingsText: plan.after, settingsExisted: true, shimText: plan.secretShimAfter };
  return { operation: "install", outcome: "applied", status: await statusFor(after, plan.record, dependencies), plan };
}
