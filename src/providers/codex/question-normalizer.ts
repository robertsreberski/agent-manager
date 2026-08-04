export interface NormalizedCodexQuestionOption {
  label: string;
  description: string | null;
}

export interface NormalizedCodexQuestion {
  id: string;
  header: string | null;
  text: string;
  options: NormalizedCodexQuestionOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
  isSecret: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  return points.length <= maxCodePoints
    ? value
    : `${points.slice(0, maxCodePoints).join("")}…`;
}

/** Normalize the provider's request_user_input question once for every projection. */
export function normalizeCodexQuestion(value: unknown): NormalizedCodexQuestion | null {
  const question = record(value);
  if (!question || typeof question.id !== "string" || !question.id.trim() ||
      typeof question.question !== "string" || !question.question.trim()) {
    return null;
  }

  const headerValue = typeof question.header === "string"
    ? question.header.trim()
    : "";
  const options = Array.isArray(question.options)
    ? question.options.flatMap((rawOption) => {
        const option = record(rawOption);
        if (!option || typeof option.label !== "string" || !option.label.trim()) {
          return [];
        }
        return [{
          label: boundedText(option.label, 300),
          description: typeof option.description === "string"
            ? boundedText(option.description, 500)
            : null,
        }];
      })
    : [];

  return {
    id: question.id,
    header: headerValue ? boundedText(headerValue, 300) : null,
    text: boundedText(question.question, 1_000),
    options,
    // The Codex request_user_input protocol is always mutually exclusive.
    // Ignore speculative provider fields rather than widening its wire semantics.
    multiSelect: false,
    allowFreeText: question.isOther === true || options.length === 0,
    isSecret: question.isSecret === true,
  };
}

export function normalizeCodexQuestions(value: unknown): NormalizedCodexQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawQuestion) => {
    const question = normalizeCodexQuestion(rawQuestion);
    return question ? [question] : [];
  });
}
