import { z } from "zod";

import { workspaceIdentitySchema } from "./wire.ts";

/** Exact persisted workspace row exposed by the workspace list API. */
export const workspaceRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  path: z.string().min(1),
  hostId: z.string().min(1),
  hostLabel: z.string().min(1),
  hostKind: z.enum(["local", "ssh"]),
  remoteWorkspaceId: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

/**
 * Resolution returns current Git/worktree identity in addition to the durable
 * row. The field is required even when the selected directory is not a repo.
 */
export const resolvedWorkspaceSchema = workspaceRecordSchema.extend({
  workspaceIdentity: workspaceIdentitySchema.nullable(),
}).strict();

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceRecordSchema),
}).strict();

export const workspaceResolutionResponseSchema = z.object({
  workspace: resolvedWorkspaceSchema,
}).strict();

export type WireWorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export type ResolvedWorkspaceRecord = z.infer<typeof resolvedWorkspaceSchema>;
export type WorkspaceResolutionResponse = z.infer<typeof workspaceResolutionResponseSchema>;
