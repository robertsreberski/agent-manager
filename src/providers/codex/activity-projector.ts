import {
  contentHash,
  messageCorrelationId,
  scopedCorrelationId,
} from "../../activity/correlation.ts";

import type {
  ActivityApprovalFacts,
  ActivityAttentionQuestion,
  ActivityFileChange,
  ActivityItemDraft,
  ActivityMutation,
  ActivityState,
  ActivityTodoInputStep,
  ActivityTodoRewriteState,
} from "../../activity/index.ts";
import {
  extractTrailingMemoryCitation,
  parseProposedPlan,
  parseMemoryCitation,
  reconcileTodoRewrite,
} from "../../activity/index.ts";
import { resolveProviderPath } from "../approval-facts.ts";
import {
  jsonRpcIdKey,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "./rpc.ts";
import type {
  CodexPendingRequest,
  CodexQueuedMessage,
  JsonRpcId,
} from "./types.ts";
import { normalizeCodexQuestions } from "./question-normalizer.ts";

export type CodexActivityAppendChannel = Extract<
  ActivityMutation,
  { type: "append" }
>["channel"];

export type CodexActivityOffsetLookup = (
  id: string,
  channel: CodexActivityAppendChannel,
) => number;

export type CodexTodoProjectionState = ActivityTodoRewriteState;

export type CodexActivityTodoLookup = (
  id: string,
) => CodexTodoProjectionState | null;

export type CodexStructuredPlanLookup = (id: string) => boolean;

export interface CodexActivityProjection {
  threadId: string;
  mutations: readonly ActivityMutation[];
}

const zeroOffset: CodexActivityOffsetLookup = () => 0;
const noTodoState: CodexActivityTodoLookup = () => null;
const noStructuredPlan: CodexStructuredPlanLookup = () => false;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scopedId(kind: string, ...parts: string[]): string {
  return scopedCorrelationId("codex", kind, ...parts);
}

/**
 * Canonical identity for a visible Codex message across the rollout, command
 * hook, and App Server projections. Codex gives the App Server/rollout an
 * item id, but command hooks expose only the turn and message body. Basing the
 * cross-source key on every field all three surfaces share keeps the provider
 * item id as the activity id while still allowing an exact hook/API item to
 * replace its inferred rollout twin.
 *
 * The content digest is important for live steering: more than one user
 * message can belong to the same provider turn. The turn id keeps identical
 * prompts in different turns distinct.
 *
 * Claude needs the same trick for a different reason — its two surfaces share no
 * identifier at all — so the construction now lives in `activity/correlation.ts`.
 * This wrapper keeps Codex's own keys byte-identical to what they always were.
 */
export function codexMessageCorrelationId(
  threadId: string,
  turnId: string,
  role: "user" | "assistant",
  text: string,
): string {
  return messageCorrelationId("codex", threadId, turnId, role, text);
}

/** One proposed-plan identity shared by structured and tagged-message surfaces. */
export function codexProposedPlanId(threadId: string, turnId: string): string {
  return scopedId("proposed-plan", threadId, turnId);
}

/** Reconciles a rollout fallback with the exact App Server plan item. */
export function codexProposedPlanCorrelationId(threadId: string, turnId: string): string {
  return scopedId("proposed-plan-correlation", threadId, turnId);
}

/**
 * Canonical identity for one request_user_input item across the Codex rollout
 * and App Server surfaces, so no prompt text or answer content needs to
 * participate in reconciliation.
 *
 * The rollout's response-item id is *expected* to be the same itemId the App
 * Server places on its server request — but neither side is guaranteed to state
 * one. Where the response-item id is absent both sides fall back to the call id
 * instead, via `codexRequestUserInputKey`. When they agree the hub collapses the
 * two into one item; when they cannot, the drawer suppresses the transcript copy
 * at render time rather than showing the questionnaire twice.
 */
export function codexRequestUserInputCorrelationId(
  threadId: string,
  itemId: string,
): string {
  return scopedId("request-user-input-correlation", threadId, itemId);
}

/**
 * The identity both surfaces agree on, in preference order: the response-item
 * id, then the call id. Returns null when a surface states neither, which is
 * the one case correlation cannot bridge.
 */
export function codexRequestUserInputKey(
  threadId: string,
  itemId: string | null,
  callId: string | null,
): string | null {
  const identity = itemId ?? callId;
  return identity ? codexRequestUserInputCorrelationId(threadId, identity) : null;
}

function itemActivityId(
  threadId: string,
  turnId: string,
  itemId: string,
  suffix?: string,
): string {
  return scopedId("item", threadId, turnId, itemId, ...(suffix ? [suffix] : []));
}

function turnActivityId(threadId: string, turnId: string): string {
  return scopedId("turn", threadId, turnId);
}

function requestActivityId(threadId: string, requestId: JsonRpcId): string {
  return scopedId("request", threadId, jsonRpcIdKey(requestId));
}

function subagentActivityId(childThreadId: string): string {
  return scopedId("subagent", childThreadId);
}

function collabAgentActivityState(value: unknown): ActivityState {
  switch (value) {
    case "pendingInit": return "pending";
    case "running": return "running";
    case "interrupted": return "interrupted";
    case "completed":
    case "shutdown": return "complete";
    case "errored":
    case "notFound": return "failed";
    default: return "pending";
  }
}

function isoFromMilliseconds(value: unknown): string | null {
  const milliseconds = finiteNumber(value);
  if (milliseconds === null) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromSeconds(value: unknown): string | null {
  const seconds = finiteNumber(value);
  return seconds === null ? null : isoFromMilliseconds(seconds * 1_000);
}

function notificationTime(notification: JsonRpcNotification): string | null {
  return isoFromMilliseconds(notification.emittedAtMs);
}

function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable provider value]";
  }
}

function nonemptyStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return null;
  }
  return value as string[];
}

