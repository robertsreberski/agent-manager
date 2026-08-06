import { z } from "zod";

import { workspaceRecordSchema } from "./workspace.ts";

export const setupHarnessAvailabilitySchema = z.object({
  state: z.enum(["present", "missing", "unavailable"]),
  reason: z.string().max(240).nullable(),
}).strict();

export const setupHarnessProbeSchema = z.object({
  codex: setupHarnessAvailabilitySchema,
  claude: setupHarnessAvailabilitySchema,
}).strict();

export const setupNearbyWorkspaceSchema = workspaceRecordSchema.extend({
  source: z.enum(["configured", "discovered"]),
  repoRoot: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  linked: z.boolean().nullable(),
}).strict();

export const setupHookStateSchema = z.enum([
  "absent",
  "installed-unseen",
  "active",
  "stale-token-schema",
  "awaiting-trust",
  "untrusted",
  "provider-disabled",
]);

export const setupHookOfferSchema = z.object({
  provider: z.literal("claude"),
  state: setupHookStateSchema,
  settingsPath: z.string().min(1),
  command: z.string().min(1),
  changed: z.boolean(),
  diff: z.string().max(256 * 1_024),
  notice: z.string().max(1_024).nullable(),
  previewId: z.string().uuid().nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine((offer, context) => {
  const hasPreview = offer.previewId !== null && offer.expiresAt !== null;
  if (offer.changed !== hasPreview) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["previewId"],
      message: offer.changed
        ? "changed hook offers require a preview ID and expiry"
        : "unchanged hook offers cannot expose a preview ID or expiry",
    });
  }
});

export const setupHookApplyRequestSchema = z.object({
  provider: z.literal("claude"),
  previewId: z.string().uuid(),
  confirmed: z.literal(true),
}).strict();

export const setupHookApplyResponseSchema = z.object({
  provider: z.literal("claude"),
  outcome: z.enum(["applied", "already-applied"]),
  hook: setupHookOfferSchema,
}).strict();

export const setupHostProbeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["local", "ssh"]),
  status: z.enum(["online", "offline", "connecting", "unknown"]),
  statusMessage: z.string().max(240).nullable(),
  harnesses: setupHarnessProbeSchema,
}).strict();

export const setupReadModelSchema = z.object({
  nearby: z.array(setupNearbyWorkspaceSchema).max(32),
  /*
    Claude only. The Codex command-hook plane is retired: its shim could never
    gate anything, and the App Server already reports exact events for managed
    threads, so there is nothing left for an operator to install.
  */
  hooks: z.object({
    claude: setupHookOfferSchema,
  }).strict(),
  hosts: z.array(setupHostProbeSchema).max(32),
}).strict();

export const setupHarnessProbeResponseSchema = z.object({
  harnesses: setupHarnessProbeSchema,
}).strict();

export type SetupHarnessAvailability = z.infer<typeof setupHarnessAvailabilitySchema>;
export type SetupHarnessProbe = z.infer<typeof setupHarnessProbeSchema>;
export type SetupNearbyWorkspace = z.infer<typeof setupNearbyWorkspaceSchema>;
export type SetupHookOffer = z.infer<typeof setupHookOfferSchema>;
export type SetupHookApplyRequest = z.infer<typeof setupHookApplyRequestSchema>;
export type SetupHookApplyResponse = z.infer<typeof setupHookApplyResponseSchema>;
export type SetupHostProbe = z.infer<typeof setupHostProbeSchema>;
export type SetupReadModel = z.infer<typeof setupReadModelSchema>;
