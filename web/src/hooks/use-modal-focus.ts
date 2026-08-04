import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalLayer {
  container: () => HTMLElement | null;
  initialFocus: () => HTMLElement | null;
  order: number;
  priority: number;
}

const layers: ModalLayer[] = [];
let nextLayerOrder = 0;

function topLayer(): ModalLayer | null {
  return layers.reduce<ModalLayer | null>((top, layer) => {
    if (!top || layer.priority > top.priority || layer.priority === top.priority && layer.order > top.order) return layer;
    return top;
  }, null);
}

/**
 * Application-level keyboard handlers must yield while a modal layer is
 * active. The modal listener may have been registered after the application
 * listener, so event propagation alone cannot establish this ordering.
 */
export function hasActiveModalLayer(): boolean {
  return topLayer() !== null;
}

function focusableElements(layer: ModalLayer): HTMLElement[] {
  return [...(layer.container()?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
}

function preferredFocus(layer: ModalLayer, edge: "first" | "last" = "first"): HTMLElement | null {
  const container = layer.container();
  const initial = layer.initialFocus();
  if (edge === "first" && initial && container?.contains(initial)) return initial;
  const focusable = focusableElements(layer);
  return (edge === "last" ? focusable.at(-1) : focusable[0]) ?? container;
}

function focusLayer(layer: ModalLayer, edge: "first" | "last" = "first") {
  preferredFocus(layer, edge)?.focus({ preventScroll: true });
}

/**
 * Contains focus in the highest-priority active modal, restores the opener on
 * close, and consumes Escape before application-level shortcuts can observe it.
 */
export function useModalFocus<T extends HTMLElement>({
  active,
  initialFocusRef,
  onEscape,
  priority = 0,
}: {
  active: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  priority?: number;
}): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  const optionsRef = useRef({ initialFocusRef, onEscape });
  optionsRef.current = { initialFocusRef, onEscape };

  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer: ModalLayer = {
      container: () => containerRef.current,
      initialFocus: () => optionsRef.current.initialFocusRef?.current ?? null,
      order: nextLayerOrder++,
      priority,
    };
    layers.push(layer);
    focusLayer(layer);

    function keydown(event: KeyboardEvent) {
      if (topLayer() !== layer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        optionsRef.current.onEscape?.();
        return;
      }
      if (event.key !== "Tab") return;
      const container = layer.container();
      const focusable = focusableElements(layer);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!container || !first || !last) {
        event.preventDefault();
        focusLayer(layer);
        return;
      }
      const focused = document.activeElement;
      if (!container.contains(focused)) {
        event.preventDefault();
        focusLayer(layer, event.shiftKey ? "last" : "first");
      } else if (event.shiftKey && focused === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    function containFocus(event: FocusEvent) {
      if (topLayer() !== layer) return;
      const container = layer.container();
      if (container && event.target instanceof Node && !container.contains(event.target)) focusLayer(layer);
    }

    window.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", containFocus, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", containFocus, true);
      const wasTop = topLayer() === layer;
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      if (!wasTop) return;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      else {
        const next = topLayer();
        if (next) focusLayer(next);
      }
    };
  }, [active, priority]);

  return containerRef;
}
