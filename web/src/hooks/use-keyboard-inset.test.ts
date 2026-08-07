import { describe, expect, it } from "vitest";

import { isKeyboardEditor, keyboardInset } from "./use-keyboard-inset";

/*
  iOS does not resize the layout viewport for the keyboard — it paints over the
  page — so `100dvh`, `fixed inset-0` and the drawer's flex column all keep
  their full height and the composer sits behind the keys. `visualViewport` is
  the only thing that reports the covered strip.
*/

describe("keyboard inset", () => {
  it("reports nothing where the API is absent", () => {
    expect(keyboardInset(null, 844)).toBe(0);
  });

  it("reports the strip a keyboard covers", () => {
    // iPhone 14: 844pt tall, ~336pt of keyboard.
    expect(keyboardInset({ height: 508, offsetTop: 0 } as VisualViewport, 844)).toBe(336);
  });

  it("counts the offset when iOS scrolls the visual viewport instead of resizing it", () => {
    expect(keyboardInset({ height: 508, offsetTop: 40 } as VisualViewport, 844)).toBe(296);
  });

  it("ignores a pinch zoom, which shrinks the same viewport", () => {
    // A zoom that hides 60px is not a keyboard, and treating it as one would
    // shove the composer up the screen while the operator is reading.
    expect(keyboardInset({ height: 784, offsetTop: 0 } as VisualViewport, 844)).toBe(0);
    expect(keyboardInset({ height: 500, offsetTop: 0, scale: 1.5 } as VisualViewport, 844)).toBe(0);
  });

  it("never reports a negative strip when the visual viewport is the taller one", () => {
    expect(keyboardInset({ height: 900, offsetTop: 0 } as VisualViewport, 844)).toBe(0);
  });
});

describe("keyboard editor focus", () => {
  it("accepts typing fields and rejects controls that cannot summon the keyboard", () => {
    const textarea = document.createElement("textarea");
    const text = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const select = document.createElement("select");

    expect(isKeyboardEditor(textarea)).toBe(true);
    expect(isKeyboardEditor(text)).toBe(true);
    expect(isKeyboardEditor(checkbox)).toBe(false);
    expect(isKeyboardEditor(select)).toBe(false);
    expect(isKeyboardEditor(null)).toBe(false);
  });
});
