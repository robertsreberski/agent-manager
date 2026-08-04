import { randomUUID } from "node:crypto";
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
import { basename, dirname, join, resolve } from "node:path";

import {
  digestHookBearerToken,
  generateHookBearerToken,
  type HookAuthorizationRecord,
} from "../providers/hooks/auth.ts";
import { CLAUDE_PERMISSION_PROVIDER_TIMEOUT_MS } from "../providers/hooks/claude-broker.ts";
import { CLAUDE_MANAGER_OWNER_ENV } from "../providers/hooks/claude-source.ts";
import { CLAUDE_HOOK_EVENTS } from "../providers/hooks/claude-types.ts";
import {
  insertArrayElement,
  insertObjectProperty,
  objectProperty,
  parseJsonc,
  removeArrayElement,
  removeObjectProperty,
  scalarString,
  type JsoncArray,
  type JsoncNode,
  type JsoncObject,
  type JsoncProperty,
} from "./hooks-jsonc.ts";

export const CLAUDE_HOOK_INSTALL_SCHEMA_VERSION = 1 as const;
export const CLAUDE_HOOK_INSTALL_HEADER = "X-Agent-Manager-Install";
export const CLAUDE_HOOK_OWNER_HEADER = "X-Agent-Manager-Owner";

export interface ClaudeHookInstallRecord extends HookAuthorizationRecord {
  schemaVersion: typeof CLAUDE_HOOK_INSTALL_SCHEMA_VERSION;
  endpoint: string;
  createdHooksProperty: boolean;
}

export interface ClaudeHookSettingsPlan {
  provider: "claude";
  action: "install" | "uninstall";
  settingsPath: string;
  before: string;
  after: string;
  beforeExisted: boolean;
  changed: boolean;
  diff: string;
  record: ClaudeHookInstallRecord;
}

export interface ClaudeHookInstallStatus {
  state: "current" | "missing" | "partial" | "stale";
  installedEvents: string[];
  missingEvents: string[];
  staleEvents: string[];
}

export type ClaudeHookScope = "user" | "project";

export interface ClaudeHookSettingsSource {
  settingsPath: string;
  settingsText: string;
  settingsExisted: boolean;
}

export type ClaudeHookOperationalState =
  | "absent"
  | "installed-unseen"
  | "active"
  | "stale-token-schema"
  | "untrusted"
  | "provider-disabled";

export interface ClaudeHookOperationalStatus {
  state: ClaudeHookOperationalState;
  settingsPath: string;
  configuration: ClaudeHookInstallStatus | null;
  lastSeenAt: string | null;
}

export type ClaudeHookOperation = "status" | "install" | "uninstall";

interface ClaudeHookOperationInputBase {
  scope: ClaudeHookScope;
  homeDirectory: string;
  projectDirectory?: string;
}

export type ClaudeHookOperationInput =
  | (ClaudeHookOperationInputBase & { operation: "status" })
  | (ClaudeHookOperationInputBase & { operation: "uninstall" })
  | (ClaudeHookOperationInputBase & { operation: "install"; endpoint: string });

export interface ClaudeHookOperationDependencies {
  loadRecord(settingsPath: string): ClaudeHookInstallRecord | null | Promise<ClaudeHookInstallRecord | null>;
  saveRecord(record: ClaudeHookInstallRecord): void | Promise<void>;
  removeRecord(recordId: string): void | Promise<void>;
  lastSeenAt?(recordId: string): string | null | Promise<string | null>;
  /** Print the exact redacted diff before consent is requested. */
  showPreview?(plan: ClaudeHookSettingsPlan): void | Promise<void>;
  /** Interactive terminal prompt, or an explicit CLI --yes decision. */
  confirm?(plan: ClaudeHookSettingsPlan): boolean | Promise<boolean>;
  randomUUID?: () => string;
  generateBearerToken?: () => string;
  now?: () => Date;
}

