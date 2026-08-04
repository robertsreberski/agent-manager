import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_HOOK_EVENTS,
  codexNoDecisionHookOutput,
  evaluateCodexHookStatus,
  parseCodexHookInput,
  probeCodexHookStatus,
} from "./codex-hook.ts";
import { projectCodexHook } from "./codex-hook-projector.ts";
import type { MessageTransport } from "./rpc.ts";

test("parses Codex command-hook input without Claude schema assumptions", () => {
  const parsed = parseCodexHookInput(JSON.stringify({
    session_id: "thread-1",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/workspace",
    hook_event_name: "PermissionRequest",
    model: "gpt-5.6",
    permission_mode: "default",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_input: { command: "git status" },
  }));
  assert.equal(parsed.sessionId, "thread-1");
  assert.equal(parsed.event, "PermissionRequest");
  assert.deepEqual(parsed.toolInput, { command: "git status" });
  assert.throws(
    () => parseCodexHookInput(JSON.stringify({ ...parsed.raw, hook_event_name: "Setup" })),
    /Unsupported Codex hook event/u,
  );
  const ended = parseCodexHookInput(JSON.stringify({
    session_id: "thread-1",
    transcript_path: null,
    cwd: "/workspace",
    hook_event_name: "SessionEnd",
    reason: "exit",
  }));
  assert.equal(ended.model, null);
  const arrayInput = parseCodexHookInput(JSON.stringify({
    ...parsed.raw,
    tool_input: ["one", 2],
  }));
  assert.deepEqual(arrayInput.toolInput, ["one", 2]);
});

test("normalizes Codex subagent fields and scopes child hierarchy to the hook session", () => {
  const childTool = parseCodexHookInput(JSON.stringify({
    session_id: "thread-1",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/workspace",
    hook_event_name: "PreToolUse",
    model: "gpt-5.6",
    agent_id: "agent-1",
    agent_type: "reviewer",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "git status" },
  }));
  assert.equal(childTool.agentId, "agent-1");
  assert.equal(childTool.agentType, "reviewer");

  const child = projectCodexHook(childTool, "2026-08-04T12:00:00.000Z").mutations[0];
  assert.ok(child?.type === "upsert");
  assert.equal(child.item.parentId, "codex-hook/thread-1/subagent/agent-1");

  const otherSession = parseCodexHookInput(JSON.stringify({
    ...childTool.raw,
    session_id: "thread-2",
  }));
  const other = projectCodexHook(otherSession, "2026-08-04T12:00:00.000Z").mutations[0];
  assert.ok(other?.type === "upsert");
  assert.equal(other.item.parentId, "codex-hook/thread-2/subagent/agent-1");
  assert.notEqual(other.item.parentId, child.item.parentId);
});

test("keeps Codex subagent lifecycle top-level while reusing its stable identity", () => {
  const common = {
    session_id: "thread-1",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/workspace",
    model: "gpt-5.6",
    agent_id: "agent-1",
    agent_type: "reviewer",
  };
  const start = projectCodexHook(parseCodexHookInput(JSON.stringify({
    ...common,
    hook_event_name: "SubagentStart",
  })), "2026-08-04T12:00:00.000Z").mutations[0];
  const stop = projectCodexHook(parseCodexHookInput(JSON.stringify({
    ...common,
    hook_event_name: "SubagentStop",
    last_assistant_message: "Done",
  })), "2026-08-04T12:01:00.000Z").mutations[0];

  assert.ok(start?.type === "upsert" && start.item.kind === "subagent");
  assert.ok(stop?.type === "upsert" && stop.item.kind === "subagent");
  assert.equal(start.item.id, "codex-hook/thread-1/subagent/agent-1");
  assert.equal(stop.item.id, start.item.id);
  assert.equal(start.item.parentId, null);
  assert.equal(stop.item.parentId, null);
  assert.equal(stop.item.output, "Done");

  assert.throws(() => parseCodexHookInput(JSON.stringify({
    ...common,
    hook_event_name: "SubagentStart",
    agent_type: undefined,
  })), /requires agent_id and agent_type/u);
});

test("exposes only the exact no-decision response", () => {
  assert.deepEqual(codexNoDecisionHookOutput(), {});
});

test("reports modified Codex hooks as awaiting explicit /hooks trust", () => {
  const command = "/opt/agent-manager hook codex";
  const events = ["SessionStart", "PermissionRequest"] as const;
  const status = evaluateCodexHookStatus({
    data: [{
      cwd: "/workspace",
      errors: [],
      warnings: [],
      hooks: events.map((event) => ({
        command,
        eventName: event[0]!.toLowerCase() + event.slice(1),
        handlerType: "command",
        enabled: true,
        trustStatus: event === "PermissionRequest" ? "modified" : "trusted",
      })),
    }],
  }, command, events);
  assert.equal(status.state, "awaiting-trust");
  assert.match(status.reason, /\/hooks/u);
});

test("probes hooks/list after initialization and reports live enable/trust state", async () => {
  const command = "'/tmp/agent-manager-codex-hook.mjs'";
  const sent: string[] = [];
  class ProbeTransport implements MessageTransport {
    readonly listeners = new Set<(message: string) => void>();

    async send(raw: string): Promise<void> {
      const message = JSON.parse(raw) as { id?: number; method: string };
      sent.push(message.method);
      if (message.id === 1) {
        queueMicrotask(() => this.emit({ id: 1, result: { userAgent: "codex-cli/0.146.0" } }));
      } else if (message.id === 2) {
        queueMicrotask(() => this.emit({
          id: 2,
          result: {
            data: [{
              cwd: "/workspace",
              errors: [],
              warnings: [],
              hooks: CODEX_HOOK_EVENTS.map((event) => ({
                command,
                eventName: event[0]!.toLowerCase() + event.slice(1),
                handlerType: "command",
                enabled: event !== "Stop",
                trustStatus: "trusted",
              })),
            }],
          },
        }));
      }
    }

    async close(): Promise<void> {}
    onMessage(listener: (message: string) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    onClose(): () => void {
      return () => undefined;
    }
    emit(value: unknown): void {
      for (const listener of this.listeners) listener(JSON.stringify(value));
    }
  }

  const status = await probeCodexHookStatus({
    codexExecutable: "/opt/codex",
    cwds: ["/workspace"],
    expectedCommand: command,
    connect: () => new ProbeTransport(),
  });
  assert.deepEqual(sent, ["initialize", "initialized", "hooks/list"]);
  assert.equal(status.state, "disabled");
  assert.deepEqual(status.installedEvents, CODEX_HOOK_EVENTS);
});