function commandActionPaths(
  value: unknown,
  cwd: string | null,
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paths: string[] = [];
  for (const rawAction of value) {
    const action = record(rawAction);
    const type = stringValue(action?.type);
    if (!action || !type || !["read", "listFiles", "search"].includes(type)) {
      return null;
    }
    const path = stringValue(action.path);
    // A provider action without a path cannot prove the command is confined
    // to the workspace, so retain the conservative unknown classification.
    if (!path) return null;
    paths.push(resolveProviderPath(path, cwd));
  }
  return [...new Set(paths)];
}

function requestsNetworkAccess(params: Record<string, unknown>): boolean | null {
  const context = record(params.networkApprovalContext);
  const protocol = stringValue(context?.protocol);
  if (
    context
    && typeof context.host === "string"
    && context.host.length > 0
    && protocol !== null
    && ["http", "https", "socks5Tcp", "socks5Udp"].includes(protocol)
  ) {
    return true;
  }
  if (Array.isArray(params.proposedNetworkPolicyAmendments)) {
    const hasExactAmendment = params.proposedNetworkPolicyAmendments.some((raw) => {
      const amendment = record(raw);
      return amendment !== null
        && typeof amendment.host === "string"
        && amendment.host.length > 0
        && (amendment.action === "allow" || amendment.action === "deny");
    });
    if (hasExactAmendment) return true;
  }
  return null;
}

function permissionApprovalFacts(
  params: Record<string, unknown>,
): ActivityApprovalFacts {
  const cwd = stringValue(params.cwd);
  const permissions = record(params.permissions);
  const fileSystem = record(permissions?.fileSystem);
  const writes: string[] = [];
  const paths: string[] = [];
  let ambiguousPath = permissions === null ||
    (permissions?.fileSystem !== null && permissions?.fileSystem !== undefined && fileSystem === null);

  if (fileSystem) {
    for (const field of ["read", "write"] as const) {
      const values = fileSystem[field] === null || fileSystem[field] === undefined
        ? []
        : nonemptyStrings(fileSystem[field]);
      if (values === null) {
        ambiguousPath = true;
        continue;
      }
      for (const value of values) {
        paths.push(resolveProviderPath(value, cwd));
        if (field === "write") writes.push(value);
      }
    }
    if (fileSystem.entries !== null && fileSystem.entries !== undefined) {
      if (!Array.isArray(fileSystem.entries)) {
        ambiguousPath = true;
      } else {
        for (const rawEntry of fileSystem.entries) {
          const entry = record(rawEntry);
          const access = stringValue(entry?.access);
          const path = record(entry?.path);
          if (!entry || !access || !path) {
            ambiguousPath = true;
            continue;
          }
          if (path.type === "path" && typeof path.path === "string" && path.path.length > 0) {
            paths.push(resolveProviderPath(path.path, cwd));
            if (access === "write") writes.push(path.path);
            continue;
          }
          if (path.type === "glob_pattern" && typeof path.pattern === "string" && path.pattern.length > 0) {
            // The glob is an exact display fact but cannot prove containment
            // without expanding it, which Agent Manager must never do.
            if (access === "write") writes.push(path.pattern);
          }
          ambiguousPath = true;
        }
      }
    }
  }

  const network = record(permissions?.network);
  return {
    command: null,
    paths: ambiguousPath ? null : [...new Set(paths)],
    writes: [...new Set(writes)],
    network: typeof network?.enabled === "boolean" ? network.enabled : null,
    canPersist: false,
    // Neither pinned Codex request contract exposes a delete count.
    deleteCount: null,
  };
}

function codexApprovalFacts(
  method: string,
  params: Record<string, unknown>,
): ActivityApprovalFacts | null {
  if (method === "item/commandExecution/requestApproval") {
    const cwd = stringValue(params.cwd);
    return {
      command: stringValue(params.command),
      paths: commandActionPaths(params.commandActions, cwd),
      writes: [],
      network: requestsNetworkAccess(params),
      // The pinned response protocol exposes acceptForSession for this exact
      // request type, even when no policy-amendment proposal is present.
      canPersist: true,
      // CommandExecutionRequestApprovalParams has no delete-count field.
      deleteCount: null,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const grantRoot = stringValue(params.grantRoot);
    return {
      command: null,
      paths: grantRoot ? [grantRoot] : null,
      writes: grantRoot ? [grantRoot] : [],
      network: null,
      // The pinned response protocol exposes acceptForSession here too.
      canPersist: true,
      // FileChangeRequestApprovalParams has no delete-count field.
      deleteCount: null,
    };
  }
  if (method === "item/permissions/requestApproval") {
    return permissionApprovalFacts(params);
  }
  return null;
}

function normalizeFileChanges(value: unknown): ActivityFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawChange) => {
    const change = record(rawChange);
    const path = stringValue(change?.path);
    if (!change || !path) return [];
    const kind = record(change.kind);
    const providerKind = stringValue(kind?.type) ?? stringValue(change.kind) ??
      stringValue(change.operation);
    const movePath = stringValue(kind?.move_path) ?? stringValue(change.movePath);
    const operation: ActivityFileChange["operation"] = movePath
      ? "rename"
      : providerKind === "add" || providerKind === "delete"
      ? providerKind
      : providerKind === "rename"
      ? "rename"
      : "update";
    return [{
      path: movePath ?? path,
      previousPath: movePath ? path : null,
      operation,
      diff: stringValue(change.diff) ?? "",
    }];
  });
}

