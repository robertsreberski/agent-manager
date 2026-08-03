import { afterEach, describe, expect, it, vi } from "vitest";
import { CockpitApi } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CockpitApi", () => {
  it("turns immutable attach argv into a copyable display command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      instruction: {
        kind: "tmux",
        argv: ["tmux", "-L", "mobile-ssh", "attach-session", "-t", "session with space"],
        cwd: "/tmp/work tree",
        warning: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await expect(api.attach("session/one")).resolves.toEqual(expect.objectContaining({
      available: true,
      kind: "tmux",
      command: "tmux -L mobile-ssh attach-session -t 'session with space'",
      cwd: "/tmp/work tree",
    }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/sessions/session%2Fone/attach", expect.anything());
  });

  it("sends the CSRF and control-lease tokens on semantic actions", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ action: { status: "queued" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: "csrf-token", actor: "Local" });

    await api.action("managed-1", {
      type: "send",
      delivery: "queue",
      text: "Continue",
      expectedGeneration: 3,
      idempotencyKey: "idempotency-key",
    }, "lease-token");

    const init = capturedInit;
    if (!init) throw new Error("fetch init was not captured");
    const headers = init.headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("csrf-token");
    expect(headers.get("x-control-lease")).toBe("lease-token");
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ delivery: "queue", text: "Continue" }));
  });

  it("returns the server error message from the normalized error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "stale_generation", message: "Session state changed." },
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: null, actor: null });

    await expect(api.sessions()).rejects.toThrow("Session state changed.");
  });

  it("presents the current rotating token when arming full-host access", async () => {
    let captured: { body: unknown; leaseToken: string | null } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      captured = {
        body: JSON.parse(String(init?.body ?? "{}")),
        leaseToken: headers.get("x-control-lease"),
      };
      return new Response(JSON.stringify({
        lease: {
          token: "rotated-lease-token",
          clientId: "browser-client",
          expiresAt: "2026-08-03T10:05:00.000Z",
          fullHostArmedUntil: "2026-08-03T10:05:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await expect(api.acquireLease("full-host", "browser-client", true, "current-token")).resolves.toEqual(
      expect.objectContaining({
        token: "rotated-lease-token",
        fullHostArmedUntil: "2026-08-03T10:05:00.000Z",
      }),
    );

    expect(captured).toEqual({
      body: { clientId: "browser-client", ttlSeconds: 300, armFullHost: true },
      leaseToken: "current-token",
    });
  });

  it("carries the explicit confirmation when launching a full-host session", async () => {
    let capturedHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Headers;
      return new Response(JSON.stringify({
        session: { id: "codex:new", provider: "codex", ownership: "manager" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    }));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await api.createSession({
      provider: "codex",
      workspaceId: "workspace-1",
      initialMessage: "Start",
      mode: "execution",
      permissionPreset: "full-host",
      idempotencyKey: "create-session-1",
    });

    expect(capturedHeaders?.get("x-confirm-full-host")).toBe("true");
    expect(capturedHeaders?.get("x-csrf-token")).toBe("csrf");
  });
});
