import type { ReactNode } from "react";
import {
  MessagePrimitive,
  type DataMessagePartProps,
  type MessagePartStatus,
  type MessageStatus,
  type ReasoningMessagePartProps,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  Brain,
  Check,
  CircleAlert,
  CircleDashed,
  CircleX,
  FileDiff,
  Gauge,
  ListChecks,
  ListPlus,
  MessageSquareText,
  Radio,
  Users,
  Wrench,
} from "lucide-react";
import { MarkdownText } from "./assistant-ui/markdown-text";
import { QuestionRequestForm } from "./pending-requests";
import { cn } from "../lib/utils";
import { jsonForDisplay } from "../lib/session-activity";
import type {
  ActivityFileChangeItem,
  ActivityItem,
  ActivityItemState,
  ActivityJsonValue,
  ActivityLifecycleItem,
  ActivitySubagentItem,
  AttentionRequest,
  RequestResponse,
} from "../types";

const ACTIVITY_DATA_PART = "agent-manager.activity";
const ACTIVITY_GROUP_DATA_PART = "agent-manager.activity-group";

export interface ActivityTurnGroup {
  kind: "activity-group";
  id: string;
  turnId: string | null;
  seq: number;
  state: ActivityItemState;
  items: ActivityItem[];
}

export type ActivityTimelineItem = ActivityItem | ActivityTurnGroup;

export interface ActivityAttentionControls {
  exactRequestIds: ReadonlySet<string>;
  mutationsReady: boolean;
  canRespond: boolean;
  busy: boolean;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}

function isActive(state: ActivityItemState): boolean {
  return state === "pending" || state === "running" || state === "waiting";
}

function isDirectProse(item: ActivityItem): boolean {
  if (item.kind !== "message") return false;
  if (item.role === "user") return true;
  return item.role === "assistant" && item.phase !== "commentary";
}

function isInitialUserMessage(item: ActivityItem): boolean {
  return item.kind === "message" && item.role === "user";
}

function isFinalAssistantMessage(item: ActivityItem): boolean {
  return item.kind === "message" && item.role === "assistant" && item.phase === "final";
}

function groupState(items: ActivityItem[]): ActivityItemState {
  // Provider lifecycle events are the authoritative end of a turn. A stream
  // can retain a running child item after the terminal event arrives, so the
  // child state must not mask a failed or interrupted outcome.
  const terminal = [...items].reverse().find((item): item is ActivityLifecycleItem => (
    item.kind === "lifecycle"
    && (item.event === "turn-completed" || item.event === "turn-failed" || item.event === "turn-interrupted")
  ));
  if (terminal?.event === "turn-failed") return "failed";
  if (terminal?.event === "turn-interrupted") return "interrupted";
  if (terminal?.event === "turn-completed") return "complete";
  if (items.some((item) => item.state === "running" || item.state === "pending")) return "running";
  if (items.some((item) => item.state === "waiting")) return "waiting";
  if (items.some((item) => item.state === "failed")) return "failed";
  if (items.some((item) => item.state === "interrupted")) return "interrupted";
  return "complete";
}

function turnTimeline(turnId: string, items: ActivityItem[]): ActivityTimelineItem[] {
  const ordered = [...items].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));

  // Provider notification order is not conversational order. Codex, for
  // example, reports turn/started before the userMessage item and reports
  // terminal usage after the final answer. Keep the initiating user message
  // first and the explicit final answer last, while leaving any later user
  // messages in place so steering naturally splits the activity disclosure.
  const initialUser = ordered.find(isInitialUserMessage);
  const finals = ordered.filter(isFinalAssistantMessage);
  const finalIds = new Set(finals.map((item) => item.id));
  const semantic = [
    ...(initialUser ? [initialUser] : []),
    ...ordered.filter((item) => item.id !== initialUser?.id && !finalIds.has(item.id)),
    ...finals,
  ];

  const timeline: ActivityTimelineItem[] = [];
  let segment: ActivityItem[] = [];
  const flush = () => {
    if (segment.length === 0) return;
    const first = segment[0]!;
    timeline.push({
      kind: "activity-group",
      id: `activity:turn:${turnId}:segment:${encodeURIComponent(first.id)}`,
      turnId,
      seq: first.seq,
      state: groupState(segment),
      items: segment,
    });
    segment = [];
  };

  for (const item of semantic) {
    if (isDirectProse(item)) {
      flush();
      timeline.push(item);
    } else {
      segment.push(item);
    }
  }
  flush();
  return timeline;
}

