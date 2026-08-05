import { useRef, useState } from "react";
import { MessagePrimitive, useAuiState, useScrollLock } from "@assistant-ui/react";
import { Check, ChevronDown, Circle, GitBranch, LoaderCircle } from "lucide-react";
import { MarkdownText } from "../assistant-ui/markdown-text";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui";
import { jsonForDisplay } from "../../lib/session-activity";
import type { ActivityItem, ActivityJsonValue, ActivityState } from "../../types";
import {
  displayDuration,
  fieldIsClamped,
  groupActivityPart,
  toolArgumentFields,
  toolCallDetail,
  toolGroupTiming,
  type ToolArgumentField,
} from "./grouping";
import type { SubagentFrameData } from "./subagent";

/**
 * Collapsing a disclosure halfway down a long turn drops every row below it by
 * the height of what was hidden, so the line the operator was reading jumps out
 * from under the cursor. `useScrollLock` walks up to the nearest scrollable
 * ancestor — the drawer's own `[data-thread-content]`, which this file does not
 * own — and pins its offset across the toggle. The transcript has no height
 * transition, so the lock only has to outlive the reflow and any scroll
 * anchoring the browser applies in the same beat.
 */
export const DISCLOSURE_SCROLL_LOCK_MS = 120;

interface ToolPart {
  toolName: string;
  args: unknown;
  argsText: string;
  result?: unknown;
  isError?: boolean | undefined;
  status: { type: string };
  timing?: { startedAt: number; completedAt?: number } | undefined;
  toolUI?: React.ReactNode;
}

/**
 * Containment grammar shared with `DiffViewer`: a `minmax(0,1fr)` track stops
 * grid children from sizing to max-content, and `[overflow-wrap:anywhere]`
 * breaks the unbroken shell commands, paths and JSON blobs a tool row carries.
 * Without both, one 2.5k-pixel Codex command widens the whole drawer.
 */
const CONTAINED = "min-w-0 max-w-full overflow-hidden";
const STACK = "grid grid-cols-[minmax(0,1fr)] min-w-0 max-w-full";
const BLOCK = "min-w-0 max-w-full overflow-x-hidden bg-[var(--surface-raised)] px-[13px] py-[11px] font-mono text-code whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

export function ToolGroupShell({ status, count, duration, defaultOpen = false, children }: { status: { type: string }; count: number; duration: string | null; defaultOpen?: boolean; children: React.ReactNode }) {
  const forced = status.type !== "complete";
  const [chosenOpen, setChosenOpen] = useState(defaultOpen);
  const shellRef = useRef<HTMLElement>(null);
  const lockScroll = useScrollLock(shellRef, DISCLOSURE_SCROLL_LOCK_MS);
  const open = forced || chosenOpen;
  return (
    <section ref={shellRef} className={`my-2 ${CONTAINED}`} data-tool-group-status={status.type}>
      <button type="button" data-compact-control className="flex min-h-9 w-full min-w-0 items-center gap-2 py-1.5 text-left text-[var(--text-muted)]" aria-expanded={open} onClick={() => { if (forced) return; lockScroll(); setChosenOpen((value) => !value); }}>
        <ChevronDown size={16} strokeWidth={1.75} className={`shrink-0 ${open ? "" : "-rotate-90"}`} />
        <span className="min-w-0 flex-1 truncate text-meta-sm font-medium">{count} tool {count === 1 ? "call" : "calls"}</span>
        {duration && <span className="shrink-0 text-meta-sm tabular-nums text-[var(--text-faint)]">{duration}</span>}
        {forced && <span className="shrink-0 font-mono text-code-xs text-[var(--text-faint)]">active</span>}
      </button>
      {open && <div className={`ml-[22px] gap-0.5 ${STACK}`} data-tool-group-body>{children}</div>}
    </section>
  );
}

function ToolGroup({ status, indices, children }: { status: { type: string }; indices: readonly number[]; children: React.ReactNode }) {
  const parts = useAuiState((state) => state.message.parts);
  return (
    <ToolGroupShell status={status} count={indices.length} duration={displayDuration(toolGroupTiming(parts, indices))}>
      {children}
    </ToolGroupShell>
  );
}

/**
 * One provider-named argument. A long value — an agent prompt, a file body —
 * is clamped rather than printed whole: expanding a tool row should not bury
 * every row after it.
 */
