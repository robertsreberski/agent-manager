import { ACTIVITY_SCHEMA_VERSION, type ActivityFrame, type ActivityItem } from "./types.ts";

const MAX_FIELD_BYTES = 128 * 1_024;
const MAX_ITEMS = 400;
const MAX_NESTING = 16;
const MAX_JSON_MEMBERS = 4_096;
const utf8Encoder = new TextEncoder();

export class ActivityWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityWireError";
  }
}

function fail(message: string): never {
  throw new ActivityWireError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} has unknown field ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing field ${key}`);
  }
}

function string(value: unknown, label: string, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be a string`);
  }
  if (utf8Encoder.encode(value).byteLength > MAX_FIELD_BYTES) fail(`${label} is too large`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(`${label} has an unsupported value`);
  }
  return value as T;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${label} must be an integer`);
  return value as number;
}

function finiteOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite or null`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

function timestampOrNull(value: unknown, label: string): string | null {
  const result = nullableString(value, label);
  if (result !== null && !Number.isFinite(Date.parse(result))) fail(`${label} must be a timestamp`);
  return result;
}

function array(value: unknown, label: string, limit = MAX_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > limit) fail(`${label} must be a bounded array`);
  return value;
}

function jsonValue(value: unknown, label: string, depth = 0, members = { value: 0 }): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    string(value, label);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (depth >= MAX_NESTING) fail(`${label} is nested too deeply`);
  if (Array.isArray(value)) {
    members.value += value.length;
    if (members.value > MAX_JSON_MEMBERS) fail(`${label} has too many members`);
    for (const item of value) jsonValue(item, label, depth + 1, members);
    return;
  }
  const object = record(value, label);
  const entries = Object.entries(object);
  members.value += entries.length;
  if (members.value > MAX_JSON_MEMBERS) fail(`${label} has too many members`);
  for (const [key, item] of entries) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      fail(`${label} has an unsafe key`);
    }
    string(key, `${label} key`, false);
    jsonValue(item, label, depth + 1, members);
  }
}

const COMMON_KEYS = [
  "schemaVersion",
  "id",
  "sessionId",
  "provider",
  "correlationId",
  "turnId",
  "parentId",
  "seq",
  "revision",
  "state",
  "startedAt",
  "updatedAt",
  "completedAt",
  "source",
  "confidence",
  "exposure",
  "truncated",
  "kind",
] as const;

function validateCommon(item: Record<string, unknown>, label: string): void {
  if (item.schemaVersion !== ACTIVITY_SCHEMA_VERSION) fail(`${label} schema version is unsupported`);
  string(item.id, `${label}.id`, false);
  string(item.sessionId, `${label}.sessionId`, false);
  enumeration(item.provider, ["codex", "claude"], `${label}.provider`);
  nullableString(item.correlationId, `${label}.correlationId`);
  nullableString(item.turnId, `${label}.turnId`);
  nullableString(item.parentId, `${label}.parentId`);
  integer(item.seq, `${label}.seq`);
  integer(item.revision, `${label}.revision`, 1);
  enumeration(item.state, ["pending", "running", "waiting", "complete", "failed", "interrupted"], `${label}.state`);
  timestampOrNull(item.startedAt, `${label}.startedAt`);
  timestampOrNull(item.updatedAt, `${label}.updatedAt`);
  timestampOrNull(item.completedAt, `${label}.completedAt`);
  enumeration(item.source, ["provider-api", "transcript"], `${label}.source`);
  enumeration(item.confidence, ["exact", "inferred", "heuristic"], `${label}.confidence`);
  enumeration(item.exposure, ["provider-exposed", "transcript-derived"], `${label}.exposure`);
  boolean(item.truncated, `${label}.truncated`);
}

