import type { ExecutionProfile } from "../../shared/session.ts";
import type { ClaudePermissionMode } from "./types.ts";

export function profileForClaudePermissionMode(mode: ClaudePermissionMode): ExecutionProfile;
export function profileForClaudePermissionMode(mode: unknown): ExecutionProfile | null;
export function profileForClaudePermissionMode(mode: unknown): ExecutionProfile | null {
  switch (mode) {
    case "plan": return "plan";
    case "acceptEdits": return "execute";
    case "bypassPermissions": return "full-access";
    case "default":
    case "dontAsk":
    case "auto":
      return "ask-first";
    default:
      return null;
  }
}
