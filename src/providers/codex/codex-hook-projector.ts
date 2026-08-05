import { createHash } from "node:crypto";

import type { ActivityItemDraft, ActivityMutation } from "../../activity/index.ts";
import {
  codexMessageCorrelationId,
  type CodexActivityProjection,
} from "./activity-projector.ts";
import type { CodexHookInput } from "./codex-hook.ts";
import { toolApprovalFacts } from "../approval-facts.ts";

function segment(value: string): string {
  return encodeURIComponent(value);
}

function hash(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = "[unserializable]";
  }
  return createHash("sha256").update(serialized).digest("hex").slice(0, 20);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.slice(0, 262_144) : null;
}

function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable provider value]";
  }
}

function id(input: CodexHookInput, kind: string, identity: string): string {
  return `codex-hook/${segment(input.sessionId)}/${segment(kind)}/${segment(identity)}`;
}

function subagentId(input: CodexHookInput, agentId: string): string {
  return id(input, "subagent", agentId);
}

function common(
  input: CodexHookInput,
  itemId: string,
  state: NonNullable<ActivityItemDraft["state"]>,
  receivedAt: string,
): Pick<
  ActivityItemDraft,
  "id" | "turnId" | "parentId" | "state" | "updatedAt" | "source" | "confidence" | "exposure"
> {
  return {
    id: itemId,
    turnId: input.turnId,
    parentId: input.agentId ? subagentId(input, input.agentId) : null,
    state,
    updatedAt: receivedAt,
    source: "provider-api",
    confidence: "exact",
    exposure: "provider-exposed",
  };
}

function upsert(item: ActivityItemDraft): ActivityMutation {
  return { type: "upsert", item };
}

/** Projects only fields delivered by the pinned Codex command-hook schema. */
export function projectCodexHook(
  input: CodexHookInput,
  receivedAt: string,
): CodexActivityProjection {
  const mutations: ActivityMutation[] = [];
  const turnIdentity = input.turnId ?? "session";
  switch (input.event) {
    case "SessionStart":
    case "SessionEnd":
      mutations.push(upsert({
        ...common(input, id(input, "session", "lifecycle"), "complete", receivedAt),
        kind: "lifecycle",
        event: "status",
        level: "info",
        title: input.event === "SessionStart" ? "External Codex session started" : "External Codex session ended",
        details: input.model ? `Codex command hook · ${input.model}` : "Codex command hook",
      }));
      break;
    case "UserPromptSubmit": {
      const prompt = text(input.raw.prompt);
      mutations.push(upsert({
        ...common(input, id(input, "prompt", `${turnIdentity}:${hash(prompt ?? input.raw)}`), "complete", receivedAt),
        correlationId: input.turnId && typeof input.raw.prompt === "string"
          ? codexMessageCorrelationId(input.sessionId, input.turnId, "user", input.raw.prompt)
          : null,
        kind: "message",
        role: "user",
        phase: null,
        text: prompt ?? "",
        label: prompt ? null : "User prompt submitted",
      }));
      break;
    }
    case "PreToolUse":
    case "PostToolUse": {
      const toolIdentity = input.toolUseId ?? hash(input.raw);
      const completed = input.event === "PostToolUse";
      mutations.push(upsert({
        ...common(input, id(input, "tool", toolIdentity), completed ? "complete" : "running", receivedAt),
        correlationId: `tool:${toolIdentity}`,
        kind: "tool",
        toolCallId: toolIdentity,
        name: input.toolName ?? "Codex tool",
        category: input.toolName === "Bash" || input.toolName === "Shell" ? "command" : "other",
        arguments: input.toolInput,
        result: completed
          ? input.raw.tool_response ?? input.raw.tool_result ?? input.raw.result ?? null
          : null,
        output: completed ? text(input.raw.output) ?? "" : "",
      }));
      break;
    }
    case "PermissionRequest": {
      const requestIdentity = input.toolUseId ?? hash({
        turnId: input.turnId,
        toolName: input.toolName,
        toolInput: input.toolInput,
      });
      mutations.push(upsert({
        ...common(input, id(input, "permission", requestIdentity), "waiting", receivedAt),
        kind: "attention",
        requestId: requestIdentity,
        attentionKind: "permission",
        title: "Codex permission request",
        summary: text(input.raw.reason) ?? `${input.toolName ?? "Codex"} is requesting permission`,
        questions: [],
        approvalFacts: toolApprovalFacts(input.toolName, input.toolInput, {
          cwd: input.cwd,
          canPersist: Array.isArray(input.raw.permission_suggestions) &&
            input.raw.permission_suggestions.length > 0,
        }),
        respondable: false,
        resolved: false,
        isSecret: false,
      }));
      break;
    }
    case "PreCompact":
    case "PostCompact":
      mutations.push(upsert({
        ...common(
          input,
          id(input, "compaction", turnIdentity),
          input.event === "PreCompact" ? "running" : "complete",
          receivedAt,
        ),
        kind: "lifecycle",
        event: "context-compaction",
        level: "info",
        title: input.event === "PreCompact" ? "Compacting context" : "Context compacted",
        details: text(input.raw.trigger),
      }));
      break;
    case "SubagentStart":
    case "SubagentStop": {
      const agentId = input.agentId;
      if (!agentId || !input.agentType) break;
      mutations.push(upsert({
        ...common(
          input,
          id(input, "subagent", agentId),
          input.event === "SubagentStop" ? "complete" : "running",
          receivedAt,
        ),
        // Codex does not expose the parent agent identity on these lifecycle
        // events. Keep the subagent top-level instead of inventing a parent or
        // self-parenting it through the common agent_id relationship.
        parentId: null,
        kind: "subagent",
        taskId: agentId,
        name: input.agentType,
        description: text(input.raw.prompt),
        output: input.event === "SubagentStop"
          ? text(input.raw.last_assistant_message) ?? json(input.raw.result) ?? ""
          : "",
        childItemIds: [],
      }));
      break;
    }
    case "Stop": {
      const assistantMessage = text(input.raw.last_assistant_message);
      if (assistantMessage) {
        mutations.push(upsert({
          ...common(input, id(input, "message", `${turnIdentity}:assistant`), "complete", receivedAt),
          correlationId: input.turnId && typeof input.raw.last_assistant_message === "string"
            ? codexMessageCorrelationId(
                input.sessionId,
                input.turnId,
                "assistant",
                input.raw.last_assistant_message,
              )
            : null,
          kind: "message",
          role: "assistant",
          phase: "final",
          text: assistantMessage,
          label: null,
        }));
      }
      mutations.push(upsert({
        ...common(input, id(input, "turn", turnIdentity), "complete", receivedAt),
        kind: "lifecycle",
        event: "turn-completed",
        level: "info",
        title: "External Codex turn stopped",
        details: text(input.raw.reason),
      }));
      break;
    }
  }
  return { threadId: input.sessionId, mutations };
}
