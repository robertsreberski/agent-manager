import type { ReactNode } from "react";
import type {
  MessagePartStatus,
  MessageStatus,
  MessageTiming,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { AlertTriangle, BookOpen, CircleAlert, Gauge, Radio } from "lucide-react";
import { DiffViewer, diffIdentityKey, fileChangeIsUpserting, relativeEditorPath, type FileChangeView } from "./diffs";
import { PlanArtifact, TodoList, type PlanArtifactView, type TodoListView } from "./plans";
import { ApprovalRequest, QuestionRequest, type ExactQuestionRequest } from "./requests";
import { QueuedMessages } from "./composer";
import { ContextDisplay } from "./assistant-ui/context-display";
import { buildSubagentHierarchy, TurnMarker, type SubagentFrameData, type TurnFacts } from "./thread";
import { jsonForDisplay } from "../lib/session-activity";
import type {
  ActivityAttentionItem,
  ActivityFileChangeItem,
  ActivityItem,
  ActivityJsonValue,
  ActivityMemoryCitation,
  ActivityState,
  ActivityTodoItem,
  RequestResponse,
  SessionActivityView,
  SessionView,
} from "../types";
import type { PlanFileResponse } from "../lib/api";

const DATA_PREFIX = "agent-manager.";
/** Namespace for cockpit-supplied part metadata, per assistant-ui's convention. */
export const PART_METADATA_KEY = "agent-manager";
type ThreadContent = Exclude<ThreadMessageLike["content"], string>;
type ThreadContentPart = ThreadContent extends readonly (infer Part)[] ? Part : never;

export interface ActivityAttentionControls {
  exactRequestIds: ReadonlySet<string>;
  /**
   * Requests a plan artifact already owns. A plan approval is answered on the
   * plan itself — the markdown plus Execute and Send-back-with-notes — so the
   * generic permission card must not compete with it for the same request.
   */
  planOwnedRequestIds: ReadonlySet<string>;
  mutationsReady: boolean;
  canRespond: boolean;
  busy: boolean;
  workspaceRoot: string | null;
  remoteHost: string | null;
  sessionsOnHost: number | null;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}

export interface ActivityFileControls {
  sessionId: string;
  canOpenEditor: boolean;
  workspaceRoot: string | null;
  readKeys: ReadonlySet<string>;
  onReadChange: (readKey: string, read: boolean) => void;
  onOpenEditor?: (relativePath: string) => void;
}

export interface ActivityPlanControls {
  requestIds: ReadonlyMap<string, string>;
  mutationsReady: boolean;
  canRespond: boolean;
  busy: boolean;
  loadFile: (itemId: string) => Promise<PlanFileResponse>;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}

export interface ActivityQueueControls {
  canRemove: boolean;
  busy: boolean;
  /**
   * Why removal is unavailable, where the harness said. Removal itself now runs
   * through the runtime's queue adapter, which is what lets
   * `QueueItemPrimitive.Remove` render the button — but the primitive is
   * always enabled, so a withheld capability has to be stated in words rather
   * than offered as a control that would fail.
   */
  withheldReason: string | null;
}

export interface ActivityDataControls {
  attention: ActivityAttentionControls;
  files: ActivityFileControls;
  plans: ActivityPlanControls;
  queue: ActivityQueueControls;
}

function messageStatus(state: ActivityState): MessageStatus {
  if (state === "pending" || state === "running") return { type: "running" };
  if (state === "waiting") return { type: "requires-action", reason: "interrupt" };
  if (state === "complete") return { type: "complete", reason: "stop" };
  if (state === "interrupted") return { type: "incomplete", reason: "cancelled" };
  return { type: "incomplete", reason: "error", error: "Provider activity failed" };
}

function partStatus(state: ActivityState): MessagePartStatus {
  if (state === "pending" || state === "running" || state === "waiting") return { type: "running" };
  if (state === "complete") return { type: "complete" };
  return { type: "incomplete", reason: state === "interrupted" ? "cancelled" : "error" };
}

function itemDate(item: ActivityItem): Date | undefined {
  const raw = item.startedAt ?? item.updatedAt ?? item.completedAt;
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toolArguments(item: Extract<ActivityItem, { kind: "tool" }>): Record<string, ActivityJsonValue> {
  if (item.arguments !== null && typeof item.arguments === "object" && !Array.isArray(item.arguments)) {
    return item.arguments;
  }
  return item.arguments === null ? {} : { input: item.arguments };
}

function itemTiming(item: ActivityItem): { startedAt: number; completedAt?: number } | undefined {
  if (!item.startedAt) return undefined;
  const startedAt = Date.parse(item.startedAt);
  if (!Number.isFinite(startedAt)) return undefined;
  if (!item.completedAt) return { startedAt };
  const completedAt = Date.parse(item.completedAt);
  return Number.isFinite(completedAt) && completedAt >= startedAt
    ? { startedAt, completedAt }
    : { startedAt };
}

function activityParts(
  item: ActivityItem,
  subagents: ReadonlyMap<string, SubagentFrameData>,
  groupItems: readonly ActivityItem[],
): ThreadContentPart[] {
  if (item.kind === "message") {
    return [
      ...(item.text ? [{ type: "text" as const, text: item.text, status: partStatus(item.state) }] : []),
      ...(item.memoryCitation
        ? [{ type: "data" as const, name: `${DATA_PREFIX}memory-citation`, data: item.memoryCitation }]
        : []),
    ];
  }
  if (item.kind === "reasoning") {
    // Codex projects one thought twice — a `summary-N` labelled "Thinking" and a
    // `raw-N` labelled "Provider reasoning". Dropping the label rendered them as
    // two identical "Reasoning" rows, which reads as a duplicated event. The
    // label is the provider's own, so it travels in `providerMetadata`.
    return [{
      type: "reasoning",
      text: item.text,
      status: partStatus(item.state),
      ...(item.label ? { providerMetadata: { [PART_METADATA_KEY]: { label: item.label } } } : {}),
    }];
  }
  if (item.kind === "tool") {
    const hasResult = item.result !== null || item.output.length > 0 || !["pending", "running", "waiting"].includes(item.state);
    const timing = itemTiming(item);
    return [{
      type: "tool-call",
      toolCallId: item.toolCallId,
      toolName: item.name,
      args: toolArguments(item),
      argsText: jsonForDisplay(item.arguments),
      ...(hasResult ? { result: item.result ?? item.output } : {}),
      ...(item.state === "failed" ? { isError: true } : {}),
      ...(timing ? { timing } : {}),
    }];
  }
  if (item.kind === "subagent") {
    const frame = subagents.get(item.id);
    if (!frame) throw new Error(`Missing subagent frame for ${item.id}`);
    return [{ type: "data", name: `${DATA_PREFIX}${item.kind}`, data: frame }];
  }
  if (item.kind === "file-change") {
    return [{
      type: "data",
      name: `${DATA_PREFIX}${item.kind}`,
      data: { ...item, upserting: fileChangeIsUpserting(item, groupItems) },
    }];
  }
  return [{ type: "data", name: `${DATA_PREFIX}${item.kind}`, data: item }];
}

export function preferredFileChangeItems(items: readonly ActivityItem[]): ActivityFileChangeItem[] {
  const turns = new Map<string, ActivityFileChangeItem[]>();
  for (const item of items) {
    if (item.kind !== "file-change") continue;
    const key = item.turnId ?? `unassociated:${item.id}`;
    const existing = turns.get(key);
    if (existing) existing.push(item); else turns.set(key, [item]);
  }
  return [...turns.values()].flatMap((files) => {
    const ordered = [...files].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    const aggregate = [...ordered].reverse().find((item) => item.summary === "Turn diff");
    return [aggregate ?? ordered.at(-1)!];
  }).sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

type ActivityLifecycleItem = Extract<ActivityItem, { kind: "lifecycle" }>;

const TURN_END_EVENTS: ReadonlyArray<ActivityLifecycleItem["event"]> = [
  "turn-completed",
  "turn-failed",
  "turn-interrupted",
];

function isTurnEnd(item: ActivityItem): item is ActivityLifecycleItem {
  return item.kind === "lifecycle" && TURN_END_EVENTS.includes(item.event);
}

function groupState(items: readonly ActivityItem[]): ActivityState {
  const terminal = [...items].reverse().find((item) => item.kind === "lifecycle"
    && ["turn-completed", "turn-failed", "turn-interrupted"].includes(item.event));
  if (terminal?.kind === "lifecycle") {
    if (terminal.event === "turn-failed") return "failed";
    if (terminal.event === "turn-interrupted") return "interrupted";
    return "complete";
  }
  if (items.some((item) => item.state === "running" || item.state === "pending")) return "running";
  if (items.some((item) => item.state === "waiting")) return "waiting";
  if (items.some((item) => item.state === "failed")) return "failed";
  if (items.some((item) => item.state === "interrupted")) return "interrupted";
  return "complete";
}

function duration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const milliseconds = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function diffCounts(items: readonly ActivityItem[]): { additions: number | null; removals: number | null } {
  const changes = preferredFileChangeItems(items).flatMap((item) => item.changes);
  if (changes.length === 0) return { additions: null, removals: null };
  let additions = 0;
  let removals = 0;
  for (const change of changes) {
    for (const line of change.diff.split(/\r?\n/u)) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
    }
  }
  return { additions, removals };
}

function turnFacts(items: readonly ActivityItem[]): TurnFacts | null {
  const terminal = [...items].reverse().find((item) => item.kind === "lifecycle"
    && ["turn-completed", "turn-failed", "turn-interrupted"].includes(item.event));
  if (!terminal) return null;
  const startedAt = items.map((item) => item.startedAt).filter((value): value is string => value !== null).sort()[0] ?? null;
  const endedAt = terminal.completedAt ?? terminal.updatedAt;
  const usage = [...items].reverse().find((item) => item.kind === "usage" && item.scope === "turn");
  const counts = diffCounts(items);
  return {
    endedAt,
    duration: duration(startedAt, endedAt),
    subagents: items.filter((item) => item.kind === "subagent").length || null,
    additions: counts.additions,
    removals: counts.removals,
    tokens: usage?.kind === "usage" ? usage.totalTokens : null,
    costUsd: usage?.kind === "usage" ? usage.costUsd : null,
  };
}

/**
 * A `TurnMarker` already states the end time, duration, subagents, diff totals,
 * tokens and cost of the turn, so an adjacent "Turn completed" row would state
 * the same fact twice. A failure or interruption is not restated by the marker —
 * it carries no outcome — so those rows survive, as does any provider `details`.
 */
/**
 * Spec 05 R12 puts the turn's totals in the turn marker. Anything the marker
 * already states must not also render as its own row, or every turn reports
 * itself twice — a `Turn completed` line above its own footer, and a usage row
 * repeating the token total the footer carries.
 */
function restatedByTurnMarker(item: ActivityItem, facts: TurnFacts): boolean {
  if (item.kind === "usage") return facts.tokens !== null || facts.costUsd !== null;
  return isTurnEnd(item)
    && item.event === "turn-completed"
    && item.level === "info"
    && item.details === null
    && !item.truncated;
}

/**
 * The turn's timing, in the shape `useMessageTiming` reads — built only from
 * what the provider said.
 *
 * Upstream this metadata holds browser-stream measurements: when the first
 * chunk arrived, how many there were, a rate derived from a client clock. None
 * of that is knowable here, and printing it beside provider totals is what got
 * `useMessageTiming` rejected in the first place. So the span comes from the
 * provider's own `startedAt`/`completedAt`, the token count from its usage
 * totals, and the rate is those two divided — every input a provider fact.
 *
 * `firstTokenTime` is omitted because the provider does not report it.
 * `totalChunks` is required by the type and unknowable, so it is zero and the
 * vendored component does not render it.
 */
function turnTiming(items: readonly ActivityItem[]): MessageTiming | undefined {
  const startedAt = items.map((item) => item.startedAt).filter((value): value is string => value !== null).sort()[0] ?? null;
  const terminal = [...items].reverse().find(isTurnEnd);
  const endedAt = terminal?.completedAt ?? terminal?.updatedAt ?? null;
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const elapsed = end - start;
  const usage = [...items].reverse().find((item) => item.kind === "usage" && item.scope === "turn");
  const tokens = usage?.kind === "usage" ? usage.totalTokens : null;
  const outputTokens = usage?.kind === "usage" ? usage.outputTokens : null;
  return {
    streamStartTime: start,
    totalStreamTime: elapsed,
    totalChunks: 0,
    toolCallCount: items.filter((item) => item.kind === "tool").length,
    ...(tokens === null ? {} : { tokenCount: tokens }),
    // Rate is only meaningful from the tokens the provider actually produced,
    // over a span it actually reported.
    ...(outputTokens !== null && elapsed > 0
      ? { tokensPerSecond: (outputTokens * 1_000) / elapsed }
      : {}),
  };
}

function assistantMessage(
  id: string,
  items: readonly ActivityItem[],
  subagents: ReadonlyMap<string, SubagentFrameData>,
  factItems: readonly ActivityItem[] = items,
): ThreadMessageLike | null {
  if (items.length === 0) return null;
  const state = groupState(items);
  const facts = turnFacts(factItems);
  const rendered = facts ? items.filter((item) => !restatedByTurnMarker(item, facts)) : items;
  const timing = turnTiming(factItems);
  return {
    id,
    role: "assistant",
    status: messageStatus(state),
    content: [
      ...rendered.flatMap((item) => activityParts(item, subagents, items)),
      ...(facts ? [{ type: "data" as const, name: `${DATA_PREFIX}turn-marker`, data: facts }] : []),
    ] satisfies ThreadContent,
    ...(timing ? { metadata: { custom: {}, timing } } : {}),
    ...(itemDate(items[0]!) ? { createdAt: itemDate(items[0]!) } : {}),
  };
}

/** Keep provider chronology intact, moving only aggregate turn artifacts. */
function semanticTurnOrder(items: readonly ActivityItem[]): ActivityItem[] {
  const ordered = [...items];
  const userIndex = ordered.findIndex((item) => item.kind === "message" && item.role === "user");
  if (userIndex > 0) {
    const leadingStart = ordered.slice(0, userIndex).findIndex((item) => (
      item.kind === "lifecycle" && item.event === "turn-started"
    ));
    if (leadingStart >= 0) {
      const [user] = ordered.splice(userIndex, 1);
      if (user) ordered.splice(leadingStart, 0, user);
    }
  }

  const latestTurnUsage = [...ordered].reverse().find((item) => (
    item.kind === "usage" && item.scope === "turn"
  ));
  const artifacts = ordered.filter((item) => (
    item.kind === "todo"
    || item.kind === "file-change"
    || (item.kind === "usage" && item.id === latestTurnUsage?.id)
  ));
  const body = ordered.filter((item) => (
    item.kind !== "todo"
    && item.kind !== "file-change"
    && item.kind !== "usage"
  ));
  return [...body, ...artifacts];
}

function stableAssistantMessageId(turnKey: string, boundaryId: string): string {
  let hash = 2_166_136_261;
  for (const character of `${turnKey}\u0000${boundaryId}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `assistant:${(hash >>> 0).toString(36)}`;
}

/**
 * Moves an item that names a parent to sit directly after it.
 *
 * A question or approval is raised *by* a tool call, but every provider emits
 * the request before the call it belongs to — Claude asks permission and only
 * then reports the tool — and `seq` freezes at first upsert, so the question
 * kept the earlier position permanently and rendered above the thing that
 * asked it.
 *
 * Only `parentId` moves an item, and only within its own turn, so a provider
 * that states no parent keeps provider order exactly as before.
 */
function placeUnderParent(items: readonly ActivityItem[]): ActivityItem[] {
  const present = new Set(items.map((item) => item.id));
  const children = new Map<string, ActivityItem[]>();
  const roots: ActivityItem[] = [];
  for (const item of items) {
    const parentId = item.parentId;
    if (parentId === null || parentId === item.id || !present.has(parentId)) {
      roots.push(item);
      continue;
    }
    const siblings = children.get(parentId);
    if (siblings) siblings.push(item);
    else children.set(parentId, [item]);
  }
  if (children.size === 0) return [...items];
  return roots.flatMap((item) => [item, ...children.get(item.id) ?? []]);
}

function messagesForTurn(turnKey: string, source: readonly ActivityItem[]): ThreadMessageLike[] {
  const hierarchy = buildSubagentHierarchy(source);
  const turnFactFileIds = new Set(preferredFileChangeItems(source).map((item) => item.id));
  const turnFactItems = source.filter((item) => item.kind !== "file-change" || turnFactFileIds.has(item.id));
  const preferredFileIds = new Set(preferredFileChangeItems(hierarchy.topLevelItems).map((item) => item.id));
  const ordered = hierarchy.topLevelItems
    .filter((item) => item.kind !== "file-change" || preferredFileIds.has(item.id));
  const semantic = placeUnderParent(semanticTurnOrder(ordered));
  const result: ThreadMessageLike[] = [];
  let assistantItems: ActivityItem[] = [];
  let boundaryId = semantic[0]?.id ?? turnKey;
  const flush = () => {
    const includesTurnEnd = assistantItems.some((item) => item.kind === "lifecycle"
      && ["turn-completed", "turn-failed", "turn-interrupted"].includes(item.event));
    const message = assistantMessage(
      stableAssistantMessageId(turnKey, boundaryId),
      assistantItems,
      hierarchy.frames,
      includesTurnEnd ? turnFactItems : assistantItems,
    );
    if (message) result.push(message);
    assistantItems = [];
  };
  for (const item of semantic) {
    if (item.kind === "message" && item.role === "user") {
      flush();
      boundaryId = item.id;
      result.push({
        id: item.id,
        role: "user",
        content: [{ type: "text", text: item.text, status: partStatus(item.state) }],
        ...(itemDate(item) ? { createdAt: itemDate(item) } : {}),
      });
    } else if (item.kind === "message" && item.role === "system") {
      flush();
      boundaryId = item.id;
      result.push({
        id: item.id,
        role: "system",
        content: [{ type: "text", text: item.text, status: partStatus(item.state) }],
        // What produced this — "Command output" for a slash command. Without it
        // the drawer can only render an anonymous block of text, which is how
        // `/clear` came to look like an error rather than an answer.
        ...(item.label ? { metadata: { custom: { label: item.label } } } : {}),
        ...(itemDate(item) ? { createdAt: itemDate(item) } : {}),
      });
    } else {
      assistantItems.push(item);
    }
  }
  flush();
  return result;
}

/**
 * A turn key per item, in stream order. A stated `turnId` always wins; nothing
 * here invents one.
 *
 * Older transcripts and provider-level diagnostics can still lack a turn id.
 * Adjacent unassociated items share one stable synthetic turn, broken only at
 * an observable operator-message or turn-end boundary.
 */
function turnKeys(ordered: readonly ActivityItem[]): readonly string[] {
  const keys: string[] = [];
  let open: string | null = null;
  for (const item of ordered) {
    if (item.turnId !== null) {
      keys.push(item.turnId);
      open = item.turnId;
      if (isTurnEnd(item)) open = null;
      continue;
    }
    if (open === null || (item.kind === "message" && item.role === "user")) {
      open = `synthetic:${item.id}`;
    }
    keys.push(open);
    if (isTurnEnd(item)) open = null;
  }
  return keys;
}

/** Projects only the canonical selected-session activity stream. */
export function activityToThreadMessages(items: readonly ActivityItem[]): ThreadMessageLike[] {
  const ordered = [...items];
  const keys = turnKeys(ordered);
  const turns = new Map<string, ActivityItem[]>();
  const entries: Array<{ order: number; key: string; items: ActivityItem[] }> = [];
  ordered.forEach((item, order) => {
    const key = keys[order]!;
    const previous = turns.get(key);
    if (previous) previous.push(item);
    else {
      const grouped = [item];
      turns.set(key, grouped);
      entries.push({ order, key, items: grouped });
    }
  });
  return entries.flatMap((entry) => messagesForTurn(entry.key, entry.items));
}

export function exactCurrentActivityRequestIds(items: readonly ActivityItem[]): ReadonlySet<string> {
  const resolved = new Set(items.flatMap((item) => item.kind === "attention" && item.resolved ? [item.requestId] : []));
  return new Set(items.flatMap((item) => item.kind === "attention"
      && item.state === "waiting"
      && item.source === "provider-api"
      && item.confidence === "exact"
      && item.exposure === "provider-exposed"
      && !item.truncated
      && item.respondable
      && !item.resolved
      && !resolved.has(item.requestId)
    ? [item.requestId]
    : []));
}

export function exactPlanApprovalRequestIds(
  items: readonly ActivityItem[],
  exactRequestIds: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const plan of items) {
    if (
      plan.kind !== "plan"
      || plan.approvedAt !== null
      || plan.supersededBy !== null
      || plan.source !== "provider-api"
      || plan.confidence !== "exact"
      || plan.exposure !== "provider-exposed"
      || plan.truncated
    ) continue;
    const requestId = plan.approvalRequestId;
    if (requestId && exactRequestIds.has(requestId)) result.set(plan.id, requestId);
  }
  return result;
}

export function currentQueue(activity: SessionActivityView) {
  const queue = [...activity.items].reverse().find((item) => item.kind === "queue");
  return queue?.kind === "queue" ? queue.messages.filter((message) => message.status !== "dispatched") : [];
}

export function currentTodo(activity: SessionActivityView): ActivityTodoItem | null {
  return [...activity.items].reverse().find((item): item is ActivityTodoItem => item.kind === "todo") ?? null;
}

export function todoView(item: ActivityTodoItem, progress: SessionView["todoProgress"] = null): TodoListView {
  return {
    id: item.id,
    steps: item.steps.map((step) => ({
      id: step.id,
      text: step.text,
      status: step.status === "in_progress" ? "in-progress" : step.status,
      detail: step.detail,
      removedReason: step.removedReason,
      addedAfterStart: step.addedAfterStart,
    })),
    added: item.added,
    removed: item.removed,
    running: item.state === "pending" || item.state === "running" || item.state === "waiting",
    active: progress?.active ?? false,
    hasMoved: progress?.hasMoved ?? false,
    duration: duration(item.startedAt, item.completedAt),
    lastTransitionAt: progress?.lastTransitionAt ?? null,
  };
}

export function questionView(item: ActivityAttentionItem): ExactQuestionRequest {
  return {
    id: item.requestId || null,
    label: item.title ?? item.summary ?? item.attentionKind.replaceAll("-", " "),
    state: item.resolved ? "resolved" : item.state === "waiting" ? "waiting" : "pending",
    source: item.source,
    confidence: item.confidence,
    exposure: item.exposure,
    truncated: item.truncated,
    respondable: item.respondable,
    questions: item.questions.map((question) => ({
      id: question.id,
      header: question.header ?? null,
      prompt: question.text,
      options: question.options.map((option, index) => ({
        id: `${question.id}:${index}`,
        label: option.label,
        description: option.description,
        recommended: option.recommended === true,
      })),
      multiple: question.multiSelect,
      allowFreeText: question.allowFreeText,
      secret: question.isSecret,
    })),
  };
}

function FileChanges({ item, controls }: { item: ActivityFileChangeItem & { upserting?: boolean }; controls: ActivityFileControls }) {
  const upserting = item.upserting ?? fileChangeIsUpserting(item, [item]);
  const changes: FileChangeView[] = item.changes.map((change) => ({
    path: change.path,
    previousPath: change.previousPath,
    operation: change.operation,
    diff: change.diff,
    truncated: item.truncated,
    readKey: diffIdentityKey(controls.sessionId, item.turnId ?? "unassociated", change.path, change.operation, change.diff),
    upserting,
  }));
  return (
    <section className="my-3 grid gap-2" aria-label={item.summary || "File changes"}>
      {changes.map((change, index) => {
        const relativePath = relativeEditorPath(controls.workspaceRoot, change.path);
        const stableKey = `${item.id}:${change.operation}:${change.previousPath ?? ""}:${change.path}:${String(index)}`;
        return <DiffViewer key={stableKey} change={change} read={controls.readKeys.has(change.readKey)} onReadChange={controls.onReadChange} {...(controls.canOpenEditor && relativePath && controls.onOpenEditor ? { onOpenEditor: () => controls.onOpenEditor!(relativePath) } : {})} />;
      })}
      {item.truncated && <p className="text-code-sm text-[var(--warning)]">The provider truncated this change.</p>}
    </section>
  );
}

function Attention({ item, controls }: { item: ActivityAttentionItem; controls: ActivityAttentionControls }) {
  const exact = controls.exactRequestIds.has(item.requestId);
  /*
    The plan renders this request, and on phone the approval card is a modal
    sheet that would cover the plan it is asking about. Only where the plan can
    actually answer it: a session that cannot respond gets no controls on the
    plan either, and suppressing the card as well would leave the request with
    no surface at all.
  */
  if (
    item.requestId !== null
    && controls.canRespond
    && controls.planOwnedRequestIds.has(item.requestId)
  ) return null;
  if ((item.attentionKind === "question" || item.attentionKind === "elicitation") && item.questions.length > 0) {
    return <QuestionRequest request={questionView(item)} disabled={!exact || !controls.mutationsReady || !controls.canRespond || controls.busy} onSubmit={controls.onRespond} />;
  }
  if (["approval", "permission", "sandbox"].includes(item.attentionKind) && exact) {
    return (
      <ApprovalRequest
        request={{
          id: item.requestId,
          label: item.title ?? item.summary ?? "Approval requested",
          command: item.approvalFacts?.command ?? null,
          reason: item.summary,
          workspaceRoot: controls.workspaceRoot,
          paths: item.approvalFacts?.paths ?? null,
          writes: item.approvalFacts?.writes ?? [],
          network: item.approvalFacts?.network ?? null,
          deleteCount: item.approvalFacts?.deleteCount ?? null,
          remoteHost: controls.remoteHost,
          sessionsOnHost: controls.sessionsOnHost,
          canPersist: item.approvalFacts?.canPersist ?? false,
        }}
        disabled={!controls.mutationsReady || !controls.canRespond || controls.busy}
        onDecision={(requestId, decision) => controls.onRespond(requestId, {
          kind: "decision",
          decision: decision.decision,
          ...(decision.decision === "allow" && decision.persist ? { persist: true } : {}),
          ...(decision.decision === "deny" && decision.reason ? { reason: decision.reason } : {}),
        })}
      />
    );
  }
  return (
    <section className="my-2 border-l-2 border-dashed border-[var(--accent)] bg-[var(--surface-raised)] p-3" data-attention-confidence={item.confidence}>
      <p className="flex items-start gap-2 text-meta"><CircleAlert size={15} className="mt-0.5 text-[var(--accent)]" /><strong>{item.title ?? item.attentionKind.replaceAll("-", " ")}</strong></p>
      {item.summary && <p className="mt-1 text-meta-sm text-[var(--text-muted)]">{item.summary}</p>}
      <p className="mt-2 text-code-sm text-[var(--text-muted)]">{item.resolved ? "Resolved in the harness." : "Open the native harness to respond; this request is not safely representable here."}</p>
    </section>
  );
}

/**
 * A provider status line. `level` decides how loud it is.
 *
 * These used to take the same bordered card as an approval request — a hook
 * firing, a session going idle and a command needing an answer all looked
 * equally like something to deal with. `level` was already on the wire and
 * already reached this component; it just wasn't used for anything but the
 * border colour. An `info` row now takes the same quiet treatment `Usage` has:
 * one mono line, muted, no card. A `warning` or `error` keeps the card, because
 * those are the ones worth interrupting for.
 */
function Lifecycle({ item }: { item: Extract<ActivityItem, { kind: "lifecycle" }> }) {
  if (item.level === "info") {
    return (
      <p className="my-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-code-xs text-[var(--text-muted)]" data-lifecycle-level="info">
        <Radio size={11} className="shrink-0 self-center" aria-hidden="true" />
        <span>{item.title}</span>
        {/* Muted, not faint: the details are the only rendering of that text. */}
        {item.details && <span className="min-w-0 whitespace-pre-wrap">{item.details}</span>}
      </p>
    );
  }
  return (
    <section className={`my-2 border-l-2 p-3 text-meta-sm ${item.level === "error" ? "border-[var(--danger)] bg-[var(--danger-field)]" : "border-[var(--warning)] bg-[var(--warning-field)]"}`} data-lifecycle-level={item.level}>
      <p className="flex items-center gap-2"><Radio size={13} /><strong>{item.title}</strong></p>
      {item.details && <p className="mt-1 whitespace-pre-wrap text-[var(--text-muted)]">{item.details}</p>}
      {item.truncated && <p className="mt-1 text-[var(--warning)]">Details were truncated by the provider.</p>}
    </section>
  );
}

function Usage({ item }: { item: Extract<ActivityItem, { kind: "usage" }> }) {
  // Only reached while a turn is still open; once it ends the turn marker states
  // the totals and this row is suppressed. `0 reasoning` is noise rather than a
  // fact worth a column, so a zero reasoning count is omitted.
  const facts = [
    item.inputTokens === null ? null : `${item.inputTokens.toLocaleString()} input`,
    item.outputTokens === null ? null : `${item.outputTokens.toLocaleString()} output`,
    item.reasoningTokens ? `${item.reasoningTokens.toLocaleString()} reasoning` : null,
    item.totalTokens === null ? null : `${item.totalTokens.toLocaleString()} total`,
    item.costUsd === null ? null : `$${item.costUsd.toFixed(4)}`,
  ].filter((value): value is string => value !== null);
  if (facts.length === 0) return null;
  return (
    <p className="my-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-code-xs text-[var(--text-muted)]">
      <Gauge size={13} className="shrink-0" />
      {facts.map((fact) => <span key={fact}>{fact}</span>)}
      {/*
        How full the window is, where the provider stated a window. Without one
        there is no denominator, and the component renders nothing rather than
        let the cockpit guess at the number it is missing.
      */}
      <ContextDisplay.Bar usage={item} modelContextWindow={item.contextWindow} />
    </p>
  );
}

function Plan({ item, controls }: { item: Extract<ActivityItem, { kind: "plan" }>; controls: ActivityPlanControls }) {
  const plan: PlanArtifactView = {
    id: item.id,
    path: item.path,
    version: item.version,
    markdown: item.markdown,
    writtenAt: item.updatedAt,
    supersededBy: item.supersededBy,
    approvedAt: item.approvedAt,
  };
  const requestId = controls.requestIds.get(item.id) ?? null;
  const actionable = requestId !== null && controls.canRespond;
  const disabled = !controls.mutationsReady || controls.busy;
  return <div className="my-3"><PlanArtifact plan={plan} disabled={disabled} loadFile={controls.loadFile} {...(actionable ? {
    onExecute: () => controls.onRespond(requestId, { kind: "decision", decision: "allow" }),
    onSendBack: (_plan: PlanArtifactView, notes: string) => controls.onRespond(requestId, { kind: "decision", decision: "deny", reason: notes }),
  } : {})} />{item.truncated && <p className="mt-1 text-code-sm text-[var(--warning)]">The plan is truncated.</p>}</div>;
}

function MemoryCitationSources({ citation }: { citation: ActivityMemoryCitation }) {
  const count = citation.entries.length;
  return (
    <details className="my-2 text-code-xs text-[var(--text-muted)]" data-memory-citation>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-1 py-1 hover:bg-[var(--surface-raised)]">
        <BookOpen size={13} aria-hidden="true" />
        <span>Memory sources</span>
        <span aria-label={`${count} ${count === 1 ? "source" : "sources"}`}>· {count}</span>
      </summary>
      <div className="ml-5 mt-1 grid gap-1 border-l border-[var(--border)] pl-3">
        {citation.entries.map((entry) => (
          <p key={`${entry.path}:${entry.lineStart}:${entry.lineEnd}:${entry.note}`}>
            <span className="break-all text-[var(--text)]">{entry.path}:{entry.lineStart}-{entry.lineEnd}</span>
            {entry.note && <span className="ml-2">{entry.note}</span>}
          </p>
        ))}
        {citation.rolloutIds.length > 0 && (
          <p className="break-all">Rollouts: {citation.rolloutIds.join(", ")}</p>
        )}
      </div>
    </details>
  );
}

export function renderActivityData(name: string, data: unknown, controls: ActivityDataControls): ReactNode {
  if (name === `${DATA_PREFIX}turn-marker`) return <TurnMarker facts={data as TurnFacts} />;
  if (name === `${DATA_PREFIX}memory-citation`) {
    return <MemoryCitationSources citation={data as ActivityMemoryCitation} />;
  }
  const item = data as ActivityItem;
  if (!item || typeof item !== "object" || !("kind" in item)) return null;
  switch (item.kind) {
    case "plan": return <Plan item={item} controls={controls.plans} />;
    case "todo": return <div className="my-3"><TodoList list={todoView(item)} /></div>;
    case "file-change": return <FileChanges item={item} controls={controls.files} />;
    case "attention": return <Attention item={item} controls={controls.attention} />;
    case "queue": return <div className="my-3"><QueuedMessages messages={item.messages.flatMap((message) => message.status === "dispatched" ? [] : [{ id: message.id, text: message.text, status: message.status }])} canRemove={controls.queue.canRemove && !controls.queue.busy} withheldReason={controls.queue.withheldReason} /></div>;
    case "lifecycle": return <Lifecycle item={item} />;
    case "usage": return <Usage item={item} />;
    case "subagent": return null; // GroupedActivityParts owns the subagent frame.
    default: return null;
  }
}

export function sessionTodoProgress(activity: SessionActivityView) {
  const todo = currentTodo(activity);
  if (!todo) return null;
  const visible = todo.steps.filter((step) => step.status !== "removed");
  return {
    completed: visible.filter((step) => step.status === "completed").length,
    total: visible.length,
    current: visible.find((step) => step.status === "in_progress")?.text ?? null,
  };
}

export function remoteHostLabel(session: SessionView, remote: boolean): string | null {
  return remote ? session.hostLabel : null;
}

export function ActivityRetentionBoundary() {
  return <p className="border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3 text-meta-sm text-[var(--warning)]"><AlertTriangle size={14} className="mr-2 inline" />Earlier provider activity is outside the retained stream window.</p>;
}
