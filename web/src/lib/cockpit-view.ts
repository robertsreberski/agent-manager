import type {
  ControlCapability,
  EvidenceConfidence,
  ExecutionProfile as SharedExecutionProfile,
  Provider,
  ReasoningEffort,
  SessionControl,
  SessionRecord,
  WorkspaceIdentity,
} from "@shared/session";

export type CockpitProvider = Provider;
export type ExecutionProfile = SharedExecutionProfile;
export type CockpitConfidence = EvidenceConfidence;
export type WorkspaceIdentityView = WorkspaceIdentity;

export interface AttentionView {
  requestId: string | null;
  kind: "question" | "approval" | "permission" | "elicitation" | "blocked";
  label: string;
  summary: string | null;
  confidence: CockpitConfidence;
  respondable: boolean;
}

export type SessionCapability = ControlCapability;
export type WithheldCapabilityView = SessionControl["withheld"][number];
export type SessionControlView = SessionControl;

export interface TodoProgressView {
  completed: number;
  total: number;
  current: string | null;
}

/**
 * Small presentation contract for the replacement web shell. The wire-model
 * adapter owns conversion; components never infer provider capabilities or
 * workspace facts from provider strings.
 */
export interface CockpitSessionView {
  id: SessionRecord["id"];
  provider: SessionRecord["provider"];
  name: string;
  hostId: string;
  hostLabel: string;
  remote: boolean;
  cwd: string | null;
  workspaceIdentity: WorkspaceIdentityView | null;
  activity: SessionRecord["status"];
  attention: readonly AttentionView[];
  updatedAt: string | null;
  control: SessionControlView;
  profile: ExecutionProfile | null;
  model: string | null;
  effort: ReasoningEffort | null;
  todo: TodoProgressView | null;
}

export function toCockpitSessionView(
  record: SessionRecord,
  extras: { remote: boolean; todo?: TodoProgressView | null; attentionLabels?: ReadonlyMap<string, string> },
): CockpitSessionView {
  return {
    id: record.id,
    provider: record.provider,
    name: record.name ?? record.providerThreadId,
    hostId: record.hostId,
    hostLabel: record.hostLabel,
    remote: extras.remote,
    cwd: record.cwd,
    workspaceIdentity: record.workspaceIdentity,
    activity: record.status,
    attention: record.attention.map((attention) => ({
      requestId: attention.id,
      kind: attention.kind === "sandbox" ? "approval" : attention.kind,
      label: attention.id ? extras.attentionLabels?.get(attention.id) ?? attention.details?.toolName ?? attention.details?.title ?? attention.kind : attention.details?.toolName ?? attention.details?.title ?? attention.kind,
      summary: attention.id ? extras.attentionLabels?.get(attention.id) ?? attention.summary : attention.summary,
      confidence: attention.confidence,
      respondable: attention.details?.respondable ?? false,
    })),
    updatedAt: record.updatedAt,
    control: record.control,
    profile: record.profile.value,
    model: record.model.value,
    effort: record.effort.value,
    todo: record.todoProgress ? {
      completed: record.todoProgress.completed,
      total: record.todoProgress.total,
      current: extras.todo?.current ?? null,
    } : null,
  };
}

export interface WorkspaceChangeFacts {
  /** Files in a non-clean state, including untracked ones. */
  files: number;
  /** Lines across *tracked* changes. Null where git could not say. */
  insertions: number | null;
  deletions: number | null;
}

/**
 * What "uncommitted" actually amounts to.
 *
 * The board used to say "25 uncommitted" and stop there, which answered none of
 * the questions an operator asks next: 25 of what, and how much? It was files,
 * and a rename counted the same as a rewrite.
 *
 * The two measurements cover different sets — `dirtyCount` includes untracked
 * files, the line counts come from `git diff` and so cover tracked changes only
 * — so they are reported side by side rather than folded into one total that
 * would be true of neither.
 */
export function workspaceChangeFacts(
  identity: CockpitSessionView["workspaceIdentity"],
): WorkspaceChangeFacts | null {
  if (!identity || identity.dirtyCount === null || identity.dirtyCount === 0) return null;
  return {
    files: identity.dirtyCount,
    insertions: identity.insertions,
    deletions: identity.deletions,
  };
}

/** `12 files · +312 −87`, dropping any half git did not supply. */
export function workspaceChangeLabel(facts: WorkspaceChangeFacts): string {
  const lines = facts.insertions === null && facts.deletions === null
    ? null
    : `+${facts.insertions ?? 0} −${facts.deletions ?? 0}`;
  const files = `${facts.files} ${facts.files === 1 ? "file" : "files"}`;
  return lines ? `${files} · ${lines}` : files;
}

export function can(session: Pick<CockpitSessionView, "control">, capability: SessionCapability): boolean {
  return session.control.capabilities.includes(capability);
}

export function withheldReason(
  session: Pick<CockpitSessionView, "control">,
  capability: SessionCapability,
): string | null {
  return session.control.withheld.find((item) => item.capability === capability)?.reason ?? null;
}
