import { z } from "zod";

import { workspaceIdentitySchema } from "./wire.ts";

/**
 * A worktree name is both a directory under `.worktrees/` and a branch name, so
 * it is deliberately narrower than either allows. The leading character must be
 * alphanumeric, which also forecloses a name being read as a git option.
 */
export const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function validWorktreeName(name: string): boolean {
  if (!WORKTREE_NAME_PATTERN.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.endsWith(".lock")) return false;
  return true;
}

export const WORKTREE_NAME_RULE =
  "Use letters, numbers, dots, dashes or underscores, starting with a letter or number.";

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
  /** Null until a session has been created here; drives recency ordering. */
  lastOpenedAt: z.iso.datetime({ offset: true }).nullable(),
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

export const repoWorktreeSchema = z.object({
  path: z.string().min(1),
  branch: z.string().nullable(),
  isMain: z.boolean(),
  locked: z.boolean(),
}).strict();

/**
 * What the draft screen knows about a candidate folder.
 *
 * A directory that is not a repository and a host that cannot answer are
 * different facts, so they are different states rather than an empty repo.
 * `defaultBranch` is null when the repository has nothing to branch from,
 * which is what makes a new worktree impossible rather than merely unnamed.
 */
export const workspaceGitContextSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("repo"),
    repoRoot: z.string().min(1),
    repoName: z.string().min(1),
    defaultBranch: z.string().min(1).nullable(),
    worktrees: z.array(repoWorktreeSchema).max(100),
  }).strict(),
  z.object({ status: z.literal("not-a-repo") }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
]);

export const gitContextResponseSchema = z.object({
  hostId: z.string().min(1),
  path: z.string().min(1),
  context: workspaceGitContextSchema,
}).strict();

export const worktreeCreationResponseSchema = z.object({
  workspace: resolvedWorkspaceSchema,
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
}).strict();

export type WireWorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export type ResolvedWorkspaceRecord = z.infer<typeof resolvedWorkspaceSchema>;
export type WorkspaceResolutionResponse = z.infer<typeof workspaceResolutionResponseSchema>;
export type WireRepoWorktree = z.infer<typeof repoWorktreeSchema>;
export type WorkspaceGitContext = z.infer<typeof workspaceGitContextSchema>;
export type GitContextResponse = z.infer<typeof gitContextResponseSchema>;
export type WorktreeCreationResponse = z.infer<typeof worktreeCreationResponseSchema>;
