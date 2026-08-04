import type { ExecutionProfile, SessionCapability } from "../../lib/cockpit-view";

export interface OutboxSessionState {
  id: string;
  providerTurnId: string | null;
  profile: ExecutionProfile | null;
  status: "running" | "waiting" | "idle" | "completed" | "failed" | "interrupted" | "unknown";
  exactRequestIds: readonly string[];
  capabilities: readonly SessionCapability[];
  generation: number;
}

export interface OfflineMessage {
  id: string;
  sessionId: string;
  text: string;
  delivery: "queue" | "steer";
  idempotencyKey: string;
  baseline: OutboxSessionState;
  queuedAt: string;
}

export type FlushDecision =
  | { kind: "send"; generation: number }
  | { kind: "review"; reason: string }
  | { kind: "missing"; reason: string };

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function decideOfflineFlush(message: OfflineMessage, current: OutboxSessionState | null): FlushDecision {
  if (!current) return { kind: "missing", reason: "The session is no longer available." };
  if (current.providerTurnId !== message.baseline.providerTurnId) return { kind: "review", reason: "The active turn changed while the cockpit was offline." };
  if (current.profile !== message.baseline.profile) return { kind: "review", reason: "The execution profile changed while the cockpit was offline." };
  if (!sameSet(current.exactRequestIds, message.baseline.exactRequestIds)) return { kind: "review", reason: "A question or approval changed while the cockpit was offline." };
  if (current.status !== message.baseline.status) {
    return {
      kind: "review",
      reason: "The session status changed while the cockpit was offline.",
    };
  }
  if (!current.capabilities.includes(message.delivery)) return { kind: "review", reason: `This session can no longer ${message.delivery} messages.` };
  return { kind: "send", generation: current.generation };
}

export function enqueueOfflineMessage(
  current: readonly OfflineMessage[],
  message: OfflineMessage,
  limit = 20,
): readonly OfflineMessage[] {
  if (current.some((item) => item.idempotencyKey === message.idempotencyKey)) return current;
  return [...current, message].slice(-Math.max(1, limit));
}