/**
 * Keeps prose and activity in conversational order. Items in one authoritative
 * provider turn stay together, but direct messages split activity into stable
 * segments. Items without a turnId are deliberately not associated.
 */
export function buildActivityTimeline(items: ActivityItem[]): ActivityTimelineItem[] {
  const ordered = [...items].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const turns = new Map<string, { seq: number; order: number; items: ActivityItem[] }>();
  const entries: Array<{
    seq: number;
    order: number;
    values: ActivityTimelineItem[];
  }> = [];

  ordered.forEach((item, order) => {
    if (!item.turnId) {
      entries.push({
        seq: item.seq,
        order,
        values: isDirectProse(item)
          ? [item]
          : [{
              kind: "activity-group",
              id: `activity:item:${encodeURIComponent(item.id)}`,
              turnId: null,
              seq: item.seq,
              state: item.state,
              items: [item],
            }],
      });
      return;
    }
    const existing = turns.get(item.turnId);
    if (existing) {
      existing.items.push(item);
      return;
    }
    const turn = { seq: item.seq, order, items: [item] };
    turns.set(item.turnId, turn);
    entries.push({ seq: item.seq, order, values: turn.items });
  });

  for (const [turnId, turn] of turns) {
    const entry = entries.find((candidate) => candidate.values === turn.items);
    if (entry) entry.values = turnTimeline(turnId, turn.items);
  }

  return entries
    .sort((left, right) => left.seq - right.seq || left.order - right.order)
    .flatMap((entry) => entry.values);
}

function stateLabel(state: ActivityItemState): string {
  return state === "complete" ? "completed" : state.replaceAll("_", " ");
}

function stateClasses(state: ActivityItemState): string {
  if (state === "failed") return "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300";
  if (state === "interrupted") return "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200";
  if (isActive(state)) return "border-primary/25 bg-primary/5 text-primary";
  return "border-border bg-muted/35 text-muted-foreground";
}

function ActivityState({ state }: { state: ActivityItemState }) {
  const Icon = state === "complete"
    ? Check
    : state === "failed" || state === "interrupted"
      ? CircleX
      : CircleDashed;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize", stateClasses(state))}>
      <Icon className={cn("size-3", isActive(state) && "animate-pulse motion-reduce:animate-none")} />
      {stateLabel(state)}
    </span>
  );
}

function activityMessageStatus(state: ActivityItemState): MessageStatus {
  if (state === "pending" || state === "running") return { type: "running" };
  if (state === "waiting") return { type: "requires-action", reason: "interrupt" };
  if (state === "complete") return { type: "complete", reason: "stop" };
  if (state === "interrupted") return { type: "incomplete", reason: "cancelled" };
  return { type: "incomplete", reason: "error", error: "Activity failed" };
}

function activityPartStatus(state: ActivityItemState): MessagePartStatus {
  if (state === "pending" || state === "running" || state === "waiting") return { type: "running" };
  if (state === "complete") return { type: "complete" };
  return { type: "incomplete", reason: state === "interrupted" ? "cancelled" : "error" };
}

