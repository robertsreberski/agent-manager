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
  provider: z.enum(["claude", "codex"]),
  state: setupHookStateSchema,
  settingsPath: z.string().min(1),
  command: z.string().min(1),
  changed: z.boolean(),
  diff: z.string().max(256 * 1_024),
  notice: z.string().max(1_024).nullable(),
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
  hooks: z.object({
    claude: setupHookOfferSchema,
    codex: setupHookOfferSchema,
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
export type SetupHostProbe = z.infer<typeof setupHostProbeSchema>;
export type SetupReadModel = z.infer<typeof setupReadModelSchema>;
