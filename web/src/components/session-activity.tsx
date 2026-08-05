import type { ReactNode } from "react";
import type {
  MessagePartStatus,
  MessageStatus,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { AlertTriangle, CircleAlert, Gauge, Radio } from "lucide-react";
import { DiffViewer, diffIdentityKey, fileChangeIsUpserting, relativeEditorPath, type FileChangeView } from "./diffs";
import { PlanArtifact, TodoList, type PlanArtifactView, type TodoListView } from "./plans";
import { ApprovalRequest, QuestionRequest, type ExactQuestionRequest } from "./requests";
import { QueuedMessages } from "./composer";
import { buildSubagentHierarchy, TurnMarker, type SubagentFrameData, type TurnFacts } from "./thread";
import { jsonForDisplay } from "../lib/session-activity";
import type {
  ActivityAttentionItem,
  ActivityFileChangeItem,
  ActivityItem,
  ActivityJsonValue,
  ActivityState,
  ActivityTodoItem,
  RequestResponse,
  SessionActivityView,
  SessionView,
} from "../types";
import type { PlanFileResponse } from "../lib/api";

const DATA_PREFIX = "agent-manager.";
type ThreadContent = Exclude<ThreadMessageLike["content"], string>;
type ThreadContentPart = ThreadContent extends readonly (infer Part)[] ? Part : never;

export interface ActivityAttentionControls {
  exactRequestIds: ReadonlySet<string>;
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
  onRemove: (messageId: string) => Promise<void>;
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

function activityPart(
  item: ActivityItem,
  subagents: ReadonlyMap<string, SubagentFrameData>,
  groupItems: readonly ActivityItem[],
): ThreadContentPart {
  if (item.kind === "message") {
    return { type: "text", text: item.text, status: partStatus(item.state) };
  }
  if (item.kind === "reasoning") {
    return { type: "reasoning", text: item.text, status: partStatus(item.state) };
  }
  if (item.kind === "tool") {
    const hasResult = item.result !== null || item.output.length > 0 || !["pending", "running", "waiting"].includes(item.state);
    const timing = itemTiming(item);
    return {
      type: "tool-call",
      toolCallId: item.toolCallId,
      toolName: item.name,
      args: toolArguments(item),
      argsText: jsonForDisplay(item.arguments),
      ...(hasResult ? { result: item.result ?? item.output } : {}),
      ...(item.state === "failed" ? { isError: true } : {}),
      ...(timing ? { timing } : {}),
    };
  }
  if (item.kind === "subagent") {
    const frame = subagents.get(item.id);
    if (!frame) throw new Error(`Missing subagent frame for ${item.id}`);
    return { type: "data", name: `${DATA_PREFIX}${item.kind}`, data: frame };
  }
  if (item.kind === "file-change") {
    return {
      type: "data",
      name: `${DATA_PREFIX}${item.kind}`,
      data: { ...item, upserting: fileChangeIsUpserting(item, groupItems) },
    };
  }
  return { type: "data", name: `${DATA_PREFIX}${item.kind}`, data: item };
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
  const usage = [...items].reverse().find((item) => item.kind === "usage");
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
  return {
    id,
    role: "assistant",
    status: messageStatus(state),
    content: [
      ...rendered.map((item) => activityPart(item, subagents, items)),
      ...(facts ? [{ type: "data" as const, name: `${DATA_PREFIX}turn-marker`, data: facts }] : []),
    ] satisfies ThreadContent,
    ...(itemDate(items[0]!) ? { createdAt: itemDate(items[0]!) } : {}),
  };
}

/**
 * Deterministic intra-turn bands. `ActivityHub` freezes an item's `seq` at its
 * first upsert, so a provider that streams the final answer before it reports
 * the turn totals — or reports usage before it reports the turn start — would
 * otherwise render the answer buried under its own footer. Provider order is
 * preserved inside each band, so tool calls never move relative to reasoning.
 */
function turnRank(
  item: ActivityItem,
  initialUserId: string | null,
  finalIds: ReadonlySet<string>,
): number {
  if (initialUserId !== null && item.id === initialUserId) return 0;
  if (item.kind === "lifecycle" && item.event === "turn-started") return 1;
  if (finalIds.has(item.id)) return 3;
  if (item.kind === "usage" || isTurnEnd(item)) return 4;
  return 2;
}

function messagesForTurn(turnKey: string, source: readonly ActivityItem[]): ThreadMessageLike[] {
  const hierarchy = buildSubagentHierarchy(source);
  const turnFactFileIds = new Set(preferredFileChangeItems(source).map((item) => item.id));
  const turnFactItems = source.filter((item) => item.kind !== "file-change" || turnFactFileIds.has(item.id));
  const preferredFileIds = new Set(preferredFileChangeItems(hierarchy.topLevelItems).map((item) => item.id));
  const ordered = hierarchy.topLevelItems
    .filter((item) => item.kind !== "file-change" || preferredFileIds.has(item.id))
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const initialUser = ordered.find((item) => item.kind === "message" && item.role === "user");
  const finalIds = new Set(ordered.flatMap((item) => (
    item.kind === "message" && item.role === "assistant" && item.phase === "final" ? [item.id] : []
  )));
  const semantic = [...ordered].sort((left, right) =>
    turnRank(left, initialUser?.id ?? null, finalIds) - turnRank(right, initialUser?.id ?? null, finalIds)
    || left.seq - right.seq
    || left.id.localeCompare(right.id));
  const result: ThreadMessageLike[] = [];
  let assistantItems: ActivityItem[] = [];
  let segment = 0;
  const flush = () => {
    const includesTurnEnd = assistantItems.some((item) => item.kind === "lifecycle"
      && ["turn-completed", "turn-failed", "turn-interrupted"].includes(item.event));
    const message = assistantMessage(
      `turn:${encodeURIComponent(turnKey)}:assistant:${segment++}`,
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
      result.push({
        id: item.id,
        role: "user",
        content: [{ type: "text", text: item.text, status: partStatus(item.state) }],
        ...(itemDate(item) ? { createdAt: itemDate(item) } : {}),
      });
    } else if (item.kind === "message" && item.role === "system") {
      flush();
      result.push({
        id: item.id,
        role: "system",
        content: [{ type: "text", text: item.text, status: partStatus(item.state) }],
        ...(itemDate(item) ? { createdAt: itemDate(item) } : {}),
      });
    } else {
      assistantItems.push(item);
    }
  }
  flush();
  return result;
}

/** Projects only the canonical selected-session activity stream. */
export function activityToThreadMessages(items: readonly ActivityItem[]): ThreadMessageLike[] {
  const ordered = [...items].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const turns = new Map<string, ActivityItem[]>();
  const entries: Array<{ seq: number; order: number; key: string; items: ActivityItem[] }> = [];
  ordered.forEach((item, order) => {
    const key = item.turnId ?? `unassociated:${item.id}`;
    const previous = turns.get(key);
    if (previous) previous.push(item);
    else {
      const grouped = [item];
      turns.set(key, grouped);
      entries.push({ seq: item.seq, order, key, items: grouped });
    }
  });
  return entries
    .sort((left, right) => left.seq - right.seq || left.order - right.order)
    .flatMap((entry) => messagesForTurn(entry.key, entry.items));
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
      <p className="mt-2 text-code-sm text-[var(--text-faint)]">{item.resolved ? "Resolved in the harness." : "Open the native harness to respond; this request is not safely representable here."}</p>
    </section>
  );
}

function Lifecycle({ item }: { item: Extract<ActivityItem, { kind: "lifecycle" }> }) {
  return (
    <section className={`my-2 border-l-2 p-3 text-meta-sm ${item.level === "error" ? "border-[var(--danger)] bg-[var(--danger-field)]" : item.level === "warning" ? "border-[var(--warning)] bg-[var(--warning-field)]" : "border-[var(--border)] bg-[var(--surface-raised)]"}`}>
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
  return <p className="my-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-code-xs text-[var(--text-faint)]"><Gauge size={13} className="shrink-0" />{facts.map((fact) => <span key={fact}>{fact}</span>)}</p>;
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

export function renderActivityData(name: string, data: unknown, controls: ActivityDataControls): ReactNode {
  if (name === `${DATA_PREFIX}turn-marker`) return <TurnMarker facts={data as TurnFacts} />;
  const item = data as ActivityItem;
  if (!item || typeof item !== "object" || !("kind" in item)) return null;
  switch (item.kind) {
    case "plan": return <Plan item={item} controls={controls.plans} />;
    case "todo": return <div className="my-3"><TodoList list={todoView(item)} /></div>;
    case "file-change": return <FileChanges item={item} controls={controls.files} />;
    case "attention": return <Attention item={item} controls={controls.attention} />;
    case "queue": return <div className="my-3"><QueuedMessages messages={item.messages.flatMap((message) => message.status === "dispatched" ? [] : [{ id: message.id, text: message.text, status: message.status }])} canRemove={controls.queue.canRemove && !controls.queue.busy} onRemove={(id) => void controls.queue.onRemove(id)} /></div>;
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