function aggregateDiffChanges(diff: string): ActivityFileChange[] {
  const headers = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu)];
  if (headers.length === 0) {
    const path = /^\+\+\+ b\/(.+)$/mu.exec(diff)?.[1] ??
      /^--- a\/(.+)$/mu.exec(diff)?.[1] ?? "(turn diff)";
    return [{ path, previousPath: null, operation: "update", diff }];
  }
  return headers.map((match, index) => {
    const start = match.index ?? 0;
    const end = headers[index + 1]?.index ?? diff.length;
    const patch = diff.slice(start, end);
    const oldPath = match[1] as string;
    const newPath = match[2] as string;
    const renamedTo = /^rename to (.+)$/mu.exec(patch)?.[1];
    const operation: ActivityFileChange["operation"] = /^--- \/dev\/null$/mu.test(patch)
      ? "add"
      : /^\+\+\+ \/dev\/null$/mu.test(patch)
      ? "delete"
      : renamedTo
      ? "rename"
      : "update";
    return {
      path: operation === "rename"
        ? renamedTo ?? newPath
        : operation === "delete"
        ? oldPath
        : newPath,
      previousPath: operation === "rename" ? oldPath : null,
      operation,
      diff: patch,
    };
  });
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    const part = record(entry);
    if (!part) return [];
    if (part.type === "text" && typeof part.text === "string") return [part.text];
    if (part.type === "image" || part.type === "localImage") return ["[Image]"];
    if (part.type === "audio" || part.type === "localAudio") return ["[Audio]"];
    if ((part.type === "skill" || part.type === "mention") &&
        typeof part.name === "string") {
      return [`[${part.type === "skill" ? "Skill" : "Mention"}: ${part.name}]`];
    }
    return [];
  }).join("\n");
}

function activityState(value: unknown, completed: boolean): ActivityState {
  if (value === "failed") return "failed";
  if (value === "interrupted") return "interrupted";
  if (value === "declined") return "interrupted";
  if (value === "completed" || completed) return "complete";
  if (value === "waiting") return "waiting";
  if (value === "pending") return "pending";
  return "running";
}

function baseItem<K extends ActivityItemDraft["kind"]>(
  id: string,
  kind: K,
  turnId: string | null,
  state: ActivityState,
  startedAt: string | null,
  updatedAt: string | null,
  completedAt: string | null,
): {
  id: string;
  kind: K;
  turnId: string | null;
  parentId: null;
  state: ActivityState;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  source: "provider-api";
  confidence: "exact";
  exposure: "provider-exposed";
} {
  return {
    id,
    kind,
    turnId,
    parentId: null,
    state,
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    source: "provider-api",
    confidence: "exact",
    exposure: "provider-exposed",
  };
}

function upsert(item: ActivityItemDraft): ActivityMutation {
  return { type: "upsert", item };
}

function append(
  id: string,
  channel: CodexActivityAppendChannel,
  text: string,
  offsetFor: CodexActivityOffsetLookup,
): ActivityMutation[] {
  if (text.length === 0) return [];
  return [{ type: "append", id, channel, offset: offsetFor(id, channel), text }];
}

function itemTimes(
  notification: JsonRpcNotification,
  completed: boolean,
): { startedAt: string | null; updatedAt: string | null; completedAt: string | null } {
  const emittedAt = notificationTime(notification);
  const lifecycleAt = isoFromMilliseconds(
    completed ? notification.params.completedAtMs : notification.params.startedAtMs,
  );
  return {
    startedAt: completed ? null : lifecycleAt ?? emittedAt,
    updatedAt: emittedAt ?? lifecycleAt,
    completedAt: completed ? lifecycleAt ?? emittedAt : null,
  };
}

function toolItem(
  id: string,
  turnId: string,
  state: ActivityState,
  times: ReturnType<typeof itemTimes>,
  fields: {
    toolCallId: string;
    name: string;
    category: NonNullable<Extract<ActivityItemDraft, { kind: "tool" }>["category"]>;
    arguments: string | null;
    result: string | null;
    output: string | null;
  },
): ActivityMutation {
  const { output, ...rest } = fields;
  return upsert({
    ...baseItem(id, "tool", turnId, state, times.startedAt, times.updatedAt, times.completedAt),
    correlationId: `tool:${fields.toolCallId}`,
    ...rest,
    ...(output === null ? {} : { output }),
  });
}