export type ClaudeHookOperationResult =
  | {
      operation: "status";
      outcome: "inspected";
      status: ClaudeHookOperationalStatus;
      plan: null;
    }
  | {
      operation: "install" | "uninstall";
      outcome: "applied" | "unchanged" | "cancelled";
      status: ClaudeHookOperationalStatus;
      plan: ClaudeHookSettingsPlan | null;
    };

interface LocatedHandler {
  event: string;
  eventProperty: JsoncProperty;
  eventArray: JsoncArray;
  matcherNode: JsoncNode;
  matcherObject: JsoncObject;
  handlerArray: JsoncArray;
  handlerNode: JsoncNode;
  current: boolean;
}

const TOOL_MATCHER_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
]);

function rootObject(text: string): JsoncObject {
  const parsed = parseJsonc(text);
  if (parsed.type !== "object") throw new Error("Claude settings root must be an object");
  return parsed;
}

function hooksObject(text: string): { root: JsoncObject; property: JsoncProperty | null; hooks: JsoncObject | null } {
  const root = rootObject(text);
  const property = objectProperty(root, "hooks");
  if (!property) return { root, property: null, hooks: null };
  if (property.value.type !== "object") throw new Error("Claude settings hooks must be an object");
  return { root, property, hooks: property.value };
}

function assertSettingsPath(settingsPath: string): string {
  const absolute = resolve(settingsPath);
  if (absolute !== settingsPath) throw new Error("Claude hook settings path must be absolute and normalized");
  if (/managed-settings(?:\.json|\.d)$/i.test(basename(absolute)) || absolute.includes("/managed-settings.d/")) {
    throw new Error("Managed Claude policy settings are never editable by Agent Manager");
  }
  if (!/settings(?:\.local)?\.json$/i.test(basename(absolute))) {
    throw new Error("Claude hook target must be settings.json or settings.local.json");
  }
  return absolute;
}

function assertEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("Claude hook endpoint must use loopback HTTP");
  }
  if (
    url.pathname !== "/api/v1/hooks/claude"
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new Error("Claude hook endpoint must be exactly /api/v1/hooks/claude");
  }
  return url.toString();
}

function hookEntry(
  event: string,
  input: { endpoint: string; bearerToken: string; installId: string },
): Record<string, unknown> {
  return {
    ...(TOOL_MATCHER_EVENTS.has(event) ? { matcher: "*" } : {}),
    hooks: [{
      type: "http",
      url: input.endpoint,
      timeout: event === "PermissionRequest"
        ? CLAUDE_PERMISSION_PROVIDER_TIMEOUT_MS / 1_000
        : event === "MessageDisplay" ? 5 : 15,
      headers: {
        Authorization: `Bearer ${input.bearerToken}`,
        [CLAUDE_HOOK_INSTALL_HEADER]: input.installId,
        [CLAUDE_HOOK_OWNER_HEADER]: `$${CLAUDE_MANAGER_OWNER_ENV}`,
      },
      allowedEnvVars: [CLAUDE_MANAGER_OWNER_ENV],
    }],
  };
}

function propertyObject(object: JsoncObject, key: string): JsoncObject | null {
  const property = objectProperty(object, key);
  return property?.value.type === "object" ? property.value : null;
}

function propertyArray(object: JsoncObject, key: string): JsoncArray | null {
  const property = objectProperty(object, key);
  return property?.value.type === "array" ? property.value : null;
}

function handlerInstallId(handler: JsoncObject): string | null {
  const headers = propertyObject(handler, "headers");
  if (!headers) return null;
  const marker = objectProperty(headers, CLAUDE_HOOK_INSTALL_HEADER);
  return marker ? scalarString(marker.value) : null;
}

/**
 * Recognize only the complete marker set written by Agent Manager. This is
 * deliberately stricter than a URL or install-ID match so cold-reset recovery
 * cannot consume another tool's HTTP hook.
 */
