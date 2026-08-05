import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, Pencil } from "lucide-react";
import { usePhoneViewport } from "../../hooks/use-phone-viewport";
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  RadioGroup,
  RadioGroupItem,
} from "../ui";
import { isExactRespondableRequest, type AtomicQuestionResponse, type ExactQuestionRequest, type RequestQuestion } from "./model";

interface DraftAnswer {
  selected: string[];
  custom: string;
}

/*
  `cn` resolves `text-*` by class group, and the named type scale (`text-meta-sm`)
  and a token colour (`text-[var(--accent-ink)]`) land in the same group — one
  silently drops the other, which on a lime fill means near-white ink at 1.2:1.
  The arbitrary `color:` property has its own group, so a filled button can state
  both its size and its ink.
*/

function isAnswered(question: RequestQuestion, answer: DraftAnswer | undefined): boolean {
  if (!answer) return false;
  if (answer.selected.length > 0) return true;
  return question.allowFreeText && answer.custom.trim().length > 0;
}

function summarizedAnswer(question: RequestQuestion, answer: DraftAnswer): string {
  if (question.secret) return "••••••";
  const labels = answer.selected.map((id) => question.options.find((option) => option.id === id)?.label ?? id);
  return [...labels, answer.custom.trim()].filter(Boolean).join(", ");
}

export interface QuestionRequestProps {
  request: ExactQuestionRequest;
  elapsed?: string;
  disabled?: boolean;
  onSubmit: (requestId: string, response: AtomicQuestionResponse) => Promise<void> | void;
}

