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
import { CODEX_HOOK_EVENTS, type CodexHookEvent } from "../providers/codex/codex-hook.ts";

export interface CodexHookConfigurationStatus {
  state: "current" | "missing" | "partial" | "stale";
  installedEvents: CodexHookEvent[];
  missingEvents: CodexHookEvent[];
  staleEvents: CodexHookEvent[];
}

interface LocatedHandler {
  event: string;
  root: JsoncObject;
  hooksProperty: JsoncProperty;
  hooks: JsoncObject;
  eventProperty: JsoncProperty;
  eventArray: JsoncArray;
  matcher: JsoncObject;
  handlerArray: JsoncArray;
  handler: JsoncObject;
  command: string;
  timeout: number | null;
}

function rootObject(text: string): JsoncObject {
  const root = parseJsonc(text);
  if (root.type !== "object") throw new Error("Codex hooks root must be an object");
  return root;
}

function hooksObject(text: string): {
  root: JsoncObject;
  property: JsoncProperty | null;
  hooks: JsoncObject | null;
} {
  const root = rootObject(text);
  const property = objectProperty(root, "hooks");
  if (!property) return { root, property: null, hooks: null };
  if (property.value.type !== "object") throw new Error("Codex hooks property must be an object");
  return { root, property, hooks: property.value };
}

function propertyArray(object: JsoncObject, key: string): JsoncArray | null {
  const property = objectProperty(object, key);
  if (!property) return null;
  if (property.value.type !== "array") throw new Error(`Codex hook ${key} must be an array`);
  return property.value;
}

function scalarNumber(node: JsoncNode | undefined): number | null {
  return node?.type === "scalar" && typeof node.value === "number" && Number.isFinite(node.value)
    ? node.value
    : null;
}

function locateHandlers(text: string): LocatedHandler[] {
  const parsed = hooksObject(text);
  if (!parsed.hooks || !parsed.property) return [];
  const result: LocatedHandler[] = [];
  for (const eventProperty of parsed.hooks.properties) {
    if (eventProperty.value.type !== "array") continue;
    for (const matcherNode of eventProperty.value.elements) {
      if (matcherNode.type !== "object") continue;
      const handlers = propertyArray(matcherNode, "hooks");
      if (!handlers) continue;
      for (const handlerNode of handlers.elements) {
        if (handlerNode.type !== "object") continue;
        const type = objectProperty(handlerNode, "type");
        const command = objectProperty(handlerNode, "command");
        if (scalarString(type?.value ?? { type: "scalar", start: 0, end: 0, value: null }) !== "command") continue;
        const commandValue = command ? scalarString(command.value) : null;
        if (!commandValue) continue;
        const timeout = scalarNumber(objectProperty(handlerNode, "timeout")?.value);
        result.push({
          event: eventProperty.key,
          root: parsed.root,
          hooksProperty: parsed.property,
          hooks: parsed.hooks,
          eventProperty,
          eventArray: eventProperty.value,
          matcher: matcherNode,
          handlerArray: handlers,
          handler: handlerNode,
          command: commandValue,
          timeout,
        });
      }
    }
  }
  return result;
}

function removeFirstOwned(text: string, command: string): string | null {
  const located = locateHandlers(text).find((item) => item.command === command);
  if (!located) return null;
  if (located.handlerArray.elements.length > 1) {
    return removeArrayElement(text, located.handlerArray, located.handler);
  }
  if (located.matcher.properties.length !== 1 || located.matcher.properties[0]?.key !== "hooks") {
    throw new Error("Codex hook matcher was modified; refusing to remove unrelated fields");
  }
  if (located.eventArray.elements.length > 1) {
    return removeArrayElement(text, located.eventArray, located.matcher);
  }
  return removeObjectProperty(text, located.hooks, located.eventProperty);
}

export function removeCodexHookCommand(settingsText: string, command: string): string {
  let result = settingsText.trim().length === 0 ? "{}\n" : settingsText;
  while (true) {
    const next = removeFirstOwned(result, command);
    if (next === null) break;
    result = next;
  }
  const parsed = hooksObject(result);
  if (parsed.hooks && parsed.property && parsed.hooks.properties.length === 0) {
    result = removeObjectProperty(result, parsed.root, parsed.property);
  }
  return result;
}

function hookMatcher(command: string, timeout: number): Record<string, unknown> {
  return { hooks: [{ type: "command", command, timeout }] };
}

export function addCodexHookCommand(
  settingsText: string,
  command: string,
  timeout = 5,
): string {
  let result = settingsText.trim().length === 0 ? "{}\n" : settingsText;
  let parsed = hooksObject(result);
  if (!parsed.hooks) {
    const value = Object.fromEntries(
      CODEX_HOOK_EVENTS.map((event) => [event, [hookMatcher(command, timeout)]]),
    );
    return insertObjectProperty(result, parsed.root, "hooks", value);
  }
  for (const event of CODEX_HOOK_EVENTS) {
    parsed = hooksObject(result);
    const hooks = parsed.hooks!;
    const property = objectProperty(hooks, event);
    if (!property) {
      result = insertObjectProperty(result, hooks, event, [hookMatcher(command, timeout)]);
      continue;
    }
    if (property.value.type !== "array") throw new Error(`Codex hook event ${event} must be an array`);
    result = insertArrayElement(result, property.value, hookMatcher(command, timeout));
  }
  return result;
}

export function inspectCodexHookCommand(
  settingsText: string,
  command: string,
  timeout = 5,
): CodexHookConfigurationStatus {
  if (settingsText.trim().length === 0) {
    return {
      state: "missing",
      installedEvents: [],
      missingEvents: [...CODEX_HOOK_EVENTS],
      staleEvents: [],
    };
  }
  const owned = locateHandlers(settingsText).filter((item) => item.command === command);
  const hasUnexpectedEvent = owned.some(
    (item) => !CODEX_HOOK_EVENTS.includes(item.event as CodexHookEvent),
  );
  const installedEvents: CodexHookEvent[] = [];
  const staleEvents: CodexHookEvent[] = [];
  for (const event of CODEX_HOOK_EVENTS) {
    const handlers = owned.filter((item) => item.event === event);
    if (handlers.length === 1 && handlers[0]?.timeout === timeout) installedEvents.push(event);
    else if (handlers.length > 0) staleEvents.push(event);
  }
  const missingEvents = CODEX_HOOK_EVENTS.filter(
    (event) => !installedEvents.includes(event) && !staleEvents.includes(event),
  );
  const state = staleEvents.length > 0 || hasUnexpectedEvent
    ? "stale"
    : installedEvents.length === CODEX_HOOK_EVENTS.length
      ? "current"
      : installedEvents.length === 0
        ? "missing"
        : "partial";
  return { state, installedEvents, missingEvents, staleEvents };
}

export function containsAgentManagerCodexShim(settingsText: string): boolean {
  if (settingsText.trim().length === 0) return false;
  return locateHandlers(settingsText).some((item) => /agent-manager.+codex.+hook/iu.test(item.command));
}

export function codexHookSettingsDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  return [
    `--- ${path}`,
    `+++ ${path}`,
    ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
    ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`),
  ].join("\n");
}