function isRecoverableAgentManagerHandler(handler: JsoncObject): boolean {
  const installId = handlerInstallId(handler);
  if (!installId || installId.trim() !== installId || installId.length > 512) return false;
  if (scalarString(objectProperty(handler, "type")?.value
      ?? { type: "scalar", start: 0, end: 0, value: null }) !== "http") return false;
  const rawUrl = scalarString(objectProperty(handler, "url")?.value
    ?? { type: "scalar", start: 0, end: 0, value: null });
  if (!rawUrl) return false;
  try {
    assertEndpoint(rawUrl);
  } catch {
    return false;
  }
  const headers = propertyObject(handler, "headers");
  if (!headers || headers.properties.length !== 3) return false;
  const owner = scalarString(objectProperty(headers, CLAUDE_HOOK_OWNER_HEADER)?.value
    ?? { type: "scalar", start: 0, end: 0, value: null });
  if (owner !== `$${CLAUDE_MANAGER_OWNER_ENV}`) return false;
  const authorization = scalarString(objectProperty(headers, "Authorization")?.value
    ?? { type: "scalar", start: 0, end: 0, value: null });
  const token = /^Bearer ([^\s]+)$/u.exec(authorization ?? "")?.[1];
  if (!token) return false;
  try {
    digestHookBearerToken(token);
  } catch {
    return false;
  }
  const allowedEnvVars = propertyArray(handler, "allowedEnvVars");
  return allowedEnvVars?.elements.length === 1
    && scalarString(allowedEnvVars.elements[0]!) === CLAUDE_MANAGER_OWNER_ENV;
}

function handlerIsCurrent(
  handler: JsoncObject,
  record: ClaudeHookInstallRecord,
  event: string,
  matcher: JsoncObject,
): boolean {
  const expectedHandlerKeys = ["type", "url", "timeout", "headers", "allowedEnvVars"];
  if (
    handler.properties.length !== expectedHandlerKeys.length
    || !expectedHandlerKeys.every((key) => handler.properties.some((property) => property.key === key))
  ) return false;
  if (scalarString(objectProperty(handler, "type")?.value ?? { type: "scalar", start: 0, end: 0, value: null }) !== "http") return false;
  if (scalarString(objectProperty(handler, "url")?.value ?? { type: "scalar", start: 0, end: 0, value: null }) !== record.endpoint) return false;
  const timeout = objectProperty(handler, "timeout")?.value;
  const expectedTimeout = event === "PermissionRequest"
    ? CLAUDE_PERMISSION_PROVIDER_TIMEOUT_MS / 1_000
    : event === "MessageDisplay" ? 5 : 15;
  if (timeout?.type !== "scalar" || timeout.value !== expectedTimeout) return false;
  const headers = propertyObject(handler, "headers");
  if (!headers) return false;
  if (
    headers.properties.length !== 3
    || !["Authorization", CLAUDE_HOOK_INSTALL_HEADER, CLAUDE_HOOK_OWNER_HEADER]
      .every((key) => headers.properties.some((property) => property.key === key))
  ) return false;
  const installId = scalarString(objectProperty(headers, CLAUDE_HOOK_INSTALL_HEADER)?.value ?? { type: "scalar", start: 0, end: 0, value: null });
  if (installId !== record.id) return false;
  const authorization = scalarString(objectProperty(headers, "Authorization")?.value ?? { type: "scalar", start: 0, end: 0, value: null });
  const token = /^Bearer ([^\s]+)$/.exec(authorization ?? "")?.[1];
  if (!token) return false;
  try {
    if (digestHookBearerToken(token) !== record.tokenDigest) return false;
  } catch {
    return false;
  }
  const owner = scalarString(objectProperty(headers, CLAUDE_HOOK_OWNER_HEADER)?.value ?? { type: "scalar", start: 0, end: 0, value: null });
  if (owner !== `$${CLAUDE_MANAGER_OWNER_ENV}`) return false;
  const allowedEnvVars = propertyArray(handler, "allowedEnvVars");
  if (
    !allowedEnvVars
    || allowedEnvVars.elements.length !== 1
    || scalarString(allowedEnvVars.elements[0]!) !== CLAUDE_MANAGER_OWNER_ENV
  ) return false;
  const expectedMatcherKeys = TOOL_MATCHER_EVENTS.has(event)
    ? ["matcher", "hooks"]
    : ["hooks"];
  if (
    matcher.properties.length !== expectedMatcherKeys.length
    || !expectedMatcherKeys.every((key) => matcher.properties.some((property) => property.key === key))
  ) return false;
  if (TOOL_MATCHER_EVENTS.has(event)) {
    const match = objectProperty(matcher, "matcher");
    if (!match || scalarString(match.value) !== "*") return false;
  }
  return true;
}