export function QuestionRequest({ request, elapsed, disabled = false, onSubmit }: QuestionRequestProps) {
  const phone = usePhoneViewport();
  const exact = isExactRespondableRequest(request);
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const question = request.questions[active];
  const complete = request.questions.length > 0 && request.questions.every((item) => isAnswered(item, answers[item.id]));
  const completedCount = request.questions.filter((item) => isAnswered(item, answers[item.id])).length;
  const remainingCount = request.questions.length - completedCount;
  const response = useMemo<AtomicQuestionResponse>(() => ({
    kind: "answers",
    answers: request.questions.map((item) => ({
      questionId: item.id,
      value: answers[item.id]?.custom.trim() ?? "",
      selectedOptions: (answers[item.id]?.selected ?? []).map((id) => item.options.find((option) => option.id === id)?.label ?? id),
    })),
  }), [answers, request.questions]);

  useEffect(() => {
    if (!open || !exact || disabled || !question) return;
    const currentQuestion = question;
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const candidates = document.querySelectorAll(`[data-question-shortcut-ready="true"]`);
      if (candidates.length !== 1 || candidates[0]?.getAttribute("data-request-id") !== request.id) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-9]$/u.test(event.key)) {
        const option = currentQuestion.options[Number(event.key) - 1];
        if (option) {
          event.preventDefault();
          choose(currentQuestion, option.id);
        }
      } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && complete) {
        event.preventDefault();
        void submit();
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "e" && currentQuestion.allowFreeText) {
        event.preventDefault();
        const input = document.getElementById(`custom-${request.id}-${currentQuestion.id}`);
        if (input instanceof HTMLInputElement) input.focus();
        else setCustomOpen((current) => ({ ...current, [currentQuestion.id]: true }));
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  function choose(item: RequestQuestion, optionId: string) {
    setCustomOpen((current) => ({ ...current, [item.id]: false }));
    setAnswers((current) => {
      const existing = current[item.id] ?? { selected: [], custom: "" };
      const selected = item.multiple
        ? existing.selected.includes(optionId)
          ? existing.selected.filter((id) => id !== optionId)
          : [...existing.selected, optionId]
        : [optionId];
      return { ...current, [item.id]: { selected, custom: "" } };
    });
  }

  function setCustom(item: RequestQuestion, custom: string) {
    setAnswers((current) => ({
      ...current,
      [item.id]: { selected: [], custom },
    }));
  }

  async function submit() {
    if (!exact || !request.id || !complete || disabled || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(request.id, response);
    } finally {
      setSubmitting(false);
    }
  }

  if (!exact) {
    return (
      <section className="border-l-2 border-dashed border-[var(--accent)] bg-[var(--surface-raised)] px-3 py-2.5" aria-label={`${request.label} needs attention`}>
        <p className="text-meta font-medium text-[var(--text)]">{request.label}</p>
        <p className="mt-1 text-meta-sm text-[var(--text-muted)]">This request is inferred or incomplete. Answer it in the native provider interface.</p>
      </section>
    );
  }

  // Frame 6a states only the two keys it offers on the open question.
  const pickHint = !question ? null
    : question.options.length > 0 ? `1–${Math.min(9, question.options.length)} to pick · ↵ to send`
      : "↵ to send";

  return (
    <section className="min-w-0 max-w-full text-meta" data-request-id={request.id} data-question-shortcut-ready={open && exact && !disabled && !submitting ? "true" : "false"} aria-label={`${request.label} question`}>
      <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="touch" className="w-full min-w-0 justify-start gap-2 px-0 py-1.5 text-left text-[var(--accent)] hover:text-[var(--accent)]">
            <AlertCircle size={16} strokeWidth={1.75} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-body-sm">Needs action: <strong className="font-semibold">{request.label}</strong></span>
            {request.questions.length > 1 && (
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-code-sm opacity-85" aria-label={`${completedCount} of ${request.questions.length} answered`}>
                {Math.min(completedCount + 1, request.questions.length)}/{request.questions.length}
                <span className="flex gap-0.5">
                  {request.questions.map((item) => <span key={item.id} className={`h-[3px] w-[13px] ${isAnswered(item, answers[item.id]) ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]"}`} />)}
                </span>
              </span>
            )}
            {elapsed && <span className="shrink-0 text-meta-sm tabular-nums opacity-70">{elapsed}</span>}
            <ChevronDown size={15} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="ml-6 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 pt-0.5 pb-2">
          {request.questions.map((item, index) => {
            const answer = answers[item.id];
            const answered = isAnswered(item, answer);
            if (index !== active) {
              return answered && answer ? (
                <Button key={item.id} variant="ghost" size="sm" data-compact-control className="h-auto min-h-10 w-full items-start justify-start gap-2.5 px-0 py-2 text-left whitespace-normal" onClick={() => setActive(index)}>
                  <Check size={15} strokeWidth={1.75} className="mt-[3px] shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-meta-sm text-[var(--text-muted)]">{item.prompt}</span>
                    <span className="block text-[13.5px] leading-[19px] font-medium text-[var(--text)] [overflow-wrap:anywhere]">{summarizedAnswer(item, answer)}</span>
                  </span>
                  <Pencil size={14} strokeWidth={1.75} className="mt-[3px] shrink-0 text-[var(--text-faint)]" />
                </Button>
              ) : (
                <Button key={item.id} variant="ghost" size="sm" data-compact-control className="h-auto min-h-10 w-full justify-start gap-2.5 px-0 py-2.5 text-left" onClick={() => setActive(index)}>
                  <span className="w-[15px] shrink-0 text-center font-mono text-code-sm font-medium text-[var(--text-faint)]">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[19px] text-[var(--text-muted)]">{item.prompt}</span>
                  <span className="shrink-0 font-mono text-code-xs text-[var(--text-muted)]">{item.multiple ? "pick many" : item.options.length ? "pick one" : "free text"}</span>
                </Button>
              );
            }
            const described = item.options.some((option) => option.description);
            const locked = disabled || submitting;
            /*
              Frame 9a-2: a described option is a full-width row and never
              collapses into a pill, because a pill would have to truncate the
              description — the one part of the option the provider wrote to be
              read before choosing.
            */
            const layout = `mt-3 min-w-0 ${described || item.options.length === 0 ? "grid grid-cols-[minmax(0,1fr)] gap-1.5" : "flex flex-wrap gap-2"}`;
            const rows = (
              <>
                {item.options.map((option, optionIndex) => {
                  const selected = answer?.selected.includes(option.id) ?? false;
                  // The control is the real one either way. A pill states its own
                  // choice by filling, so the box/circle is only drawn on the rows
                  // that have no fill of their own.
                  const indicator = described ? "mt-[3px]" : "sr-only";
                  return (
                    <label key={option.id} className={described
                      ? `flex min-h-[46px] min-w-0 cursor-pointer items-start gap-[11px] px-3 py-2.5 ${selected ? "bg-[var(--wants-field)] outline outline-[var(--wants-outline)]" : "border border-[var(--border)]"}`
                      : `flex ${phone ? "min-h-[46px]" : "min-h-8"} max-w-full cursor-pointer items-center rounded-full border px-3 text-meta-sm ${selected || option.recommended && !answer ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]" : "border-[var(--border)]"}`}
                    >
                      {item.multiple
                        ? <Checkbox className={indicator} disabled={locked} checked={selected} onCheckedChange={() => choose(item, option.id)} />
                        : <RadioGroupItem className={indicator} value={option.id} />}
                      <span className="min-w-0 flex-1">
                        <span className="block text-body-sm font-medium [overflow-wrap:anywhere]">{option.label}</span>
                        {option.description && <span className="mt-0.5 block text-meta-sm text-[var(--text-muted)] [text-wrap:pretty]">{option.description}</span>}
                      </span>
                      {described && <kbd className="shrink-0 bg-[var(--menu)] px-1.5 font-mono text-code-xs font-medium text-[var(--text-muted)]">{optionIndex + 1}</kbd>}
                    </label>
                  );
                })}
                {item.allowFreeText && !described && item.options.length > 0 && (
                  customOpen[item.id] || Boolean(answer?.custom)
                    ? <input autoFocus id={`custom-${request.id}-${item.id}`} type={item.secret ? "password" : "text"} autoComplete={item.secret ? "new-password" : undefined} value={answer?.custom ?? ""} onChange={(event) => setCustom(item, event.target.value)} className={`${phone ? "min-h-[46px]" : "min-h-8"} min-w-32 max-w-full rounded-full border border-dashed border-[var(--border)] bg-transparent px-3 text-meta-sm outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]`} placeholder="Something else…" aria-label={`${item.prompt} custom answer`} />
                    : <Button variant="secondary" size={phone ? "touch" : "sm"} data-compact-control className="rounded-full border-dashed border-[var(--border)] px-3 hover:border-[var(--accent)]" onClick={() => setCustomOpen((current) => ({ ...current, [item.id]: true }))}><span className="text-meta-sm text-[var(--text-muted)]">Something else…</span></Button>
                )}
                {/* With described options the free-text escape keeps the same
                    full-width row, dashed, rather than shrinking to a pill. */}
                {item.allowFreeText && (described || item.options.length === 0) && (
                  <label className="flex min-h-[46px] min-w-0 cursor-text items-center gap-[11px] border border-dashed border-[var(--border-strong)] px-3 py-2.5">
                    <span className="size-4 shrink-0 rounded-full border border-[var(--text-faint)]" aria-hidden="true" />
                    <input id={`custom-${request.id}-${item.id}`} type={item.secret ? "password" : "text"} autoComplete={item.secret ? "new-password" : undefined} value={answer?.custom ?? ""} onChange={(event) => setCustom(item, event.target.value)} className="min-w-0 flex-1 bg-transparent text-body-sm outline-none placeholder:text-[var(--text-muted)]" placeholder="Something else…" aria-label={`${item.prompt} custom answer`} />
                  </label>
                )}
              </>
            );
            return (
              <fieldset key={item.id} className="my-1 min-w-0 max-w-full bg-[var(--surface-raised-active)] px-3.5 py-[13px]" disabled={locked}>
                {/* A flex `legend` will not shrink below max-content, so an unbroken
                    provider token would widen the whole drawer at 390px. */}
                <legend className="block max-w-full text-title-sm font-medium [overflow-wrap:anywhere] [text-wrap:pretty]"><span className="mr-2 font-mono text-code-sm font-medium text-[var(--accent)]">{index + 1}</span>{item.prompt}</legend>
                {item.header && <p className="mt-1 font-mono text-eyebrow uppercase text-[var(--text-muted)]">{item.header}</p>}
                {/*
                  One provider choice is one control: a `multiple` question is a
                  set of checkboxes, a single-answer question is one radio group
                  whose value is the empty string the moment free text takes over,
                  which is what keeps "Other" and the provider's own options
                  mutually exclusive.
                */}
                {item.multiple || item.options.length === 0
                  ? <div className={layout}>{rows}</div>
                  : <RadioGroup className={layout} aria-label={item.prompt} disabled={locked} value={answer?.selected[0] ?? ""} onValueChange={(optionId) => choose(item, optionId)}>{rows}</RadioGroup>}
                <div className="mt-3 flex justify-between">
                  <Button variant="ghost" size="sm" data-compact-control disabled={index === 0} className="px-0 disabled:invisible" onClick={() => setActive(index - 1)}>Previous</Button>
                  {index < request.questions.length - 1
                    ? <Button variant="primary" size="sm" data-compact-control disabled={!answered} className={`px-4 font-semibold`} onClick={() => setActive(index + 1)}>Next</Button>
                    : (!phone || request.questions.length === 1) && <Button variant="primary" size="sm" data-compact-control disabled={!complete || submitting} className={`px-4 font-semibold`} onClick={() => void submit()}>Send {request.questions.length > 1 ? `${request.questions.length} answers` : "answer"}</Button>}
                </div>
              </fieldset>
            );
          })}
          {!phone && pickHint && <span className="pt-1 font-mono text-code-sm text-[var(--text-muted)]">{pickHint}</span>}
          {phone && request.questions.length > 1 && (
            <footer className="question-request__phone-footer" data-phone-sticky-footer aria-label="Question submission">
              <span className="min-w-0 flex-1 font-mono text-meta-sm leading-[1.4] text-[var(--text-muted)]">{remainingCount === 0 ? "All questions answered" : `${remainingCount} ${remainingCount === 1 ? "question" : "questions"} left`}</span>
              {/* The one atomic send on a phone: nothing leaves until every question is answered. */}
              <Button variant="primary" size="touch" disabled={!complete || submitting} className={`shrink-0 px-[18px] font-semibold disabled:bg-[var(--surface-selected)] disabled:[color:var(--text-muted)] disabled:opacity-100`} onClick={() => void submit()}>Send {request.questions.length} answers</Button>
            </footer>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