function validateTodoSteps(value: unknown, label: string): void {
  const ids = new Set<string>();
  for (const [index, raw] of array(value, label).entries()) {
    const step = record(raw, `${label}[${String(index)}]`);
    exactKeys(
      step,
      ["id", "text", "status", "detail", "addedAfterStart", "removedReason"],
      `${label}[${String(index)}]`,
    );
    const id = string(step.id, `${label}[${String(index)}].id`, false);
    if (ids.has(id)) throw new ActivityWireError(`${label} contains duplicate id ${id}`);
    ids.add(id);
    string(step.text, `${label}[${String(index)}].text`);
    const status = enumeration(
      step.status,
      ["pending", "in_progress", "completed", "removed"],
      `${label}[${String(index)}].status`,
    );
    nullableString(step.detail, `${label}[${String(index)}].detail`);
    boolean(step.addedAfterStart, `${label}[${String(index)}].addedAfterStart`);
    nullableString(step.removedReason, `${label}[${String(index)}].removedReason`);
    if (status !== "removed" && step.removedReason !== null) {
      throw new ActivityWireError(`${label}[${String(index)}].removedReason requires removed status`);
    }
  }
}

function validateQuestions(value: unknown, label: string): void {
  for (const [index, raw] of array(value, label, 32).entries()) {
    const question = record(raw, `${label}[${String(index)}]`);
    const keys = ["id", ...(Object.hasOwn(question, "header") ? ["header"] : []), "text", "options", "multiSelect", "allowFreeText", "isSecret"];
    exactKeys(question, keys, `${label}[${String(index)}]`);
    string(question.id, `${label}[${String(index)}].id`, false);
    if (Object.hasOwn(question, "header")) string(question.header, `${label}[${String(index)}].header`);
    string(question.text, `${label}[${String(index)}].text`);
    for (const [optionIndex, rawOption] of array(question.options, `${label}[${String(index)}].options`, 32).entries()) {
      const option = record(rawOption, `${label}.option`);
      exactKeys(option, ["label", "description", "recommended"], `${label}.option`);
      string(option.label, `${label}[${String(index)}].options[${String(optionIndex)}].label`, false);
      nullableString(option.description, `${label}[${String(index)}].options[${String(optionIndex)}].description`);
      if (option.recommended !== null) {
        boolean(option.recommended, `${label}[${String(index)}].options[${String(optionIndex)}].recommended`);
      }
    }
    boolean(question.multiSelect, `${label}[${String(index)}].multiSelect`);
    boolean(question.allowFreeText, `${label}[${String(index)}].allowFreeText`);
    boolean(question.isSecret, `${label}[${String(index)}].isSecret`);
  }
}

function validateApprovalFacts(value: unknown, label: string): void {
  if (value === null) return;
  const facts = record(value, label);
  exactKeys(
    facts,
    ["command", "paths", "writes", "network", "canPersist", "deleteCount"],
    label,
  );
  nullableString(facts.command, `${label}.command`);
  if (facts.paths !== null) {
    for (const [index, path] of array(facts.paths, `${label}.paths`).entries()) {
      string(path, `${label}.paths[${String(index)}]`, false);
    }
  }
  for (const [index, path] of array(facts.writes, `${label}.writes`).entries()) {
    string(path, `${label}.writes[${String(index)}]`, false);
  }
  if (facts.network !== null) boolean(facts.network, `${label}.network`);
  boolean(facts.canPersist, `${label}.canPersist`);
  if (facts.deleteCount !== null) {
    integer(facts.deleteCount, `${label}.deleteCount`);
  }
}