function locateMatchingHandlers(
  text: string,
  include: (handler: JsoncObject) => boolean,
  record?: ClaudeHookInstallRecord,
): LocatedHandler[] {
  const { hooks } = hooksObject(text);
  if (!hooks) return [];
  const located: LocatedHandler[] = [];
  for (const eventProperty of hooks.properties) {
    if (eventProperty.value.type !== "array") continue;
    for (const matcherNode of eventProperty.value.elements) {
      if (matcherNode.type !== "object") continue;
      const handlers = propertyArray(matcherNode, "hooks");
      if (!handlers) continue;
      for (const handlerNode of handlers.elements) {
        if (handlerNode.type !== "object" || !include(handlerNode)) continue;
        const item: LocatedHandler = {
          event: eventProperty.key,
          eventProperty,
          eventArray: eventProperty.value,
          matcherNode,
          matcherObject: matcherNode,
          handlerArray: handlers,
          handlerNode,
          current: false,
        };
        item.current = record
          ? handlerIsCurrent(handlerNode, record, item.event, item.matcherObject)
          : false;
        located.push(item);
      }
    }
  }
  return located;
}

function locateHandlers(text: string, record: ClaudeHookInstallRecord): LocatedHandler[] {
  return locateMatchingHandlers(text, (handler) => handlerInstallId(handler) === record.id, record);
}

function removeLocatedHandlers(
  text: string,
  locate: (current: string) => LocatedHandler[],
  removeEmptyHooksProperty: boolean,
): string {
  let result = text;
  while (true) {
    const located = locate(result)[0];
    if (!located) break;
    if (located.handlerArray.elements.length > 1) {
      result = removeArrayElement(result, located.handlerArray, located.handlerNode);
      continue;
    }
    const matcherOnlyContainsGeneratedFields = located.matcherObject.properties.every(
      ({ key }) => key === "matcher" || key === "hooks",
    );
    if (!matcherOnlyContainsGeneratedFields) {
      result = removeArrayElement(result, located.handlerArray, located.handlerNode);
      continue;
    }
    if (located.eventArray.elements.length > 1) {
      result = removeArrayElement(result, located.eventArray, located.matcherNode);
      continue;
    }
    const parsed = hooksObject(result);
    if (!parsed.hooks) break;
    const currentEventProperty = objectProperty(parsed.hooks, located.event);
    if (!currentEventProperty) break;
    result = removeObjectProperty(result, parsed.hooks, currentEventProperty);
  }

  if (removeEmptyHooksProperty) {
    const parsed = hooksObject(result);
    if (parsed.hooks && parsed.hooks.properties.length === 0 && parsed.property) {
      result = removeObjectProperty(result, parsed.root, parsed.property);
    }
  }
  return result;
}

function removeInstall(text: string, record: ClaudeHookInstallRecord): string {
  return removeLocatedHandlers(
    text,
    (current) => locateHandlers(current, record),
    record.createdHooksProperty,
  );
}

function removeRecoverableAgentManagerHandlers(text: string): string {
  return removeLocatedHandlers(
    text,
    (current) => locateMatchingHandlers(current, isRecoverableAgentManagerHandler),
    false,
  );
}

