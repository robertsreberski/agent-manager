import { useState } from "react";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { Bot, Check, ChevronDown, Circle, GitBranch, LoaderCircle } from "lucide-react";
import { MarkdownText } from "../assistant-ui/markdown-text";
import { jsonForDisplay } from "../../lib/session-activity";
import type { ActivityItem, ActivityJsonValue, ActivityState } from "../../types";
import { displayDuration, groupActivityPart, toolGroupTiming } from "./grouping";
import type { SubagentFrameData } from "./subagent";

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

function ToolGroup({ status, indices, children }: { status: { type: string }; indices: readonly number[]; children: React.ReactNode }) {
  const forced = status.type !== "complete";
  const [chosenOpen, setChosenOpen] = useState(false);
  const open = forced || chosenOpen;
  const parts = useAuiState((state) => state.message.parts);
  const duration = displayDuration(toolGroupTiming(parts, indices));
  return (
    <section className="my-2" data-tool-group-status={status.type}>
      <button type="button" data-compact-control className="flex min-h-9 w-full items-center gap-2 text-left text-[12px] font-medium" aria-expanded={open} onClick={() => !forced && setChosenOpen((value) => !value)}>
        <ChevronDown size={13} className={open ? "rotate-180" : "-rotate-90"} />
        <span>{indices.length} tool {indices.length === 1 ? "call" : "calls"}</span>
        {duration && <span className="font-mono text-[11px] font-normal text-[var(--text-muted)]">{duration}</span>}
        {forced && <span className="font-mono text-[10.5px] text-[var(--text-muted)]">active</span>}
      </button>
      {open && <div className="ml-[22px] grid gap-1.5">{children}</div>}
    </section>
  );
}

