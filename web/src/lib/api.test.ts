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

  it("releases every lease owned by the current browser auth session", async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, ...(init === undefined ? {} : { init }) };
      return new Response(null, { status: 204 });
    }));
    const api = new CockpitApi({ csrfToken: "csrf-token", actor: "Local" });

    await api.releaseBrowserLeases();

    expect(captured).not.toBeNull();
    const request = captured as unknown as { input: RequestInfo | URL; init: RequestInit };
    expect(request.input).toBe("/api/v1/control-leases");
    expect(request.init.method).toBe("DELETE");
    expect((request.init.headers as Headers).get("x-csrf-token")).toBe("csrf-token");
    expect((request.init.headers as Headers).has("x-control-lease")).toBe(false);
  });

  it("returns the server error message from the normalized error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "stale_generation", message: "Session state changed." },
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: null, actor: null });

    await expect(api.sessions()).rejects.toThrow("Session state changed.");
  });

  it("presents the current rotating token when explicitly taking over control", async () => {
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
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await expect(api.acquireLease("session-one", "browser-client", "current-token", 60, true)).resolves.toEqual(
      expect.objectContaining({
        token: "rotated-lease-token",
      }),
    );

    expect(captured).toEqual({
      body: { clientId: "browser-client", ttlSeconds: 60, takeover: true },
      leaseToken: "current-token",
    });
  });

  it("launches bypass-permissions sessions without a legacy confirmation header", async () => {
    let captured: { headers: Headers; body: unknown } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        headers: init?.headers as Headers,
        body: JSON.parse(String(init?.body ?? "{}")),
      };
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
      accessMode: "bypass-permissions",
      idempotencyKey: "create-session-1",
    });

    expect(captured?.headers.has("x-confirm-full-host")).toBe(false);
    expect(captured?.headers.get("x-csrf-token")).toBe("csrf");
    expect(captured?.body).toEqual(expect.objectContaining({ accessMode: "bypass-permissions" }));
  });

  it("resolves a host-specific workspace and requests path completion on that host", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/directories?")) {
        return new Response(JSON.stringify({ paths: ["/srv/project"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        workspace: {
          id: "workspace-remote",
          label: "project",
          path: "/srv/project",
          hostId: "host-studio",
          hostLabel: "Studio Mac",
          hostKind: "ssh",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await expect(api.completeDirectories("host-studio", "/srv/pro")).resolves.toEqual(["/srv/project"]);
    await expect(api.resolveWorkspace("host-studio", "/srv/project")).resolves.toEqual({
      id: "workspace-remote",
      label: "project",
      path: "/srv/project",
      hostId: "host-studio",
      hostLabel: "Studio Mac",
      hostKind: "ssh",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/hosts/host-studio/directories?path=%2Fsrv%2Fpro&limit=30",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      hostId: "host-studio",
      path: "/srv/project",
    });
  });
});
