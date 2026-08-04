import { describe, expect, it } from "vitest";
import {
  countSessionScopes,
  navigationSessions,
  searchWithSessionScope,
  sessionScopeFromSearch,
} from "./session-navigation";
import type { SessionView } from "../types";

function session(overrides: Partial<SessionView> & Pick<SessionView, "id">): SessionView {
  return {
    provider: "codex",
    name: overrides.id,
    cwd: `/work/${overrides.id}`,
    parentSessionId: null,
    depth: 0,
    ownership: "external",
    runtimeAlive: true,
    mode: { value: "execution", providerValue: null, source: "test", confidence: "exact" },
    activity: "idle",
    attention: [],
    effectiveAccess: { permissionMode: null, sandboxMode: null, fullHostAccess: false },
    terminal: null,
    control: { plane: "test", capabilities: [], managerOwned: false, writableLease: false },
    generation: 1,
    runId: null,
    updatedAt: "2026-08-04T10:00:00.000Z",
    messages: [],
    queue: [],
    ...overrides,
  };
}

describe("session navigation scopes", () => {
  it("reads validated scope values and preserves unrelated URL parameters", () => {
    expect(sessionScopeFromSearch("?session=codex%3Aone&scope=managed")).toBe("managed");
    expect(sessionScopeFromSearch("?scope=unknown")).toBe("all");
    expect(sessionScopeFromSearch("?scope=attention")).toBe("needs-you");
    expect(searchWithSessionScope("?session=codex%3Aone", "claude")).toBe("?session=codex%3Aone&scope=claude");
    expect(searchWithSessionScope("?session=codex%3Aone&scope=claude", "all")).toBe("?session=codex%3Aone");
  });

  it("counts every independent scope", () => {
    const sessions = [
      session({ id: "codex:managed", ownership: "manager", activity: "running" }),
      session({
        id: "claude:attention",
        provider: "claude",
        attention: [{ id: "ask", kind: "question", summary: null, source: "test", confidence: "exact" }],
      }),
      session({ id: "claude:external", provider: "claude" }),
    ];

    expect(countSessionScopes(sessions)).toEqual({
      "needs-you": 1,
      working: 1,
      all: 3,
      managed: 1,
      external: 2,
      codex: 1,
      claude: 2,
    });
  });
});

describe("navigationSessions", () => {
  it("rebuilds provider-qualified hierarchy while preserving root and sibling priority", () => {
    const rootB = session({ id: "codex:root-b", name: "Root B" });
    const childA = session({ id: "codex:child-a", name: "Child A", parentSessionId: "root-a", depth: 1 });
    const rootA = session({ id: "codex:root-a", name: "Root A" });
    const grandchildA = session({ id: "codex:grandchild-a", name: "Grandchild A", parentSessionId: "child-a", depth: 2 });
    const childB = session({ id: "codex:child-b", name: "Child B", parentSessionId: "root-b", depth: 1 });

    const result = navigationSessions([rootB, childA, rootA, grandchildA, childB], "all", "");

    expect(result.map((item) => item.session.id)).toEqual([
      "codex:root-b",
      "codex:child-b",
      "codex:root-a",
      "codex:child-a",
      "codex:grandchild-a",
    ]);
    expect(result.map((item) => item.depth)).toEqual([0, 1, 0, 1, 2]);
  });

  it("retains the complete ancestor chain for a matching descendant", () => {
    const root = session({ id: "codex:root", name: "Unmatched root" });
    const child = session({ id: "codex:child", name: "Unmatched child", parentSessionId: "root", depth: 1 });
    const grandchild = session({ id: "codex:grandchild", name: "Deploy reports", parentSessionId: "child", depth: 2 });
    const other = session({ id: "codex:other", name: "Other root" });

    const result = navigationSessions([other, grandchild, root, child], "all", "deploy");

    expect(result.map((item) => item.session.id)).toEqual(["codex:root", "codex:child", "codex:grandchild"]);
    expect(result.map((item) => item.ancestorOnly)).toEqual([true, true, false]);
  });

  it("breaks malformed cycles deterministically instead of losing their rows", () => {
    const first = session({ id: "codex:first", parentSessionId: "second", depth: 1 });
    const second = session({ id: "codex:second", parentSessionId: "first", depth: 2 });

    expect(navigationSessions([first, second], "all", "").map((item) => item.session.id)).toEqual([
      "codex:first",
      "codex:second",
    ]);
  });
});
