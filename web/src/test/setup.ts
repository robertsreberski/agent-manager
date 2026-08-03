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
