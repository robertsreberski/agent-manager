import { createHash } from "node:crypto";

import type {
  ActivityAttentionQuestion,
  ActivityItemDraft,
  ActivityJsonValue,
  ActivityMutation,
  ActivityState,
  ActivityTodoInputStep,
  ActivityTodoRewriteState,
} from "../../activity/index.ts";
import { reconcileTodoRewrite } from "../../activity/index.ts";
import type {
  ClaudeManagedSessionSnapshot,
  ClaudePendingRequest,
  ClaudeSdkMessage,
} from "./types.ts";
import { toolApprovalFacts } from "../approval-facts.ts";

interface StreamBlock {
  id: string;
  kind: "text" | "thinking" | "tool" | "ignored";
  text: string;
  textOffset: number;
  toolCallId: string | null;
  toolName: string | null;
  partialJson: string;
}

interface StreamLane {
  messageId: string;
  parentToolUseId: string | null;
  turnId: string;
  blocks: Map<number, StreamBlock>;
}

interface SubagentRecord {
  itemId: string;
  taskId: string;
  name: string;
  description: string | null;
  childItemIds: Set<string>;
}

interface ToolRecord {
  name: string;
  category: NonNullable<Extract<ActivityItemDraft, { kind: "tool" }>["category"]>;
  turnId: string | null;
  parentId: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatUnixTimestamp(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  // Claude 0.3.220 reports rate-limit reset times in Unix seconds while other
  // SDK timestamps use milliseconds. Accept both wire representations.
  const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableSegment(value: string): string {
  return encodeURIComponent(value);
}

function itemId(kind: string, value: string): string {
  return `claude:${kind}:${stableSegment(value)}`;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    const block = objectValue(entry);
    if (!block) return [];
    if (block.type === "text" && typeof block.text === "string") {
      return [block.text];
    }
    if (block.type === "image") return ["[Image]"];
    if (block.type === "document") return ["[Document]"];
    if (block.type === "tool_result") return [contentText(block.content)];
    return [];
  }).filter((text) => text.length > 0).join("\n");
}

function toActivityJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): ActivityJsonValue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (depth >= 16 || seen.has(value)) return "[Truncated]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => toActivityJson(entry, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  const result: Record<string, ActivityJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
      continue;
    }
    result[key] = toActivityJson(entry, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function parseJsonOrText(value: string): ActivityJsonValue | string | null {
  if (value.length === 0) return null;
  try {
    return toActivityJson(JSON.parse(value));
  } catch {
    return value;
  }
}

function toolCategory(
  name: string,
  blockType?: string,
): NonNullable<Extract<ActivityItemDraft, { kind: "tool" }>["category"]> {
  if (blockType === "mcp_tool_use" || name.startsWith("mcp__")) return "mcp";
  if (/^(?:bash|shell|terminal|command)$/i.test(name)) return "command";
  if (/^(?:websearch|webfetch|web_search|web_fetch)$/i.test(name)) {
    return "web-search";
  }
  if (/^(?:viewimage|image|image_view)$/i.test(name)) return "image-view";
  if (/^(?:task|agent|sendmessage|teamcreate|teamdelete)$/i.test(name)) {
    return "collaboration";
  }
  if (blockType === "server_tool_use") return "dynamic";
  return "other";
}

function taskState(value: string): ActivityState {
  switch (value) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "interrupted";
    default:
      return "running";
  }
}

function requestQuestions(request: ClaudePendingRequest): ActivityAttentionQuestion[] {
  if (request.kind !== "question") return [];
  const input = objectValue(request.payload.input);
  if (!Array.isArray(input?.questions)) return [];
  return input.questions.flatMap((rawQuestion, index) => {
    const question = objectValue(rawQuestion);
    if (!question || typeof question.question !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          if (typeof rawOption === "string") {
            return [{ label: rawOption, description: null, recommended: null }];
          }
          const option = objectValue(rawOption);
          if (!option || typeof option.label !== "string") return [];
          return [{
            label: option.label,
            description: typeof option.description === "string"
              ? option.description
              : null,
            recommended: typeof option.recommended === "boolean"
              ? option.recommended
              : null,
          }];
        })
      : [];
    return [{
      id: typeof question.header === "string" && question.header.length > 0
        ? question.header
        : `question-${index + 1}`,
      text: question.question,
      options,
      multiSelect: question.multiSelect === true,
      allowFreeText: question.allowFreeText !== false,
      isSecret: question.isSecret === true,
    }];
  });
}

function requestKind(
  request: ClaudePendingRequest,
): Extract<ActivityItemDraft, { kind: "attention" }>["attentionKind"] {
  switch (request.kind) {
    case "question":
      return "question";
    case "plan-approval":
      return "approval";
    case "permission":
      return "permission";
    case "elicitation":
      return "elicitation";
  }
}

/**
 * The context window the result message reported, where it reported one.
 *
 * `modelUsage` is keyed by model, and a turn can touch more than one. A single
 * window is only a fact when they agree; where they do not, the cockpit has no
 * one denominator to state and says nothing.
 */
function resultContextWindow(message: { modelUsage?: unknown }): number | null {
  const usage = objectValue(message.modelUsage);
  if (!usage) return null;
  const windows = new Set<number>();
  for (const entry of Object.values(usage)) {
    const value = finiteNumber(objectValue(entry)?.contextWindow);
    if (value !== null && value > 0) windows.add(value);
  }
  return windows.size === 1 ? [...windows][0]! : null;
}

function usageDraft(
  id: string,
  turnId: string,
  usage: unknown,
  options: { state?: ActivityState; costUsd?: number | null; parentId?: string | null } = {},
): ActivityItemDraft | null {
  const record = objectValue(usage);
  if (!record) return null;
  const inputTokens = finiteNumber(record.input_tokens);
  const outputTokens = finiteNumber(record.output_tokens);
  const cacheRead = finiteNumber(record.cache_read_input_tokens);
  const cacheCreation = finiteNumber(record.cache_creation_input_tokens);
  const cachedInputTokens = cacheRead === null && cacheCreation === null
    ? null
    : (cacheRead ?? 0) + (cacheCreation ?? 0);
  const outputDetails = objectValue(record.output_tokens_details);
  const reasoningTokens = finiteNumber(outputDetails?.thinking_tokens);
  const totalTokens = inputTokens === null && outputTokens === null
    && cachedInputTokens === null
    ? null
    : (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedInputTokens ?? 0);
  return {
    id,
    kind: "usage",
    scope: "turn",
    turnId,
    ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
    state: options.state ?? "running",
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens,
    costUsd: options.costUsd ?? null,
    source: "provider-api",
    confidence: "exact",
    exposure: "provider-exposed",
  };
}

/**
 * Deterministic, side-effect-free projection state for one managed Claude
 * query. It retains only the small amount of ephemeral state needed to fold
 * SDK deltas into idempotent activity mutations; it never persists content.
 */
export class ClaudeActivityProjector {
  readonly #lanes = new Map<string, StreamLane>();
  readonly #providerUuidItems = new Map<string, Set<string>>();
  readonly #pendingRequests = new Map<string, ClaudePendingRequest>();
  readonly #subagentsByTask = new Map<string, SubagentRecord>();
  readonly #subagentsByTool = new Map<string, SubagentRecord>();
  readonly #tools = new Map<string, ToolRecord>();
  readonly #usage = new Map<
    string,
    Extract<ActivityItemDraft, { kind: "usage" }>
  >();
  readonly #todos = new Map<string, ActivityTodoRewriteState>();
  readonly #planApprovalRequests = new Map<string, string>();
  readonly #approvedPlans = new Map<string, string>();
  #currentTurnId: string | null = null;
  #syntheticSequence = 0;
  #lastSnapshotActivity: ClaudeManagedSessionSnapshot["activity"] | null = null;
  #lastSnapshotError: string | null = null;
  #requestStatusActive = false;
  #cwd: string | null = null;

