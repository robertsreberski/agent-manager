import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { normalizeSession } from "../lib/normalize";
import type { SessionView } from "../types";
import { SessionThread } from "./session-thread";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver,
});

function renderThread(session: SessionView) {
  render(
    <SessionThread
      session={session}
      lease={null}
      busy={false}
      onAcquire={vi.fn()}
      onRelease={vi.fn()}
      onSend={vi.fn()}
      onRespond={vi.fn()}
      onInterrupt={vi.fn()}
      onSetMode={vi.fn()}
      loadPreview={vi.fn()}
      loadAttach={vi.fn()}
    />,
  );
}

function rawSession(overrides: Record<string, unknown> = {}) {
  return normalizeSession({
    id: "codex:thread",
    provider: "codex",
    ownership: "manager",
    status: "idle",
    control: { capabilities: [] },
    ...overrides,
  });
}

describe("SessionThread transcript states", () => {
  it("shows a transcript loading state before selected detail arrives", () => {
    renderThread(rawSession());

    expect(screen.getByText("Loading transcript…")).toBeInTheDocument();
  });

  it("shows why a transcript is unavailable", () => {
    renderThread(rawSession({
      transcript: {
        state: "unavailable",
        source: "codex-rollout",
        reason: "unreadable",
      },
    }));

    expect(screen.getByText("Transcript unavailable")).toBeInTheDocument();
    expect(screen.getByText(/could not be read safely/u)).toBeInTheDocument();
  });

  it("distinguishes an available empty transcript from loading", () => {
    renderThread(rawSession({
      messages: [],
      transcript: {
        state: "available",
        source: "provider-api",
        messageCount: 0,
      },
    }));

    expect(screen.getByText("No transcript messages yet")).toBeInTheDocument();
    expect(screen.queryByText("Loading transcript…")).not.toBeInTheDocument();
  });

  it("shows truncation metadata and wraps long message text", () => {
    const longUrl = `https://example.com/${"long-path-segment/".repeat(20)}`;
    renderThread(rawSession({
      messages: [{ id: "answer", role: "assistant", text: longUrl }],
      transcript: {
        state: "available",
        source: "codex-rollout",
        truncated: true,
        messageCount: 12,
      },
    }));

    expect(screen.getByText("Earlier transcript content is omitted. Showing the latest 12 messages.")).toBeInTheDocument();
    expect(screen.getByText(longUrl)).toBeInTheDocument();
    expect(screen.getByText(longUrl).closest("[class*='overflow-wrap']")).not.toBeNull();
  });
});
