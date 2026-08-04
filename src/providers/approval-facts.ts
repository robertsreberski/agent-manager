import { isAbsolute, normalize, resolve } from "node:path";

import type { ActivityApprovalFacts } from "../activity/index.ts";

interface ToolApprovalFactOptions {
  cwd: string | null;
  blockedPath?: string | null;
  canPersist?: boolean;
}

/**
 * Pinned Claude built-in tool inputs from @anthropic-ai/claude-agent-sdk.
 *
 * MCP and future tools may also contain keys named `path`, `command`, or
 * `network`; those keys are application data, not permission facts. Keep the
 * allowlist deliberately small and update it only alongside a provider
 * contract upgrade.
 */
const CLAUDE_TOOL_FACT_FIELDS = new Map<string, {
  readonly commandField?: string;
  readonly pathFields: readonly string[];
  readonly writeFields: readonly string[];
}>([
  ["Bash", { commandField: "command", pathFields: [], writeFields: [] }],
  ["Read", { pathFields: ["file_path"], writeFields: [] }],
  ["Write", { pathFields: ["file_path"], writeFields: ["file_path"] }],
  ["Edit", { pathFields: ["file_path"], writeFields: ["file_path"] }],
  ["NotebookEdit", {
    pathFields: ["notebook_path"],
    writeFields: ["notebook_path"],
  }],
  ["Glob", { pathFields: ["path"], writeFields: [] }],
  ["Grep", { pathFields: ["path"], writeFields: [] }],
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Resolve only against an exact absolute provider cwd; never consult the filesystem. */
export function resolveProviderPath(value: string, cwd: string | null): string {
  if (isAbsolute(value)) return normalize(value);
  return cwd && isAbsolute(cwd) ? resolve(cwd, value) : value;
}

function namedValues(
  input: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.flatMap((field) => {
    const value = nonemptyString(input[field]);
    return value ? [value] : [];
  });
}

/**
 * Extracts only fields in a pinned Claude built-in tool contract, plus the
 * SDK's explicit blockedPath permission fact. In particular, this does not
 * promote lookalike fields from MCP/custom tools, tokenize a shell command,
 * expand globs, inspect the filesystem, or infer network/delete facts.
 */
export function toolApprovalFacts(
  toolName: string | null,
  rawInput: unknown,
  options: ToolApprovalFactOptions,
): ActivityApprovalFacts {
  const input = objectValue(rawInput) ?? {};
  const contract = toolName ? CLAUDE_TOOL_FACT_FIELDS.get(toolName) : undefined;
  const blockedPath = nonemptyString(options.blockedPath);
  const suppliedPaths = namedValues(input, contract?.pathFields ?? []);
  if (blockedPath) suppliedPaths.push(blockedPath);
  const paths = unique(suppliedPaths);
  const writes = namedValues(input, contract?.writeFields ?? []);
  if (blockedPath && (contract?.writeFields.length ?? 0) > 0) writes.push(blockedPath);
  const command = contract?.commandField
    ? nonemptyString(input[contract.commandField])
    : null;
  return {
    command,
    paths: paths.length > 0
      ? paths.map((path) => resolveProviderPath(path, options.cwd))
      : null,
    writes: unique(writes),
    network: null,
    canPersist: options.canPersist === true,
    deleteCount: null,
  };
}