  projectMessage(message: ClaudeSdkMessage): ActivityMutation[] {
    switch (message.type) {
      case "stream_event":
        return this.#projectStreamEvent(message);
      case "assistant":
        return this.#projectAssistant(message);
      case "user":
        return this.#projectUser(message);
      case "result":
        return this.#projectResult(message);
      case "tool_progress":
        return this.#projectToolProgress(message);
      case "tool_use_summary":
        return this.#projectToolSummary(message);
      case "auth_status":
        return this.#projectAuthStatus(message);
      case "conversation_reset":
        this.#resetEphemeralState();
        return [{ type: "reset", reason: "provider-reset" }];
      case "prompt_suggestion":
        return [];
      case "rate_limit_event":
        return this.#projectRateLimit(message);
      case "system":
        return this.#projectSystem(message);
      default:
        return [];
    }
  }

  projectSnapshot(snapshot: ClaudeManagedSessionSnapshot): ActivityMutation[] {
    this.#cwd = snapshot.cwd;
    const mutations: ActivityMutation[] = [];
    const stagedMessages = snapshot.stagedMessages ?? [];
    mutations.push({
      type: "upsert",
      item: {
        id: "claude:queue:staged",
        kind: "queue",
        messages: stagedMessages.map((message) => ({
          id: message.id,
          text: message.text,
          status: "queued",
          enqueuedAt: message.enqueuedAt,
          turnId: null,
        })),
        state: stagedMessages.length > 0 ? "waiting" : "complete",
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    });
    const current = new Map(snapshot.pendingRequests.map((request) => [request.id, request]));
    for (const request of snapshot.pendingRequests) {
      this.#pendingRequests.set(request.id, structuredClone(request));
      if (request.kind === "plan-approval" && request.toolUseId) {
        const plan = this.#planMutation(
          request.toolUseId,
          request.payload.input,
          this.#currentTurnId,
          null,
          request.id,
        );
        if (plan) mutations.push(plan);
      }
      mutations.push({ type: "upsert", item: this.#attentionDraft(request, false) });
    }
    for (const [id, request] of this.#pendingRequests) {
      if (current.has(id)) continue;
      mutations.push({ type: "upsert", item: this.#attentionDraft(request, true) });
      this.#pendingRequests.delete(id);
    }

    if (snapshot.activity !== this.#lastSnapshotActivity) {
      const state: ActivityState = snapshot.activity === "failed"
        ? "failed"
        : snapshot.activity === "closed"
          ? "complete"
          : snapshot.activity === "requires_action"
            ? "waiting"
            : snapshot.activity === "native"
              ? "interrupted"
              : snapshot.activity === "idle"
                ? "complete"
                : "running";
      mutations.push({
        type: "upsert",
        item: {
          id: "claude:lifecycle:session-status",
          kind: "lifecycle",
          event: snapshot.activity === "failed" ? "error" : "status",
          level: snapshot.activity === "failed" ? "error" : "info",
          title: `Claude session ${snapshot.activity.replaceAll("_", " ")}`,
          details: null,
          state,
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      });
      this.#lastSnapshotActivity = snapshot.activity;
    }

    if (snapshot.lastError && snapshot.lastError !== this.#lastSnapshotError) {
      mutations.push({
        type: "upsert",
        item: {
          id: "claude:error:session",
          kind: "lifecycle",
          event: "error",
          level: "error",
          title: "Claude provider error",
          details: snapshot.lastError,
          state: "failed",
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      });
    }
    this.#lastSnapshotError = snapshot.lastError;
    return mutations;
  }

  /**
   * Projects the exact approval Agent Manager just returned for one held
   * Claude ExitPlanMode request. The request's toolUseId is the provider edge
   * back to the plan document; no turn/time proximity is consulted.
   */
  projectPlanApproval(
    request: ClaudePendingRequest,
    approvedAt: string,
  ): ActivityMutation[] {
    if (request.kind !== "plan-approval" || !request.toolUseId) return [];
    this.#planApprovalRequests.set(request.toolUseId, request.id);
    this.#approvedPlans.set(request.toolUseId, approvedAt);
    const plan = this.#planMutation(
      request.toolUseId,
      request.payload.input,
      this.#currentTurnId,
      this.#tools.get(request.toolUseId)?.parentId ?? null,
      request.id,
    );
    if (!plan || plan.type !== "upsert" || plan.item.kind !== "plan") return [];
    return [{
      type: "upsert",
      item: {
        ...plan.item,
        approvedAt,
        state: "complete",
      },
    }];
  }

  #projectStreamEvent(
    message: Extract<ClaudeSdkMessage, { type: "stream_event" }>,
  ): ActivityMutation[] {
    const event = message.event;
    const laneKey = message.parent_tool_use_id ?? "root";
    const mutations: ActivityMutation[] = [];

    if (event.type === "message_start") {
      const turnId = message.parent_tool_use_id
        ? this.#turnForParent(message.parent_tool_use_id)
        : this.#currentTurnId ?? event.message.id;
      const lane: StreamLane = {
        messageId: event.message.id,
        parentToolUseId: message.parent_tool_use_id,
        turnId,
        blocks: new Map(),
      };
      this.#lanes.set(laneKey, lane);
      if (!message.parent_tool_use_id) this.#currentTurnId = turnId;
      mutations.push({
        type: "upsert",
        item: {
          id: itemId("turn", turnId),
          kind: "lifecycle",
          event: "turn-started",
          level: "info",
          title: "Claude started responding",
          state: "running",
          turnId,
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      });
      const usage = this.#usageDraft(
        itemId("usage:turn", turnId),
        turnId,
        event.message.usage,
      );
      if (usage) mutations.push({ type: "upsert", item: usage });
      this.#rememberUuid(message.uuid, mutations);
      return mutations;
    }

    const lane = this.#lanes.get(laneKey) ?? this.#fallbackLane(message);
    if (event.type === "content_block_start") {
      const rawBlock = event.content_block;
      if (rawBlock.type === "text") {
        const block: StreamBlock = {
          id: itemId("message", `${lane.messageId}:${event.index}`),
          kind: "text",
          text: rawBlock.text,
          textOffset: Buffer.byteLength(rawBlock.text, "utf8"),
          toolCallId: null,
          toolName: null,
          partialJson: "",
        };
        lane.blocks.set(event.index, block);
        mutations.push({ type: "upsert", item: this.#textDraft(lane, block, "running") });
        this.#linkChild(lane.parentToolUseId, block.id, mutations);
      } else if (rawBlock.type === "thinking") {
        const block: StreamBlock = {
          id: itemId("reasoning", `${lane.messageId}:${event.index}`),
          kind: "thinking",
          text: rawBlock.thinking,
          textOffset: Buffer.byteLength(rawBlock.thinking, "utf8"),
          toolCallId: null,
          toolName: null,
          partialJson: "",
        };
        lane.blocks.set(event.index, block);
        // Establish the stable block identity even when the thinking block
        // starts empty so subsequent provider tokens can use append frames.
        mutations.push({ type: "upsert", item: this.#thinkingDraft(lane, block, "running") });
        this.#linkChild(lane.parentToolUseId, block.id, mutations);
      } else if (
        rawBlock.type === "tool_use"
        || rawBlock.type === "server_tool_use"
        || rawBlock.type === "mcp_tool_use"
      ) {
        const blockRecord = rawBlock as unknown as Record<string, unknown>;
        const toolCallId = stringValue(blockRecord.id) ?? `${lane.messageId}:${event.index}`;
        const toolName = stringValue(blockRecord.name) ?? "Tool";
        const block: StreamBlock = {
          id: itemId("tool", toolCallId),
          kind: "tool",
          text: "",
          textOffset: 0,
          toolCallId,
          toolName,
          partialJson: "",
        };
        lane.blocks.set(event.index, block);
        mutations.push({
          type: "upsert",
          item: this.#toolDraft(
            toolCallId,
            toolName,
            lane,
            "running",
            toActivityJson(blockRecord.input),
            rawBlock.type,
          ),
        });
        this.#linkChild(lane.parentToolUseId, block.id, mutations);
      } else {
        lane.blocks.set(event.index, {
          id: itemId("stream", `${lane.messageId}:${event.index}`),
          kind: "ignored",
          text: "",
          textOffset: 0,
          toolCallId: null,
          toolName: null,
          partialJson: "",
        });
      }
      this.#rememberUuid(message.uuid, mutations);
      return mutations;
    }

    if (event.type === "content_block_delta") {
      const block = lane.blocks.get(event.index);
      if (!block) return [];
      if (event.delta.type === "text_delta" && block.kind === "text") {
        mutations.push({
          type: "append",
          id: block.id,
          channel: "text",
          offset: block.textOffset,
          text: event.delta.text,
        });
        block.text += event.delta.text;
        block.textOffset += Buffer.byteLength(event.delta.text, "utf8");
      } else if (event.delta.type === "thinking_delta" && block.kind === "thinking") {
        // Only provider-returned displayable thinking is projected. Signature
        // deltas and redacted-thinking payloads never enter activity state.
        mutations.push({
          type: "append",
          id: block.id,
          channel: "text",
          offset: block.textOffset,
          text: event.delta.thinking,
        });
        block.text += event.delta.thinking;
        block.textOffset += Buffer.byteLength(event.delta.thinking, "utf8");
        if (event.delta.estimated_tokens !== null) {
          mutations.push({
            type: "upsert",
            item: {
              id: itemId("usage:turn", lane.turnId),
              kind: "usage",
              scope: "turn",
              turnId: lane.turnId,
              reasoningTokens: event.delta.estimated_tokens,
              state: "running",
              source: "provider-api",
              confidence: "inferred",
              exposure: "provider-exposed",
            },
          });
        }
      } else if (event.delta.type === "input_json_delta" && block.kind === "tool") {
        block.partialJson += event.delta.partial_json;
        mutations.push({
          type: "upsert",
          item: {
            id: block.id,
            correlationId: `tool:${block.toolCallId as string}`,
            kind: "tool",
            toolCallId: block.toolCallId as string,
            name: block.toolName as string,
            arguments: block.partialJson,
            state: "running",
            turnId: lane.turnId,
            parentId: this.#parentId(lane.parentToolUseId),
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
      }
      this.#rememberUuid(message.uuid, mutations);
      return mutations;
    }

    if (event.type === "content_block_stop") {
      const block = lane.blocks.get(event.index);
      if (block?.kind === "tool") {
        const argumentsValue = parseJsonOrText(block.partialJson);
        mutations.push({
          type: "upsert",
          item: {
            id: block.id,
            correlationId: `tool:${block.toolCallId as string}`,
            kind: "tool",
            toolCallId: block.toolCallId as string,
            name: block.toolName as string,
            arguments: argumentsValue,
            state: "pending",
            turnId: lane.turnId,
            parentId: this.#parentId(lane.parentToolUseId),
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        mutations.push(...this.#artifactMutations(
          block.toolCallId as string,
          block.toolName as string,
          argumentsValue,
          lane.turnId,
          this.#parentId(lane.parentToolUseId),
        ));
      } else if (block?.kind === "text") {
        mutations.push({ type: "upsert", item: this.#textDraft(lane, block, "complete") });
      } else if (block?.kind === "thinking" && block.text.length > 0) {
        mutations.push({ type: "upsert", item: this.#thinkingDraft(lane, block, "complete") });
      }
      this.#rememberUuid(message.uuid, mutations);
      return mutations;
    }

    if (event.type === "message_delta") {
      const usage = this.#usageDraft(
        itemId("usage:turn", lane.turnId),
        lane.turnId,
        event.usage,
      );
      if (usage) mutations.push({ type: "upsert", item: usage });
      this.#rememberUuid(message.uuid, mutations);
      return mutations;
    }

    this.#rememberUuid(message.uuid, mutations);
    return mutations;
  }

  #projectAssistant(
    message: Extract<ClaudeSdkMessage, { type: "assistant" }>,
  ): ActivityMutation[] {
    const mutations: ActivityMutation[] = [];
    for (const uuid of message.supersedes ?? []) this.#removeProviderUuid(uuid, mutations);

    const laneKey = message.parent_tool_use_id ?? "root";
    const lane = this.#lanes.get(laneKey);
    const turnId = lane?.turnId
      ?? (message.parent_tool_use_id
        ? this.#turnForParent(message.parent_tool_use_id)
        : this.#currentTurnId ?? message.message.id);
    if (!message.parent_tool_use_id) this.#currentTurnId = turnId;
    const state: ActivityState = message.error
      ? "failed"
      : message.aborted
        ? "interrupted"
        : "complete";
    const phase = message.message.stop_reason === "tool_use" ? "commentary" : "final";
    const matchedPartialIds = new Set<string>();
    let hasCorrelatedText = false;

    for (const [index, rawContent] of message.message.content.entries()) {
      const content = rawContent as unknown as Record<string, unknown>;
      const type = stringValue(content.type);
      if (type === "text") {
        const partial = this.#matchingPartial(lane, index, "text", matchedPartialIds);
        const id = partial?.id ?? itemId("message", `${message.message.id}:${index}`);
        mutations.push({
          type: "upsert",
          item: {
            id,
            correlationId: hasCorrelatedText ? null : `message:${message.message.id}`,
            kind: "message",
            role: "assistant",
            phase,
            text: typeof content.text === "string" ? content.text : "",
            state,
            turnId,
            parentId: this.#parentId(message.parent_tool_use_id),
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        hasCorrelatedText = true;
        this.#linkChild(message.parent_tool_use_id, id, mutations, {
          ...(message.subagent_type ? { name: message.subagent_type } : {}),
          ...(message.task_description
            ? { description: message.task_description }
            : {}),
        });
      } else if (type === "thinking") {
        const text = typeof content.thinking === "string" ? content.thinking : "";
        if (text.length === 0) continue;
        const partial = this.#matchingPartial(lane, index, "thinking", matchedPartialIds);
        const id = partial?.id ?? itemId("reasoning", `${message.message.id}:${index}`);
        mutations.push({
          type: "upsert",
          item: {
            id,
            correlationId: `reasoning:${message.message.id}:thinking:${String(index)}`,
            kind: "reasoning",
            reasoningKind: "summary",
            label: "Claude thinking",
            text,
            state,
            turnId,
            parentId: this.#parentId(message.parent_tool_use_id),
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        this.#linkChild(message.parent_tool_use_id, id, mutations, {
          ...(message.subagent_type ? { name: message.subagent_type } : {}),
          ...(message.task_description
            ? { description: message.task_description }
            : {}),
        });
      } else if (
        type === "tool_use"
        || type === "server_tool_use"
        || type === "mcp_tool_use"
      ) {
        const toolCallId = stringValue(content.id) ?? `${message.uuid}:${index}`;
        const name = stringValue(content.name) ?? "Tool";
        const id = itemId("tool", toolCallId);
        this.#rememberTool(
          toolCallId,
          name,
          toolCategory(name, type),
          turnId,
          this.#parentId(message.parent_tool_use_id),
        );
        const partial = lane
          ? [...lane.blocks.values()].find((block) => block.toolCallId === toolCallId)
          : undefined;
        if (partial) matchedPartialIds.add(partial.id);
        mutations.push({
          type: "upsert",
          item: {
            id,
            correlationId: `tool:${toolCallId}`,
            kind: "tool",
            toolCallId,
            name,
            category: toolCategory(name, type),
            arguments: toActivityJson(content.input),
            state: "pending",
            turnId,
            parentId: this.#parentId(message.parent_tool_use_id),
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        mutations.push(...this.#artifactMutations(
          toolCallId,
          name,
          content.input,
          turnId,
          this.#parentId(message.parent_tool_use_id),
        ));
        this.#linkChild(message.parent_tool_use_id, id, mutations, {
          ...(message.subagent_type ? { name: message.subagent_type } : {}),
          ...(message.task_description
            ? { description: message.task_description }
            : {}),
        });
      } else if (type?.endsWith("_tool_result")) {
        this.#projectToolResultBlock(
          content,
          message.uuid,
          turnId,
          mutations,
          undefined,
          message.parent_tool_use_id,
        );
      }
    }

    if (lane) {
      for (const block of lane.blocks.values()) {
        if (block.kind !== "ignored" && !matchedPartialIds.has(block.id)) {
          mutations.push({ type: "remove", id: block.id });
        }
      }
      this.#lanes.delete(laneKey);
    }

    const usage = this.#usageDraft(
      itemId("usage:turn", turnId),
      turnId,
      message.message.usage,
      { state },
    );
    if (usage) mutations.push({ type: "upsert", item: usage });
    if (message.error) {
      mutations.push({
        type: "upsert",
        item: {
          id: itemId("error", message.uuid),
          kind: "lifecycle",
          event: "error",
          level: "error",
          title: "Claude response failed",
          details: message.error,
          state: "failed",
          turnId,
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      });
    }
    this.#rememberProviderItems(message.uuid, mutations);
    return mutations;
  }

  #projectUser(
    message: Extract<ClaudeSdkMessage, { type: "user" }>,
  ): ActivityMutation[] {
    const mutations: ActivityMutation[] = [];
    const content = message.message.content;
    const blocks = Array.isArray(content) ? content : [];
    let projectedToolResult = false;
    for (const rawBlock of blocks) {
      const block = rawBlock as unknown as Record<string, unknown>;
      if (block.type !== "tool_result") continue;
      projectedToolResult = true;
      this.#projectToolResultBlock(
        block,
        message.uuid ?? `provider-missing-id-${++this.#syntheticSequence}`,
        this.#currentTurnId ?? message.uuid ?? "unknown-turn",
        mutations,
        message.tool_use_result,
        message.parent_tool_use_id,
      );
    }
    if (!projectedToolResult && !message.isSynthetic) {
      const text = contentText(content);
      if (text.length > 0) {
        const uuid = message.uuid ?? `provider-missing-id-${++this.#syntheticSequence}`;
        const turnId = uuid;
        this.#currentTurnId = turnId;
        const id = itemId("message", uuid);
        mutations.push({
          type: "upsert",
          item: {
            id,
            correlationId: `message:${uuid}`,
            kind: "message",
            role: "user",
            phase: null,
            text,
            state: "complete",
            turnId,
            parentId: this.#parentId(message.parent_tool_use_id),
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        const metadata = message as typeof message & {
          subagent_type?: string;
          task_description?: string;
        };
        this.#linkChild(message.parent_tool_use_id, id, mutations, {
          ...(metadata.subagent_type ? { name: metadata.subagent_type } : {}),
          ...(metadata.task_description
            ? { description: metadata.task_description }
            : {}),
        });
      }
    }
    if (message.uuid) this.#rememberProviderItems(message.uuid, mutations);
    return mutations;
  }

  #projectToolResultBlock(
    block: Record<string, unknown>,
    providerUuid: string,
    turnId: string,
    mutations: ActivityMutation[],
    structuredResult?: unknown,
    parentToolUseId: string | null = null,
  ): void {
    const toolCallId = stringValue(block.tool_use_id);
    if (!toolCallId) return;
    const id = itemId("tool", toolCallId);
    const known = this.#tools.get(toolCallId);
    const text = contentText(block.content);
    const result = structuredResult === undefined
      ? (toActivityJson(block.content) ?? text)
      : (toActivityJson(structuredResult) ?? text);
    const failed = block.is_error === true
      || stringValue(block.type)?.includes("error") === true;
    mutations.push({
      type: "upsert",
      item: {
        id,
        correlationId: `tool:${toolCallId}`,
        kind: "tool",
        toolCallId,
        name: known?.name ?? "Tool",
        ...(known?.category ? { category: known.category } : {}),
        result,
        output: text,
        state: failed ? "failed" : "complete",
        turnId,
        parentId: known?.parentId ?? this.#parentId(parentToolUseId),
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    });
    this.#rememberProviderId(providerUuid, id);
  }

  #usageDraft(
    id: string,
    turnId: string,
    usage: unknown,
    options: {
      state?: ActivityState;
      costUsd?: number | null;
      parentId?: string | null;
      contextWindow?: number | null;
    } = {},
  ): Extract<ActivityItemDraft, { kind: "usage" }> | null {
    const projected = usageDraft(id, turnId, usage, options);
    if (!projected || projected.kind !== "usage") return null;
    const previous = this.#usage.get(id);
    const inputTokens = projected.inputTokens ?? previous?.inputTokens ?? null;
    const outputTokens = projected.outputTokens ?? previous?.outputTokens ?? null;
    const cachedInputTokens = projected.cachedInputTokens
      ?? previous?.cachedInputTokens
      ?? null;
    const reasoningTokens = projected.reasoningTokens
      ?? previous?.reasoningTokens
      ?? null;
    const costUsd = projected.costUsd ?? previous?.costUsd ?? null;
    // Claude reports the window once, on the result message, so it has to stick
    // for the rest of the turn like the other totals do.
    const contextWindow = options.contextWindow ?? previous?.contextWindow ?? null;
    const totalTokens = inputTokens === null && outputTokens === null
      && cachedInputTokens === null
      ? null
      : (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedInputTokens ?? 0);
    const next: Extract<ActivityItemDraft, { kind: "usage" }> = {
      ...projected,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      totalTokens,
      costUsd,
      contextWindow,
    };
    this.#usage.set(id, next);
    return next;
  }

  #projectResult(
    message: Extract<ClaudeSdkMessage, { type: "result" }>,
  ): ActivityMutation[] {
    const turnId = message.subtype === "success"
      ? message.user_message_uuid ?? this.#currentTurnId ?? message.uuid
      : this.#currentTurnId ?? message.uuid;
    const failed = message.subtype !== "success";
    const mutations: ActivityMutation[] = [];
    if (this.#requestStatusActive) {
      mutations.push({
        type: "upsert",
        item: {
          id: "claude:lifecycle:request-status",
          kind: "lifecycle",
          event: "status",
          level: "info",
          title: "Claude request status cleared",
          details: null,
          state: "complete",
          turnId,
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      });
      this.#requestStatusActive = false;
    }
    mutations.push({
      type: "upsert",
      item: {
        id: itemId("turn", turnId),
        kind: "lifecycle",
        event: failed ? "turn-failed" : "turn-completed",
        level: failed ? "error" : "info",
        title: failed ? "Claude turn failed" : "Claude turn completed",
        details: failed ? message.errors.join("\n") || message.subtype : null,
        state: failed ? "failed" : "complete",
        turnId,
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    });
    const usage = this.#usageDraft(
      itemId("usage:turn", turnId),
      turnId,
      message.usage,
      {
        state: failed ? "failed" : "complete",
        costUsd: message.total_cost_usd,
        contextWindow: resultContextWindow(message),
      },
    );
    if (usage) mutations.push({ type: "upsert", item: usage });
    for (const denial of message.permission_denials) {
      this.#rememberTool(
        denial.tool_use_id,
        denial.tool_name,
        toolCategory(denial.tool_name),
        turnId,
        null,
      );
      const id = itemId("tool", denial.tool_use_id);
      mutations.push({
        type: "upsert",
        item: {
          id,
          correlationId: `tool:${denial.tool_use_id}`,
          kind: "tool",
          toolCallId: denial.tool_use_id,
          name: denial.tool_name,
          arguments: toActivityJson(denial.tool_input),
          result: "Permission denied",
          state: "failed",
          turnId,
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      });
    }
    this.#rememberProviderItems(message.uuid, mutations);
    return mutations;
  }

  #projectToolProgress(
    message: Extract<ClaudeSdkMessage, { type: "tool_progress" }>,
  ): ActivityMutation[] {
    const turnId = this.#currentTurnId ?? message.uuid;
    const parentId = this.#parentId(message.parent_tool_use_id);
    this.#rememberTool(
      message.tool_use_id,
      message.tool_name,
      toolCategory(message.tool_name),
      turnId,
      parentId,
    );
    const mutations: ActivityMutation[] = [{
      type: "upsert",
      item: {
        id: itemId("tool", message.tool_use_id),
        correlationId: `tool:${message.tool_use_id}`,
        kind: "tool",
        toolCallId: message.tool_use_id,
        name: message.tool_name,
        category: toolCategory(message.tool_name),
        state: "running",
        turnId,
        parentId,
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    }];
    this.#linkChild(message.parent_tool_use_id, itemId("tool", message.tool_use_id), mutations);
    const knownSubagent = message.task_id
      ? this.#knownSubagent(message.task_id)
      : undefined;
    if (knownSubagent) {
      mutations.push({
        type: "upsert",
        item: this.#subagentDraft(knownSubagent, "running"),
      });
    } else if (message.task_id && message.parent_tool_use_id) {
      // The child tool id identifies this particular step, not the Task/Agent
      // invocation which owns the subagent. parent_tool_use_id is the exact
      // provider edge back to that invocation.
      const record = this.#ensureSubagent(
        message.task_id,
        message.parent_tool_use_id,
        message.subagent_type,
        null,
      );
      mutations.push({ type: "upsert", item: this.#subagentDraft(record, "running") });
    }
    this.#rememberProviderItems(message.uuid, mutations);
    return mutations;
  }

  #projectToolSummary(
    message: Extract<ClaudeSdkMessage, { type: "tool_use_summary" }>,
  ): ActivityMutation[] {
    const mutations = message.preceding_tool_use_ids.map<ActivityMutation>((toolCallId) => {
      const known = this.#tools.get(toolCallId);
      return {
        type: "upsert",
        item: {
          id: itemId("tool", toolCallId),
          kind: "tool",
          toolCallId,
          name: known?.name ?? "Tool",
          ...(known?.category ? { category: known.category } : {}),
          output: message.summary,
          source: "provider-api",
          confidence: "exact",
          exposure: "provider-exposed",
        },
      };
    });
    this.#rememberProviderItems(message.uuid, mutations);
    return mutations;
  }

  #projectSystem(
    message: Extract<ClaudeSdkMessage, { type: "system" }>,
  ): ActivityMutation[] {
    const mutations: ActivityMutation[] = [];
    switch (message.subtype) {
      case "init":
        mutations.push({
          type: "upsert",
          item: {
            id: "claude:lifecycle:initialized",
            kind: "lifecycle",
            event: "status",
            level: "info",
            title: "Claude session initialized",
            details: `${message.model} · Claude Code ${message.claude_code_version}`,
            state: "complete",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "session_state_changed":
        mutations.push({
          type: "upsert",
          item: {
            id: "claude:lifecycle:provider-state",
            kind: "lifecycle",
            event: "status",
            level: "info",
            title: `Claude is ${message.state.replaceAll("_", " ")}`,
            state: message.state === "requires_action"
              ? "waiting"
              : message.state === "idle"
                ? "complete"
                : "running",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "status": {
        const compacting = message.status === "compacting";
        if (message.status === "requesting") this.#requestStatusActive = true;
        else if (message.status === null) this.#requestStatusActive = false;
        mutations.push({
          type: "upsert",
          item: {
            id: compacting
              ? "claude:lifecycle:compaction"
              : "claude:lifecycle:request-status",
            kind: "lifecycle",
            event: compacting ? "context-compaction" : "status",
            level: message.compact_result === "failed" ? "error" : "info",
            title: compacting
              ? "Claude is compacting context"
              : message.status === "requesting"
                ? "Claude is requesting a response"
                : "Claude request status cleared",
            details: message.compact_error ?? null,
            state: message.compact_result === "failed"
              ? "failed"
              : message.compact_result === "success" || message.status === null
                ? "complete"
                : "running",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      }
      case "compact_boundary":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("compaction", message.uuid),
            kind: "lifecycle",
            event: "context-compaction",
            level: "info",
            title: `Claude compacted context (${message.compact_metadata.trigger})`,
            details: `${message.compact_metadata.pre_tokens} → ${message.compact_metadata.post_tokens ?? "unknown"} tokens`,
            state: "complete",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "task_started": {
        if (message.subagent_type) {
          const record = this.#ensureSubagent(
            message.task_id,
            message.tool_use_id,
            message.subagent_type,
            message.description,
          );
          mutations.push({ type: "upsert", item: this.#subagentDraft(record, "running") });
        } else {
          mutations.push({
            type: "upsert",
            item: this.#taskLifecycleDraft(
              message.task_id,
              message.description,
              "running",
              message.workflow_name ?? message.task_type ?? null,
            ),
          });
        }
        break;
      }
      case "task_progress": {
        const existing = this.#knownSubagent(message.task_id, message.tool_use_id);
        const record = existing ?? (message.subagent_type
          ? this.#ensureSubagent(
            message.task_id,
            message.tool_use_id,
            message.subagent_type,
            message.description,
          )
          : undefined);
        const parentId = record?.itemId ?? itemId("task", message.task_id);
        if (record) {
          mutations.push({
            type: "upsert",
            item: {
              ...this.#subagentDraft(record, "running"),
              ...(message.summary ? { output: message.summary } : {}),
            },
          });
        } else {
          mutations.push({
            type: "upsert",
            item: this.#taskLifecycleDraft(
              message.task_id,
              message.description,
              "running",
              message.summary ?? null,
            ),
          });
        }
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("usage:task", message.task_id),
            kind: "usage",
            scope: "turn",
            turnId: this.#currentTurnId,
            parentId,
            totalTokens: message.usage.total_tokens,
            state: "running",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      }
      case "task_updated": {
        const state = taskState(message.patch.status ?? "running");
        const record = this.#knownSubagent(message.task_id);
        if (record) {
          if (message.patch.description) record.description = message.patch.description;
          mutations.push({
            type: "upsert",
            item: {
              ...this.#subagentDraft(record, state),
              ...(message.patch.error ? { output: message.patch.error } : {}),
            },
          });
        } else {
          mutations.push({
            type: "upsert",
            item: this.#taskLifecycleDraft(
              message.task_id,
              message.patch.description ?? `Task ${message.task_id}`,
              state,
              message.patch.error ?? null,
            ),
          });
        }
        break;
      }
      case "task_notification": {
        const state = taskState(message.status);
        const record = this.#knownSubagent(message.task_id, message.tool_use_id);
        const parentId = record?.itemId ?? itemId("task", message.task_id);
        if (record) {
          mutations.push({
            type: "upsert",
            item: {
              ...this.#subagentDraft(record, state),
              output: message.summary,
            },
          });
        } else {
          mutations.push({
            type: "upsert",
            item: this.#taskLifecycleDraft(
              message.task_id,
              `Task ${message.status}`,
              state,
              message.summary,
            ),
          });
        }
        if (message.usage) {
          mutations.push({
            type: "upsert",
            item: {
              id: itemId("usage:task", message.task_id),
              kind: "usage",
              scope: "turn",
              turnId: this.#currentTurnId,
              parentId,
              totalTokens: message.usage.total_tokens,
              state: taskState(message.status),
              source: "provider-api",
              confidence: "exact",
              exposure: "provider-exposed",
            },
          });
        }
        break;
      }
      case "background_tasks_changed":
        mutations.push({
          type: "upsert",
          item: {
            id: "claude:lifecycle:background-tasks",
            kind: "lifecycle",
            event: "status",
            level: "info",
            title: message.tasks.length === 0
              ? "No background tasks are running"
              : `${message.tasks.length} background task${message.tasks.length === 1 ? "" : "s"} running`,
            details: message.tasks.map((task) => `${task.task_id}: ${task.description}`).join("\n") || null,
            state: message.tasks.length === 0 ? "complete" : "running",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        // This is a replacement-style level signal with ids only. The SDK
        // explicitly forbids correlating it with task edge events, so it must
        // never manufacture subagent identities or hierarchy edges.
        break;
      case "thinking_tokens": {
        const turnId = this.#currentTurnId ?? message.uuid;
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("usage:turn", turnId),
            kind: "usage",
            scope: "turn",
            turnId,
            reasoningTokens: message.estimated_tokens,
            state: "running",
            source: "provider-api",
            confidence: "inferred",
            exposure: "provider-exposed",
          },
        });
        break;
      }
      case "hook_started":
      case "hook_progress":
      case "hook_response": {
        const state = message.subtype === "hook_started"
          ? "running"
          : message.subtype === "hook_progress"
            ? "running"
            : message.outcome === "success"
              ? "complete"
              : message.outcome === "cancelled"
                ? "interrupted"
                : "failed";
        const details = message.subtype === "hook_started"
          ? null
          : message.output || message.stderr || message.stdout || null;
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("hook", message.hook_id),
            kind: "lifecycle",
            event: "hook",
            level: state === "failed" ? "error" : "info",
            title: `${message.hook_name} · ${message.hook_event}`,
            details,
            state,
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      }
      case "permission_denied":
        this.#rememberTool(
          message.tool_use_id,
          message.tool_name,
          toolCategory(message.tool_name),
          this.#currentTurnId,
          null,
        );
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("tool", message.tool_use_id),
            correlationId: `tool:${message.tool_use_id}`,
            kind: "tool",
            toolCallId: message.tool_use_id,
            name: message.tool_name,
            result: message.message,
            state: "failed",
            turnId: this.#currentTurnId,
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "api_retry":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("retry", message.uuid),
            kind: "lifecycle",
            event: "warning",
            level: "warning",
            title: `Claude API retry ${message.attempt}/${message.max_retries}`,
            details: `${message.error}; retrying in ${message.retry_delay_ms} ms`,
            state: "running",
            turnId: this.#currentTurnId,
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "model_refusal_fallback":
        for (const uuid of message.retracted_message_uuids ?? []) {
          this.#removeProviderUuid(uuid, mutations);
        }
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("model-routing", message.uuid),
            kind: "lifecycle",
            event: "model-routing",
            level: "warning",
            title: `Claude switched from ${message.original_model} to ${message.fallback_model}`,
            details: message.content,
            state: "complete",
            turnId: this.#currentTurnId,
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "model_refusal_no_fallback":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("error", message.uuid),
            kind: "lifecycle",
            event: "error",
            level: "error",
            title: `${message.original_model} refused the request`,
            details: message.content,
            state: "failed",
            turnId: this.#currentTurnId,
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      /*
        The output of a slash command — `/clear`, `/context`, `/cost`. The SDK
        documents it as "assistant-style text", meaning markdown, and it is the
        entire answer to something the operator explicitly asked for. It gets a
        label so the drawer can title it rather than rendering an anonymous
        block of grey text under the command that produced it.
      */
      case "local_command_output":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("message", message.uuid),
            kind: "message",
            role: "system",
            phase: null,
            label: "Command output",
            text: message.content,
            state: "complete",
            turnId: this.#currentTurnId,
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      /*
        A status banner, and `level` is the SDK's own statement of how loudly to
        render it. Sharing one branch with command output discarded that, so a
        hook's block reason and a passing status line arrived looking identical.
        The two prominent levels are what the lifecycle warning row already
        exists for; the quiet two stay inline messages.
      */
      case "informational":
        mutations.push(
          message.level === "warning" || message.level === "suggestion"
            ? {
              type: "upsert",
              item: {
                id: itemId("informational", message.uuid),
                kind: "lifecycle",
                event: "warning",
                level: message.level === "warning" ? "warning" : "info",
                title: message.content,
                details: null,
                state: "complete",
                turnId: this.#currentTurnId,
                source: "provider-api",
                confidence: "exact",
                exposure: "provider-exposed",
              },
            }
            : {
              type: "upsert",
              item: {
                id: itemId("message", message.uuid),
                kind: "message",
                role: "system",
                phase: null,
                label: null,
                text: message.content,
                state: "complete",
                turnId: this.#currentTurnId,
                source: "provider-api",
                confidence: "exact",
                exposure: "provider-exposed",
              },
            },
        );
        break;
      case "notification":
        mutations.push({
          type: "upsert",
          item: {
            /*
              Keyed on the notification's own `key`, not the per-emission
              `uuid`. The SDK mirrors the REPL notification queue, where one
              notification is re-emitted as its state changes; keying on `uuid`
              made each re-emission a brand-new row, so the operator watched the
              same sentence stack up. `key` is what identifies the notification;
              `uuid` identifies the delivery.
            */
            id: itemId("notification", message.key || message.uuid),
            kind: "lifecycle",
            event: "warning",
            level: message.priority === "high" || message.priority === "immediate"
              ? "warning"
              : "info",
            title: message.text,
            details: null,
            state: "complete",
            turnId: this.#currentTurnId,
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "mirror_error":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("error", message.uuid),
            kind: "lifecycle",
            event: "error",
            level: "error",
            title: "Claude transcript mirror failed",
            details: message.error,
            state: "failed",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "plugin_install":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("plugin-install", message.name ?? message.uuid),
            kind: "lifecycle",
            event: message.status === "failed" ? "error" : "status",
            level: message.status === "failed" ? "error" : "info",
            title: message.name
              ? `Claude plugin ${message.name}: ${message.status}`
              : `Claude plugin installation ${message.status}`,
            details: message.error ?? null,
            state: message.status === "failed"
              ? "failed"
              : message.status === "completed" || message.status === "installed"
                ? "complete"
                : "running",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "worker_shutting_down":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("shutdown", message.uuid),
            kind: "lifecycle",
            event: "status",
            level: "warning",
            title: "Claude worker is shutting down",
            details: message.reason,
            state: "interrupted",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      case "files_persisted":
        if (message.failed.length > 0) {
          mutations.push({
            type: "upsert",
            item: {
              id: itemId("error", message.uuid),
              kind: "lifecycle",
              event: "warning",
              level: "warning",
              title: "Some Claude files could not be persisted",
              details: message.failed.map((failure) => `${failure.filename}: ${failure.error}`).join("\n"),
              state: "failed",
              source: "provider-api",
              confidence: "exact",
              exposure: "provider-exposed",
            },
          });
        }
        break;
      case "elicitation_complete":
        mutations.push({
          type: "upsert",
          item: {
            id: itemId("attention", `elicitation:${message.elicitation_id}`),
            kind: "attention",
            requestId: `elicitation:${message.elicitation_id}`,
            attentionKind: "elicitation",
            title: `${message.mcp_server_name} elicitation completed`,
            respondable: false,
            resolved: true,
            state: "complete",
            source: "provider-api",
            confidence: "exact",
            exposure: "provider-exposed",
          },
        });
        break;
      default:
        break;
    }
    this.#rememberProviderItems(message.uuid, mutations);
    return mutations;
  }

  #projectAuthStatus(
    message: Extract<ClaudeSdkMessage, { type: "auth_status" }>,
  ): ActivityMutation[] {
    const mutation: ActivityMutation = {
      type: "upsert",
      item: {
        id: "claude:lifecycle:auth",
        kind: "lifecycle",
        event: message.error ? "error" : "status",
        level: message.error ? "error" : "info",
        title: message.isAuthenticating
          ? "Claude is authenticating"
          : message.error
            ? "Claude authentication failed"
            : "Claude authentication completed",
        details: message.error ?? (message.output.join("\n") || null),
        state: message.error ? "failed" : message.isAuthenticating ? "running" : "complete",
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    };
    this.#rememberProviderItems(message.uuid, [mutation]);
    return [mutation];
  }

  #projectRateLimit(
    message: Extract<ClaudeSdkMessage, { type: "rate_limit_event" }>,
  ): ActivityMutation[] {
    const rejected = message.rate_limit_info.status === "rejected";
    const resetsAt = formatUnixTimestamp(message.rate_limit_info.resetsAt);
    const mutation: ActivityMutation = {
      type: "upsert",
      item: {
        id: "claude:lifecycle:rate-limit",
        kind: "lifecycle",
        event: rejected ? "error" : "warning",
        level: rejected ? "error" : "warning",
        title: rejected ? "Claude rate limit reached" : "Claude rate limit warning",
        details: resetsAt ? `Resets at ${resetsAt}` : null,
        state: rejected ? "failed" : "waiting",
        turnId: this.#currentTurnId,
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    };
    this.#rememberProviderItems(message.uuid, [mutation]);
    return [mutation];
  }

  #attentionDraft(request: ClaudePendingRequest, resolved: boolean): ActivityItemDraft {
    const input = objectValue(request.payload.input);
    const description = stringValue(request.payload.description)
      ?? stringValue(request.payload.decisionReason)
      ?? (request.kind === "elicitation"
        ? stringValue(request.payload.serverName)
        : request.toolName && input
          ? `${request.toolName} requires approval`
          : null);
    const questions = requestQuestions(request);
    const suggestions = Array.isArray(request.payload.suggestions)
      ? request.payload.suggestions
      : [];
    return {
      id: itemId("attention", request.id),
      kind: "attention",
      requestId: request.id,
      attentionKind: requestKind(request),
      title: request.title,
      summary: description,
      questions,
      /*
        A plan approval reaches no path and runs no command, so it has no
        approval facts. Computing them anyway produced an empty set, which the
        browser's tiering reads as "outside the workspace" — the loudest tier,
        headlined for a command that escapes the workspace. Leaving a plan
        without facts states what is true: there is nothing here to inspect.
      */
      approvalFacts: request.kind === "permission"
        ? toolApprovalFacts(request.toolName, request.payload.input, {
            cwd: this.#cwd,
            blockedPath: stringValue(request.payload.blockedPath),
            canPersist: suggestions.length > 0,
          })
        : null,
      respondable: request.kind !== "elicitation",
      resolved,
      isSecret: questions.some((question) => question.isSecret),
      state: resolved ? "complete" : "waiting",
      startedAt: request.createdAt,
      parentId: request.toolUseId ? itemId("tool", request.toolUseId) : null,
      turnId: this.#currentTurnId,
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    };
  }

  #textDraft(lane: StreamLane, block: StreamBlock, state: ActivityState): ActivityItemDraft {
    return {
      id: block.id,
      kind: "message",
      role: "assistant",
      phase: "commentary",
      text: block.text,
      state,
      turnId: lane.turnId,
      parentId: this.#parentId(lane.parentToolUseId),
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    };
  }

  #thinkingDraft(lane: StreamLane, block: StreamBlock, state: ActivityState): ActivityItemDraft {
    return {
      id: block.id,
      kind: "reasoning",
      reasoningKind: "summary",
      label: "Claude thinking",
      text: block.text,
      state,
      turnId: lane.turnId,
      parentId: this.#parentId(lane.parentToolUseId),
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    };
  }

  #toolDraft(
    toolCallId: string,
    name: string,
    lane: StreamLane,
    state: ActivityState,
    argumentsValue: ActivityJsonValue | string | null,
    blockType?: string,
  ): ActivityItemDraft {
    const parentId = this.#parentId(lane.parentToolUseId);
    const category = toolCategory(name, blockType);
    this.#rememberTool(
      toolCallId,
      name,
      category,
      lane.turnId,
      parentId,
    );
    return {
      id: itemId("tool", toolCallId),
      correlationId: `tool:${toolCallId}`,
      kind: "tool",
      toolCallId,
      name,
      category,
      arguments: argumentsValue,
      state,
      turnId: lane.turnId,
      parentId,
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    };
  }

  #artifactMutations(
    toolCallId: string,
    name: string,
    input: unknown,
    turnId: string | null,
    parentId: string | null,
  ): ActivityMutation[] {
    if (name === "ExitPlanMode") {
      const plan = this.#planMutation(toolCallId, input, turnId, parentId);
      return plan ? [plan] : [];
    }
    if (name !== "TodoWrite") return [];
    const value = objectValue(input);
    if (!Array.isArray(value?.todos)) return [];

    const occurrence = new Map<string, number>();
    const nextSteps: ActivityTodoInputStep[] = value.todos.flatMap((rawTodo): ActivityTodoInputStep[] => {
      const todo = objectValue(rawTodo);
      const content = stringValue(todo?.content);
      const status = todo?.status;
      if (
        !content
        || (status !== "pending" && status !== "in_progress" && status !== "completed")
      ) return [];
      const count = occurrence.get(content) ?? 0;
      occurrence.set(content, count + 1);
      return [{
        id: `claude-todo-${digestText(`${content}\0${count}`)}`,
        text: content,
        status,
        detail: status === "in_progress" ? stringValue(todo?.activeForm) : null,
      }];
    });
    const todoKey = turnId ?? "session";
    const previous = this.#todos.get(todoKey);
    const rewrite = reconcileTodoRewrite(previous ?? null, nextSteps);
    this.#todos.set(todoKey, rewrite);
    const complete = nextSteps.length > 0 && nextSteps.every((step) => step.status === "completed");
    const running = nextSteps.some((step) => step.status === "in_progress");
    return [{
      type: "upsert",
      item: {
        id: itemId("todo", todoKey),
        kind: "todo",
        steps: rewrite.steps,
        added: rewrite.added,
        removed: rewrite.removed,
        state: complete ? "complete" : running ? "running" : "pending",
        turnId,
        parentId,
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    }];
  }

  #planMutation(
    toolCallId: string,
    input: unknown,
    turnId: string | null,
    parentId: string | null,
    approvalRequestId: string | null = null,
  ): ActivityMutation | null {
    const value = objectValue(input);
    const markdown = stringValue(value?.plan);
    const path = stringValue(value?.planFilePath);
    /*
      The pinned CLI injects `plan` by reading the file it names, so a plan the
      manager can see the path to but not the text of is a real state. Keeping
      the item — empty, with its path — leaves the document reachable through
      the hardened reader and, more importantly, keeps the approval answerable:
      dropping it took Execute and Send-back with it.
    */
    if (!markdown && !path) return null;
    const rawVersion = value?.version;
    const version = Number.isSafeInteger(rawVersion) && (rawVersion as number) > 0
      ? rawVersion as number
      : null;
    if (approvalRequestId) {
      this.#planApprovalRequests.set(toolCallId, approvalRequestId);
    }
    const linkedRequestId = this.#planApprovalRequests.get(toolCallId) ?? null;
    const approvedAt = this.#approvedPlans.get(toolCallId) ?? null;
    return {
      type: "upsert",
      item: {
        id: itemId("plan", toolCallId),
        kind: "plan",
        path,
        version,
        markdown: markdown ?? "",
        supersededBy: null,
        approvalRequestId: linkedRequestId,
        approvedAt,
        state: approvedAt ? "complete" : "waiting",
        turnId,
        parentId,
        source: "provider-api",
        confidence: "exact",
        exposure: "provider-exposed",
      },
    };
  }

  #fallbackLane(
    message: Extract<ClaudeSdkMessage, { type: "stream_event" }>,
  ): StreamLane {
    const laneKey = message.parent_tool_use_id ?? "root";
    const turnId = message.parent_tool_use_id
      ? this.#turnForParent(message.parent_tool_use_id)
      : this.#currentTurnId ?? message.uuid;
    const lane: StreamLane = {
      messageId: message.uuid,
      parentToolUseId: message.parent_tool_use_id,
      turnId,
      blocks: new Map(),
    };
    this.#lanes.set(laneKey, lane);
    return lane;
  }

  /**
   * The streamed partial this content block finishes, if the lane still holds
   * one.
   *
   * Matching on the content-array index alone is not enough. Claude splits one
   * provider message across several records, and a record's index space does
   * not have to line up with the lane's — so a miss deleted the partial and
   * re-emitted its text under a fresh id. `seq` freezes at an item's first
   * upsert, so that fresh id took a slot at the *end* of the timeline, and the
   * assistant's own words sank below tool calls it had introduced.
   *
   * A tool block never had this problem: it matches on `toolCallId` and ignores
   * the index entirely. Text and thinking have no such id, so they fall back to
   * the next unclaimed partial of the same kind in lane order, which is the
   * order the provider streamed them in.
   */
  #matchingPartial(
    lane: StreamLane | undefined,
    index: number,
    kind: StreamBlock["kind"],
    claimed: Set<string>,
  ): StreamBlock | undefined {
    if (!lane) return undefined;
    const candidate = lane.blocks.get(index);
    const block = candidate?.kind === kind && !claimed.has(candidate.id)
      ? candidate
      : [...lane.blocks.values()].find((entry) => (
          entry.kind === kind && !claimed.has(entry.id)
        ));
    if (block) claimed.add(block.id);
    return block;
  }

  #ensureSubagent(
    taskId: string,
    toolUseId?: string,
    name?: string,
    description?: string | null,
  ): SubagentRecord {
    const existing = this.#subagentsByTask.get(taskId)
      ?? (toolUseId ? this.#subagentsByTool.get(toolUseId) : undefined);
    if (existing) {
      if (existing.taskId.startsWith("tool:")) existing.taskId = taskId;
      if (name) existing.name = name;
      if (description !== undefined && description !== null) existing.description = description;
      this.#subagentsByTask.set(taskId, existing);
      if (toolUseId) this.#subagentsByTool.set(toolUseId, existing);
      return existing;
    }
    const key = toolUseId ?? taskId;
    const record: SubagentRecord = {
      itemId: itemId("subagent", key),
      taskId,
      name: name ?? "Claude subagent",
      description: description ?? null,
      childItemIds: new Set(),
    };
    this.#subagentsByTask.set(taskId, record);
    if (toolUseId) this.#subagentsByTool.set(toolUseId, record);
    return record;
  }

  #knownSubagent(
    taskId: string,
    toolUseId?: string,
  ): SubagentRecord | undefined {
    return this.#subagentsByTask.get(taskId)
      ?? (toolUseId ? this.#subagentsByTool.get(toolUseId) : undefined);
  }

  #taskLifecycleDraft(
    taskId: string,
    title: string,
    state: ActivityState,
    details: string | null,
  ): Extract<ActivityItemDraft, { kind: "lifecycle" }> {
    return {
      id: itemId("task", taskId),
      kind: "lifecycle",
      event: "status",
      level: state === "failed" ? "error" : "info",
      title,
      details,
      state,
      turnId: this.#currentTurnId,
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    };
  }

  #subagentForTool(
    toolUseId: string,
    options: { name?: string; description?: string } = {},
  ): SubagentRecord {
    return this.#subagentsByTool.get(toolUseId)
      ?? this.#ensureSubagent(
        `tool:${toolUseId}`,
        toolUseId,
        options.name,
        options.description,
      );
  }

  #subagentDraft(
    record: SubagentRecord,
    state: ActivityState,
  ): Extract<ActivityItemDraft, { kind: "subagent" }> {
    const toolUseId = [...this.#subagentsByTool.entries()].find(
      ([, candidate]) => candidate === record,
    )?.[0];
    return {
      id: record.itemId,
      kind: "subagent",
      taskId: record.taskId,
      name: record.name,
      description: record.description,
      childItemIds: [...record.childItemIds],
      state,
      turnId: this.#currentTurnId,
      parentId: toolUseId ? itemId("tool", toolUseId) : null,
      source: "provider-api",
      confidence: "exact",
      exposure: "provider-exposed",
    };
  }

  #linkChild(
    parentToolUseId: string | null,
    childId: string,
    mutations: ActivityMutation[],
    options: { name?: string; description?: string } = {},
  ): void {
    if (!parentToolUseId) return;
    const record = this.#subagentForTool(parentToolUseId, options);
    if (record.childItemIds.has(childId)) return;
    record.childItemIds.add(childId);
    mutations.push({ type: "upsert", item: this.#subagentDraft(record, "running") });
  }

  #parentId(parentToolUseId: string | null): string | null {
    return parentToolUseId ? this.#subagentForTool(parentToolUseId).itemId : null;
  }

  #turnForParent(parentToolUseId: string): string {
    return this.#currentTurnId ?? `subagent:${parentToolUseId}`;
  }

  #rememberUuid(uuid: string, mutations: readonly ActivityMutation[]): void {
    this.#rememberProviderItems(uuid, mutations);
  }

  #rememberProviderItems(uuid: string, mutations: readonly ActivityMutation[]): void {
    for (const mutation of mutations) {
      if (
        mutation.type === "upsert"
        && mutation.item.kind !== "plan"
        && mutation.item.kind !== "todo"
      ) this.#rememberProviderId(uuid, mutation.item.id);
    }
  }

  #rememberProviderId(uuid: string, id: string): void {
    const ids = this.#providerUuidItems.get(uuid) ?? new Set<string>();
    ids.add(id);
    this.#providerUuidItems.set(uuid, ids);
  }

  #rememberTool(
    toolCallId: string,
    name: string,
    category: ToolRecord["category"],
    turnId: string | null,
    parentId: string | null,
  ): void {
    this.#tools.set(toolCallId, { name, category, turnId, parentId });
  }

  #removeProviderUuid(uuid: string, mutations: ActivityMutation[]): void {
    const ids = this.#providerUuidItems.get(uuid);
    if (!ids) return;
    for (const id of ids) mutations.push({ type: "remove", id });
    this.#providerUuidItems.delete(uuid);
  }

  #resetEphemeralState(): void {
    this.#lanes.clear();
    this.#providerUuidItems.clear();
    this.#pendingRequests.clear();
    this.#subagentsByTask.clear();
    this.#subagentsByTool.clear();
    this.#tools.clear();
    this.#usage.clear();
    this.#todos.clear();
    this.#planApprovalRequests.clear();
    this.#approvedPlans.clear();
    this.#currentTurnId = null;
    this.#lastSnapshotActivity = null;
    this.#lastSnapshotError = null;
    this.#requestStatusActive = false;
  }
}
