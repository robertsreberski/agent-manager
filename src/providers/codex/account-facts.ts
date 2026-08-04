import { z } from "zod";

import {
  ACCOUNT_PLAN_TYPES,
  availableSessionAccountFactsSchema,
  type AccountRateLimitFacts,
  type AccountUsageFacts,
  type AvailableSessionAccountFacts,
} from "../../shared/session-facts.ts";

const int64 = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const percent = z.number().int().min(0).max(100);
const shortNullable = z.string().min(1).max(128).nullable();

const rawUsageSummarySchema = z.object({
  lifetimeTokens: int64.nullable(),
  peakDailyTokens: int64.nullable(),
  longestRunningTurnSec: int64.nullable(),
  currentStreakDays: int64.nullable(),
  longestStreakDays: int64.nullable(),
}).strict();

const rawUsageDaySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  tokens: int64,
}).strict();

const rawUsageResponseSchema = z.object({
  summary: rawUsageSummarySchema,
  dailyUsageBuckets: z.array(rawUsageDaySchema).max(366).nullable(),
}).strict();

const rawWindowSchema = z.object({
  usedPercent: percent,
  windowDurationMins: int64.nullable(),
  resetsAt: int64.nullable(),
}).strict();

const rawCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().max(128).nullable(),
}).strict();

const rawSpendControlSchema = z.object({
  limit: z.string().min(1).max(128),
  used: z.string().min(1).max(128),
  remainingPercent: percent,
  resetsAt: int64,
}).strict();

const reachedTypeSchema = z.enum([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

const rawRateLimitSchema = z.object({
  limitId: shortNullable,
  limitName: shortNullable,
  primary: rawWindowSchema.nullable(),
  secondary: rawWindowSchema.nullable(),
  credits: rawCreditsSchema.nullable(),
  individualLimit: rawSpendControlSchema.nullable(),
  spendControlReached: z.boolean().nullable(),
  planType: z.enum(ACCOUNT_PLAN_TYPES).nullable(),
  rateLimitReachedType: reachedTypeSchema.nullable(),
}).strict();

const rawRateLimitMapSchema = z.record(
  z.string().min(1).max(128),
  rawRateLimitSchema,
).superRefine((value, context) => {
  if (Object.keys(value).length > 16) {
    context.addIssue({ code: "custom", message: "too many rate-limit buckets" });
  }
});

const rawResetCreditSchema = z.object({
  id: z.string().min(1).max(256),
  resetType: z.enum(["codexRateLimits", "unknown"]),
  status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
  grantedAt: int64,
  expiresAt: int64.nullable(),
  title: z.string().max(256).nullable(),
  description: z.string().max(1_000).nullable(),
}).strict();

const rawResetCreditsSchema = z.object({
  availableCount: int64,
  credits: z.array(rawResetCreditSchema).max(32).nullable(),
}).strict();

const rawRateLimitsResponseSchema = z.object({
  rateLimits: rawRateLimitSchema,
  rateLimitsByLimitId: rawRateLimitMapSchema.nullable(),
  rateLimitResetCredits: rawResetCreditsSchema.nullable(),
}).strict();

export function parseCodexAccountUsage(value: unknown): AccountUsageFacts {
  const raw = rawUsageResponseSchema.parse(value);
  return {
    summary: { ...raw.summary },
    recentDays: [...(raw.dailyUsageBuckets ?? [])]
      .sort((left, right) => left.startDate.localeCompare(right.startDate))
      .slice(-14)
      .map((day) => ({ date: day.startDate, tokens: day.tokens })),
  };
}

function projectLimit(
  key: string | null,
  raw: z.infer<typeof rawRateLimitSchema>,
): AccountRateLimitFacts {
  return {
    label: raw.limitName ?? raw.limitId ?? key,
    planType: raw.planType,
    primary: raw.primary ? { ...raw.primary } : null,
    secondary: raw.secondary ? { ...raw.secondary } : null,
    spendControlReached: raw.spendControlReached,
  };
}

export function parseCodexAccountRateLimits(value: unknown): AccountRateLimitFacts[] {
  const raw = rawRateLimitsResponseSchema.parse(value);
  const buckets = raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length > 0
    ? Object.entries(raw.rateLimitsByLimitId)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, limit]) => projectLimit(key, limit))
    : [projectLimit(null, raw.rateLimits)];
  return buckets;
}

export function codexAccountFacts(input: {
  usage: AccountUsageFacts | null;
  rateLimits: AccountRateLimitFacts[] | null;
}): AvailableSessionAccountFacts {
  return availableSessionAccountFactsSchema.parse({
    available: true,
    source: "provider-api",
    usage: input.usage,
    rateLimits: input.rateLimits,
  });
}
