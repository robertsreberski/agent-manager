import type { CockpitConfidence } from "../../lib/cockpit-view";
import type { RequestResponse } from "@shared/actions";

export interface RequestOption {
  id: string;
  label: string;
  description: string | null;
  recommended: boolean;
}

export interface RequestQuestion {
  id: string;
  header: string | null;
  prompt: string;
  options: readonly RequestOption[];
  multiple: boolean;
  allowFreeText: boolean;
  secret: boolean;
}

export interface ExactQuestionRequest {
  id: string | null;
  label: string;
  state: "waiting" | "resolved" | "pending";
  source: "provider-api" | "transcript" | "metadata";
  confidence: CockpitConfidence;
  exposure: "provider-exposed" | "transcript-derived";
  truncated: boolean;
  respondable: boolean;
  questions: readonly RequestQuestion[];
}

export type AtomicQuestionResponse = Extract<RequestResponse, { kind: "answers" }>;

export function isExactRespondableRequest(request: ExactQuestionRequest): request is ExactQuestionRequest & { id: string } {
  return request.id !== null
    && request.state === "waiting"
    && request.source === "provider-api"
    && request.confidence === "exact"
    && request.exposure === "provider-exposed"
    && !request.truncated
    && request.respondable;
}

export interface ApprovalRequestView {
  id: string;
  label: string;
  command: string | null;
  reason: string | null;
  workspaceRoot: string | null;
  /** Absolute normalized paths explicitly supplied by the provider. null means unknown. */
  paths: readonly string[] | null;
  writes: readonly string[];
  network: boolean | null;
  deleteCount: number | null;
  remoteHost: string | null;
  sessionsOnHost: number | null;
  canPersist: boolean;
}

export type ApprovalTier = "workspace" | "outside" | "remote";

function isInside(root: string, path: string): boolean {
  const normalizedRoot = root.replace(/\/+$/u, "");
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/** Unknown or ambiguous paths deliberately choose the click-only tier. */
export function approvalTier(request: ApprovalRequestView): ApprovalTier {
  if (request.remoteHost) return "remote";
  if (!request.workspaceRoot || !request.paths || request.paths.length === 0) return "outside";
  return request.paths.every((path) => path.startsWith("/") && isInside(request.workspaceRoot!, path))
    ? "workspace"
    : "outside";
}
