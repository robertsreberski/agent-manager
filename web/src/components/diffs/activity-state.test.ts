import { describe, expect, it } from "vitest";
import { activityToThreadMessages } from "../session-activity";
import { ACTIVITY_SCHEMA_VERSION, type ActivityItem } from "../../types";
import { fileChangeIsUpserting } from "./activity-state";

describe("fileChangeIsUpserting", () => {
  it("uses the exact turn lifecycle to finalize a still-running file item", () => {
    const item = { turnId: "turn-1", state: "running" as const };
    expect(fileChangeIsUpserting(item, [
      { kind: "file-change", turnId: "turn-1" },
      { kind: "lifecycle", turnId: "turn-2", event: "turn-completed" },
    ])).toBe(true);
    expect(fileChangeIsUpserting(item, [
      { kind: "file-change", turnId: "turn-1" },
      { kind: "lifecycle", turnId: "turn-1", event: "turn-completed" },
    ])).toBe(false);
  });

  it("does not invent a group for an unassociated item", () => {
    expect(fileChangeIsUpserting({ turnId: null, state: "waiting" }, [
      { kind: "lifecycle", turnId: null, event: "turn-completed" },
    ])).toBe(true);
    expect(fileChangeIsUpserting({ turnId: null, state: "complete" }, [])).toBe(false);
  });

  it("carries the exact group completion signal into the rendered diff data", () => {
    const common = {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      sessionId: "local:codex:thread",
      provider: "codex" as const,
      turnId: "turn-1",
      parentId: null,
      revision: 1,
      startedAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:01.000Z",
      source: "provider-api" as const,
      confidence: "exact" as const,
      exposure: "provider-exposed" as const,
      truncated: false,
    };
    const file = {
      ...common,
      id: "diff",
      seq: 1,
      state: "running" as const,
      completedAt: null,
      kind: "file-change" as const,
      summary: "Turn diff",
      changes: [{ path: "file.txt", previousPath: null, operation: "update" as const, diff: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n" }],
    };
    const upserting = (items: ActivityItem[]) => {
      const parts = activityToThreadMessages(items)
        .flatMap((message) => typeof message.content === "string" ? [] : message.content);
      const part = parts.find((candidate) => candidate.type === "data" && candidate.name === "agent-manager.file-change");
      return part?.type === "data" ? (part.data as { upserting?: unknown }).upserting : undefined;
    };

    expect(upserting([file])).toBe(true);
    expect(upserting([file, {
      ...common,
      id: "done",
      seq: 2,
      state: "complete",
      completedAt: "2026-08-04T10:00:01.000Z",
      kind: "lifecycle",
      event: "turn-completed",
      level: "info",
      title: "Turn completed",
      details: null,
    }])).toBe(false);
  });
});
