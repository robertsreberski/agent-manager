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
  // Pinch zoom shrinks the visual viewport too, but it does not uncover space
  // below the composer. Treating that as a keyboard leaves a large, sticky
  // footer gutter until the next viewport event.
  if (Number.isFinite(viewport.scale) && Math.abs(viewport.scale - 1) > 0.01) return 0;
  const covered = layoutHeight - viewport.height - viewport.offsetTop;
  // A pinch-zoom also shrinks the visual viewport. Ignoring anything under a
  // keyboard's worth of pixels keeps zoom from shoving the composer around.
  return covered > 80 ? Math.round(covered) : 0;
}

/** Only controls that can summon a typing keyboard may reserve its inset. */
export function isKeyboardEditor(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ["", "text", "search", "email", "url", "tel", "password", "number"].includes(target.type);
}

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport ?? null;
    if (!viewport) return;
    let animationFrame: number | null = null;
    const update = () => setInset(
      document.visibilityState === "visible" && isKeyboardEditor(document.activeElement)
        ? keyboardInset(viewport, window.innerHeight)
        : 0,
    );
    // During focusout the browser may still report the element being left as
    // active. Read focus on the next frame, after it has settled.
    const updateAfterFocus = () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        update();
      });
    };
    update();
    viewport.addEventListener("resize", update);
    // iOS scrolls the visual viewport rather than resizing it when focus moves
    // between fields while the keyboard is already up.
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", updateAfterFocus);
    document.addEventListener("focusout", updateAfterFocus);
    document.addEventListener("visibilitychange", update);
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", updateAfterFocus);
      document.removeEventListener("focusout", updateAfterFocus);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return inset;
}
