import { describe, expect, it } from "vitest";
import type { SessionView } from "../types";
import { hostFilterFromSearch, reconcileSelectedSessionId, searchWithHostFilter, searchWithSelectedSession, searchWithSessionScope, sessionMatchesScope, sessionScopeFromSearch } from "./session-navigation";

const base = { attention: [], status: "idle" } as unknown as SessionView;

describe("board navigation", () => {
  it("round-trips active scopes and the separate archived scope", () => {
    expect(sessionScopeFromSearch("?scope=wants-you")).toBe("wants-you");
    expect(sessionScopeFromSearch("?scope=managed")).toBe("all");
    expect(searchWithSessionScope("?session=x", "working")).toBe("?session=x&scope=working");
    expect(searchWithSessionScope("?session=x", "archived")).toBe("?session=x&scope=archived");
  });
  it("keeps opaque session ids and sorted host filters", () => {
    expect(searchWithSelectedSession("", "studio:codex:a/b")).toBe("?session=studio%3Acodex%3Aa%2Fb");
    const search = searchWithHostFilter("?session=x&host=old", new Set(["z", "a"]));
    expect([...hostFilterFromSearch(search)]).toEqual(["a", "z"]);
  });
  it("does not auto-open a session after the first snapshot", () => {
    const session = { ...base, id: "local:codex:one" } as SessionView;
    expect(reconcileSelectedSessionId({ sessions: [session], selectedId: null, hasSuccessfulSnapshot: true })).toBeNull();
    expect(reconcileSelectedSessionId({ sessions: [session], selectedId: "missing", hasSuccessfulSnapshot: true })).toBeNull();
    expect(reconcileSelectedSessionId({ sessions: [], selectedId: "deep", hasSuccessfulSnapshot: false })).toBe("deep");
  });
  it("groups failed sessions into the idle operator scope", () => {
    expect(sessionMatchesScope({ ...base, status: "failed" } as SessionView, "idle")).toBe(true);
    expect(sessionMatchesScope({ ...base, attention: [{}] } as SessionView, "idle")).toBe(false);
  });
  it("keeps archived records out of every active scope", () => {
    const archived = { ...base, archived: true } as SessionView;
    expect(sessionMatchesScope(archived, "all")).toBe(false);
    expect(sessionMatchesScope(archived, "idle")).toBe(false);
    expect(sessionMatchesScope(archived, "archived")).toBe(true);
  });
});
