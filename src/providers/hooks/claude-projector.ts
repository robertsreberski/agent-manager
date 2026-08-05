import { createHash } from "node:crypto";

import {
  redactActivityJson,
  redactActivityText,
  reconcileTodoRewrite,
  type ActivityItemDraft,
  type ActivityJsonValue,
  type ActivityMutation,
  type ActivityTodoInputStep,
  type ActivityTodoRewriteState,
} from "../../activity/index.ts";
import type { ClaudeHookInput } from "./claude-types.ts";
import { toolApprovalFacts } from "../approval-facts.ts";

interface DisplayMessage {
  text: string;
  nextIndex: number;
}

type TaskProjectionStep = ActivityTodoInputStep;

export interface ClaudeHookProjection {
  sessionId: string;
  mutations: ActivityMutation[];
}

export interface ClaudeHookProjectionOptions {
  /** UUID allocated by ClaudePermissionBroker for this exact held POST. */
  permissionRequestId?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function itemId(input: ClaudeHookInput, kind: string, identity: string): string {
  return `claude-hook:${segment(input.session_id)}:${kind}:${segment(identity)}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? redactActivityText(value)
    : null;
}

function toJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): ActivityJsonValue {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (depth >= 16 || seen.has(value)) return "[Truncated]";
  seen.add(value);
  if (Array.isArray(value)) {
    const array = value.slice(0, 2_000).map((entry) => toJson(entry, seen, depth + 1));
    seen.delete(value);
    return array;
  }
  const result: Record<string, ActivityJsonValue> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 2_000)) {
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    result[key] = toJson(entry, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function safeJson(value: unknown): ActivityJsonValue {
  return redactActivityJson(toJson(value));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function permissionQuestions(toolInput: unknown) {
  const input = objectValue(toolInput);
  if (!Array.isArray(input?.questions)) return [];
  return input.questions.flatMap((rawQuestion, index) => {
    const question = objectValue(rawQuestion);
    if (!question || typeof question.question !== "string" || question.question.length === 0) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          if (typeof rawOption === "string") {
            return [{ label: redactActivityText(rawOption), description: null, recommended: null }];
          }
          const option = objectValue(rawOption);
          if (!option || typeof option.label !== "string") return [];
          return [{
            label: redactActivityText(option.label),
            description: typeof option.description === "string"
              ? redactActivityText(option.description)
              : null,
            recommended: typeof option.recommended === "boolean"
              ? option.recommended
              : null,
          }];
        })
      : [];
    return [{
      id: typeof question.header === "string" && question.header.length > 0
        ? redactActivityText(question.header)
        : `question-${index + 1}`,
      ...(typeof question.header === "string"
        ? { header: redactActivityText(question.header) }
        : {}),
      text: redactActivityText(question.question),
      options,
      multiSelect: question.multiSelect === true,
      allowFreeText: question.allowFreeText !== false,
      isSecret: question.isSecret === true,
    }];
  });
}

function common(input: ClaudeHookInput): Pick<
  ActivityItemDraft,
  "turnId" | "parentId" | "source" | "confidence" | "exposure"
> {
  return {
    turnId: input.prompt_id ?? null,
    parentId: input.agent_id
      ? itemId(input, "subagent", input.agent_id)
      : null,
    source: "provider-api",
    confidence: "exact",
    exposure: "provider-exposed",
  };
}

function toolCategory(name: string): Extract<
  ActivityItemDraft,
  { kind: "tool" }
>["category"] & {} {
  if (/^(?:bash|shell|terminal|command)$/i.test(name)) return "command";
  if (name.startsWith("mcp__")) return "mcp";
  if (/^(?:websearch|webfetch|web_search|web_fetch)$/i.test(name)) return "web-search";
  if (/^(?:viewimage|image|image_view)$/i.test(name)) return "image-view";
  if (/^(?:task|agent|sendmessage|teamcreate|teamdelete)$/i.test(name)) return "collaboration";
  return "other";
}

function upsert(item: ActivityItemDraft): ActivityMutation {
  return { type: "upsert", item };
}

/** Stateful for MessageDisplay folding and provider checklist rewrite identity/churn. */
export class ClaudeHookActivityProjector {
  readonly #displayMessages = new Map<string, DisplayMessage>();
  readonly #completedDisplays = new Map<string, number>();
  readonly #todos = new Map<string, ActivityTodoRewriteState>();
  readonly #tasks = new Map<string, Map<string, TaskProjectionStep>>();
  readonly #taskTodos = new Map<string, ActivityTodoRewriteState>();
  /*
    A permission request the tool call has not arrived for yet, keyed
    `<session>\0<tool_name>`.

    `PermissionRequestHookInput` carries no `tool_use_id` — Claude asks before
    it has one — so at the moment the question is projected there is nothing to
    point it at, and the cockpit rendered the question above the tool call that
    raised it. Claude fires `PermissionRequest` for a tool and then `PreToolUse`
    for that same tool, so the id arrives one hook later; this remembers the
    question until it does.
  */
  readonly #awaitingToolUse = new Map<string, Extract<ActivityItemDraft, { kind: "attention" }>>();

  project(
    input: ClaudeHookInput,
    options: ClaudeHookProjectionOptions = {},
  ): ClaudeHookProjection {
    const base = common(input);
    const mutations: ActivityMutation[] = [];

    switch (input.hook_event_name) {
      case "SessionStart":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "lifecycle", "session"),
          kind: "lifecycle",
          event: "status",
          level: "info",
          title: input.source === "resume" ? "Claude session resumed" : "Claude session started",
          details: [text(input.model), text(input.session_title)].filter(Boolean).join(" · ") || null,
          state: "running",
        }));
        break;

      case "SessionEnd":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "lifecycle", "session"),
          kind: "lifecycle",
          event: "status",
          level: "info",
          title: "Claude session ended",
          details: text(input.reason),
          state: "complete",
        }));
        break;

      case "UserPromptSubmit": {
        const identity = input.prompt_id ?? digest(input.prompt);
        mutations.push(upsert({
          ...base,
          id: itemId(input, "message:user", identity),
          correlationId: input.prompt_id ? `message:${input.prompt_id}` : null,
          kind: "message",
          role: "user",
          text: redactActivityText(input.prompt),
          state: "complete",
        }));
        break;
      }

      case "PreToolUse": {
        const toolItemId = itemId(input, "tool", input.tool_use_id);
        mutations.push(upsert({
          ...base,
          id: toolItemId,
          correlationId: `tool:${input.tool_use_id}`,
          kind: "tool",
          toolCallId: input.tool_use_id,
          name: redactActivityText(input.tool_name),
          category: toolCategory(input.tool_name),
          arguments: safeJson(input.tool_input),
          state: "running",
        }));
        /*
          The tool id Claude withheld when it asked. Re-upserting the question
          with it fills in the parent the cockpit places by; the hub merges on
          id and freezes seq at first upsert, so this moves the question under
          its tool call without disturbing anything else in the turn.
        */
        const awaitingKey = `${input.session_id}\u0000${input.tool_name}`;
        const awaiting = this.#awaitingToolUse.get(awaitingKey);
        if (awaiting) {
          this.#awaitingToolUse.delete(awaitingKey);
          mutations.push(upsert({ ...awaiting, parentId: toolItemId }));
        }
        if (input.tool_name === "TodoWrite") {
          const todo = this.#todoMutation(input);
          if (todo) mutations.push(todo);
        }
        break;
      }

      case "PostToolUse":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "tool", input.tool_use_id),
          correlationId: `tool:${input.tool_use_id}`,
          kind: "tool",
          toolCallId: input.tool_use_id,
          name: redactActivityText(input.tool_name),
          category: toolCategory(input.tool_name),
          arguments: safeJson(input.tool_input),
          result: safeJson(input.tool_response),
          state: "complete",
        }));
        break;

      case "PostToolUseFailure":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "tool", input.tool_use_id),
          correlationId: `tool:${input.tool_use_id}`,
          kind: "tool",
          toolCallId: input.tool_use_id,
          name: redactActivityText(input.tool_name),
          category: toolCategory(input.tool_name),
          arguments: safeJson(input.tool_input),
          result: redactActivityText(input.error),
          state: input.is_interrupt ? "interrupted" : "failed",
        }));
        break;

      case "PermissionDenied":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "tool", input.tool_use_id),
          correlationId: `tool:${input.tool_use_id}`,
          kind: "tool",
          toolCallId: input.tool_use_id,
          name: redactActivityText(input.tool_name),
          category: toolCategory(input.tool_name),
          arguments: safeJson(input.tool_input),
          result: redactActivityText(input.reason),
          state: "failed",
        }));
        break;

      case "PermissionRequest": {
        const requestId = options.permissionRequestId;
        if (!requestId) {
          throw new Error("PermissionRequest projection requires its broker request UUID");
        }
        const questions = input.tool_name === "AskUserQuestion"
          ? permissionQuestions(input.tool_input)
          : [];
        if (input.tool_name === "ExitPlanMode") {
          const plan = objectValue(input.tool_input);
          if (typeof plan?.plan === "string" && plan.plan.length > 0) {
            const rawVersion = plan.version;
            mutations.push(upsert({
              ...base,
              id: itemId(input, "plan", requestId),
              kind: "plan",
              path: typeof plan.planFilePath === "string"
                ? redactActivityText(plan.planFilePath)
                : null,
              version: Number.isSafeInteger(rawVersion) && (rawVersion as number) > 0
                ? rawVersion as number
                : null,
              markdown: redactActivityText(plan.plan),
              supersededBy: null,
              approvalRequestId: requestId,
              approvedAt: null,
              state: "waiting",
            }));
          }
        }
        const attention = {
          ...base,
          id: itemId(input, "attention", requestId),
          kind: "attention" as const,
          requestId,
          attentionKind: input.tool_name === "AskUserQuestion"
            ? "question" as const
            : input.tool_name === "ExitPlanMode"
              ? "approval" as const
              : "permission" as const,
          title: `Claude requests ${redactActivityText(input.tool_name)}`,
          summary: JSON.stringify(safeJson(input.tool_input)).slice(0, 2_000),
          questions,
          approvalFacts: input.tool_name === "AskUserQuestion"
            ? null
            : toolApprovalFacts(input.tool_name, input.tool_input, {
                cwd: input.cwd,
                canPersist: Array.isArray(input.permission_suggestions) &&
                  input.permission_suggestions.length > 0,
              }),
          respondable: true,
          resolved: false,
          isSecret: questions.some((question) => question.isSecret),
          state: "waiting" as const,
        };
        mutations.push(upsert(attention));
        // The tool id arrives one hook later, on `PreToolUse`.
        this.#awaitingToolUse.set(
          `${input.session_id}\u0000${input.tool_name}`,
          attention,
        );
        break;
      }

      case "Elicitation": {
        const identity = input.elicitation_id
          ?? digest(`${input.prompt_id ?? ""}\0${input.mcp_server_name}\0${input.message}`);
        mutations.push(upsert({
          ...base,
          id: itemId(input, "attention:elicitation", identity),
          kind: "attention",
          requestId: identity,
          attentionKind: "elicitation",
          title: `Input requested by ${redactActivityText(input.mcp_server_name)}`,
          summary: redactActivityText(input.message),
          respondable: false,
          resolved: false,
          state: "waiting",
        }));
        break;
      }

      case "MessageDisplay": {
        const key = `${input.session_id}\0${input.message_id}`;
        const completedIndex = this.#completedDisplays.get(key);
        if (completedIndex !== undefined && input.index <= completedIndex) break;
        const current = this.#displayMessages.get(key) ?? { text: "", nextIndex: 0 };
        if (input.index < current.nextIndex) break;
        if (input.index > current.nextIndex) {
          mutations.push(upsert({
            ...base,
            id: itemId(input, "lifecycle:display-gap", input.message_id),
            kind: "lifecycle",
            event: "warning",
            level: "warning",
            title: "Claude display stream skipped a delta",
            details: `Expected ${current.nextIndex}, received ${input.index}`,
            state: "complete",
          }));
        }
        current.text += redactActivityText(input.delta);
        current.nextIndex = input.index + 1;
        if (current.text.length > 262_144) current.text = current.text.slice(-262_144);
        this.#displayMessages.set(key, current);
        mutations.push(upsert({
          ...base,
          turnId: input.turn_id,
          id: itemId(input, "message:assistant", input.message_id),
          correlationId: `message:${input.message_id}`,
          kind: "message",
          role: "assistant",
          text: current.text,
          state: input.final ? "complete" : "running",
        }));
        if (input.final) {
          this.#displayMessages.delete(key);
          this.#completedDisplays.set(key, input.index);
          if (this.#completedDisplays.size > 512) {
            const oldest = this.#completedDisplays.keys().next().value;
            if (typeof oldest === "string") this.#completedDisplays.delete(oldest);
          }
        }
        break;
      }

      case "SubagentStart":
        mutations.push(upsert({
          ...base,
          // Claude's hook payload identifies this agent but does not expose
          // the parent agent that spawned it. Keep the container top-level;
          // inferring a nested edge from arrival order would be fabricated.
          parentId: null,
          id: itemId(input, "subagent", input.agent_id),
          kind: "subagent",
          taskId: input.agent_id,
          name: redactActivityText(input.agent_type),
          state: "running",
        }));
        break;

      case "SubagentStop":
        mutations.push(upsert({
          ...base,
          // Same wire limitation as SubagentStart: the parent agent identity
          // is not present on this event.
          parentId: null,
          id: itemId(input, "subagent", input.agent_id),
          kind: "subagent",
          taskId: input.agent_id,
          name: redactActivityText(input.agent_type),
          output: text(input.last_assistant_message) ?? "",
          state: "complete",
        }));
        break;

      case "TaskCreated":
      case "TaskCompleted": {
        const tasks = this.#tasks.get(input.session_id) ?? new Map<string, TaskProjectionStep>();
        tasks.set(input.task_id, {
          id: input.task_id,
          text: redactActivityText(input.task_subject),
          status: input.hook_event_name === "TaskCompleted" ? "completed" : "pending",
          detail: text(input.task_description),
        });
        this.#tasks.set(input.session_id, tasks);
        const nextSteps = [...tasks.values()];
        const rewrite = reconcileTodoRewrite(
          this.#taskTodos.get(input.session_id) ?? null,
          nextSteps,
        );
        this.#taskTodos.set(input.session_id, rewrite);
        mutations.push(upsert({
          ...base,
          id: itemId(input, "todo:tasks", "session"),
          kind: "todo",
          steps: rewrite.steps,
          added: rewrite.added,
          removed: rewrite.removed,
          state: nextSteps.every((step) => step.status === "completed") ? "complete" : "pending",
        }));
        break;
      }

      case "PreCompact":
      case "PostCompact":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "compact", input.prompt_id ?? "session"),
          kind: "lifecycle",
          event: "context-compaction",
          level: "info",
          title: input.hook_event_name === "PreCompact"
            ? "Claude is compacting context"
            : "Claude compacted context",
          details: input.hook_event_name === "PreCompact" ? text(input.trigger) : null,
          state: input.hook_event_name === "PreCompact" ? "running" : "complete",
        }));
        break;

      case "Stop":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "turn", input.prompt_id ?? digest(input.last_assistant_message ?? "stop")),
          kind: "lifecycle",
          event: "turn-completed",
          level: "info",
          title: "Claude turn completed",
          details: null,
          state: "complete",
        }));
        break;

      case "StopFailure":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "turn", input.prompt_id ?? "failure"),
          kind: "lifecycle",
          event: "turn-failed",
          level: "error",
          title: "Claude turn failed",
          details: text(input.error_details) ?? JSON.stringify(safeJson(input.error)).slice(0, 2_000),
          state: "failed",
        }));
        break;

      case "Notification":
        mutations.push(upsert({
          ...base,
          id: itemId(input, "notification", digest(`${input.prompt_id ?? ""}\0${input.notification_type}\0${input.message}`)),
          kind: "lifecycle",
          event: "warning",
          level: "warning",
          title: text(input.title) ?? "Claude notification",
          details: redactActivityText(input.message),
          state: "complete",
        }));
        break;
    }

    return { sessionId: input.session_id, mutations };
  }

  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.#displayMessages.keys()) {
      if (key.startsWith(prefix)) this.#displayMessages.delete(key);
    }
    for (const key of this.#completedDisplays.keys()) {
      if (key.startsWith(prefix)) this.#completedDisplays.delete(key);
    }
    this.#todos.delete(sessionId);
    this.#tasks.delete(sessionId);
    this.#taskTodos.delete(sessionId);
  }

  #todoMutation(input: Extract<ClaudeHookInput, { hook_event_name: "PreToolUse" }>): ActivityMutation | null {
    const value = objectValue(input.tool_input);
    if (!Array.isArray(value?.todos)) return null;
    const occurrence = new Map<string, number>();
    const nextSteps: ActivityTodoInputStep[] = value.todos.flatMap((rawTodo): ActivityTodoInputStep[] => {
      const todo = objectValue(rawTodo);
      const content = typeof todo?.content === "string" && todo.content.length > 0
        ? todo.content
        : null;
      const status = todo?.status;
      if (
        !content
        || (status !== "pending" && status !== "in_progress" && status !== "completed")
      ) return [];
      const count = occurrence.get(content) ?? 0;
      occurrence.set(content, count + 1);
      return [{
        id: `claude-todo-${digest(`${content}\0${count}`)}`,
        text: redactActivityText(content),
        status,
        detail: status === "in_progress" && typeof todo?.activeForm === "string"
          ? redactActivityText(todo.activeForm)
          : null,
      }];
    });
    const previous = this.#todos.get(input.session_id);
    const rewrite = reconcileTodoRewrite(previous ?? null, nextSteps);
    this.#todos.set(input.session_id, rewrite);
    return upsert({
      ...common(input),
      id: itemId(input, "todo", "session"),
      kind: "todo",
      steps: rewrite.steps,
      added: rewrite.added,
      removed: rewrite.removed,
      state: nextSteps.length > 0 && nextSteps.every((step) => step.status === "completed")
        ? "complete"
        : nextSteps.some((step) => step.status === "in_progress")
          ? "running"
          : "pending",
    });
  }
}
