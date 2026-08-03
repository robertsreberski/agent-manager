import { describe, expect, it, vi } from "vitest";

import {
  DEV_BACKEND_ORIGIN,
  DEV_WEB_ORIGIN,
  rewriteDevProxyHeaders,
} from "./dev-proxy";

describe("the Vite API proxy", () => {
  it("uses the fixed backend Host and rewrites only the fixed dev Origin", () => {
    const setHeader = vi.fn();
    rewriteDevProxyHeaders(
      { setHeader },
      { headers: { origin: DEV_WEB_ORIGIN } },
    );
    expect(setHeader.mock.calls).toEqual([
      ["host", "127.0.0.1:43127"],
      ["origin", DEV_BACKEND_ORIGIN],
    ]);
  });

  it.each([
    "http://localhost:43128",
    "https://attacker.example",
  ])("does not launder a non-matching browser Origin (%s)", (origin) => {
    const setHeader = vi.fn();
    rewriteDevProxyHeaders({ setHeader }, { headers: { origin } });
    expect(setHeader).toHaveBeenCalledOnce();
    expect(setHeader).toHaveBeenCalledWith("host", "127.0.0.1:43127");
  });
});