function addInstall(
  text: string,
  input: { endpoint: string; bearerToken: string; installId: string },
): string {
  let result = text.trim().length === 0 ? "{}\n" : text;
  let parsed = hooksObject(result);
  if (!parsed.hooks) {
    const value = Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((event) => [event, [hookEntry(event, input)]]),
    );
    return insertObjectProperty(result, parsed.root, "hooks", value);
  }
  for (const event of CLAUDE_HOOK_EVENTS) {
    parsed = hooksObject(result);
    const hooks = parsed.hooks!;
    const property = objectProperty(hooks, event);
    if (!property) {
      result = insertObjectProperty(result, hooks, event, [hookEntry(event, input)]);
      continue;
    }
    if (property.value.type !== "array") {
      throw new Error(`Claude hook event ${event} must be an array`);
    }
    result = insertArrayElement(result, property.value, hookEntry(event, input));
  }
  return result;
}

function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const body = [
    ...oldLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
    ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`),
    ...newLines.slice(newLines.length - suffix, newEnd).map((line) => ` ${line}`),
  ];
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`,
    ...body,
  ].join("\n").replace(/Bearer [^"\\\s]+/g, "Bearer [REDACTED]");
}

export function previewClaudeHookInstall(input: {
  settingsPath: string;
  settingsText: string;
  settingsExisted: boolean;
  endpoint: string;
  bearerToken: string;
  installId: string;
  now?: Date;
  previousRecord?: ClaudeHookInstallRecord;
}): ClaudeHookSettingsPlan {
  const settingsPath = assertSettingsPath(input.settingsPath);
  const endpoint = assertEndpoint(input.endpoint);
  const original = input.settingsText;
  const hadHooks = original.trim().length > 0 && hooksObject(original).hooks !== null;
  const tokenDigest = digestHookBearerToken(input.bearerToken);
  const previousStillIdentical = input.previousRecord !== undefined
    && input.previousRecord.id === input.installId
    && input.previousRecord.settingsPath === settingsPath
    && input.previousRecord.endpoint === endpoint
    && input.previousRecord.tokenDigest === tokenDigest
    && input.previousRecord.schemaVersion === CLAUDE_HOOK_INSTALL_SCHEMA_VERSION;
  const record: ClaudeHookInstallRecord = {
    id: input.installId,
    provider: "claude",
    schemaVersion: CLAUDE_HOOK_INSTALL_SCHEMA_VERSION,
    tokenDigest,
    createdAt: previousStillIdentical
      ? input.previousRecord!.createdAt
      : (input.now ?? new Date()).toISOString(),
    settingsPath,
    endpoint,
    createdHooksProperty: input.previousRecord?.createdHooksProperty ?? !hadHooks,
  };
  if (
    input.previousRecord
    && input.previousRecord.id === record.id
    && input.previousRecord.settingsPath === record.settingsPath
    && input.previousRecord.endpoint === record.endpoint
    && input.previousRecord.tokenDigest === record.tokenDigest
    && inspectClaudeHookInstall(original, input.previousRecord).state === "current"
  ) {
    return {
      provider: "claude",
      action: "install",
      settingsPath,
      before: original,
      after: original,
      beforeExisted: input.settingsExisted,
      changed: false,
      diff: "",
      record: input.previousRecord,
    };
  }
  const withoutRecordedInstall = removeInstall(
    original.trim().length === 0 ? "{}\n" : original,
    input.previousRecord ?? record,
  );
  // A settings replace can succeed just before the database save fails (or
  // the pre-prototype database is cold-reset). Replace that complete orphaned
  // marker set instead of stacking a second Agent Manager handler on every
  // event. Unrelated command/HTTP hooks do not satisfy the strict marker set.
  const withoutPrevious = removeRecoverableAgentManagerHandlers(withoutRecordedInstall);
  const after = addInstall(withoutPrevious, {
    endpoint,
    bearerToken: input.bearerToken,
    installId: input.installId,
  });
  return {
    provider: "claude",
    action: "install",
    settingsPath,
    before: original,
    after,
    beforeExisted: input.settingsExisted,
    changed: original !== after,
    diff: unifiedDiff(settingsPath, original, after),
    record,
  };
}

export function previewClaudeHookUninstall(input: {
  settingsPath: string;
  settingsText: string;
  settingsExisted: boolean;
  record: ClaudeHookInstallRecord;
}): ClaudeHookSettingsPlan {
  const settingsPath = assertSettingsPath(input.settingsPath);
  if (settingsPath !== input.record.settingsPath) throw new Error("Hook install record targets a different settings file");
  const after = input.settingsText.trim().length === 0
    ? input.settingsText
    : removeInstall(input.settingsText, input.record);
  return {
    provider: "claude",
    action: "uninstall",
    settingsPath,
    before: input.settingsText,
    after,
    beforeExisted: input.settingsExisted,
    changed: input.settingsText !== after,
    diff: unifiedDiff(settingsPath, input.settingsText, after),
    record: input.record,
  };
}

export function inspectClaudeHookInstall(
  settingsText: string,
  record: ClaudeHookInstallRecord,
): ClaudeHookInstallStatus {
  if (settingsText.trim().length === 0) {
    return {
      state: "missing",
      installedEvents: [],
      missingEvents: [...CLAUDE_HOOK_EVENTS],
      staleEvents: [],
    };
  }
  const located = locateHandlers(settingsText, record);
  const installedEvents: string[] = [];
  const staleEvents: string[] = [];
  for (const event of new Set([...CLAUDE_HOOK_EVENTS, ...located.map((item) => item.event)])) {
    const eventHandlers = located.filter((item) => item.event === event);
    if (eventHandlers.length === 1 && eventHandlers[0]?.current) {
      installedEvents.push(event);
    } else if (eventHandlers.length > 0) {
      staleEvents.push(event);
    }
  }
  const missingEvents = CLAUDE_HOOK_EVENTS.filter(
    (event) => !installedEvents.includes(event) && !staleEvents.includes(event),
  );
  const state = staleEvents.length > 0
    ? "stale"
    : installedEvents.length === CLAUDE_HOOK_EVENTS.length
      ? "current"
      : installedEvents.length === 0
        ? "missing"
        : "partial";
  return { state, installedEvents, missingEvents, staleEvents };
}

/** Resolves only the two settings scopes the CLI is allowed to mutate. */
export function resolveClaudeHookSettingsPath(input: {
  scope: ClaudeHookScope;
  homeDirectory: string;
  projectDirectory?: string;
}): string {
  const homeDirectory = resolve(input.homeDirectory);
  if (homeDirectory !== input.homeDirectory) {
    throw new Error("Claude hook home directory must be absolute and normalized");
  }
  if (input.scope === "user") {
    return assertSettingsPath(join(homeDirectory, ".claude", "settings.json"));
  }
  if (!input.projectDirectory) {
    throw new Error("Project-local Claude hooks require a project directory");
  }
  const projectDirectory = resolve(input.projectDirectory);
  if (projectDirectory !== input.projectDirectory) {
    throw new Error("Claude hook project directory must be absolute and normalized");
  }
  return assertSettingsPath(join(projectDirectory, ".claude", "settings.local.json"));
}

/** Reads a preview source without following a symlink at the settings leaf. */
export async function readClaudeHookSettings(
  settingsPath: string,
): Promise<ClaudeHookSettingsSource> {
  const path = assertSettingsPath(settingsPath);
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Claude settings target must be a regular non-symlink file");
    }
    return {
      settingsPath: path,
      settingsText: await readFile(path, "utf8"),
      settingsExisted: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { settingsPath: path, settingsText: "", settingsExisted: false };
  }
}

