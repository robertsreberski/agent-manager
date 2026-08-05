import { useEffect, useState } from "react";

/**
 * How much of the layout viewport the on-screen keyboard is covering, in pixels.
 *
 * On iOS the keyboard does not resize the layout viewport: `100dvh`, `fixed
 * inset-0` and the drawer's flex column all keep their full height, and the
 * keyboard is simply painted over the bottom of the page. The composer ends up
 * behind it. Only `visualViewport` reports the covered strip.
 *
 * Returns 0 wherever the API is absent, so callers need no branch of their own.
 */
export function keyboardInset(viewport: VisualViewport | null, layoutHeight: number): number {
  if (!viewport) return 0;
  const covered = layoutHeight - viewport.height - viewport.offsetTop;
  // A pinch-zoom also shrinks the visual viewport. Ignoring anything under a
  // keyboard's worth of pixels keeps zoom from shoving the composer around.
  return covered > 80 ? Math.round(covered) : 0;
}

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport ?? null;
    if (!viewport) return;
    const update = () => setInset(keyboardInset(viewport, window.innerHeight));
    update();
    viewport.addEventListener("resize", update);
    // iOS scrolls the visual viewport rather than resizing it when focus moves
    // between fields while the keyboard is already up.
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
