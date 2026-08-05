import { describe, expect, it } from "vitest";

import {
  applyCompletion,
  completionTrigger,
  composerPlaceholder,
  matchCommands,
  providerCommands,
} from "./mentions";

/*
  Frame 5a's placeholder reads "@mention files, run /commands". It shipped as
  "Message the agent…" because neither affordance existed, and a placeholder
  that advertises a control nobody built costs the operator a turn finding out.
*/

describe("what the caret is inside", () => {
  it("opens the file picker on an @ that begins a word", () => {
    expect(completionTrigger("look at @src/app", 16))
      .toEqual({ kind: "file", start: 8, query: "src/app" });
  });

  it("leaves an address or a mid-word @ alone", () => {
    expect(completionTrigger("mail me@example.com", 19)).toBeNull();
  });

  it("closes once the operator types past the query", () => {
    // Whatever follows a space is prose, not a filename.
    expect(completionTrigger("@src/app and then", 17)).toBeNull();
  });

  it("opens the command list only at the start of a message", () => {
    expect(completionTrigger("/rev", 4)).toEqual({ kind: "command", start: 0, query: "rev" });
    expect(completionTrigger("check /usr/bin", 14)).toBeNull();
  });

  it("reads the query at the caret, not at the end of the line", () => {
    expect(completionTrigger("@src rest of the message", 4))
      .toEqual({ kind: "file", start: 0, query: "src" });
  });
});

describe("taking a completion", () => {
  it("replaces the sigil and its query, and leaves the caret ready to type", () => {
    const trigger = completionTrigger("look at @src/ap", 15)!;
    expect(applyCompletion("look at @src/ap", 15, trigger, "src/app.tsx"))
      .toEqual({ value: "look at @src/app.tsx ", caret: 21 });
  });

  it("keeps whatever the operator had typed after the caret", () => {
    const trigger = completionTrigger("@src and explain", 4)!;
    expect(applyCompletion("@src and explain", 4, trigger, "src/app.tsx").value)
      .toBe("@src/app.tsx  and explain");
  });
});

describe("provider commands", () => {
  it("offers only commands the provider's own CLI accepts", () => {
    expect(matchCommands("claude", "rev").map((command) => command.name)).toEqual(["review"]);
    // Codex has no /cost; offering one would send text the harness ignores.
    expect(matchCommands("codex", "cost")).toEqual([]);
  });

  it("offers none for a provider whose command set is unknown", () => {
    expect(providerCommands("some-other-harness")).toEqual([]);
  });
});

describe("the placeholder", () => {
  it("promises both affordances only where both exist", () => {
    expect(composerPlaceholder("claude", true)).toBe("@mention files, run /commands…");
  });

  it("drops the half this session cannot do", () => {
    // A remote workspace is not readable from here, so there is nothing to
    // @mention — and saying otherwise is what the deviation was recorded for.
    expect(composerPlaceholder("claude", false)).toBe("run /commands…");
    expect(composerPlaceholder("some-other-harness", true)).toBe("@mention files…");
    expect(composerPlaceholder("some-other-harness", false)).toBe("Message the agent…");
  });
});