function containsUnknownAgentManagerInstall(settingsText: string): boolean {
  if (settingsText.trim().length === 0) return false;
  const { hooks } = hooksObject(settingsText);
  if (!hooks) return false;
  for (const event of hooks.properties) {
    if (event.value.type !== "array") continue;
    for (const matcher of event.value.elements) {
      if (matcher.type !== "object") continue;
      const handlers = propertyArray(matcher, "hooks");
      if (!handlers) continue;
      for (const handler of handlers.elements) {
        if (handler.type === "object" && handlerInstallId(handler)) return true;
      }
    }
  }
  return false;
}

function claudeProviderHooksEnabled(settingsText: string): boolean {
  if (settingsText.trim().length === 0) return true;
  const disabled = objectProperty(rootObject(settingsText), "disableAllHooks")?.value;
  return !(disabled?.type === "scalar" && disabled.value === true);
}

/** Adds runtime liveness to the surgical configuration inspection used by CLI status. */
export function inspectClaudeHookOperationalStatus(input: {
  source: ClaudeHookSettingsSource;
  record: ClaudeHookInstallRecord | null;
  lastSeenAt?: string | null;
}): ClaudeHookOperationalStatus {
  const settingsPath = assertSettingsPath(input.source.settingsPath);
  const lastSeenAt = input.lastSeenAt ?? null;
  if (!claudeProviderHooksEnabled(input.source.settingsText)) {
    return { state: "provider-disabled", settingsPath, configuration: null, lastSeenAt };
  }
  if (!input.record) {
    return {
      state: containsUnknownAgentManagerInstall(input.source.settingsText) ? "untrusted" : "absent",
      settingsPath,
      configuration: null,
      lastSeenAt,
    };
  }
  if (input.record.settingsPath !== settingsPath) {
    return { state: "stale-token-schema", settingsPath, configuration: null, lastSeenAt };
  }
  const configuration = inspectClaudeHookInstall(input.source.settingsText, input.record);
  if (configuration.state === "missing") {
    return { state: "absent", settingsPath, configuration, lastSeenAt };
  }
  if (configuration.state !== "current") {
    return { state: "stale-token-schema", settingsPath, configuration, lastSeenAt };
  }
  const seenAt = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  const installedAt = Date.parse(input.record.createdAt);
  return {
    state: Number.isFinite(seenAt) && Number.isFinite(installedAt) && seenAt >= installedAt
      ? "active"
      : "installed-unseen",
    settingsPath,
    configuration,
    lastSeenAt,
  };
}