function projectThreadItem(
  notification: JsonRpcNotification,
  completed: boolean,
  structuredPlanFor: CodexStructuredPlanLookup,
): CodexActivityProjection | null {
  const { params } = notification;
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId);
  const item = record(params.item);
  const itemId = stringValue(item?.id);
  const itemType = stringValue(item?.type);
  if (!threadId || !turnId || !item || !itemId || !itemType) return null;

  const id = itemActivityId(threadId, turnId, itemId);
  const times = itemTimes(notification, completed);
  const state = activityState(item.status, completed);
  const mutations: ActivityMutation[] = [];

  switch (itemType) {
    case "userMessage":
      {
        const text = textContent(item.content);
        mutations.push(upsert({
          ...baseItem(id, "message", turnId, state, times.startedAt, times.updatedAt, times.completedAt),
          correlationId: codexMessageCorrelationId(threadId, turnId, "user", text),
          role: "user",
          phase: null,
          text,
          label: null,
        }));
      }
      break;
    case "hookPrompt": {
      const text = Array.isArray(item.fragments)
        ? item.fragments.flatMap((fragment) => {
            const value = record(fragment);
            return typeof value?.text === "string" ? [value.text] : [];
          }).join("\n")
        : "";
      mutations.push(upsert({
        ...baseItem(id, "message", turnId, state, times.startedAt, times.updatedAt, times.completedAt),
        correlationId: `message:${itemId}`,
        role: "system",
        phase: null,
        text,
        label: "Hook prompt",
      }));
      break;
    }
    case "agentMessage":
      {
        const extracted = extractTrailingMemoryCitation(stringValue(item.text) ?? "");
        const text = extracted.text;
        const memoryCitation = parseMemoryCitation(item.memory_citation ?? item.memoryCitation)
          ?? extracted.memoryCitation;
        const final = item.phase === "final_answer" || item.phase === "final";
        const proposedPlan = final ? parseProposedPlan(text) : null;
        const planId = codexProposedPlanId(threadId, turnId);
        if (proposedPlan !== null && !structuredPlanFor(planId)) {
          mutations.push(upsert({
            ...baseItem(planId, "plan", turnId, state, times.startedAt, times.updatedAt, times.completedAt),
            correlationId: codexProposedPlanCorrelationId(threadId, turnId),
            path: null,
            version: null,
            markdown: proposedPlan,
            supersededBy: null,
            approvalRequestId: null,
            approvedAt: null,
          }));
        } else if (proposedPlan === null) {
          mutations.push(upsert({
            ...baseItem(id, "message", turnId, state, times.startedAt, times.updatedAt, times.completedAt),
            correlationId: final
              ? codexMessageCorrelationId(threadId, turnId, "assistant", text)
              : `message:${itemId}`,
            role: "assistant",
            phase: item.phase === "commentary"
              ? "commentary"
              : final
              ? "final"
              : null,
            text,
            label: null,
            memoryCitation,
          }));
        }
        // Plans have no citation field on the public activity shape. Keep the
        // parsed source list as a neighbouring, textless message instead of
        // discarding it or leaking the XML wrapper back into the transcript.
        if (proposedPlan !== null && memoryCitation) {
          mutations.push(upsert({
            ...baseItem(
              itemActivityId(threadId, turnId, itemId, "memory-citation"),
              "message",
              turnId,
              state,
              times.startedAt,
              times.updatedAt,
              times.completedAt,
            ),
            correlationId: `${codexProposedPlanCorrelationId(threadId, turnId)}:memory-citation`,
            role: "assistant",
            phase: null,
            text: "",
            label: null,
            memoryCitation,
          }));
        }
      }
      break;
    case "plan": {
      const markdown = stringValue(item.text) ?? textContent(item.content);
      if (!markdown.trim()) break;
      mutations.push(upsert({
        ...baseItem(
          codexProposedPlanId(threadId, turnId),
          "plan",
          turnId,
          state,
          times.startedAt,
          times.updatedAt,
          times.completedAt,
        ),
        correlationId: codexProposedPlanCorrelationId(threadId, turnId),
        path: null,
        version: null,
        markdown: markdown.trim(),
        supersededBy: null,
        approvalRequestId: null,
        approvedAt: null,
      }));
      break;
    }
    case "reasoning": {
      const summaries = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      summaries.forEach((value, index) => {
        if (typeof value !== "string") return;
        mutations.push(upsert({
          ...baseItem(
            itemActivityId(threadId, turnId, itemId, `summary-${String(index)}`),
            "reasoning",
            turnId,
            state,
            times.startedAt,
            times.updatedAt,
            times.completedAt,
          ),
          correlationId: `reasoning:${itemId}:summary:${String(index)}`,
          reasoningKind: "summary",
          label: "Thinking",
          text: value,
        }));
      });
      content.forEach((value, index) => {
        if (typeof value !== "string") return;
        mutations.push(upsert({
          ...baseItem(
            itemActivityId(threadId, turnId, itemId, `raw-${String(index)}`),
            "reasoning",
            turnId,
            state,
            times.startedAt,
            times.updatedAt,
            times.completedAt,
          ),
          correlationId: `reasoning:${itemId}:raw:${String(index)}`,
          reasoningKind: "raw",
          label: "Provider reasoning",
          text: value,
        }));
      });
      break;
    }
    case "commandExecution": {
      const command = stringValue(item.command) ?? "Command";
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: command,
        category: "command",
        arguments: jsonText({
          command,
          cwd: item.cwd ?? null,
          source: item.source ?? null,
          commandActions: item.commandActions ?? [],
          pluginId: item.pluginId ?? null,
          scriptPath: item.scriptPath ?? null,
        }),
        result: finiteNumber(item.exitCode) === null
          ? null
          : `Exit code ${String(item.exitCode)}`,
        output: stringValue(item.aggregatedOutput),
      }));
      break;
    }
    case "fileChange": {
      const changes = normalizeFileChanges(item.changes);
      mutations.push(upsert({
        ...baseItem(id, "file-change", turnId, state, times.startedAt, times.updatedAt, times.completedAt),
        summary: changes.length === 1 ? "1 file change" : `${String(changes.length)} file changes`,
        changes,
      }));
      break;
    }
    case "mcpToolCall": {
      const server = stringValue(item.server) ?? "MCP";
      const tool = stringValue(item.tool) ?? "tool";
      const error = record(item.error);
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: `${server}.${tool}`,
        category: "mcp",
        arguments: jsonText(item.arguments),
        result: stringValue(error?.message) ?? jsonText(item.result),
        output: null,
      }));
      break;
    }
    case "dynamicToolCall": {
      const namespace = stringValue(item.namespace);
      const tool = stringValue(item.tool) ?? "tool";
      /*
        `request_user_input` reaches this projector twice: once as the server
        request that carries the questions and can be answered, and once as the
        plain tool row below. The tool row has no transcript twin to reconcile
        against — the transcript turns that call into an attention item too — so
        it survived as a second, inert `request_user_input` beside the
        questionnaire. The attention item is the faithful rendering of this call.
      */
      if (tool === "request_user_input") break;
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: namespace ? `${namespace}.${tool}` : tool,
        category: "dynamic",
        arguments: jsonText(item.arguments),
        result: jsonText(item.contentItems),
        output: null,
      }));
      break;
    }
    case "collabAgentToolCall": {
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: stringValue(item.tool) ?? "Agent collaboration",
        category: "collaboration",
        arguments: jsonText({
          senderThreadId: item.senderThreadId ?? null,
          receiverThreadIds: item.receiverThreadIds ?? [],
          prompt: item.prompt ?? null,
          model: item.model ?? null,
          reasoningEffort: item.reasoningEffort ?? null,
        }),
        result: jsonText(item.agentsStates),
        output: null,
      }));

      if (item.tool === "spawnAgent" && Array.isArray(item.receiverThreadIds)) {
        const agentsStates = record(item.agentsStates);
        for (const receiverThreadId of item.receiverThreadIds) {
          const childThreadId = stringValue(receiverThreadId);
          if (!childThreadId) continue;
          const childState = record(agentsStates?.[childThreadId]);
          mutations.push(upsert({
            ...baseItem(
              subagentActivityId(childThreadId),
              "subagent",
              turnId,
              collabAgentActivityState(childState?.status),
              times.startedAt,
              times.updatedAt,
              null,
            ),
            parentId: id,
            taskId: childThreadId,
            name: "Codex subagent",
            description: stringValue(item.prompt),
            output: stringValue(childState?.message) ?? "",
            childItemIds: [],
          }));
        }
      }
      break;
    }
    case "subAgentActivity": {
      const childThreadId = stringValue(item.agentThreadId) ?? itemId;
      // This event carries no spawning tool identity. Reuse the child-thread
      // item without a parent field so an earlier exact spawn edge survives;
      // never mirror activity across sessions or synthesize child-step edges.
      const { parentId: _parentId, ...activityBase } = baseItem(
        subagentActivityId(childThreadId),
        "subagent",
        turnId,
        item.kind === "interrupted" ? "interrupted" : "running",
        times.startedAt,
        times.updatedAt,
        item.kind === "interrupted" ? times.completedAt : null,
      );
      mutations.push(upsert({
        ...activityBase,
        taskId: childThreadId,
        name: stringValue(item.agentPath) ?? "Subagent",
        description: stringValue(item.kind),
        output: "",
        childItemIds: [],
      }));
      break;
    }
    case "webSearch":
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: "Web search",
        category: "web-search",
        arguments: jsonText({ query: item.query ?? null, action: item.action ?? null }),
        result: jsonText(item.results),
        output: null,
      }));
      break;
    case "imageView":
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: "View image",
        category: "image-view",
        arguments: jsonText({ path: item.path ?? null }),
        result: null,
        output: null,
      }));
      break;
    case "imageGeneration":
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: "Generate image",
        category: "other",
        arguments: jsonText({ revisedPrompt: item.revisedPrompt ?? null }),
        result: jsonText({ result: item.result ?? null, savedPath: item.savedPath ?? null }),
        output: null,
      }));
      break;
    case "sleep":
      mutations.push(toolItem(id, turnId, state, times, {
        toolCallId: itemId,
        name: "Sleep",
        category: "other",
        arguments: jsonText({ durationMs: item.durationMs ?? null }),
        result: null,
        output: null,
      }));
      break;
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      mutations.push(upsert({
        ...baseItem(id, "lifecycle", turnId, state, times.startedAt, times.updatedAt, times.completedAt),
        event: itemType === "contextCompaction" ? "context-compaction" : "status",
        level: "info",
        title: itemType === "enteredReviewMode"
          ? "Entered review mode"
          : itemType === "exitedReviewMode"
          ? "Exited review mode"
          : "Context compacted",
        details: stringValue(item.review),
      }));
      break;
  }

  return mutations.length > 0 ? { threadId, mutations } : null;
}

