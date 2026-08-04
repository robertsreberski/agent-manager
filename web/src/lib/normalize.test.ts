import { describe, expect, it } from "vitest";
import { normalizeSession, normalizeSnapshot } from "./normalize";

describe("normalizeSession", () => {
  it("adapts the legacy discovery record without inventing semantic controls", () => {
    const session = normalizeSession({
      provider: "claude",
      sessionId: "legacy-1",
      lifecycle: "live",
      status: "waiting",
      waitingReason: "user-input",
      cwd: "/tmp/example",
      statusSource: "provider-cli",
      updatedAt: "2026-08-03T10:00:00.000Z",
    });

    expect(session.id).toBe("legacy-1");
    expect(session.runtimeAlive).toBe(true);
    expect(session.activity).toBe("waiting");
    expect(session.mode.value).toBe("unknown");
    expect(session.attention).toEqual([
      expect.objectContaining({ kind: "question", confidence: "heuristic", id: null }),
    ]);
    expect(session.control.capabilities).toEqual([]);
    expect(session.ownership).toBe("external");
    expect(session.transcript).toEqual({
      state: "not-loaded",
      truncated: false,
      source: null,
      messageCount: 0,
      reason: null,
    });
  });

  it("preserves evidence-aware cockpit state and normalizes dotted capabilities", () => {
    const session = normalizeSession({
      id: "managed-1",
      provider: "codex",
      ownership: "manager",
      runtimeAlive: true,
      activity: "running",
      generation: 7,
      runId: "turn-7",
      mode: {
        value: "planning",
        providerValue: "Plan",
        source: "provider-api",
        confidence: "exact",
      },
      attention: [
        {
          id: "request-1",
          kind: "approval",
          summary: "Allow command?",
          source: "provider-api",
          confidence: "exact",
        },
      ],
      effectiveAccess: {
        permissionMode: "default",
        sandboxMode: "workspace-write",
        fullHostAccess: false,
      },
      control: {
        plane: "codex-app-server",
        managerOwned: true,
        writableLease: false,
        capabilities: ["turn.queue", "turn.steer", "turn.interrupt", "question.respond", "set-mode"],
      },
    });

    expect(session.mode).toEqual(expect.objectContaining({ value: "planning", confidence: "exact" }));
    expect(session.attention[0]).toEqual(expect.objectContaining({ id: "request-1", kind: "approval" }));
    expect(session.control.capabilities).toEqual(["queue", "steer", "interrupt", "respond", "set-mode"]);
    expect(session.generation).toBe(7);
    expect(session.runId).toBe("turn-7");
  });

  it("detects full host access from raw provider permission modes", () => {
    const session = normalizeSession({
      id: "full-access",
      provider: "claude",
      permissionMode: "bypassPermissions",
      sandboxMode: null,
    });
    expect(session.effectiveAccess.fullHostAccess).toBe(true);
  });

  it("preserves exact structured multi-question details", () => {
    const session = normalizeSession({
      id: "questions",
      provider: "claude",
      attention: [{
        id: "request-questions",
        kind: "question",
        summary: "Two decisions are needed",
        source: "provider-api",
        confidence: "exact",
        details: {
          title: "Configure storage",
          questions: [
            {
              id: "database",
              header: "Storage",
              text: "Which database?",
              options: [{ label: "SQLite", description: "Local file" }, { label: "Postgres" }],
              multiSelect: false,
              allowFreeText: true,
            },
            {
              id: "features",
              text: "Which features?",
              options: [{ label: "Backups" }, { label: "Encryption" }],
              multiSelect: true,
              allowFreeText: false,
            },
          ],
        },
      }],
    });

    expect(session.attention[0]).toEqual(expect.objectContaining({
      title: "Configure storage",
      questions: [
        expect.objectContaining({ id: "database", header: "Storage", text: "Which database?", allowFreeText: true }),
        expect.objectContaining({ id: "features", multiSelect: true }),
      ],
    }));
  });

  it("converts transcript content to plain display text without raw html handling", () => {
    const session = normalizeSession({
      id: "with-messages",
      provider: "codex",
      messages: [
        { id: "one", role: "user", content: [{ type: "text", text: "<script>plain text</script>" }] },
        { id: "two", role: "assistant", content: [{ type: "tool-call", toolName: "read_file" }] },
      ],
    });
    expect(session.messages).toEqual([
      expect.objectContaining({ role: "user", text: "<script>plain text</script>" }),
      expect.objectContaining({ role: "assistant", text: "[Tool: read_file]" }),
    ]);
    expect(session.transcript).toEqual(expect.objectContaining({
      state: "available",
      messageCount: 2,
    }));
  });

  it("normalizes selected-session transcript metadata independently from messages", () => {
    const session = normalizeSession({
      id: "detail",
      provider: "codex",
      messages: [{ id: "latest", role: "assistant", text: "Latest answer" }],
      transcript: {
        state: "available",
        truncated: true,
        source: "codex-rollout",
        messageCount: 42,
        reason: null,
      },
    });

    expect(session.messages).toEqual([
      expect.objectContaining({ id: "latest", text: "Latest answer" }),
    ]);
    expect(session.transcript).toEqual({
      state: "available",
      truncated: true,
      source: "codex-rollout",
      messageCount: 42,
      reason: null,
    });
  });

  it("keeps an explicit transcript-unavailable reason", () => {
    const session = normalizeSession({
      id: "unavailable",
      provider: "claude",
      transcript: {
        state: "unavailable",
        source: "claude-transcript",
        reason: "unreadable",
      },
    });

    expect(session.messages).toEqual([]);
    expect(session.transcript).toEqual({
      state: "unavailable",
      truncated: false,
      source: "claude-transcript",
      messageCount: 0,
      reason: "unreadable",
    });
  });
});

describe("normalizeSnapshot", () => {
  it("accepts the v2 envelope and defaults malformed diagnostic providers to system", () => {
    const snapshot = normalizeSnapshot({
      version: 2,
      generatedAt: "2026-08-03T10:00:00.000Z",
      seq: 17,
      sessions: [{ id: "one", provider: "codex" }],
      diagnostics: [{ level: "warning", provider: "unexpected", message: "schema drift" }],
    });
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.seq).toBe(17);
    expect(snapshot.diagnostics).toEqual([
      { provider: "system", level: "warning", message: "schema drift" },
    ]);
    expect(snapshot.stale).toBe(false);
  });
});
