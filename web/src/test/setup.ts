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

afterEach(cleanup);