function deltaProjection(
  notification: JsonRpcNotification,
  suffix: string | null,
  channel: CodexActivityAppendChannel,
  text: unknown,
  offsetFor: CodexActivityOffsetLookup,
): CodexActivityProjection | null {
  const threadId = stringValue(notification.params.threadId);
  const turnId = stringValue(notification.params.turnId);
  const itemId = stringValue(notification.params.itemId);
  if (!threadId || !turnId || !itemId || typeof text !== "string") return null;
  const id = itemActivityId(threadId, turnId, itemId, suffix ?? undefined);
  const mutations = append(id, channel, text, offsetFor);
  return mutations.length > 0 ? { threadId, mutations } : null;
}

function lifecycleMutation(
  notification: JsonRpcNotification,
  turn: Record<string, unknown>,
  completed: boolean,
): CodexActivityProjection | null {
  const threadId = stringValue(notification.params.threadId);
  const turnId = stringValue(turn.id);
  if (!threadId || !turnId) return null;
  const providerStatus = stringValue(turn.status);
  const state = activityState(providerStatus, completed && providerStatus === "completed");
  const error = record(turn.error);
  const emittedAt = notificationTime(notification);
  const startedAt = isoFromSeconds(turn.startedAt) ?? (!completed ? emittedAt : null);
  const completedAt = completed ? isoFromSeconds(turn.completedAt) ?? emittedAt : null;
  const details = error
    ? jsonText({
        message: error.message ?? null,
        codexErrorInfo: error.codexErrorInfo ?? null,
        additionalDetails: error.additionalDetails ?? null,
      })
    : null;
  const lifecycleEvent = !completed
    ? "turn-started"
    : state === "failed"
    ? "turn-failed"
    : state === "interrupted"
    ? "turn-interrupted"
    : "turn-completed";
  return {
    threadId,
    mutations: [upsert({
      ...baseItem(
        turnActivityId(threadId, turnId),
        "lifecycle",
        turnId,
        state,
        startedAt,
        emittedAt ?? completedAt ?? startedAt,
        completedAt,
      ),
      event: lifecycleEvent,
      level: state === "failed" ? "error" : "info",
      title: completed
        ? state === "failed"
          ? "Turn failed"
          : state === "interrupted"
          ? "Turn interrupted"
          : "Turn completed"
        : "Turn started",
      details,
    })],
  };
}

