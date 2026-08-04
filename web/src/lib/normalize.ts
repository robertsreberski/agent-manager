import type {
  Activity,
  AttentionRequest,
  Capability,
  Confidence,
  ConversationMessage,
  Diagnostic,
  ModeValue,
  SessionTranscript,
  SessionView,
  SessionsSnapshot,
} from "../types";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function confidence(value: unknown): Confidence {
  return value === "exact" || value === "inferred" || value === "heuristic"
    ? value
    : "heuristic";
}

function modeValue(value: unknown): ModeValue {
  if (value === "planning" || value === "plan") return "planning";
  if (value === "execution" || value === "default" || value === "full-access") {
    return "execution";
  }
  return "unknown";
}

function activity(value: unknown): Activity {
  const normalized = value === "live" ? "running" : value;
  if (
    normalized === "running" ||
    normalized === "waiting" ||
    normalized === "idle" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "interrupted"
  ) {
    return normalized;
  }
  return "unknown";
}

function capability(value: unknown): Capability | null {
  if (typeof value !== "string") return null;
  const suffix = value.split(".").at(-1);
  if (suffix === "start") return "queue";
  if (suffix === "input") return "attach";
  if (
    suffix === "queue" ||
    suffix === "steer" ||
    suffix === "interrupt" ||
    suffix === "respond" ||
    suffix === "preview" ||
    suffix === "attach" ||
    suffix === "resume"
  ) {
    return suffix;
  }
  if (value === "set-mode" || value === "mode.set") return "set-mode";
  return null;
}

