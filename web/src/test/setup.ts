import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
}

/*
  jsdom has no layout engine, no ResizeObserver and no pointer-capture APIs.
  Radix's positioned primitives (dropdown, dialog, select) and cmdk's list
  sizer all call into them, so without these stubs mounting any of the shared
  `components/ui` primitives throws. Every assertion in the suite is about
  roles, state and focus, never geometry, so returning zeroes is honest here.
*/
if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}

if (!("DOMRect" in globalThis)) {
  Object.defineProperty(globalThis, "DOMRect", {
    configurable: true,
    value: class {
      constructor(
        readonly x = 0,
        readonly y = 0,
        readonly width = 0,
        readonly height = 0,
      ) {}
    },
  });
}

for (const method of ["scrollIntoView", "hasPointerCapture", "setPointerCapture", "releasePointerCapture"]) {
  if (typeof (Element.prototype as unknown as Record<string, unknown>)[method] !== "function") {
    Object.defineProperty(Element.prototype, method, { configurable: true, value: () => false });
  }
}

if (typeof HTMLElement.prototype.scrollTo !== "function") {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(optionsOrX: ScrollToOptions | number, y?: number) {
      if (typeof optionsOrX === "number") {
        this.scrollLeft = optionsOrX;
        this.scrollTop = y ?? 0;
        return;
      }
      if (typeof optionsOrX.left === "number") this.scrollLeft = optionsOrX.left;
      if (typeof optionsOrX.top === "number") this.scrollTop = optionsOrX.top;
    },
  });
}

afterEach(cleanup);