function warningProjection(
  notification: JsonRpcNotification,
  title: string,
): CodexActivityProjection | null {
  const threadId = stringValue(notification.params.threadId);
  const message = stringValue(notification.params.message);
  if (!threadId || !message) return null;
  const updatedAt = notificationTime(notification);
  const id = scopedId(
    "warning",
    threadId,
    contentHash(title, message, updatedAt ?? ""),
  );
  return {
    threadId,
    mutations: [upsert({
      ...baseItem(id, "lifecycle", null, "complete", updatedAt, updatedAt, updatedAt),
      event: "warning",
      level: "warning",
      title,
      details: message,
    })],
  };
}

export function projectCodexNotification(
  notification: JsonRpcNotification,
  offsetFor: CodexActivityOffsetLookup = zeroOffset,
  todoFor: CodexActivityTodoLookup = noTodoState,
  structuredPlanFor: CodexStructuredPlanLookup = noStructuredPlan,
): CodexActivityProjection | null {
  const { params } = notification;
  switch (notification.method) {
    case "item/started": return projectThreadItem(notification, false, structuredPlanFor);
    case "item/completed": return projectThreadItem(notification, true, structuredPlanFor);
    case "item/agentMessage/delta":
      return deltaProjection(notification, null, "text", params.delta, offsetFor);
    case "item/plan/delta": return null;
    case "item/reasoning/summaryTextDelta": {
      const index = finiteNumber(params.summaryIndex);
      return index === null
        ? null
        : deltaProjection(notification, `summary-${String(index)}`, "text", params.delta, offsetFor);
    }
    case "item/reasoning/summaryPartAdded": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      const itemId = stringValue(params.itemId);
      const index = finiteNumber(params.summaryIndex);
      if (!threadId || !turnId || !itemId || index === null) return null;
      const updatedAt = notificationTime(notification);
      return {
        threadId,
        mutations: [upsert({
          ...baseItem(
            itemActivityId(threadId, turnId, itemId, `summary-${String(index)}`),
            "reasoning",
            turnId,
            "running",
            updatedAt,
            updatedAt,
            null,
          ),
          reasoningKind: "summary",
          label: "Thinking",
          text: "",
        })],
      };
    }
    case "item/reasoning/textDelta": {
      const index = finiteNumber(params.contentIndex);
      return index === null
        ? null
        : deltaProjection(notification, `raw-${String(index)}`, "text", params.delta, offsetFor);
    }
    case "item/commandExecution/outputDelta":
      return deltaProjection(notification, null, "output", params.delta, offsetFor);
    case "item/mcpToolCall/progress": {
      const message = stringValue(params.message);
      return deltaProjection(
        notification,
        null,
        "output",
        message ? `${message}\n` : null,
        offsetFor,
      );
    }
    case "item/fileChange/patchUpdated": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      const itemId = stringValue(params.itemId);
      if (!threadId || !turnId || !itemId || !Array.isArray(params.changes)) return null;
      const updatedAt = notificationTime(notification);
      return {
        threadId,
        mutations: [upsert({
          ...baseItem(
            itemActivityId(threadId, turnId, itemId),
            "file-change",
            turnId,
            "running",
            null,
            updatedAt,
            null,
          ),
          summary: params.changes.length === 1
            ? "1 file change"
            : `${String(params.changes.length)} file changes`,
          changes: normalizeFileChanges(params.changes),
        })],
      };
    }
    case "turn/diff/updated": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      const diff = stringValue(params.diff);
      if (!threadId || !turnId || diff === null) return null;
      const updatedAt = notificationTime(notification);
      return {
        threadId,
        mutations: [upsert({
          ...baseItem(
            scopedId("turn-diff", threadId, turnId),
            "file-change",
            turnId,
            "running",
            null,
            updatedAt,
            null,
          ),
          summary: "Turn diff",
          changes: aggregateDiffChanges(diff),
        })],
      };
    }
    case "turn/plan/updated": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      if (!threadId || !turnId || !Array.isArray(params.plan)) return null;
      const updatedAt = notificationTime(notification);
      const occurrences = new Map<string, number>();
      const nextSteps: ActivityTodoInputStep[] = params.plan.flatMap((value) => {
        const step = record(value);
        const text = stringValue(step?.step);
        const status = stringValue(step?.status);
        if (!text || !status) return [];
        const normalizedStatus: ActivityTodoInputStep["status"] = status === "inProgress"
          ? "in_progress"
          : status === "completed"
          ? "completed"
          : "pending";
        const occurrence = occurrences.get(text) ?? 0;
        occurrences.set(text, occurrence + 1);
        return [{
          id: scopedId("todo-step", threadId, turnId, contentHash(text), String(occurrence)),
          text,
          status: normalizedStatus,
          detail: null,
        }];
      });
      const todoId = scopedId("turn-todo", threadId, turnId);
      const previous = todoFor(todoId);
      const rewrite = reconcileTodoRewrite(previous, nextSteps);
      return {
        threadId,
        mutations: [upsert({
          ...baseItem(
            todoId,
            "todo",
            turnId,
            nextSteps.some((step) => step.status === "in_progress")
              ? "running"
              : nextSteps.length > 0 && nextSteps.every((step) => step.status === "completed")
              ? "complete"
              : "pending",
            null,
            updatedAt,
            null,
          ),
          steps: rewrite.steps,
          added: rewrite.added,
          removed: rewrite.removed,
        })],
      };
    }
    case "turn/started": {
      const turn = record(params.turn);
      return turn ? lifecycleMutation(notification, turn, false) : null;
    }
    case "turn/completed": {
      const turn = record(params.turn);
      return turn ? lifecycleMutation(notification, turn, true) : null;
    }
    case "thread/tokenUsage/updated": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      const usage = record(params.tokenUsage);
      const last = record(usage?.last);
      const total = record(usage?.total);
      if (!threadId || !turnId || !last || !total) return null;
      const updatedAt = notificationTime(notification);
      const usageItem = (
        id: string,
        scope: "turn" | "thread",
        value: Record<string, unknown>,
      ): ActivityMutation => upsert({
        ...baseItem(id, "usage", turnId, "complete", null, updatedAt, updatedAt),
        scope,
        inputTokens: finiteNumber(value.inputTokens),
        outputTokens: finiteNumber(value.outputTokens),
        cachedInputTokens: finiteNumber(value.cachedInputTokens),
        reasoningTokens: finiteNumber(value.reasoningOutputTokens),
        totalTokens: finiteNumber(value.totalTokens),
        costUsd: null,
        // Codex states the window on every usage notification. Dropping it left
        // the token counts without a denominator.
        contextWindow: finiteNumber(usage?.modelContextWindow),
      });
      return {
        threadId,
        mutations: [
          usageItem(scopedId("usage-turn", threadId, turnId), "turn", last),
          usageItem(scopedId("usage-thread", threadId), "thread", total),
        ],
      };
    }
    case "error": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      const error = record(params.error);
      if (!threadId || !turnId || !error) return null;
      const updatedAt = notificationTime(notification);
      const willRetry = params.willRetry === true;
      return {
        threadId,
        mutations: [upsert({
          ...baseItem(
            turnActivityId(threadId, turnId),
            "lifecycle",
            turnId,
            willRetry ? "running" : "failed",
            null,
            updatedAt,
            willRetry ? null : updatedAt,
          ),
          event: "error",
          level: "error",
          title: willRetry ? "Turn error; retrying" : "Turn failed",
          details: jsonText({
            message: error.message ?? null,
            codexErrorInfo: error.codexErrorInfo ?? null,
            additionalDetails: error.additionalDetails ?? null,
          }),
        })],
      };
    }
    case "warning": return warningProjection(notification, "Codex warning");
    case "guardianWarning": return warningProjection(notification, "Guardian warning");
    case "thread/compacted": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      if (!threadId || !turnId) return null;
      const updatedAt = notificationTime(notification);
      return {
        threadId,
        mutations: [upsert({
          ...baseItem(
            scopedId("compaction", threadId, turnId),
            "lifecycle",
            turnId,
            "complete",
            updatedAt,
            updatedAt,
            updatedAt,
          ),
          event: "context-compaction",
          level: "info",
          title: "Context compacted",
          details: null,
        })],
      };
    }
    case "serverRequest/resolved": {
      const threadId = stringValue(params.threadId);
      const requestId = params.requestId;
      if (!threadId || (typeof requestId !== "string" && typeof requestId !== "number")) {
        return null;
      }
      return projectCodexRequestResolved(threadId, requestId, notification.emittedAtMs);
    }
    case "model/rerouted": {
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      if (!threadId || !turnId) return null;
      const updatedAt = notificationTime(notification);
      return {
        threadId,
        mutations: [upsert({
          ...baseItem(
            scopedId("model-reroute", threadId, turnId),
            "lifecycle",
            turnId,
            "complete",
            updatedAt,
            updatedAt,
            updatedAt,
          ),
          event: "model-routing",
          level: "warning",
          title: "Model rerouted",
          details: jsonText({
            fromModel: params.fromModel ?? null,
            toModel: params.toModel ?? null,
            reason: params.reason ?? null,
          }),
        })],
      };
    }
    // Deliberately hidden: terminal stdin, raw Responses API envelopes, and
    // connection-scoped command/process output that Agent Manager did not start.
    case "item/commandExecution/terminalInteraction":
    case "rawResponseItem/completed":
    case "rawResponse/completed":
    case "command/exec/outputDelta":
    case "process/outputDelta":
    case "process/exited":
      return null;
    default:
      return null;
  }
}