function installedBearerToken(
  settingsText: string,
  record: ClaudeHookInstallRecord,
): string | null {
  if (inspectClaudeHookInstall(settingsText, record).state !== "current") return null;
  const current = locateHandlers(settingsText, record).find((handler) => handler.current);
  if (!current || current.handlerNode.type !== "object") return null;
  const headers = propertyObject(current.handlerNode, "headers");
  if (!headers) return null;
  const authorization = scalarString(
    objectProperty(headers, "Authorization")?.value
      ?? { type: "scalar", start: 0, end: 0, value: null },
  );
  const token = /^Bearer ([^\s]+)$/.exec(authorization ?? "")?.[1];
  if (!token) return null;
  try {
    return digestHookBearerToken(token) === record.tokenDigest ? token : null;
  } catch {
    return null;
  }
}

async function operationalStatus(
  source: ClaudeHookSettingsSource,
  record: ClaudeHookInstallRecord | null,
  dependencies: ClaudeHookOperationDependencies,
): Promise<ClaudeHookOperationalStatus> {
  const lastSeenAt = record && dependencies.lastSeenAt
    ? await dependencies.lastSeenAt(record.id)
    : null;
  return inspectClaudeHookOperationalStatus({
    source,
    record,
    lastSeenAt,
  });
}

/**
 * End-to-end CLI seam. It performs no prompting or record persistence behind
 * the caller's back: preview and consent are explicit dependencies, while the
 * only persisted secret material is the bearer token inside Claude settings.
 */
