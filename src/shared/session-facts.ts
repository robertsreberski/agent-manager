import { z } from "zod";

const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeFinite = z.number().finite().nonnegative();
const shortText = z.string().trim().min(1).max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must be display-safe text");

export const sessionTurnUsageSchema = z.object({
  turnId: z.string().min(1).max(256).nullable(),
  inputTokens: safeCount.nullable(),
  outputTokens: safeCount.nullable(),
  cachedInputTokens: safeCount.nullable(),
  reasoningTokens: safeCount.nullable(),
  totalTokens: safeCount.nullable(),
  costUsd: safeFinite.nullable(),
}).strict();

const accountUsageSummarySchema = z.object({
  lifetimeTokens: safeCount.nullable(),
  peakDailyTokens: safeCount.nullable(),
  longestRunningTurnSec: safeCount.nullable(),
  currentStreakDays: safeCount.nullable(),
  longestStreakDays: safeCount.nullable(),
}).strict();

const accountUsageDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  tokens: safeCount,
}).strict();

export const accountUsageFactsSchema = z.object({
  summary: accountUsageSummarySchema,
  recentDays: z.array(accountUsageDaySchema).max(31),
}).strict();

export const rateLimitWindowFactsSchema = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: safeCount.nullable(),
  resetsAt: safeCount.nullable(),
}).strict();

export const ACCOUNT_PLAN_TYPES = [
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
] as const;

export const accountRateLimitFactsSchema = z.object({
  label: shortText.nullable(),
  planType: z.enum(ACCOUNT_PLAN_TYPES).nullable(),
  primary: rateLimitWindowFactsSchema.nullable(),
  secondary: rateLimitWindowFactsSchema.nullable(),
  spendControlReached: z.boolean().nullable(),
}).strict();

export const availableSessionAccountFactsSchema = z.object({
  available: z.literal(true),
  source: z.literal("provider-api"),
  /** Null means this pinned provider method is unsupported, not zero usage. */
  usage: accountUsageFactsSchema.nullable(),
  /** Null means this pinned provider method is unsupported, not no limits. */
  rateLimits: z.array(accountRateLimitFactsSchema).max(16).nullable(),
}).strict();

export const unavailableSessionAccountFactsSchema = z.object({
  available: z.literal(false),
  reason: z.enum([
    "remote-session",
    "not-manager-owned",
    "unsupported-provider",
    "provider-unavailable",
  ]),
}).strict();

export const sessionAccountFactsSchema = z.discriminatedUnion("available", [
  availableSessionAccountFactsSchema,
  unavailableSessionAccountFactsSchema,
]);

export const selectedSessionFactsQuerySchema = z.object({
  generation: z.coerce.number().int().nonnegative(),
}).strict();

export const selectedSessionFactsResponseSchema = z.object({
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  turnUsage: sessionTurnUsageSchema.nullable(),
  account: sessionAccountFactsSchema,
}).strict();

export type SessionTurnUsage = z.infer<typeof sessionTurnUsageSchema>;
export type AccountUsageFacts = z.infer<typeof accountUsageFactsSchema>;
export type AccountRateLimitFacts = z.infer<typeof accountRateLimitFactsSchema>;
export type AvailableSessionAccountFacts = z.infer<typeof availableSessionAccountFactsSchema>;
export type SessionAccountFacts = z.infer<typeof sessionAccountFactsSchema>;
export type SelectedSessionFactsResponse = z.infer<typeof selectedSessionFactsResponseSchema>;