export function projectCodexServerRequest(
  request: JsonRpcServerRequest,
): CodexActivityProjection | null {
  const threadId = stringValue(request.params.threadId);
  if (!threadId) return null;
  const turnId = stringValue(request.params.turnId);
  const questions: ActivityAttentionQuestion[] = normalizeCodexQuestions(
    request.params.questions,
  ).map((question) => ({
    id: question.id,
    ...(question.header ? { header: question.header } : {}),
    text: question.text,
    options: question.options,
    multiSelect: question.multiSelect,
    allowFreeText: question.allowFreeText,
    isSecret: question.isSecret,
  }));
  const isSecret = questions.some((question) => question.isSecret === true);
  let attentionKind: Extract<
    ActivityItemDraft,
    { kind: "attention" }
  >["attentionKind"] = "blocked";
  let title = "Unsupported Codex request";
  let summary: string | null = request.method;
  let respondable = false;

  switch (request.method) {
    case "item/tool/requestUserInput":
      attentionKind = "question";
      title = questions.length === 1 ? "Codex needs your answer" : "Codex needs your answers";
      summary = questions.length > 0 ? null : "Codex is waiting for input";
      // Secret answers take the same live response path, while `isSecret`
      // instructs the server/UI to avoid durable storage and use password UI.
      respondable = questions.length > 0;
      break;
    case "item/commandExecution/requestApproval":
      attentionKind = "approval";
      title = "Command approval";
      summary = stringValue(request.params.reason) ??
        stringValue(request.params.command) ?? "Codex wants to run a command";
      respondable = true;
      break;
    case "item/fileChange/requestApproval":
      attentionKind = "approval";
      title = "File-change approval";
      summary = stringValue(request.params.reason) ?? "Codex wants to change files";
      respondable = true;
      break;
    case "item/permissions/requestApproval":
      attentionKind = "permission";
      title = "Permission request";
      summary = stringValue(request.params.reason) ?? "Codex is requesting additional access";
      respondable = true;
      break;
    case "mcpServer/elicitation/request":
      attentionKind = "elicitation";
      title = "MCP input requested";
      summary = stringValue(request.params.message) ??
        stringValue(request.params.serverName) ?? "An MCP server needs input";
      // The current cockpit cannot faithfully encode form or URL elicitations.
      respondable = false;
      break;
  }

  const startedAt = isoFromMilliseconds(request.params.startedAtMs) ??
    notificationTime(request);
  const updatedAt = notificationTime(request) ?? startedAt;
  const correlation = codexRequestUserInputKey(
    threadId,
    stringValue(request.params.itemId),
    stringValue(request.params.callId),
  );
  return {
    threadId,
    mutations: [upsert({
      ...baseItem(
        requestActivityId(threadId, request.id),
        "attention",
        turnId,
        "waiting",
        startedAt,
        updatedAt,
        null,
      ),
      ...(request.method === "item/tool/requestUserInput" && correlation
        ? { correlationId: correlation }
        : {}),
      requestId: jsonRpcIdKey(request.id),
      attentionKind,
      title,
      summary,
      questions,
      approvalFacts: codexApprovalFacts(request.method, request.params),
      respondable,
      resolved: false,
      isSecret,
    })],
  };
}

