import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Elicitation",
  "MessageDisplay",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "PreCompact",
  "PostCompact",
  "Stop",
  "StopFailure",
  "Notification",
] as const;

export type ClaudeHookEvent = typeof CLAUDE_HOOK_EVENTS[number];
export type ClaudeHookInput = Extract<HookInput, { hook_event_name: ClaudeHookEvent }>;

const EVENT_SET = new Set<string>(CLAUDE_HOOK_EVENTS);
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_STRING_LENGTH = 262_144;

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(
  value: Record<string, unknown>,
  field: string,
  maxLength = MAX_STRING_LENGTH,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Claude hook ${field} must be a non-empty string`);
  }
  if (candidate.length > maxLength) {
    throw new Error(`Claude hook ${field} exceeds ${maxLength} characters`);
  }
  return candidate;
}

function optionalText(
  value: Record<string, unknown>,
  field: string,
  maxLength = MAX_STRING_LENGTH,
): void {
  const candidate = value[field];
  if (candidate === undefined) return;
  if (typeof candidate !== "string" || candidate.length > maxLength) {
    throw new Error(`Claude hook ${field} must be a bounded string`);
  }
}

function requiredBoolean(value: Record<string, unknown>, field: string): void {
  if (typeof value[field] !== "boolean") {
    throw new Error(`Claude hook ${field} must be a boolean`);
  }
}

function requiredNonnegativeInteger(value: Record<string, unknown>, field: string): void {
  if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
    throw new Error(`Claude hook ${field} must be a non-negative integer`);
  }
}

function validatePermissionSuggestions(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("Claude hook permission_suggestions must be a bounded array");
  }
  const destinations = new Set(["userSettings", "projectSettings", "localSettings", "session", "cliArg"]);
  const behaviors = new Set(["allow", "deny", "ask"]);
  const modes = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);
  for (const [index, rawSuggestion] of value.entries()) {
    const suggestion = record(rawSuggestion, `permission_suggestions[${String(index)}]`);
    if (!destinations.has(requiredText(suggestion, "destination", 64))) {
      throw new Error("Claude hook permission suggestion destination is unsupported");
    }
    const type = requiredText(suggestion, "type", 64);
    if (["addRules", "replaceRules", "removeRules"].includes(type)) {
      if (!behaviors.has(requiredText(suggestion, "behavior", 32)) || !Array.isArray(suggestion.rules)) {
        throw new Error("Claude hook permission rule suggestion is malformed");
      }
      for (const [ruleIndex, rawRule] of suggestion.rules.entries()) {
        const rule = record(rawRule, `permission_suggestions[${String(index)}].rules[${String(ruleIndex)}]`);
        requiredText(rule, "toolName", 1_024);
        optionalText(rule, "ruleContent", 8_192);
      }
      continue;
    }
    if (type === "setMode") {
      if (!modes.has(requiredText(suggestion, "mode", 64))) {
        throw new Error("Claude hook permission mode suggestion is unsupported");
      }
      continue;
    }
    if (type === "addDirectories" || type === "removeDirectories") {
      if (!Array.isArray(suggestion.directories) || suggestion.directories.length > 512 ||
          !suggestion.directories.every((directory) =>
            typeof directory === "string" && directory.length > 0 && directory.length <= 32_768
          )) {
        throw new Error("Claude hook permission directory suggestion is malformed");
      }
      continue;
    }
    throw new Error(`Claude hook permission suggestion type ${type} is unsupported`);
  }
}

function validateCommon(value: Record<string, unknown>): ClaudeHookEvent {
  requiredText(value, "session_id", 512);
  requiredText(value, "transcript_path", 32_768);
  requiredText(value, "cwd", 32_768);
  optionalText(value, "prompt_id", 512);
  optionalText(value, "permission_mode", 128);
  optionalText(value, "agent_id", 512);
  optionalText(value, "agent_type", 512);
  const event = requiredText(value, "hook_event_name", 128);
  if (!EVENT_SET.has(event)) throw new Error(`Unsupported Claude hook event ${event}`);
  return event as ClaudeHookEvent;
}

function validateEvent(value: Record<string, unknown>, event: ClaudeHookEvent): void {
  switch (event) {
    case "SessionStart":
      requiredText(value, "source", 128);
      optionalText(value, "model", 512);
      optionalText(value, "session_title", 4_096);
      return;
    case "SessionEnd":
      requiredText(value, "reason", 128);
      return;
    case "UserPromptSubmit":
      requiredText(value, "prompt");
      return;
    case "PreToolUse":
      requiredText(value, "tool_name", 1_024);
      requiredText(value, "tool_use_id", 1_024);
      if (!("tool_input" in value)) throw new Error("Claude hook tool_input is required");
      return;
    case "PostToolUse":
      requiredText(value, "tool_name", 1_024);
      requiredText(value, "tool_use_id", 1_024);
      if (!("tool_input" in value) || !("tool_response" in value)) {
        throw new Error("Claude PostToolUse requires tool_input and tool_response");
      }
      return;
    case "PostToolUseFailure":
      requiredText(value, "tool_name", 1_024);
      requiredText(value, "tool_use_id", 1_024);
      requiredText(value, "error");
      if (!("tool_input" in value)) throw new Error("Claude hook tool_input is required");
      return;
    case "PermissionRequest":
      requiredText(value, "tool_name", 1_024);
      if (!("tool_input" in value)) throw new Error("Claude hook tool_input is required");
      validatePermissionSuggestions(value.permission_suggestions);
      return;
    case "PermissionDenied":
      requiredText(value, "tool_name", 1_024);
      requiredText(value, "tool_use_id", 1_024);
      requiredText(value, "reason");
      if (!("tool_input" in value)) throw new Error("Claude hook tool_input is required");
      return;
    case "Elicitation":
      requiredText(value, "mcp_server_name", 1_024);
      requiredText(value, "message");
      return;
    case "MessageDisplay":
      requiredText(value, "turn_id", 1_024);
      requiredText(value, "message_id", 1_024);
      requiredNonnegativeInteger(value, "index");
      requiredBoolean(value, "final");
      if (typeof value.delta !== "string") throw new Error("Claude hook delta must be a string");
      return;
    case "SubagentStart":
      requiredText(value, "agent_id", 512);
      requiredText(value, "agent_type", 512);
      return;
    case "SubagentStop":
      requiredText(value, "agent_id", 512);
      requiredText(value, "agent_type", 512);
      requiredText(value, "agent_transcript_path", 32_768);
      requiredBoolean(value, "stop_hook_active");
      return;
    case "TaskCreated":
    case "TaskCompleted":
      requiredText(value, "task_id", 1_024);
      requiredText(value, "task_subject", 8_192);
      return;
    case "PreCompact":
      requiredText(value, "trigger", 128);
      return;
    case "PostCompact":
      return;
    case "Stop":
      requiredBoolean(value, "stop_hook_active");
      return;
    case "StopFailure":
      if (!("error" in value)) throw new Error("Claude StopFailure error is required");
      return;
    case "Notification":
      requiredText(value, "message");
      requiredText(value, "notification_type", 512);
      return;
  }
}

/** Parses only Claude's documented hook wire shape; Codex hooks are intentionally separate. */
export function parseClaudeHookInput(input: unknown): ClaudeHookInput {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("Claude hook payload must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new Error("Claude hook payload must be JSON serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error(`Claude hook payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const value = record(structuredClone(input), "Claude hook payload");
  const event = validateCommon(value);
  validateEvent(value, event);
  return value as unknown as ClaudeHookInput;
}