function activityDate(item: ActivityItem): Date | undefined {
  const raw = item.startedAt ?? item.updatedAt ?? item.completedAt;
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function metadata(item: ActivityItem): NonNullable<ReasoningMessagePartProps["providerMetadata"]> {
  return {
    "agent-manager": {
      item: item as unknown as Record<string, unknown>,
    },
  } as unknown as NonNullable<ReasoningMessagePartProps["providerMetadata"]>;
}

function itemFromMetadata(value: ReasoningMessagePartProps["providerMetadata"]): ActivityItem | null {
  const candidate = value?.["agent-manager"]?.item;
  return candidate && typeof candidate === "object" ? candidate as unknown as ActivityItem : null;
}

function toolArguments(item: Extract<ActivityItem, { kind: "tool" }>): Record<string, ActivityJsonValue> {
  if (item.arguments !== null && typeof item.arguments === "object" && !Array.isArray(item.arguments)) {
    return item.arguments;
  }
  return item.arguments === null ? {} : { input: item.arguments };
}

export function activityToThreadMessage(item: ActivityTimelineItem): ThreadMessageLike {
  if (item.kind === "activity-group") {
    return {
      id: item.id,
      role: "assistant",
      status: activityMessageStatus(item.state),
      content: [{ type: "data", name: ACTIVITY_GROUP_DATA_PART, data: item }],
    };
  }
  const common = {
    id: item.id,
    ...(activityDate(item) ? { createdAt: activityDate(item) } : {}),
  };
  if (item.kind === "message") {
    const prefix = item.role === "system"
      ? "[System] "
      : item.role === "tool"
        ? `[Tool${item.label ? `: ${item.label}` : ""}] `
        : "";
    return {
      ...common,
      role: item.role === "user" ? "user" : "assistant",
      content: [{ type: "text", text: `${prefix}${item.text}`, status: activityPartStatus(item.state) }],
      ...(item.role === "user" ? {} : { status: activityMessageStatus(item.state) }),
    };
  }
  if (item.kind === "reasoning") {
    return {
      ...common,
      role: "assistant",
      status: activityMessageStatus(item.state),
      content: [{
        type: "reasoning",
        text: item.text,
        status: activityPartStatus(item.state),
        providerMetadata: metadata(item),
      }],
    };
  }
  if (item.kind === "tool") {
    const hasResult = item.result !== null || item.output.length > 0 || !isActive(item.state);
    return {
      ...common,
      role: "assistant",
      status: activityMessageStatus(item.state),
      content: [{
        type: "tool-call",
        toolCallId: item.toolCallId,
        toolName: item.name,
        args: toolArguments(item),
        argsText: jsonForDisplay(item.arguments),
        ...(hasResult ? { result: item.result ?? item.output } : {}),
        ...(item.state === "failed" ? { isError: true } : {}),
        artifact: item,
        providerMetadata: metadata(item),
      }],
    };
  }
  return {
    ...common,
    role: "assistant",
    status: activityMessageStatus(item.state),
    content: [{ type: "data", name: ACTIVITY_DATA_PART, data: item }],
  };
}

function ActivityCard({
  item,
  label,
  icon,
  children,
}: {
  item: ActivityItem;
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "w-full min-w-0 rounded-lg border bg-card text-card-foreground shadow-sm",
        item.state === "failed" && "border-red-500/35",
      )}
      data-activity-kind={item.kind}
      data-activity-state={item.state}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <ActivityState state={item.state} />
      </div>
      <div className="min-w-0 border-t px-3 py-2.5 text-xs leading-5">{children}</div>
    </section>
  );
}

function Pre({ children, label }: { children: string; label: string }) {
  if (!children) return null;
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="max-w-full overflow-x-auto rounded-md bg-muted/70 p-2 font-mono text-[11px] leading-5 [tab-size:2]">{children}</pre>
    </div>
  );
}

function ActivityReasoningPart({ text, status, providerMetadata }: ReasoningMessagePartProps) {
  const item = itemFromMetadata(providerMetadata);
  if (!item || item.kind !== "reasoning") return <p className="whitespace-pre-wrap break-words">{text}</p>;
  const provenance = item.exposure === "provider-exposed" ? "Provider reasoning" : "Transcript reasoning";
  const label = item.label
    ? `${provenance}: ${item.label}`
    : item.reasoningKind === "summary" ? `${provenance} summary` : provenance;
  return (
    <ActivityCard
      item={item}
      label={label}
      icon={<Brain className="size-3.5" />}
    >
      <p className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere]", status.type === "running" && "text-foreground")}>{text || "Thinking…"}</p>
    </ActivityCard>
  );
}

function ActivityToolPart(props: ToolCallMessagePartProps) {
  const item = props.artifact as ActivityItem | undefined;
  if (!item || item.kind !== "tool") {
    return <Pre label={props.toolName}>{props.result ? jsonForDisplay(props.result as never) : props.argsText}</Pre>;
  }
  return <ActivityToolCard item={item} />;
}

