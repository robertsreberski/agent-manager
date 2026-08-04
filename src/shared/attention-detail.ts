import { z } from "zod";

export const SELECTED_ATTENTION_REQUEST_LIMIT = 50;
export const SELECTED_ATTENTION_FIELD_LIMIT = 128 * 1_024;

const requestIdSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "request id contains a control character");

export const selectedAttentionDetailsQuerySchema = z.object({
  requestId: z.preprocess(
    (value) => value === undefined ? [] : Array.isArray(value) ? value : [value],
    z.array(requestIdSchema).min(1).max(SELECTED_ATTENTION_REQUEST_LIMIT),
  ),
}).strict().superRefine((query, context) => {
  if (new Set(query.requestId).size !== query.requestId.length) {
    context.addIssue({
      code: "custom",
      path: ["requestId"],
      message: "request ids must be unique",
    });
  }
});

const selectedAttentionQuestionSchema = z.object({
  id: z.string().min(1).max(SELECTED_ATTENTION_FIELD_LIMIT),
  text: z.string().min(1).max(SELECTED_ATTENTION_FIELD_LIMIT),
}).strict();

export const selectedAttentionDetailSchema = z.object({
  requestId: requestIdSchema,
  kind: z.enum(["question", "approval", "permission", "sandbox", "elicitation", "blocked"]),
  title: z.string().min(1).max(SELECTED_ATTENTION_FIELD_LIMIT).nullable(),
  toolName: z.string().min(1).max(SELECTED_ATTENTION_FIELD_LIMIT).nullable(),
  questions: z.array(selectedAttentionQuestionSchema).max(50),
  truncated: z.boolean(),
}).strict();

export const selectedAttentionDetailsResponseSchema = z.object({
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  details: z.array(selectedAttentionDetailSchema).max(SELECTED_ATTENTION_REQUEST_LIMIT),
}).strict().superRefine((response, context) => {
  const seen = new Set<string>();
  for (const [index, detail] of response.details.entries()) {
    if (seen.has(detail.requestId)) {
      context.addIssue({
        code: "custom",
        path: ["details", index, "requestId"],
        message: "attention detail request ids must be unique",
      });
    }
    seen.add(detail.requestId);
  }
});

export type SelectedAttentionDetailsQuery = z.infer<typeof selectedAttentionDetailsQuerySchema>;
export type SelectedAttentionDetail = z.infer<typeof selectedAttentionDetailSchema>;
export type SelectedAttentionDetailsResponse = z.infer<typeof selectedAttentionDetailsResponseSchema>;
