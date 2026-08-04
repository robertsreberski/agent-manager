import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, CircleHelp, KeyRound, ShieldQuestion, X } from "lucide-react";
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

function isOtherOption(label: string): boolean {
  const normalized = label.trim().toLocaleLowerCase().replace(/[.:…]+$/u, "");
  return normalized === "other"
    || normalized === "something else"
    || normalized === "custom"
    || normalized === "custom answer"
    || normalized.startsWith("other (");
}

export function isCanonicalInlineQuestion(
  request: AttentionRequest,
  exactRequestIds: ReadonlySet<string>,
): boolean {
  return Boolean(
    request.id
      && exactRequestIds.has(request.id)
      && request.kind === "question"
      && request.respondable !== false
      && request.questions?.length,
  );
}

export function QuestionRequestForm({
  request,
  writable,
  mutationsReady,
  canRespond,
  busy,
  onTakeControl,
  onRespond,
}: {
  request: AttentionRequest;
  writable: boolean;
  mutationsReady: boolean;
  canRespond: boolean;
  busy: boolean;
  onTakeControl?: () => void;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const questions = request.questions ?? [];

  const answerItems = questions.map((item) => {
    const includesFreeText = item.options.length === 0 || Boolean(otherSelected[item.id]);
    return {
      questionId: item.id,
      value: includesFreeText ? (answers[item.id] ?? "").trim() : "",
      selectedOptions: selected[item.id] ?? [],
    };
  });
  const allQuestionsAnswered = questions.length > 0 && questions.every((item) => {
    const value = (answers[item.id] ?? "").trim();
    const selectedOptions = selected[item.id] ?? [];
    if (item.options.length === 0) return value.length > 0;
    if (otherSelected[item.id]) return value.length > 0;
    return selectedOptions.length > 0;
  });
  const draftDisabled = !mutationsReady || !canRespond || busy || submitting;
  const canSubmit = writable && mutationsReady && canRespond && !busy && !submitting;

  function selectNamedOption(question: AttentionQuestion, value: string) {
    setSelected((current) => {
      const existing = current[question.id] ?? [];
      const next = question.multiSelect
        ? existing.includes(value)
          ? existing.filter((item) => item !== value)
          : [...existing, value]
        : [value];
      return { ...current, [question.id]: next };
    });
    if (!question.multiSelect) {
      setOtherSelected((current) => ({ ...current, [question.id]: false }));
      setAnswers((current) => ({ ...current, [question.id]: "" }));
    }
  }

  function selectOther(question: AttentionQuestion) {
    setOtherSelected((current) => {
      const next = !current[question.id];
      return { ...current, [question.id]: next };
    });
    if (!question.multiSelect) {
      setSelected((current) => ({ ...current, [question.id]: [] }));
    }
  }

  async function submitAnswer() {
    if (!request.id || !allQuestionsAnswered || !canSubmit) return;
    const response: RequestResponse = answerItems.length === 1
      ? {
          kind: "answer",
          value: answerItems[0]!.value,
          selectedOptions: answerItems[0]!.selectedOptions,
        }
      : { kind: "answers", answers: answerItems };
    setSubmitting(true);
    try {
      await onRespond(request.id, response);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2.5 grid gap-3">
      {questions.map((item, questionIndex) => {
        const selectedOptions = selected[item.id] ?? [];
        const existingOther = item.allowFreeText
          ? item.options.find((option) => isOtherOption(option.label))
          : undefined;
        const choices = item.options.map((option) => ({
          ...option,
          other: option === existingOther,
        }));
        if (item.allowFreeText && item.options.length > 0 && !existingOther) {
          choices.push({ label: "Other", description: "Enter a different answer.", other: true });
        }
        const showOtherInput = item.options.length > 0 && Boolean(otherSelected[item.id]);
        const inputId = `attention-${request.id}-${item.id}-other`;
        const choiceName = `attention-${request.id}-${item.id}`;
        return (
          <fieldset
            key={item.id}
            className="min-w-0 rounded-lg border bg-background/75 p-2.5"
            role={item.multiSelect ? "group" : "radiogroup"}
            aria-describedby={`${choiceName}-hint`}
          >
            <legend className="max-w-full px-1 text-sm font-medium leading-5">
              {item.header && (
                <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {item.header}
                </span>
              )}
              <span>{questions.length > 1 ? `${questionIndex + 1}. ` : ""}{item.text}</span>
            </legend>
            {choices.length > 0 && (
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {choices.map((option) => {
                  const checked = option.other
                    ? Boolean(otherSelected[item.id])
                    : selectedOptions.includes(option.label);
                  const optionId = `${choiceName}-${option.label.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}`;
                  return (
                    <label
                      key={`${option.other ? "other" : "option"}:${option.label}`}
                      htmlFor={optionId}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border bg-background px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                        checked && "border-primary bg-primary/5",
                        draftDisabled && "cursor-not-allowed opacity-50 hover:bg-background",
                      )}
                    >
                      <input
                        id={optionId}
                        type={item.multiSelect ? "checkbox" : "radio"}
                        name={choiceName}
                        checked={checked}
                        disabled={draftDisabled}
                        onChange={() => option.other ? selectOther(item) : selectNamedOption(item, option.label)}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center border border-muted-foreground/50",
                          item.multiSelect ? "rounded" : "rounded-full",
                          checked && "border-primary bg-primary text-primary-foreground",
                        )}
                      >
                        {checked && <Check className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-medium leading-5 [overflow-wrap:anywhere]">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block break-words text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {(item.options.length === 0 || showOtherInput) && (
              <Input
                id={inputId}
                type={item.isSecret || request.isSecret ? "password" : "text"}
                autoComplete={item.isSecret || request.isSecret ? "new-password" : undefined}
                aria-label={`${item.text} answer`}
                value={answers[item.id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                disabled={draftDisabled}
                className="mt-2 min-h-11"
                placeholder={showOtherInput ? "Enter another answer" : "Type your answer"}
                autoFocus={showOtherInput && !draftDisabled}
              />
            )}
            <p id={`${choiceName}-hint`} className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              {item.options.length > 0
                ? item.multiSelect
                  ? "Choose one or more options."
                  : "Choose one option."
                : "Enter an answer."}
              {item.allowFreeText && item.options.length > 0 ? " Choose Other for a custom answer." : ""}
            </p>
          </fieldset>
        );
      })}
      <div className="flex min-h-11 flex-wrap items-center justify-end gap-2">
        {!mutationsReady ? (
          <Button type="button" disabled>Reconnect to answer</Button>
        ) : !canRespond ? (
          <p className="text-xs text-muted-foreground">Continue in the provider’s native interface to answer.</p>
        ) : !writable ? (
          <Button type="button" disabled={busy} onClick={onTakeControl}>
            <KeyRound /> {busy ? "Taking control…" : "Take control to answer"}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void submitAnswer().catch(() => undefined)}
            disabled={!canSubmit || !allQuestionsAnswered}
          >
            {submitting ? "Sending…" : `Send ${questions.length > 1 ? `${questions.length} answers` : "answer"}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function PendingRequestCard({
  request,
  exactCurrent,
  disabled,
  mutationsReady,
  busy,
  onRespond,
}: {
  request: AttentionRequest;
  exactCurrent: boolean;
  disabled: boolean;
  mutationsReady: boolean;
  busy: boolean;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}) {
  const [denyReason, setDenyReason] = useState("");
  const question = request.kind === "question";
  const providerRespondable = request.respondable !== false;
  const exactDetailsReady = exactCurrent && (!question || Boolean(request.questions?.length));
  const canRespond = exactDetailsReady && Boolean(request.id) && providerRespondable && !disabled && !busy;
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

          {!question && request.kind !== "blocked" && exactDetailsReady && providerRespondable && (
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

          {(!exactCurrent || (providerRespondable && !exactDetailsReady)) && (
            <p className="mt-3 text-xs text-muted-foreground">
              Exact request details are still loading. Open the provider’s native interface to respond now.
            </p>
          )}
          {exactCurrent && !providerRespondable && (
            <p className="mt-3 text-xs text-muted-foreground">
              This provider request cannot be represented safely in the cockpit. Interrupt it or continue in the provider’s native interface.
            </p>
          )}
          {exactCurrent && disabled && providerRespondable && (
            <p className="mt-3 text-xs text-muted-foreground">
              {mutationsReady ? "Take control to answer this request." : "Reconnect to answer this request."}
            </p>
          )}
        </div>
      </div>
    </Alert>
  );
}

export function PendingRequests({
  session,
  requests = session.attention,
  exactRequestIds = new Set<string>(),
  writable,
  mutationsReady = true,
  busy,
  onJumpToRequest,
  onRespond,
}: {
  session: SessionView;
  requests?: AttentionRequest[];
  exactRequestIds?: ReadonlySet<string>;
  writable: boolean;
  mutationsReady?: boolean;
  busy: boolean;
  onJumpToRequest?: (requestId: string) => void;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (requests.length === 0) return null;
  const inlineQuestions = requests.filter((request) => isCanonicalInlineQuestion(request, exactRequestIds));
  const fallbackRequests = requests.filter((request) => !isCanonicalInlineQuestion(request, exactRequestIds));
  const first = inlineQuestions[0] ?? fallbackRequests[0];
  const summary = requests.length === 1
    ? first?.questions?.[0]?.header
      || first?.questions?.[0]?.text
      || first?.summary
      || first?.title
      || "This session needs your input."
    : `${requests.length} requests are waiting.`;
  const exactRespondableCount = fallbackRequests.filter((request) =>
    Boolean(
      request.id
        && exactRequestIds.has(request.id)
        && request.kind !== "blocked"
        && request.respondable !== false
        && (request.kind !== "question" || request.questions?.length),
    ),
  ).length;
  const jumpRequestId = inlineQuestions[0]?.id ?? null;
  const opensSheet = !jumpRequestId && fallbackRequests.length > 0;
  return (
    <>
      <section className="flex shrink-0 border-b bg-amber-500/[0.06]" aria-label="Pending requests">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-4 py-2 text-left outline-none hover:bg-amber-500/[0.08] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:pl-6"
          onClick={() => {
            if (jumpRequestId) onJumpToRequest?.(jumpRequestId);
            else if (opensSheet) setOpen(true);
          }}
          aria-haspopup={opensSheet ? "dialog" : undefined}
        >
          <AlertTriangle className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <span className="shrink-0 text-sm font-semibold">Needs you</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
          <span className="shrink-0 rounded-full border border-amber-500/30 bg-background px-2 py-0.5 text-[11px] font-medium">
            {requests.length}
          </span>
          <span className="hidden shrink-0 text-xs font-medium sm:inline">{jumpRequestId ? "Jump" : "Review"}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
        {jumpRequestId && fallbackRequests.length > 0 && (
          <button
            type="button"
            className="min-h-11 shrink-0 border-l px-3 text-xs font-medium outline-none hover:bg-amber-500/[0.08] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-4"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
          >
            Review {fallbackRequests.length} more
          </button>
        )}
      </section>
      {fallbackRequests.length > 0 && <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="gap-0 overflow-hidden p-0 [padding-bottom:env(safe-area-inset-bottom)] md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[min(92vw,42rem)] md:border-l md:border-t-0 md:[padding-right:env(safe-area-inset-right)] md:[padding-top:env(safe-area-inset-top)]"
        >
          <SheetHeader className="border-b px-5 py-4">
            <SheetTitle>Needs you</SheetTitle>
            <SheetDescription>
              {exactRespondableCount > 0
                ? fallbackRequests.length === 1
                  ? "Review and answer this request."
                  : `Review ${fallbackRequests.length} waiting requests and answer the verified provider requests.`
                : "Review this pending attention. Exact response details are still loading."}
            </SheetDescription>
          </SheetHeader>
          <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable] sm:px-5">
            {fallbackRequests.map((request, index) => (
              <PendingRequestCard
                key={request.id ?? `${request.kind}-${index}`}
                request={request}
                exactCurrent={Boolean(request.id && exactRequestIds.has(request.id))}
                disabled={!mutationsReady || !writable || !session.control.capabilities.includes("respond")}
                mutationsReady={mutationsReady}
                busy={busy}
                onRespond={onRespond}
              />
            ))}
          </div>
        </SheetContent>
      </Sheet>}
    </>
  );
}