function ArgumentField({ field }: { field: ToolArgumentField }) {
  const clamped = fieldIsClamped(field.value);
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded || !clamped;
  if (!field.multiline && field.name) {
    return (
      <div className={`flex min-w-0 max-w-full gap-2 ${BLOCK}`} data-tool-argument={field.name}>
        <span className="shrink-0 text-[var(--text-muted)]">{field.name}</span>
        <span className="min-w-0 flex-1">{field.value}</span>
      </div>
    );
  }
  return (
    <div className={`${STACK} gap-1`} data-tool-argument={field.name || "value"}>
      {field.name && <span className="font-mono text-code-xs text-[var(--text-muted)]">{field.name}</span>}
      <pre className={`${BLOCK} ${showAll ? "" : "max-h-32 overflow-hidden"}`}>{field.value}</pre>
      {clamped && (
        <button
          type="button"
          data-compact-control="height"
          className="min-h-8 justify-self-start py-1 text-left font-mono text-code-xs text-[var(--text-muted)] underline"
          aria-expanded={showAll}
          onClick={() => setExpanded((value) => !value)}
        >{showAll ? "Show less" : "Show all"}</button>
      )}
    </div>
  );
}

export function ToolCall({ part }: { part: ToolPart }) {
  // A running call used to force itself open, so an agent call put its whole
  // prompt on screen for the length of the turn. Only a failure opens itself.
  const [open, setOpen] = useState(Boolean(part.isError));
  const rowRef = useRef<HTMLElement>(null);
  const lockScroll = useScrollLock(rowRef, DISCLOSURE_SCROLL_LOCK_MS);
  const duration = displayDuration(part.timing);
  if (part.toolUI) return part.toolUI;
  const detail = toolCallDetail(part.args);
  const fields = toolArgumentFields(part.args);
  return (
    <section ref={rowRef} className={CONTAINED} data-tool-status={part.status.type}>
      <button type="button" data-compact-control className="flex min-h-8 w-full min-w-0 items-center gap-[9px] py-1.5 text-left" aria-expanded={open} onClick={() => { lockScroll(); setOpen((value) => !value); }}>
        {part.status.type === "running" ? <LoaderCircle size={15} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)] motion-safe:animate-spin" /> : part.isError ? <Circle size={12} className="shrink-0 text-[var(--danger)]" /> : <Check size={15} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" />}
        <strong className="min-w-0 truncate font-mono text-code-sm font-medium text-[var(--text)]" data-tool-name>{part.toolName}</strong>
        {detail !== null && <span className="min-w-0 flex-1 truncate font-mono text-code-sm text-[var(--text-faint)]" data-tool-detail>{detail}</span>}
        {duration && <span className="shrink-0 font-mono text-code-xs text-[var(--text-faint)]">{duration}</span>}
        <ChevronDown size={12} className={`shrink-0 text-[var(--text-faint)] ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className={`gap-1.5 pb-2 ${STACK}`}>
          <div className={`gap-1.5 ${STACK}`} data-tool-arguments>
            {fields.length > 0
              ? fields.map((field) => <ArgumentField key={field.name || "value"} field={field} />)
              : <pre className={BLOCK}>{part.argsText}</pre>}
          </div>
          {part.result !== undefined && (
            <div className={`${STACK} ${part.isError ? "text-[var(--danger)]" : ""}`} data-tool-result>
              <ArgumentField field={{ name: "", value: typeof part.result === "string" ? part.result : jsonForDisplay(part.result as ActivityJsonValue), multiline: true }} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/*
  A bare `<details>`/`<summary>` announces no expanded state and controls no
  named region. Radix's Collapsible — the same one the rest of the cockpit was
  moved to — wires `aria-expanded` and `aria-controls`, and its controlled
  `open` is what lets the reasoning body join the scroll lock above.
*/
function ReasoningDisclosure({ text, label }: { text: string; label?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(frameRef, DISCLOSURE_SCROLL_LOCK_MS);
  return (
    <Collapsible ref={frameRef} open={open} onOpenChange={(next) => { lockScroll(); setOpen(next); }} className={`text-meta-sm text-[var(--text-muted)] ${CONTAINED}`}>
      {/* Codex sends a summarised thought and its raw counterpart as two items.
          Its own labels are what tell them apart; a fixed "Reasoning" made the
          pair read as one event rendered twice. */}
      <CollapsibleTrigger data-compact-control="height" className="min-h-8 cursor-pointer py-1.5" data-reasoning-label={label ?? "Reasoning"}>{label ?? "Reasoning"}</CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="min-w-0 max-w-full overflow-x-hidden border-l border-[var(--rule)] pl-3 font-mono text-code-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function stepStatus(state: ActivityState): { type: string } {
  return ["pending", "running", "waiting"].includes(state) ? { type: "running" } : { type: "complete" };
}

function toolArguments(item: Extract<ActivityItem, { kind: "tool" }>): Record<string, ActivityJsonValue> {
  if (item.arguments !== null && typeof item.arguments === "object" && !Array.isArray(item.arguments)) return item.arguments;
  return item.arguments === null ? {} : { input: item.arguments };
}

function timing(item: ActivityItem): ToolPart["timing"] {
  if (!item.startedAt) return undefined;
  const startedAt = Date.parse(item.startedAt);
  if (!Number.isFinite(startedAt)) return undefined;
  if (!item.completedAt) return { startedAt };
  const completedAt = Date.parse(item.completedAt);
  return Number.isFinite(completedAt) ? { startedAt, completedAt } : { startedAt };
}

function SubagentStep({ item, renderData }: { item: ActivityItem; renderData?: (name: string, data: unknown) => React.ReactNode }) {
  if (item.kind === "tool") {
    const hasResult = item.result !== null || item.output.length > 0 || !["pending", "running", "waiting"].includes(item.state);
    const itemTiming = timing(item);
    return <ToolCall part={{
      toolName: item.name,
      args: toolArguments(item),
      argsText: jsonForDisplay(item.arguments),
      ...(hasResult ? { result: item.result ?? item.output } : {}),
      ...(item.state === "failed" ? { isError: true } : {}),
      status: stepStatus(item.state),
      ...(itemTiming ? { timing: itemTiming } : {}),
    }} />;
  }
  if (item.kind === "reasoning") return <ReasoningDisclosure text={item.text} {...(item.label ? { label: item.label } : {})} />;
  if (item.kind === "message") {
    return (
      <div className={`py-1 text-meta-sm ${CONTAINED}`} data-subagent-message-role={item.role}>
        {item.role !== "assistant" && <span className="mb-1 block font-mono text-eyebrow uppercase text-[var(--text-faint)]">{item.role}</span>}
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.text}</p>
      </div>
    );
  }
  if (item.kind === "usage" || item.kind === "subagent") return null;
  return renderData?.(`agent-manager.${item.kind}`, item) ?? null;
}

interface SubagentStepRun {
  kind: "tools" | "single";
  key: string;
  items: readonly ActivityItem[];
}

/**
 * Subagent steps render outside `MessagePrimitive.GroupedParts` — they are not
 * message parts — so a subagent that ran twelve tools listed twelve bare rows
 * while the parent turn collapsed its own into one shell. Adjacent tool steps
 * coalesce here on the same rule the primitive uses: provider order is kept,
 * and anything that is not a tool closes the run.
 */
function subagentStepRuns(steps: readonly ActivityItem[]): readonly SubagentStepRun[] {
  const runs: SubagentStepRun[] = [];
  for (const step of steps) {
    const previous = runs.at(-1);
    if (step.kind !== "tool") {
      runs.push({ kind: "single", key: step.id, items: [step] });
      continue;
    }
    if (previous?.kind === "tools") {
      previous.items = [...previous.items, step];
      continue;
    }
    runs.push({ kind: "tools", key: step.id, items: [step] });
  }
  return runs;
}

function stepRunStatus(items: readonly ActivityItem[]): { type: string } {
  return items.some((item) => ["pending", "running", "waiting"].includes(item.state))
    ? { type: "running" }
    : { type: "complete" };
}

function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

export function SubagentFrame({ data, renderData }: { data: SubagentFrameData; renderData?: (name: string, data: unknown) => React.ReactNode }) {
  const { item, nestedCount, returnFacts } = data;
  const returned = item.state === "complete" || item.state === "failed" || item.state === "interrupted";
  const hasFacts = returnFacts.additions !== null
    || returnFacts.removals !== null
    || returnFacts.tokens !== null
    || returnFacts.costUsd !== null;
  return (
    <section className={`relative my-1.5 mb-2 border-l-2 border-[var(--remote)] pl-[15px] ${CONTAINED}`} data-subagent-id={item.id}>
      <header className="flex min-h-8 min-w-0 max-w-full items-center gap-[9px] pt-0.5 pb-2">
        <GitBranch size={15} strokeWidth={1.75} className="shrink-0 text-[var(--remote)]" />
        <span className="min-w-0 flex-1 truncate text-meta">Subagent <strong className="font-semibold text-[var(--remote)]">{item.name}</strong></span>
        {nestedCount > 0 && <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-code-xs text-[var(--remote-dim)]"><GitBranch size={12} />{nestedCount} nested {nestedCount === 1 ? "subagent" : "subagents"}</span>}
      </header>
      {item.description && <p className="max-w-full bg-[var(--surface-raised)] px-[13px] py-[11px] text-meta-sm break-words text-[var(--text-secondary)] [overflow-wrap:anywhere]">{item.description}</p>}
      {data.steps.length > 0 && <div className={`gap-0.5 ${STACK}`} data-subagent-steps>{subagentStepRuns(data.steps).map((run) => (
        run.kind === "tools"
          ? (
            // Open by default: the subagent frame is already the detail view an
            // operator opened on purpose, so the shell is here for the count and
            // the containment, not to hide the work a second time.
            <ToolGroupShell key={run.key} status={stepRunStatus(run.items)} count={run.items.length} duration={null} defaultOpen>
              {run.items.map((step) => <SubagentStep key={step.id} item={step} {...(renderData ? { renderData } : {})} />)}
            </ToolGroupShell>
          )
          : <SubagentStep key={run.key} item={run.items[0]!} {...(renderData ? { renderData } : {})} />
      ))}</div>}
      {item.output && <p className="mt-2 max-w-full whitespace-pre-wrap break-words text-meta-sm [overflow-wrap:anywhere]">{item.output}</p>}
      {(returned || hasFacts) && (
        <footer className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--remote-rule)] pt-[9px] font-mono text-code-xs text-[var(--remote-dim)]">
          <span>{item.state === "complete" ? "returned to parent" : item.state === "failed" ? "failed" : item.state === "interrupted" ? "interrupted" : "current totals"}</span>
          {(returnFacts.additions !== null || returnFacts.removals !== null) && <span className="inline-flex gap-[7px]">{returnFacts.additions !== null && <span className="text-[var(--added)]">+{returnFacts.additions}</span>}{returnFacts.removals !== null && <span className="text-[var(--removed)]">−{returnFacts.removals}</span>}</span>}
          <span className="min-w-0 flex-1" />
          {returnFacts.tokens !== null && <span>{returnFacts.tokens.toLocaleString()} tokens</span>}
          {returnFacts.costUsd !== null && <span>{formatCost(returnFacts.costUsd)}</span>}
        </footer>
      )}
    </section>
  );
}

export interface GroupedActivityPartsProps {
  renderData?: (name: string, data: unknown) => React.ReactNode;
}

/** The provider's own reasoning label, where it supplied one. */
function reasoningLabel(part: { providerMetadata?: Record<string, unknown> | undefined }): { label?: string } {
  const scoped = part.providerMetadata?.["agent-manager"];
  const label = scoped && typeof scoped === "object" && "label" in scoped
    ? (scoped as { label?: unknown }).label
    : undefined;
  return typeof label === "string" && label.length > 0 ? { label } : {};
}

export function GroupedActivityParts({ renderData }: GroupedActivityPartsProps) {
  return (
    // A fresh `groupBy` arrow rebuilt the whole group tree on every token
    // delta; the module-level function is a stable memo key.
    <MessagePrimitive.GroupedParts<ActivityGroupKey>
      groupBy={groupActivityPart}
      indicator="never"
    >
      {({ part, children }) => {
        switch (part.type) {
          case "group-thought": return <div className={`gap-1 ${STACK}`}>{children}</div>;
          case "group-tools": return <ToolGroup status={part.status} indices={part.indices}>{children}</ToolGroup>;
          case "group-subagent": return <div className={`gap-2 ${STACK}`}>{children}</div>;
          case "text": return <MarkdownText />;
          case "reasoning": return <ReasoningDisclosure text={part.text} {...reasoningLabel(part)} />;
          case "tool-call": return <ToolCall part={part} />;
          case "data": {
            if (part.dataRendererUI) return part.dataRendererUI;
            if (part.name === "agent-manager.subagent") return <SubagentFrame data={part.data as unknown as SubagentFrameData} {...(renderData ? { renderData } : {})} />;
            return renderData?.(part.name, part.data) ?? null;
          }
          case "source": return <a className="text-[var(--accent-quiet)] underline" href={part.sourceType === "url" ? part.url : undefined} target="_blank" rel="noreferrer">{part.title}</a>;
          case "file": return <span className="font-mono text-code-sm text-[var(--text-muted)]">{part.filename ?? "Attached file"}</span>;
          case "image": return <img src={part.image} alt={part.filename ?? "Message image"} className="max-w-full" />;
          case "audio": return <span className="text-meta-sm text-[var(--text-muted)]">Audio attachment</span>;
          case "generative-ui": return null;
          case "indicator": return null;
          default: return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

type ActivityGroupKey = "group-thought" | "group-tools" | "group-subagent";