function ActivityToolCard({ item }: { item: Extract<ActivityItem, { kind: "tool" }> }) {
  const argumentsText = jsonForDisplay(item.arguments);
  const resultText = jsonForDisplay(item.result);
  return (
    <ActivityCard item={item} label={item.name || "Tool call"} icon={<Wrench className="size-3.5" />}>
      <div className="grid min-w-0 gap-2.5">
        <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>{item.category.replaceAll("-", " ")}</span>
          <span>·</span>
          <span>{item.confidence}</span>
          {item.truncated && <span>· truncated</span>}
        </div>
        <Pre label="Arguments">{argumentsText}</Pre>
        <Pre label="Result">{resultText}</Pre>
        <Pre label="Output">{item.output}</Pre>
      </div>
    </ActivityCard>
  );
}

function PlanRow({ item }: { item: Extract<ActivityItem, { kind: "plan" }> }) {
  return (
    <section className="w-full min-w-0 rounded-lg border bg-card px-3 py-2.5 text-xs shadow-sm" data-activity-kind="plan">
      <div className="flex items-center gap-2">
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium">Plan</span>
        <ActivityState state={item.state} />
      </div>
      {item.text && <p className="mt-2 whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">{item.text}</p>}
      {item.steps.length > 0 && (
        <ol className="mt-2 grid gap-1.5">
          {item.steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-start gap-2">
              <span className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]",
                step.status === "completed" && "border-primary/30 bg-primary/10 text-primary",
                step.status === "in_progress" && "border-primary/40 text-primary",
              )}>
                {step.status === "completed" ? <Check className="size-2.5" /> : "·"}
              </span>
              <span className={cn("min-w-0 break-words [overflow-wrap:anywhere]", step.status === "completed" && "text-muted-foreground line-through")}>{step.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function LifecycleRow({ item }: { item: ActivityLifecycleItem }) {
  if (item.details) {
    return (
      <ActivityCard item={item} label={item.title} icon={<Radio className="size-3.5" />}>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.details}</p>
      </ActivityCard>
    );
  }
  return (
    <section className={cn(
      "flex w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs",
      item.level === "error" && "border-red-500/30 bg-red-500/5",
      item.level === "warning" && "border-amber-500/30 bg-amber-500/5",
    )} data-activity-kind="lifecycle">
      <Radio className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere]">{item.title}</span>
      <ActivityState state={item.state} />
    </section>
  );
}

function QueueRow({ item }: { item: Extract<ActivityItem, { kind: "queue" }> }) {
  return (
    <section className="w-full min-w-0 rounded-lg border bg-muted/25 px-3 py-2.5 text-xs" data-activity-kind="queue">
      <div className="flex items-center gap-2">
        <ListPlus className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium">Queued messages</span>
        <span className="text-muted-foreground">{item.messages.length}</span>
      </div>
      {item.messages.length > 0 && (
        <ul className="mt-2 grid gap-1.5">
          {item.messages.map((message) => (
            <li key={message.id} className="flex min-w-0 items-start gap-2 rounded-md bg-background/70 px-2 py-1.5">
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.text}</span>
              <span className={cn("shrink-0 capitalize text-muted-foreground", message.status === "failed" && "text-red-600 dark:text-red-300")}>{message.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UsageRow({ item }: { item: Extract<ActivityItem, { kind: "usage" }> }) {
  const number = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const entries = [
    ["input", item.inputTokens],
    ["output", item.outputTokens],
    ["cached", item.cachedInputTokens],
    ["reasoning", item.reasoningTokens],
    ["total", item.totalTokens],
  ] as const;
  return (
    <section className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground" data-activity-kind="usage">
      <span className="flex items-center gap-1.5 font-medium text-foreground"><Gauge className="size-3.5" /> {item.scope} usage</span>
      {entries.map(([label, value]) => value === null ? null : <span key={label}>{label} {number.format(value)}</span>)}
      {item.costUsd !== null && <span>${item.costUsd.toFixed(4)}</span>}
    </section>
  );
}

function FileChangeRow({ item }: { item: ActivityFileChangeItem }) {
  return (
    <ActivityCard item={item} label={item.summary || `${item.changes.length} file changes`} icon={<FileDiff className="size-3.5" />}>
      <div className="grid min-w-0 gap-3">
        {item.changes.map((change, index) => (
          <div key={`${change.path}:${index}`} className="min-w-0">
            <div className="mb-1 flex min-w-0 gap-2">
              <span className="shrink-0 uppercase text-muted-foreground">{change.operation}</span>
              <span className="min-w-0 break-words font-mono [overflow-wrap:anywhere]">{change.path}</span>
            </div>
            <Pre label="Diff">{change.diff}</Pre>
          </div>
        ))}
      </div>
    </ActivityCard>
  );
}

function SubagentRow({ item }: { item: ActivitySubagentItem }) {
  return (
    <ActivityCard item={item} label={item.name || "Subagent"} icon={<Users className="size-3.5" />}>
      <div className="grid min-w-0 gap-2">
        {item.description && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.description}</p>}
        <Pre label="Output">{item.output}</Pre>
        {item.childItemIds.length > 0 && <p className="text-muted-foreground">{item.childItemIds.length} child activit{item.childItemIds.length === 1 ? "y" : "ies"}</p>}
      </div>
    </ActivityCard>
  );
}

function questionRequest(item: Extract<ActivityItem, { kind: "attention" }>): AttentionRequest {
  return {
    id: item.requestId || null,
    kind: item.attentionKind,
    summary: item.summary,
    ...(item.title ? { title: item.title } : {}),
    questions: item.questions.map((question) => ({
      id: question.id,
      ...(question.header ? { header: question.header } : {}),
      text: question.text,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      multiSelect: question.multiSelect,
      allowFreeText: question.allowFreeText,
      isSecret: question.isSecret,
    })),
    respondable: item.respondable,
    isSecret: item.isSecret,
    source: item.source,
    confidence: item.confidence,
  };
}

function normalizedPrompt(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase();
}

function summaryRepeatsQuestion(item: Extract<ActivityItem, { kind: "attention" }>): boolean {
  if (!item.summary || item.questions.length === 0) return false;
  const summary = normalizedPrompt(item.summary);
  return item.questions.some((question) => {
    const prompt = normalizedPrompt(question.text);
    const headedPrompt = question.header
      ? normalizedPrompt(`${question.header}: ${question.text}`)
      : prompt;
    return summary === prompt || summary === headedPrompt;
  });
}

function isInlineQuestion(
  item: Extract<ActivityItem, { kind: "attention" }>,
  controls: ActivityAttentionControls | undefined,
): controls is ActivityAttentionControls {
  return Boolean(
    controls
      && item.requestId
      && controls.exactRequestIds.has(item.requestId)
      && item.attentionKind === "question"
      && item.respondable
      && !item.resolved
      && item.questions.length > 0,
  );
}

function AttentionRow({
  item,
  controls,
}: {
  item: Extract<ActivityItem, { kind: "attention" }>;
  controls: ActivityAttentionControls | undefined;
}) {
  const interactive = isInlineQuestion(item, controls);
  const showSummary = Boolean(item.summary) && !(item.attentionKind === "question" && summaryRepeatsQuestion(item));
  return (
    <section
      id={item.requestId ? `attention-request-${item.requestId}` : undefined}
      className="w-full min-w-0 scroll-mt-4 rounded-lg border border-amber-500/35 bg-amber-500/5 px-3 py-2.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-activity-kind="attention"
      data-attention-request-id={item.requestId || undefined}
      tabIndex={interactive ? -1 : undefined}
    >
      <div className="flex items-center gap-2">
        <CircleAlert className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <span className="min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere]">{item.title ?? item.attentionKind.replaceAll("-", " ")}</span>
        <ActivityState state={item.state} />
      </div>
      {showSummary && <p className="mt-2 whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">{item.summary}</p>}
      {interactive ? (
        <QuestionRequestForm
          request={questionRequest(item)}
          mutationsReady={controls.mutationsReady}
          canRespond={controls.canRespond}
          busy={controls.busy}
          onRespond={controls.onRespond}
        />
      ) : item.questions.length > 0 && (
        <ul className="mt-2 grid gap-1.5">
          {item.questions.map((question) => (
            <li key={question.id} className="break-words [overflow-wrap:anywhere]">
              {question.header && <span className="mr-1 font-medium">{question.header}:</span>}
              {question.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentaryRow({ item }: { item: Extract<ActivityItem, { kind: "message" }> }) {
  const label = item.role === "assistant"
    ? "Commentary"
    : item.role === "system"
      ? "System update"
      : "Tool message";
  return (
    <section className="w-full min-w-0 rounded-lg border bg-muted/20 px-3 py-2.5 text-xs" data-activity-kind="message">
      <div className="flex items-center gap-2">
        <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium">{item.label || label}</span>
        <ActivityState state={item.state} />
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">{item.text}</p>
    </section>
  );
}

function ActivityItemRow({ item, controls }: { item: ActivityItem; controls: ActivityAttentionControls | undefined }) {
  switch (item.kind) {
    case "message": return <CommentaryRow item={item} />;
    case "reasoning": return (
      <ActivityReasoningPart
        type="reasoning"
        text={item.text}
        status={activityPartStatus(item.state)}
        providerMetadata={metadata(item)}
      />
    );
    case "tool": return <ActivityToolCard item={item} />;
    case "plan": return <PlanRow item={item} />;
    case "lifecycle": return <LifecycleRow item={item} />;
    case "queue": return <QueueRow item={item} />;
    case "usage": return <UsageRow item={item} />;
    case "file-change": return <FileChangeRow item={item} />;
    case "subagent": return <SubagentRow item={item} />;
    case "attention": return <AttentionRow item={item} controls={controls} />;
  }
}

function ActivityTurnDisclosure({
  group,
  controls,
}: {
  group: ActivityTurnGroup;
  controls: ActivityAttentionControls | undefined;
}) {
  const live = isActive(group.state);
  const expanded = live || group.state === "failed" || group.state === "interrupted";
  const itemLabel = `${group.items.length} update${group.items.length === 1 ? "" : "s"}`;
  return (
    <details
      className="group/turn w-full min-w-0 rounded-xl border bg-muted/20 shadow-sm"
      open={expanded ? true : undefined}
      data-activity-turn={group.turnId ?? group.id}
      data-activity-state={group.state}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs marker:content-none [&::-webkit-details-marker]:hidden">
        <Brain className={cn("size-3.5 shrink-0 text-muted-foreground", live && "animate-pulse motion-reduce:animate-none")} />
        <span className="font-medium">Activity</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{itemLabel}</span>
        <ActivityState state={group.state} />
        <span aria-hidden="true" className="text-muted-foreground transition-transform group-open/turn:rotate-90 motion-reduce:transition-none">›</span>
      </summary>
      <div className="grid min-w-0 gap-2 border-t p-2.5">
        {group.items.map((item) => <ActivityItemRow key={item.id} item={item} controls={controls} />)}
      </div>
    </details>
  );
}

function ActivityDataPart({
  data,
  controls,
}: DataMessagePartProps<ActivityItem> & { controls: ActivityAttentionControls | undefined }) {
  switch (data.kind) {
    case "plan": return <PlanRow item={data} />;
    case "lifecycle": return <LifecycleRow item={data} />;
    case "queue": return <QueueRow item={data} />;
    case "usage": return <UsageRow item={data} />;
    case "file-change": return <FileChangeRow item={data} />;
    case "subagent": return <SubagentRow item={data} />;
    case "attention": return <AttentionRow item={data} controls={controls} />;
    default: return null;
  }
}

export function ActivityMessageParts({ controls }: { controls: ActivityAttentionControls | undefined }) {
  return (
    <MessagePrimitive.Parts>
      {({ part }) => {
        switch (part.type) {
          case "text":
            return <MarkdownText />;
          case "reasoning":
            return <ActivityReasoningPart {...part} />;
          case "tool-call":
            return part.toolUI ?? <ActivityToolPart {...part} />;
          case "data":
            if (part.name === ACTIVITY_GROUP_DATA_PART) {
              return <ActivityTurnDisclosure group={part.data as ActivityTurnGroup} controls={controls} />;
            }
            return part.name === ACTIVITY_DATA_PART
              ? <ActivityDataPart {...part} data={part.data as ActivityItem} controls={controls} />
              : part.dataRendererUI;
          default:
            return null;
        }
      }}
    </MessagePrimitive.Parts>
  );
}