export async function runClaudeHookOperation(
  input: ClaudeHookOperationInput,
  dependencies: ClaudeHookOperationDependencies,
): Promise<ClaudeHookOperationResult> {
  const settingsPath = resolveClaudeHookSettingsPath(input);
  const source = await readClaudeHookSettings(settingsPath);
  const record = await dependencies.loadRecord(settingsPath);

  if (input.operation === "status") {
    return {
      operation: "status",
      outcome: "inspected",
      status: await operationalStatus(source, record, dependencies),
      plan: null,
    };
  }

  if (input.operation === "uninstall") {
    if (!record) {
      return {
        operation: "uninstall",
        outcome: "unchanged",
        status: await operationalStatus(source, null, dependencies),
        plan: null,
      };
    }
    const plan = previewClaudeHookUninstall({
      ...source,
      record,
    });
    if (!plan.changed) {
      await dependencies.removeRecord(record.id);
      return {
        operation: "uninstall",
        outcome: "unchanged",
        status: await operationalStatus(source, null, dependencies),
        plan,
      };
    }
    if (!dependencies.showPreview) {
      throw new Error("Claude hook uninstall requires an exact diff preview handler");
    }
    await dependencies.showPreview(plan);
    if (!dependencies.confirm) {
      throw new Error("Claude hook uninstall requires an explicit terminal confirmation handler");
    }
    if (!await dependencies.confirm(plan)) {
      return {
        operation: "uninstall",
        outcome: "cancelled",
        status: await operationalStatus(source, record, dependencies),
        plan,
      };
    }
    await applyClaudeHookSettingsPlan(plan, { confirmed: true });
    await dependencies.removeRecord(record.id);
    const after: ClaudeHookSettingsSource = {
      settingsPath,
      settingsText: plan.after,
      settingsExisted: source.settingsExisted,
    };
    return {
      operation: "uninstall",
      outcome: "applied",
      status: await operationalStatus(after, null, dependencies),
      plan,
    };
  }

  const bearerToken = record
    ? installedBearerToken(source.settingsText, record)
      ?? (dependencies.generateBearerToken ?? generateHookBearerToken)()
    : (dependencies.generateBearerToken ?? generateHookBearerToken)();
  const plan = previewClaudeHookInstall({
    ...source,
    endpoint: input.endpoint,
    bearerToken,
    installId: record?.id ?? (dependencies.randomUUID ?? randomUUID)(),
    now: (dependencies.now ?? (() => new Date()))(),
    ...(record ? { previousRecord: record } : {}),
  });
  if (!plan.changed) {
    await dependencies.saveRecord(plan.record);
    return {
      operation: "install",
      outcome: "unchanged",
      status: await operationalStatus(source, plan.record, dependencies),
      plan,
    };
  }
  if (!dependencies.showPreview) {
    throw new Error("Claude hook install requires an exact diff preview handler");
  }
  await dependencies.showPreview(plan);
  if (!dependencies.confirm) {
    throw new Error("Claude hook install requires an explicit terminal confirmation handler");
  }
  if (!await dependencies.confirm(plan)) {
    return {
      operation: "install",
      outcome: "cancelled",
      status: await operationalStatus(source, record, dependencies),
      plan,
    };
  }
  await applyClaudeHookSettingsPlan(plan, { confirmed: true });
  await dependencies.saveRecord(plan.record);
  const after: ClaudeHookSettingsSource = {
    settingsPath,
    settingsText: plan.after,
    settingsExisted: true,
  };
  return {
    operation: "install",
    outcome: "applied",
    status: await operationalStatus(after, plan.record, dependencies),
    plan,
  };
}

/** Applies only the exact preview the operator confirmed; concurrent edits fail closed. */
export async function applyClaudeHookSettingsPlan(
  plan: ClaudeHookSettingsPlan,
  options: { confirmed: boolean },
): Promise<void> {
  if (!options.confirmed) throw new Error("Claude hook settings change requires explicit confirmation");
  if (!plan.changed) return;
  const path = assertSettingsPath(plan.settingsPath);
  let current = "";
  let mode = 0o600;
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Claude settings target must be a regular non-symlink file");
    }
    mode = stats.mode & 0o777;
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (plan.beforeExisted) throw new Error("Claude settings file disappeared after preview");
  }
  if (current !== plan.before) {
    throw new Error("Claude settings changed after preview; generate a new diff");
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.agent-manager-${process.pid}-${Date.now()}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    await handle.writeFile(plan.after, "utf8");
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
