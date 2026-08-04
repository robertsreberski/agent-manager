import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, CircleHelp, ShieldQuestion, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { cn } from "../lib/utils";
import type { AttentionQuestion, AttentionRequest, RequestResponse, SessionView } from "../types";

function RequestIcon({ kind }: { kind: AttentionRequest["kind"] }) {
  if (kind === "question" || kind === "elicitation") return <CircleHelp className="size-4 text-blue-600" />;
  if (kind === "blocked") return <AlertTriangle className="size-4 text-amber-600" />;
  return <ShieldQuestion className="size-4 text-amber-600" />;
}

function PendingRequestCard({
  request,
  disabled,
  busy,
  onRespond,
}: {
  request: AttentionRequest;
  disabled: boolean;
  busy: boolean;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [denyReason, setDenyReason] = useState("");
  const question = request.kind === "question";
  const providerRespondable = request.respondable !== false;
  const canRespond = Boolean(request.id) && providerRespondable && !disabled && !busy;
  const questions: AttentionQuestion[] = request.questions && request.questions.length > 0
    ? request.questions
    : question
      ? [{
          id: "answer",
          text: request.prompt || request.summary || "What should the agent do?",
          options: (request.options ?? []).map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
          multiSelect: request.multiple === true,
          allowFreeText: true,
        }]
      : [];
  const answerItems = questions.map((item) => ({
    questionId: item.id,
    value: (answers[item.id] ?? "").trim(),
    selectedOptions: selected[item.id] ?? [],
  }));
  const allQuestionsAnswered = answerItems.length > 0 && answerItems.every((item) =>
    item.value.length > 0 || item.selectedOptions.length > 0,
  );

  function toggleOption(question: AttentionQuestion, value: string) {
    setSelected((current) => {
      const existing = current[question.id] ?? [];
      const next = question.multiSelect
        ? existing.includes(value)
          ? existing.filter((item) => item !== value)
          : [...existing, value]
        : [value];
      return { ...current, [question.id]: next };
    });
  }

  async function submitAnswer() {
    if (!request.id) return;
    if (!allQuestionsAnswered) return;
    const response: RequestResponse = answerItems.length === 1
      ? {
          kind: "answer",
          value: answerItems[0]!.value,
          selectedOptions: answerItems[0]!.selectedOptions,
        }
      : { kind: "answers", answers: answerItems };
    await onRespond(request.id, response);
  }

  async function submitDecision(decision: "allow" | "deny") {
    if (!request.id) return;
    await onRespond(request.id, {
      kind: "decision",
      decision,
      ...(decision === "deny" && denyReason.trim() ? { reason: denyReason.trim() } : {}),
    });
  }

  return (
    <Alert className={cn(
      "border-amber-500/30 bg-amber-500/[0.04]",
      request.kind === "blocked" && "border-dashed",
    )}>
      <div className="flex items-start gap-2.5">
        <RequestIcon kind={request.kind} />
        <div className="min-w-0 flex-1">
          <AlertTitle>{request.title || request.kind.replace("-", " ")}</AlertTitle>
          <AlertDescription>
            {request.summary || (!question ? request.prompt : null) || "This session needs attention."}
          </AlertDescription>
          {(request.toolName || request.inputSummary) && (
            <div className="mt-2 rounded-md border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
              {request.toolName && <span className="font-semibold text-foreground">{request.toolName}</span>}
              {request.toolName && request.inputSummary && <span>: </span>}
              {request.inputSummary}
            </div>
          )}
          <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {request.confidence} · {request.source}
          </p>

          {question && request.kind !== "blocked" && providerRespondable && (
            <div className="mt-3 grid gap-4">
              {questions.map((item, questionIndex) => {
                const selectedOptions = selected[item.id] ?? [];
                return (
                  <fieldset key={item.id} className="grid gap-2 rounded-lg border bg-background/70 p-3">
                    <legend className="px-1 text-sm font-medium">
                      {questions.length > 1 ? `${questionIndex + 1}. ` : ""}{item.text}
                    </legend>
                    {item.options.length > 0 && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {item.options.map((option) => {
                          const checked = selectedOptions.includes(option.label);
                          return (
                            <button
                              key={option.label}
                              type="button"
                              disabled={!canRespond}
                              onClick={() => toggleOption(item, option.label)}
                              aria-pressed={checked}
                              className={cn(
                                "rounded-md border bg-background p-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                                checked && "border-primary bg-primary/5",
                              )}
                            >
                              <span className="flex items-center justify-between gap-2 font-medium">
                                {option.label}
                                {checked && <Check className="size-3.5 text-primary" />}
                              </span>
                              {option.description && <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {(item.allowFreeText || item.options.length === 0) && (
                      <Input
                        type={item.isSecret || request.isSecret ? "password" : "text"}
                        autoComplete={item.isSecret || request.isSecret ? "new-password" : undefined}
                        aria-label={`${item.text} answer`}
                        value={answers[item.id] ?? ""}
                        onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                        disabled={!canRespond}
                        placeholder={selectedOptions.length > 0 ? "Add context (optional)" : "Type your answer"}
                      />
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {item.options.length > 0
                        ? item.multiSelect
                          ? "Choose one or more options."
                          : "Choose one option."
                        : "Enter an answer."}
                      {item.options.length > 0 && item.allowFreeText ? " A custom answer is also allowed." : ""}
                    </p>
                  </fieldset>
                );
              })}
              <div className="flex justify-end">
                <Button
                  onClick={() => void submitAnswer().catch(() => undefined)}
                  disabled={!canRespond || !allQuestionsAnswered}
                >
                  Send {questions.length > 1 ? `${questions.length} answers` : "answer"}
                </Button>
              </div>
            </div>
          )}

          {!question && request.kind !== "blocked" && providerRespondable && (
            <div className="mt-3 grid gap-2">
              <Input
                value={denyReason}
                onChange={(event) => setDenyReason(event.target.value)}
                disabled={!canRespond}
                placeholder="Reason if denying (optional)"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => void submitDecision("deny").catch(() => undefined)} disabled={!canRespond}>
                  <X /> Deny
                </Button>
                <Button onClick={() => void submitDecision("allow").catch(() => undefined)} disabled={!canRespond}>
                  <Check /> Allow once
                </Button>
              </div>
            </div>
          )}

          {!request.id && (
            <p className="mt-3 text-xs text-muted-foreground">
              This is an inferred state. Open the provider session to respond safely.
            </p>
          )}
          {request.id && !providerRespondable && (
            <p className="mt-3 text-xs text-muted-foreground">
              This provider request cannot be represented safely in the cockpit. Interrupt it or continue in the provider’s native interface.
            </p>
          )}
          {disabled && request.id && providerRespondable && (
            <p className="mt-3 text-xs text-muted-foreground">Take control to answer this request.</p>
          )}
        </div>
      </div>
    </Alert>
  );
}

export function PendingRequests({
  session,
  requests = session.attention,
  writable,
  busy,
  onRespond,
}: {
  session: SessionView;
  requests?: AttentionRequest[];
  writable: boolean;
  busy: boolean;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (requests.length === 0) return null;
  const first = requests[0];
  const summary = requests.length === 1
    ? first?.title || first?.summary || "This session needs your input."
    : `${requests.length} requests are waiting.`;
  return (
    <>
      <section className="shrink-0 border-b bg-amber-500/[0.06]" aria-label="Pending requests">
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left outline-none hover:bg-amber-500/[0.08] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-6"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <AlertTriangle className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <span className="shrink-0 text-sm font-semibold">Needs you</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
          <span className="shrink-0 rounded-full border border-amber-500/30 bg-background px-2 py-0.5 text-[11px] font-medium">
            {requests.length}
          </span>
          <span className="hidden shrink-0 text-xs font-medium sm:inline">Review</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </section>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="gap-0 overflow-hidden p-0 md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[min(92vw,42rem)] md:border-l md:border-t-0"
        >
          <SheetHeader className="border-b px-5 py-4">
            <SheetTitle>Needs you</SheetTitle>
            <SheetDescription>
              {requests.length === 1 ? "Review and answer this request." : `Review and answer ${requests.length} waiting requests.`}
            </SheetDescription>
          </SheetHeader>
          <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable] sm:px-5">
            {requests.map((request, index) => (
              <PendingRequestCard
                key={request.id ?? `${request.kind}-${index}`}
                request={request}
                disabled={!writable || !session.control.capabilities.includes("respond")}
                busy={busy}
                onRespond={onRespond}
              />
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
