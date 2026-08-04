import { describe, expect, it } from "vitest";
import { canAttemptDraftCreation, draftIdempotencyKey, draftReducer, newDraftSession } from "./draft";

describe("draft session", () => {
  it("uses one stable first-send key and permits one creation attempt", () => {
    let draft = newDraftSession({ key: "abc", workspace: { hostId: "local", path: "/work/app" } });
    draft = draftReducer(draft, { type: "set-text", text: "Build it" });
    expect(canAttemptDraftCreation(draft)).toBe(true);
    expect(draftIdempotencyKey(draft)).toBe("draft:abc:first-send");
    expect(canAttemptDraftCreation(draftReducer(draft, { type: "creating" }))).toBe(false);
  });

  it("never silently retries an unknown outcome", () => {
    const failed = draftReducer(newDraftSession(), { type: "create-failed", message: "Outcome unknown", outcomeUnknown: true });
    expect(draftReducer(failed, { type: "retry" })).toBe(failed);
  });

  it("keeps effort choices honest when switching harnesses", () => {
    const codex = newDraftSession({ provider: "codex", effort: "ultra" });
    expect(codex.effort).toBe("ultra");
    const claude = draftReducer(codex, { type: "set-provider", provider: "claude", model: null });
    expect(claude.effort).toBe("medium");
    expect(newDraftSession({ provider: "claude", effort: "minimal" }).effort).toBe("medium");
    expect(newDraftSession({ provider: "claude", effort: "ultra" }).effort).toBe("medium");
  });

  it("resets every public draft setting to the configured create defaults", () => {
    const changed = newDraftSession({ provider: "claude", model: "opus", effort: "high", profile: "full-access" });
    expect(draftReducer(changed, { type: "reset-settings" })).toMatchObject({
      provider: "codex",
      model: null,
      effort: null,
      profile: "plan",
    });
  });
});
