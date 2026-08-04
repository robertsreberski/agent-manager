import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, Pencil } from "lucide-react";
import { usePhoneViewport } from "../../hooks/use-phone-viewport";
import { isExactRespondableRequest, type AtomicQuestionResponse, type ExactQuestionRequest, type RequestQuestion } from "./model";

interface DraftAnswer {
  selected: string[];
  custom: string;
}

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
        <p className="text-[13px] font-medium text-[var(--text)]">{request.label}</p>
        <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">This request is inferred or incomplete. Answer it in the native provider interface.</p>
      </section>
    );
  }

  return (
    <section className="text-[13px]" data-request-id={request.id} data-question-shortcut-ready={open && exact && !disabled && !submitting ? "true" : "false"} aria-label={`${request.label} question`}>
      <button type="button" className="flex min-h-11 w-full items-center gap-2 text-left text-[var(--accent)]" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <AlertCircle size={15} strokeWidth={1.75} />
        <span>Needs action: <strong>{request.label}</strong></span>
        {request.questions.length > 1 && <span className="font-mono text-[11px]">{Math.min(completedCount + 1, request.questions.length)}/{request.questions.length}</span>}
        {elapsed && <span className="ml-auto font-mono text-[11px] opacity-70">{elapsed}</span>}
        <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="ml-6 grid gap-2">
          {request.questions.length > 1 && (
            <div className="flex gap-1" aria-label={`${completedCount} of ${request.questions.length} answered`}>
              {request.questions.map((item) => <span key={item.id} className={`h-[3px] w-[13px] ${isAnswered(item, answers[item.id]) ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`} />)}
            </div>
          )}
          {request.questions.map((item, index) => {
            const answer = answers[item.id];
            const answered = isAnswered(item, answer);
            if (index !== active) {
              return (
                <button key={item.id} type="button" data-compact-control className="flex min-h-10 items-center gap-2 border-b border-[var(--rule)] text-left" onClick={() => setActive(index)}>
                  <span className="w-5 font-mono text-[11px] text-[var(--text-faint)]">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-muted)]">{item.prompt}</span>
                  {answered && answer ? <span className="max-w-[45%] truncate font-medium text-[var(--text)]">{summarizedAnswer(item, answer)}</span> : <span className="font-mono text-[10px] text-[var(--text-faint)]">{item.multiple ? "multiple" : item.options.length ? "choose one" : "write"}</span>}
                  {answered && <Pencil size={12} strokeWidth={1.75} />}
                </button>
              );
            }
            const described = item.options.some((option) => option.description);
            return (
              <fieldset key={item.id} className="bg-[var(--surface-raised)] p-3" disabled={disabled || submitting}>
                <legend className="px-1 text-sm font-medium"><span className="mr-1 font-mono text-[11px] text-[var(--text-faint)]">{index + 1}.</span>{item.prompt}</legend>
                {item.header && <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">{item.header}</p>}
                <div className={`mt-3 ${described ? "grid gap-2" : "flex flex-wrap gap-2"}`}>
                  {item.options.map((option, optionIndex) => {
                    const selected = answer?.selected.includes(option.id) ?? false;
                    return (
                      <label key={option.id} className={described
                        ? `flex min-h-[46px] cursor-pointer items-start gap-2.5 border px-3 py-2.5 ${selected ? "border-[var(--accent)] bg-[var(--wants-field)]" : "border-[var(--border)]"}`
                        : `flex ${phone ? "min-h-[46px]" : "min-h-8"} cursor-pointer items-center rounded-full border px-3 text-[12.5px] ${selected || option.recommended && !answer ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]" : "border-[var(--border)]"}`}
                      >
                        <input className="sr-only" type={item.multiple ? "checkbox" : "radio"} name={`request-${request.id}-${item.id}`} checked={selected} onChange={() => choose(item, option.id)} />
                        {described && <span className={`mt-0.5 grid size-4 shrink-0 place-items-center ${item.multiple ? "" : "rounded-full"} border ${selected ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]" : "border-[var(--text-faint)]"}`}>{selected && <Check size={11} />}</span>}
                        <span><span className="block font-medium">{option.label}<kbd className="ml-2 font-mono text-[9px] opacity-60">{optionIndex + 1}</kbd></span>{option.description && <span className="mt-0.5 block text-[12.5px] leading-[18px] text-[var(--text-muted)] [text-wrap:pretty]">{option.description}</span>}</span>
                      </label>
                    );
                  })}
                  {item.allowFreeText && !described && item.options.length > 0 && (
                    customOpen[item.id] || Boolean(answer?.custom)
                      ? <input autoFocus id={`custom-${request.id}-${item.id}`} type={item.secret ? "password" : "text"} autoComplete={item.secret ? "new-password" : undefined} value={answer?.custom ?? ""} onChange={(event) => setCustom(item, event.target.value)} className={`${phone ? "min-h-[46px]" : "min-h-8"} min-w-32 max-w-full rounded-full border border-dashed border-[var(--border)] bg-transparent px-3 text-[12.5px] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]`} placeholder="Something else…" aria-label={`${item.prompt} custom answer`} />
                      : <button type="button" data-compact-control className={`${phone ? "min-h-[46px]" : "min-h-8"} rounded-full border border-dashed border-[var(--border)] px-3 text-[12.5px] text-[var(--text-muted)] hover:border-[var(--accent)]`} onClick={() => setCustomOpen((current) => ({ ...current, [item.id]: true }))}>Something else…</button>
                  )}
                </div>
                {item.allowFreeText && (described || item.options.length === 0) && (
                  <input id={`custom-${request.id}-${item.id}`} type={item.secret ? "password" : "text"} autoComplete={item.secret ? "new-password" : undefined} value={answer?.custom ?? ""} onChange={(event) => setCustom(item, event.target.value)} className="mt-3 min-h-[46px] w-full border border-dashed border-[var(--border)] bg-transparent px-3 outline-none focus:border-[var(--accent)]" placeholder="Something else…" aria-label={`${item.prompt} custom answer`} />
                )}
                <div className="mt-3 flex justify-between">
                  <button type="button" data-compact-control disabled={index === 0} className="min-h-9 text-[12px] text-[var(--text-muted)] disabled:invisible" onClick={() => setActive(index - 1)}>Previous</button>
                  {index < request.questions.length - 1 ? <button type="button" data-compact-control disabled={!answered} className="min-h-9 rounded-full bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] disabled:opacity-35" onClick={() => setActive(index + 1)}>Next</button> : (!phone || request.questions.length === 1) && <button type="button" disabled={!complete || submitting} className="min-h-11 rounded-full bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] disabled:opacity-35 sm:min-h-9" onClick={() => void submit()}>Send {request.questions.length > 1 ? `${request.questions.length} answers` : "answer"}</button>}
                </div>
              </fieldset>
            );
          })}
          {phone && request.questions.length > 1 && (
            <footer className="question-request__phone-footer" data-phone-sticky-footer aria-label="Question submission">
              <span className="min-w-0 flex-1 font-mono text-[12px] text-[var(--text-muted)]">{remainingCount === 0 ? "All questions answered" : `${remainingCount} ${remainingCount === 1 ? "question" : "questions"} left`}</span>
              <button type="button" disabled={!complete || submitting} className="min-h-11 shrink-0 rounded-full bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] disabled:bg-[var(--surface-selected)] disabled:text-[var(--text-muted)]" onClick={() => void submit()}>Send {request.questions.length} answers</button>
            </footer>
          )}
        </div>
      )}
    </section>
  );
}