export function parseActivityItem(value: unknown, label = "activity item"): ActivityItem {
  const item = record(value, label);
  const kind = enumeration(item.kind, ["message", "reasoning", "plan", "todo", "tool", "file-change", "subagent", "attention", "queue", "lifecycle", "usage"], `${label}.kind`);
  const specific: string[] = [];
  switch (kind) {
    case "message":
      specific.push("role", "phase", "text", "label");
      break;
    case "reasoning":
      specific.push("reasoningKind", "label", "text");
      break;
    case "plan":
      specific.push("path", "version", "markdown", "supersededBy", "approvalRequestId", "approvedAt");
      break;
    case "todo":
      specific.push("steps", "added", "removed");
      break;
    case "tool":
      specific.push("toolCallId", "name", "category", "arguments", "result", "output");
      break;
    case "file-change":
      specific.push("summary", "changes");
      break;
    case "subagent":
      specific.push("taskId", "name", "description", "output", "childItemIds");
      break;
    case "attention":
      specific.push("requestId", "attentionKind", "title", "summary", "questions", "approvalFacts", "respondable", "resolved", "isSecret");
      break;
    case "queue":
      specific.push("messages");
      break;
    case "lifecycle":
      specific.push("event", "level", "title", "details");
      break;
    case "usage":
      specific.push("scope", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "totalTokens", "costUsd", "contextWindow");
      break;
  }
  exactKeys(item, [...COMMON_KEYS, ...specific], label);
  validateCommon(item, label);

  switch (kind) {
    case "message":
      enumeration(item.role, ["user", "assistant", "system", "tool"], `${label}.role`);
      if (item.phase !== null) enumeration(item.phase, ["commentary", "final"], `${label}.phase`);
      string(item.text, `${label}.text`);
      nullableString(item.label, `${label}.label`);
      break;
    case "reasoning":
      enumeration(item.reasoningKind, ["summary", "raw"], `${label}.reasoningKind`);
      nullableString(item.label, `${label}.label`);
      string(item.text, `${label}.text`);
      break;
    case "plan":
      nullableString(item.path, `${label}.path`);
      if (item.version !== null) integer(item.version, `${label}.version`, 1);
      string(item.markdown, `${label}.markdown`);
      nullableString(item.supersededBy, `${label}.supersededBy`);
      nullableString(item.approvalRequestId, `${label}.approvalRequestId`);
      timestampOrNull(item.approvedAt, `${label}.approvedAt`);
      break;
    case "todo":
      validateTodoSteps(item.steps, `${label}.steps`);
      integer(item.added, `${label}.added`);
      integer(item.removed, `${label}.removed`);
      break;
    case "tool":
      string(item.toolCallId, `${label}.toolCallId`, false);
      string(item.name, `${label}.name`, false);
      enumeration(item.category, ["command", "mcp", "web-search", "image-view", "dynamic", "collaboration", "other"], `${label}.category`);
      jsonValue(item.arguments, `${label}.arguments`);
      jsonValue(item.result, `${label}.result`);
      string(item.output, `${label}.output`);
      break;
    case "file-change":
      string(item.summary, `${label}.summary`);
      for (const [index, raw] of array(item.changes, `${label}.changes`).entries()) {
        const change = record(raw, `${label}.changes[${String(index)}]`);
        exactKeys(change, ["path", "previousPath", "operation", "diff"], `${label}.changes[${String(index)}]`);
        string(change.path, `${label}.changes[${String(index)}].path`, false);
        nullableString(change.previousPath, `${label}.changes[${String(index)}].previousPath`);
        enumeration(change.operation, ["add", "update", "delete", "rename"], `${label}.changes[${String(index)}].operation`);
        string(change.diff, `${label}.changes[${String(index)}].diff`);
      }
      break;
    case "subagent":
      string(item.taskId, `${label}.taskId`, false);
      string(item.name, `${label}.name`, false);
      nullableString(item.description, `${label}.description`);
      string(item.output, `${label}.output`);
      for (const [index, child] of array(item.childItemIds, `${label}.childItemIds`).entries()) {
        string(child, `${label}.childItemIds[${String(index)}]`, false);
      }
      break;
    case "attention":
      string(item.requestId, `${label}.requestId`, false);
      enumeration(item.attentionKind, ["question", "approval", "permission", "sandbox", "elicitation", "blocked"], `${label}.attentionKind`);
      nullableString(item.title, `${label}.title`);
      nullableString(item.summary, `${label}.summary`);
      validateQuestions(item.questions, `${label}.questions`);
      validateApprovalFacts(item.approvalFacts, `${label}.approvalFacts`);
      boolean(item.respondable, `${label}.respondable`);
      boolean(item.resolved, `${label}.resolved`);
      boolean(item.isSecret, `${label}.isSecret`);
      break;
    case "queue":
      for (const [index, raw] of array(item.messages, `${label}.messages`).entries()) {
        const message = record(raw, `${label}.messages[${String(index)}]`);
        exactKeys(message, ["id", "text", "status", "enqueuedAt", "turnId"], `${label}.messages[${String(index)}]`);
        string(message.id, `${label}.messages[${String(index)}].id`, false);
        string(message.text, `${label}.messages[${String(index)}].text`);
        enumeration(message.status, ["queued", "dispatching", "dispatched", "failed"], `${label}.messages[${String(index)}].status`);
        const enqueuedAt = string(message.enqueuedAt, `${label}.messages[${String(index)}].enqueuedAt`, false);
        if (!Number.isFinite(Date.parse(enqueuedAt))) {
          fail(`${label}.messages[${String(index)}].enqueuedAt must be a timestamp`);
        }
        nullableString(message.turnId, `${label}.messages[${String(index)}].turnId`);
      }
      break;
    case "lifecycle":
      enumeration(item.event, ["turn-started", "turn-completed", "turn-failed", "turn-interrupted", "warning", "error", "hook", "model-routing", "context-compaction", "status"], `${label}.event`);
      enumeration(item.level, ["info", "warning", "error"], `${label}.level`);
      string(item.title, `${label}.title`, false);
      nullableString(item.details, `${label}.details`);
      break;
    case "usage":
      enumeration(item.scope, ["turn", "thread", "session"], `${label}.scope`);
      finiteOrNull(item.inputTokens, `${label}.inputTokens`);
      finiteOrNull(item.outputTokens, `${label}.outputTokens`);
      finiteOrNull(item.cachedInputTokens, `${label}.cachedInputTokens`);
      finiteOrNull(item.reasoningTokens, `${label}.reasoningTokens`);
      finiteOrNull(item.totalTokens, `${label}.totalTokens`);
      finiteOrNull(item.costUsd, `${label}.costUsd`);
      finiteOrNull(item.contextWindow, `${label}.contextWindow`);
      break;
  }
  return structuredClone(item) as unknown as ActivityItem;
}

