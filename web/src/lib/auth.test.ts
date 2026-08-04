import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionError, establishBrowserSession } from "./auth";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("establishBrowserSession", () => {
  it("exchanges a fragment secret once and removes it from browser history", async () => {
    window.history.replaceState(null, "", "/#bootstrap=one-time-secret");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authenticated: true,
        csrfToken: "csrf-token",
        actor: { displayName: "Local user" },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(establishBrowserSession()).resolves.toEqual({
      csrfToken: "csrf-token",
      actor: "Local user",
    });
    expect(window.location.hash).toBe("");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/auth/bootstrap", expect.objectContaining({
      body: JSON.stringify({ secret: "one-time-secret" }),
      credentials: "include",
    }));
  });

  it("removes an invalid bootstrap secret before reporting the error", async () => {
    window.history.replaceState(null, "", "/#token=expired-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })));

    await expect(establishBrowserSession()).rejects.toThrow("invalid or has expired");
    expect(window.location.hash).toBe("");
  });

  it("classifies a transport failure as an offline shell state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const failure = await establishBrowserSession().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrowserSessionError);
    expect(failure).toMatchObject({ kind: "offline", status: null });
  });

  it("classifies the panic boundary without treating it as an offline response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "CONTROL_PLANE_LOCKED", message: "Agent Manager is locked" },
    }), {
      status: 423,
      headers: { "content-type": "application/json" },
    })));

    const failure = await establishBrowserSession().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrowserSessionError);
    expect(failure).toMatchObject({ kind: "locked", status: 423 });
  });
});