function normalizeAttention(value: unknown, fallbackReason: unknown): AttentionRequest[] {
  const values = Array.isArray(value)
    ? value
    : record(value).requests && Array.isArray(record(value).requests)
      ? (record(value).requests as unknown[])
      : [];

  const normalized = values.flatMap((raw): AttentionRequest[] => {
    const input = record(raw);
    const details = record(input.details);
    const kind = text(input.kind);
    if (
      kind !== "question" &&
      kind !== "approval" &&
      kind !== "permission" &&
      kind !== "sandbox" &&
      kind !== "elicitation" &&
      kind !== "blocked"
    ) {
      return [];
    }
    const options = Array.isArray(input.options)
      ? input.options.flatMap((option) => {
          const item = record(option);
          const label = text(item.label) ?? text(option);
          return label
            ? [{
                ...(text(item.id) ? { id: text(item.id)! } : {}),
                label,
                ...(text(item.description) ? { description: text(item.description)! } : {}),
              }]
            : [];
        })
      : undefined;
    const questions = Array.isArray(details.questions)
      ? details.questions.flatMap((rawQuestion, questionIndex) => {
          const question = record(rawQuestion);
          const questionText = text(question.text) ?? text(question.question);
          if (!questionText) return [];
          const questionOptions = Array.isArray(question.options)
            ? question.options.flatMap((rawOption) => {
                const option = record(rawOption);
                const label = text(option.label) ?? text(rawOption);
                if (!label) return [];
                const description = text(option.description);
                return [{ label, ...(description ? { description } : {}) }];
              })
            : [];
          return [{
            id: text(question.id) ?? `question-${questionIndex + 1}`,
            ...(text(question.header) ? { header: text(question.header)! } : {}),
            text: questionText,
            options: questionOptions,
            multiSelect: boolean(question.multiSelect),
            allowFreeText: boolean(question.allowFreeText, questionOptions.length === 0),
          }];
        })
      : undefined;
    return [
      {
        id: text(input.id),
        kind,
        summary: text(input.summary),
        prompt: text(input.prompt),
        ...(options ? { options } : {}),
        multiple: boolean(input.multiple),
        ...(text(details.title) ? { title: text(details.title)! } : {}),
        ...(questions ? { questions } : {}),
        ...(text(details.toolName) ? { toolName: text(details.toolName)! } : {}),
        ...(text(details.inputSummary) ? { inputSummary: text(details.inputSummary)! } : {}),
        ...(typeof details.respondable === "boolean" ? { respondable: details.respondable } : {}),
        source: text(input.source) ?? "inferred",
        confidence: confidence(input.confidence),
      },
    ];
  });

  if (normalized.length > 0) return normalized;
  if (fallbackReason === "approval") {
    return [{ id: null, kind: "approval", summary: "Approval requested", source: "legacy", confidence: "heuristic" }];
  }
  if (fallbackReason === "user-input") {
    return [{ id: null, kind: "question", summary: "Input requested", source: "legacy", confidence: "heuristic" }];
  }
  if (fallbackReason === "blocked") {
    return [{ id: null, kind: "blocked", summary: "Blocked — reason unknown", source: "legacy", confidence: "heuristic" }];
  }
  return [];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "tool-call" || item.type === "tool_use") {
        return `[Tool: ${text(item.toolName) ?? text(item.name) ?? "activity"}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index): ConversationMessage[] => {
    const input = record(raw);
    const rawRole = text(input.role) ?? "assistant";
    const role =
      rawRole === "user" || rawRole === "system" || rawRole === "tool"
        ? rawRole
        : "assistant";
    const messageText = text(input.text) ?? contentText(input.content);
    if (!messageText) return [];
    const status =
      input.status === "running" || input.status === "incomplete"
        ? input.status
        : "complete";
    return [
      {
        id: text(input.id) ?? `message-${index}`,
        role,
        text: messageText,
        createdAt: text(input.createdAt) ?? text(input.timestamp),
        status,
        label: text(input.label) ?? text(input.toolName),
      },
    ];
  });
}

function hasOwn(input: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function normalizeTranscript(
  input: JsonRecord,
  messages: ConversationMessage[],
): SessionTranscript {
  const rawTranscript = input.transcript;
  const transcript = record(rawTranscript);
  const rawState = text(transcript.state);
  const hasMessages = hasOwn(input, "messages") && Array.isArray(input.messages)
    || Array.isArray(rawTranscript)
    || hasOwn(input, "history") && Array.isArray(input.history);
  const state = rawState === "available" || rawState === "unavailable" || rawState === "not-loaded"
    ? rawState
    : hasMessages
      ? "available"
      : "not-loaded";
  const rawSource = text(transcript.source);
  const source = rawSource === "codex-rollout" ||
      rawSource === "claude-transcript" ||
      rawSource === "provider-api"
    ? rawSource
    : null;
  const rawReason = text(transcript.reason);
  const reason = rawReason === "not-found" || rawReason === "unreadable" || rawReason === "unsupported"
    ? rawReason
    : null;

  return {
    state,
    truncated: boolean(transcript.truncated),
    source,
    messageCount: number(transcript.messageCount) ?? messages.length,
    reason,
  };
}

export function normalizeSession(raw: unknown): SessionView {
  const input = record(raw);
  const modeInput = record(input.mode);
  const accessInput = record(input.effectiveAccess ?? input.access);
  const terminalInput = record(input.terminal);
  const controlInput = record(input.control);
  const sessionId = text(input.id) ?? text(input.sessionId) ?? "unknown-session";
  const rawCapabilities = Array.isArray(controlInput.capabilities)
    ? controlInput.capabilities
    : [];
  const capabilities = Array.from(
    new Set(rawCapabilities.map(capability).filter((item): item is Capability => item !== null)),
  );
  const provider = input.provider === "claude" ? "claude" : "codex";
  const ownership =
    input.ownership === "manager" || boolean(controlInput.managerOwned)
      ? "manager"
      : "external";
  const normalizedActivity = activity(input.activity ?? input.status);
  const rawMode = modeInput.value ?? input.mode;
  const permissionMode = text(accessInput.permissionMode) ?? text(input.permissionMode);
  const sandboxMode = text(accessInput.sandboxMode) ?? text(input.sandboxMode);
  const inferredFullAccess =
    permissionMode === "bypassPermissions" ||
    permissionMode === "danger-full-access" ||
    sandboxMode === "danger-full-access" ||
    boolean(accessInput.fullHostAccess);

  const queueInput = Array.isArray(input.queue) ? input.queue : [];
  const rawMessages = Array.isArray(input.messages)
    ? input.messages
    : Array.isArray(input.transcript)
      ? input.transcript
      : input.history;
  const messages = normalizeMessages(rawMessages);

  return {
    id: sessionId,
    provider,
    name: text(input.name) ?? text(input.title),
    cwd: text(input.cwd),
    parentSessionId: text(input.parentSessionId),
    depth: number(input.depth) ?? 0,
    ownership,
    runtimeAlive: boolean(input.runtimeAlive, input.lifecycle === "live"),
    mode: {
      value: modeValue(rawMode),
      providerValue: text(modeInput.providerValue) ?? text(input.providerMode) ?? permissionMode,
      source: text(modeInput.source) ?? text(input.statusSource) ?? "inferred",
      confidence: confidence(modeInput.confidence),
    },
    activity: normalizedActivity,
    attention: normalizeAttention(input.attention, input.waitingReason),
    effectiveAccess: {
      permissionMode,
      sandboxMode,
      fullHostAccess: inferredFullAccess,
    },
    terminal:
      Object.keys(terminalInput).length > 0
        ? {
            attachAvailable: boolean(terminalInput.attachAvailable, true),
            session: text(terminalInput.session) ?? "unknown",
            window: text(terminalInput.window) ?? "unknown",
            paneId: text(terminalInput.paneId) ?? "unknown",
            attachedClients: number(terminalInput.attachedClients) ?? 0,
          }
        : null,
    control: {
      plane: text(controlInput.plane) ?? text(controlInput.transport) ?? "observe-only",
      capabilities,
      managerOwned: ownership === "manager",
      writableLease: boolean(controlInput.writableLease),
    },
    generation: number(input.generation) ?? 0,
    runId: text(input.runId) ?? text(input.turnId),
    updatedAt: text(input.updatedAt),
    messages,
    transcript: normalizeTranscript(input, messages),
    queue: queueInput.flatMap((entry, index) => {
      const item = record(entry);
      const prompt = text(item.prompt) ?? text(item.text);
      return prompt ? [{ id: text(item.id) ?? `queue-${index}`, prompt }] : [];
    }),
  };
}

export function normalizeSnapshot(raw: unknown): SessionsSnapshot {
  const input = record(raw);
  const sessionsValue = Array.isArray(raw)
    ? raw
    : Array.isArray(input.sessions)
      ? input.sessions
      : [];
  const diagnosticValue = Array.isArray(input.diagnostics) ? input.diagnostics : [];
  const diagnostics: Diagnostic[] = diagnosticValue.flatMap((rawDiagnostic) => {
    const diagnostic = record(rawDiagnostic);
    const message = text(diagnostic.message);
    if (!message) return [];
    return [
      {
        provider:
          diagnostic.provider === "codex" ||
          diagnostic.provider === "claude" ||
          diagnostic.provider === "system"
            ? diagnostic.provider
            : "system",
        level: diagnostic.level === "error" ? "error" : "warning",
        message,
      },
    ];
  });
  return {
    sessions: sessionsValue.map(normalizeSession),
    diagnostics,
    generatedAt: text(input.generatedAt),
    seq: number(input.seq),
    stale: boolean(input.stale),
  };
}