function validateFrameBase(frame: Record<string, unknown>, label: string): void {
  if (frame.schemaVersion !== ACTIVITY_SCHEMA_VERSION) fail(`${label} schema version is unsupported`);
  string(frame.streamEpoch, `${label}.streamEpoch`, false);
  string(frame.sessionId, `${label}.sessionId`, false);
  enumeration(frame.provider, ["codex", "claude"], `${label}.provider`);
  integer(frame.seq, `${label}.seq`);
  string(frame.cursor, `${label}.cursor`, false);
  const at = string(frame.at, `${label}.at`, false);
  if (!Number.isFinite(Date.parse(at))) fail(`${label}.at must be a timestamp`);
}

export function parseActivityFrame(value: unknown): ActivityFrame {
  const frame = record(value, "activity frame");
  const type = enumeration(frame.type, ["activity.snapshot", "activity.upsert", "activity.append", "activity.remove", "activity.reset"], "activity frame.type");
  const base = ["schemaVersion", "streamEpoch", "sessionId", "provider", "seq", "cursor", "at", "type"];
  if (type === "activity.snapshot") {
    exactKeys(frame, [...base, "items", "truncated"], "activity frame");
    frame.items = array(frame.items, "activity frame.items").map((item, index) =>
      parseActivityItem(item, `activity frame.items[${String(index)}]`)
    );
    boolean(frame.truncated, "activity frame.truncated");
  } else if (type === "activity.upsert") {
    exactKeys(frame, [...base, "item"], "activity frame");
    frame.item = parseActivityItem(frame.item);
  } else if (type === "activity.append") {
    exactKeys(frame, [...base, "id", "revision", "channel", "offset", "text", "truncated"], "activity frame");
    string(frame.id, "activity frame.id", false);
    integer(frame.revision, "activity frame.revision", 1);
    enumeration(frame.channel, ["text", "markdown", "arguments", "result", "output", "diff", "details"], "activity frame.channel");
    integer(frame.offset, "activity frame.offset");
    string(frame.text, "activity frame.text");
    boolean(frame.truncated, "activity frame.truncated");
  } else if (type === "activity.remove") {
    exactKeys(frame, [...base, "id"], "activity frame");
    string(frame.id, "activity frame.id", false);
  } else {
    exactKeys(frame, [...base, "reason", "items", "truncated"], "activity frame");
    enumeration(frame.reason, ["provider-reset", "transcript-reset", "rotation", "truncation", "branch-change", "replay-gap", "cleared", "other"], "activity frame.reason");
    frame.items = array(frame.items, "activity frame.items").map((item, index) =>
      parseActivityItem(item, `activity frame.items[${String(index)}]`)
    );
    boolean(frame.truncated, "activity frame.truncated");
  }
  validateFrameBase(frame, "activity frame");
  return structuredClone(frame) as unknown as ActivityFrame;
}
