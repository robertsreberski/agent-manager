import { z } from "zod";

export const SELECTED_TODO_TEXT_LIMIT = 128 * 1_024;

export const selectedTodoDetailSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  current: z.string().min(1).max(SELECTED_TODO_TEXT_LIMIT).nullable(),
}).strict().superRefine((todo, context) => {
  if (todo.completed > todo.total) {
    context.addIssue({
      code: "custom",
      path: ["completed"],
      message: "completed todos cannot exceed the total",
    });
  }
});

/**
 * The only todo content allowed outside the selected-session activity stream.
 * Counts duplicate metadata solely to bind the current text to one exact
 * generation; the response never includes pending text, details, or churn.
 */
export const selectedTodoDetailResponseSchema = z.object({
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  todo: selectedTodoDetailSchema.nullable(),
}).strict();

export type SelectedTodoDetail = z.infer<typeof selectedTodoDetailSchema>;
export type SelectedTodoDetailResponse = z.infer<typeof selectedTodoDetailResponseSchema>;