function ToolCall({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(part.status.type !== "complete" || Boolean(part.isError));
  const duration = displayDuration(part.timing);
  if (part.toolUI) return part.toolUI;
  const detail = typeof part.args === "object" && part.args !== null
    ? Object.values(part.args as Record<string, unknown>).find((value) => typeof value === "string")
    : null;
  return (
    <section className="border-l border-[var(--rule)] pl-2.5" data-tool-status={part.status.type}>
      <button type="button" data-compact-control className="flex min-h-8 w-full min-w-0 items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {part.status.type === "running" ? <LoaderCircle size={12} className="motion-safe:animate-spin" /> : part.isError ? <Circle size={10} className="text-[var(--danger)]" /> : <Check size={12} className="text-[var(--text-muted)]" />}
        <strong className="shrink-0 font-mono text-[11.5px]">{part.toolName}</strong>
        {typeof detail === "string" && <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">{detail}</span>}
        {duration && <span className="font-mono text-[10px] text-[var(--text-faint)]">{duration}</span>}
        <ChevronDown size={11} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="grid gap-1.5 pb-2">
          <pre className="overflow-x-auto bg-[var(--surface-raised)] p-2 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-words">{part.argsText || JSON.stringify(part.args, null, 2)}</pre>
          {part.result !== undefined && <pre className={`overflow-x-auto bg-[var(--surface-raised)] p-2 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-words ${part.isError ? "text-[var(--danger)]" : ""}`}>{typeof part.result === "string" ? part.result : JSON.stringify(part.result, null, 2)}</pre>}
        </div>
      )}
    </section>
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
  if (item.kind === "reasoning") {
    return <details className="text-[12px] text-[var(--text-muted)]"><summary data-compact-control className="min-h-8 cursor-pointer py-1.5">Reasoning</summary><pre className="border-l border-[var(--rule)] pl-3 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-words">{item.text}</pre></details>;
  }
  if (item.kind === "message") {
    return (
      <div className="py-1 text-[12.5px] leading-5" data-subagent-message-role={item.role}>
        {item.role !== "assistant" && <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">{item.role}</span>}
        <p className="whitespace-pre-wrap">{item.text}</p>
      </div>
    );
  }
  if (item.kind === "usage" || item.kind === "subagent") return null;
  return renderData?.(`agent-manager.${item.kind}`, item) ?? null;
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
    <section className="relative my-3 border-l-2 border-[var(--remote)] pl-[15px]" data-subagent-id={item.id}>
      <header className="flex min-h-8 min-w-0 items-center gap-2">
        <Bot size={14} className="shrink-0 text-[var(--remote)]" />
        <span className="shrink-0 text-[13px]">Subagent <strong className="text-[var(--remote)]">{item.name}</strong></span>
        {nestedCount > 0 && <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-[var(--remote-dim)]"><GitBranch size={12} />{nestedCount} nested {nestedCount === 1 ? "subagent" : "subagents"}</span>}
      </header>
      {item.description && <p className="mt-2 bg-[var(--surface-raised)] p-2.5 text-[12.5px] leading-5 text-[var(--text-muted)]">{item.description}</p>}
      {data.steps.length > 0 && <div className="mt-2 grid gap-1" data-subagent-steps>{data.steps.map((step) => <SubagentStep key={step.id} item={step} {...(renderData ? { renderData } : {})} />)}</div>}
      {item.output && <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-5">{item.output}</p>}
      {(returned || hasFacts) && (
        <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[color-mix(in_oklab,var(--remote)_30%,transparent)] pt-2 font-mono text-[11px] text-[var(--remote-dim)]">
          <span>{item.state === "complete" ? "returned to parent" : item.state === "failed" ? "failed" : item.state === "interrupted" ? "interrupted" : "current totals"}</span>
          {(returnFacts.additions !== null || returnFacts.removals !== null) && <span className="inline-flex gap-2">{returnFacts.additions !== null && <span className="text-[var(--added)]">+{returnFacts.additions}</span>}{returnFacts.removals !== null && <span className="text-[var(--removed)]">−{returnFacts.removals}</span>}</span>}
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

export function GroupedActivityParts({ renderData }: GroupedActivityPartsProps) {
  return (
    <MessagePrimitive.GroupedParts<ActivityGroupKey>
      groupBy={(part) => groupActivityPart(part)}
      indicator="never"
    >
      {({ part, children }) => {
        switch (part.type) {
          case "group-thought": return <div className="grid gap-1">{children}</div>;
          case "group-tools": return <ToolGroup status={part.status} indices={part.indices}>{children}</ToolGroup>;
          case "group-subagent": return <div className="grid gap-2">{children}</div>;
          case "text": return <MarkdownText />;
          case "reasoning": return <details className="text-[12px] text-[var(--text-muted)]"><summary data-compact-control className="min-h-8 cursor-pointer py-1.5">Reasoning</summary><pre className="border-l border-[var(--rule)] pl-3 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-words">{part.text}</pre></details>;
          case "tool-call": return <ToolCall part={part} />;
          case "data": {
            if (part.dataRendererUI) return part.dataRendererUI;
            if (part.name === "agent-manager.subagent") return <SubagentFrame data={part.data as unknown as SubagentFrameData} {...(renderData ? { renderData } : {})} />;
            return renderData?.(part.name, part.data) ?? null;
          }
          case "source": return <a className="text-[var(--accent-quiet)] underline" href={part.sourceType === "url" ? part.url : undefined} target="_blank" rel="noreferrer">{part.title}</a>;
          case "file": return <span className="font-mono text-[11.5px] text-[var(--text-muted)]">{part.filename ?? "Attached file"}</span>;
          case "image": return <img src={part.image} alt={part.filename ?? "Message image"} className="max-w-full" />;
          case "audio": return <span className="text-[12px] text-[var(--text-muted)]">Audio attachment</span>;
          case "generative-ui": return null;
          case "indicator": return null;
          default: return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

type ActivityGroupKey = "group-thought" | "group-tools" | "group-subagent";