export function projectCodexRequestResolved(
  threadId: string,
  requestId: JsonRpcId,
  emittedAtMs: number | null,
  pending?: CodexPendingRequest,
): CodexActivityProjection {
  const updatedAt = isoFromMilliseconds(emittedAtMs);
  const receivedAtMs = pending ? Date.parse(pending.receivedAt) : Number.NaN;
  const priorProjection = pending
    ? projectCodexServerRequest({
        id: pending.id,
        method: pending.method,
        params: pending.params,
        emittedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : null,
      })
    : null;
  const priorMutation = priorProjection?.mutations[0];
  const priorItem = priorMutation?.type === "upsert" &&
      priorMutation.item.kind === "attention"
    ? priorMutation.item
    : null;
  return {
    threadId,
    mutations: [upsert(priorItem ? {
      ...priorItem,
      state: "complete",
      updatedAt,
      completedAt: updatedAt,
      respondable: false,
      resolved: true,
    } : {
      ...baseItem(
        requestActivityId(threadId, requestId),
        "attention",
        null,
        "complete",
        null,
        updatedAt,
        updatedAt,
      ),
      requestId: jsonRpcIdKey(requestId),
      attentionKind: "blocked",
      title: null,
      summary: null,
      questions: [],
      approvalFacts: null,
      respondable: false,
      resolved: true,
      isSecret: false,
    })],
  };
}

export function projectCodexQueue(
  threadId: string,
  queue: readonly CodexQueuedMessage[],
  updatedAt: string | null,
): CodexActivityProjection {
  return {
    threadId,
    mutations: [upsert({
      ...baseItem(
        scopedId("queue", threadId),
        "queue",
        null,
        queue.length > 0 ? "waiting" : "complete",
        null,
        updatedAt,
        queue.length > 0 ? null : updatedAt,
      ),
      messages: queue.map((message) => ({
        id: message.id,
        text: message.text,
        status: message.status,
        enqueuedAt: message.enqueuedAt,
        turnId: message.turnId,
      })),
    })],
  };
}

export function projectCodexDiagnostic(
  threadId: string,
  code: string,
  message: string,
  updatedAt: string | null,
): CodexActivityProjection {
  return {
    threadId,
    mutations: [upsert({
      ...baseItem(
        scopedId("diagnostic", threadId, code),
        "lifecycle",
        null,
        "failed",
        updatedAt,
        updatedAt,
        updatedAt,
      ),
      event: "error",
      level: "error",
      title: "Codex diagnostic",
      details: message,
    })],
  };
}

export function recordCodexActivityOffsets(
  offsets: Map<string, number>,
  mutation: ActivityMutation,
): void {
  if (mutation.type === "reset") {
    offsets.clear();
    return;
  }
  if (mutation.type === "remove") {
    for (const key of offsets.keys()) {
      if (key.startsWith(`${mutation.id}\u0000`)) offsets.delete(key);
    }
    return;
  }
  if (mutation.type === "append") {
    offsets.set(
      `${mutation.id}\u0000${mutation.channel}`,
      mutation.offset + Buffer.byteLength(mutation.text, "utf8"),
    );
    return;
  }
  if (mutation.type === "retention-boundary") return;

  const item = mutation.item as unknown as Record<string, unknown>;
  const id = stringValue(item.id);
  if (!id) return;
  for (const key of offsets.keys()) {
    if (key.startsWith(`${id}\u0000`)) offsets.delete(key);
  }
  const fields: Array<[CodexActivityAppendChannel, unknown]> = [
    ["text", item.text],
    ["arguments", item.arguments],
    ["result", item.result],
    ["output", item.output],
    ["details", item.details],
  ];
  for (const [channel, value] of fields) {
    if (typeof value === "string") {
      offsets.set(`${id}\u0000${channel}`, Buffer.byteLength(value, "utf8"));
    }
  }
}

export function codexActivityOffset(
  offsets: ReadonlyMap<string, number>,
  id: string,
  channel: CodexActivityAppendChannel,
): number {
  return offsets.get(`${id}\u0000${channel}`) ?? 0;
}

export function recordCodexTodoProjectionState(
  states: Map<string, CodexTodoProjectionState>,
  mutation: ActivityMutation,
): void {
  if (mutation.type === "reset") {
    states.clear();
    return;
  }
  if (mutation.type === "remove") {
    states.delete(mutation.id);
    return;
  }
  if (mutation.type !== "upsert" || mutation.item.kind !== "todo") return;
  const previous = states.get(mutation.item.id);
  states.set(mutation.item.id, {
    steps: mutation.item.steps ?? previous?.steps ?? [],
    added: mutation.item.added ?? previous?.added ?? 0,
    removed: mutation.item.removed ?? previous?.removed ?? 0,
  });
}
