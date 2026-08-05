import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MANAGER_BUILD_ID, WireUpgradeRequiredError, WIRE_SCHEMA_VERSION } from "../../../src/shared/wire.ts";
import { ApiError, CockpitApi } from "./api";

function sessionRecord() {
  return {
    id: "local:codex:new",
    provider: "codex",
    providerThreadId: "new",
    providerTreeId: null,
    parentId: null,
    providerTurnId: null,
    depth: 0,
    hostId: "local",
    hostLabel: "This Mac",
    name: null,
    cwd: "/tmp/project",
    kind: "interactive",
    archived: false,
    presence: "live",
    status: "idle",
    providerStatus: "idle",
    pid: null,
    runtimePid: null,
    startedAt: null,
    updatedAt: "2026-08-04T10:00:00.000Z",
    childSummary: {
      total: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    },
    statusSource: "provider-api",
    source: "thread/list",
    profile: {
      value: "full-access",
      providerValue: "full-access",
      source: "provider-api",
      confidence: "exact",
    },
    model: {
      value: null,
      providerValue: null,
      source: "provider-api",
      confidence: "exact",
    },
    effort: {
      value: null,
      providerValue: null,
      source: "provider-api",
      confidence: "exact",
    },
    todoProgress: null,
    attention: [],
    terminal: null,
    control: {
      plane: "codex-private",
      authority: "manager",
      capabilities: ["queue", "set-profile"],
      withheld: [],
      takeover: null,
    },
    workspaceIdentity: null,
    generation: 1,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CockpitApi", () => {
  it("reads strict cursor-paginated archived sessions as read-only records", async () => {
    let requested = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(JSON.stringify({
        schemaVersion: WIRE_SCHEMA_VERSION,
        buildId: AGENT_MANAGER_BUILD_ID,
        query: "needle",
        sessions: [{
          ...sessionRecord(),
          archived: true,
          presence: "recent",
          status: "completed",
          providerStatus: "archived",
          control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
        }],
        nextCursor: "next-page",
        total: 51,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    const page = await api.archivedSessions("needle", "opaque-cursor", 50);

    expect(requested).toContain("/api/v1/archived-sessions?");
    expect(requested).toContain("q=needle");
    expect(requested).toContain("cursor=opaque-cursor");
    expect(page.sessions[0]?.archived).toBe(true);
    expect(page.sessions[0]?.control.capabilities).toEqual([]);
    expect(page.nextCursor).toBe("next-page");
    expect(page.total).toBe(51);
  });

  it("resolves an archived direct link without treating a missing record as fatal", async () => {
    const responses = [
      new Response(JSON.stringify({
        schemaVersion: WIRE_SCHEMA_VERSION,
        buildId: AGENT_MANAGER_BUILD_ID,
        session: {
          ...sessionRecord(),
          archived: true,
          presence: "recent",
          status: "completed",
          providerStatus: "archived",
          control: { plane: "observe-only", authority: "none", capabilities: [], withheld: [], takeover: null },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404, headers: { "content-type": "application/json" } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await expect(api.archivedSession("local:codex:new")).resolves.toMatchObject({ archived: true });
    await expect(api.archivedSession("local:codex:missing")).resolves.toBeNull();
  });

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

  it("accepts only the server-built SSH wrapper for a remote resume", async () => {
    const argv = [
      "ssh",
      "-t",
      "dev@build-host",
      "/bin/zsh -lc 'exec agent-manager attach \"$1\"' agent-manager 'local:claude:session-1'",
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      instruction: {
        kind: "ssh",
        argv,
        cwd: null,
        warning: "Run from a terminal with SSH access to Build host.",
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await expect(api.attach("build:claude:session-1")).resolves.toEqual(expect.objectContaining({
      available: true,
      kind: "ssh",
      argv,
      requiresHandoff: true,
      cwd: null,
    }));
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

  it("starts a keepalive writer release for page exit", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ released: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: "csrf-token", actor: "Local" });

    await api.releaseLease("local:codex:thread/one", "lease-token", true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Acodex%3Athread%2Fone/control-lease",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-control-lease")).toBe("lease-token");
    expect(headers.get("x-csrf-token")).toBe("csrf-token");
  });

  it("returns the server error message from the normalized error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "stale_generation", message: "Session state changed." },
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: null, actor: null });

    await expect(api.sessions()).rejects.toThrow("Session state changed.");
  });

  it("keeps a REST build mismatch on the typed upgrade-required path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: WIRE_SCHEMA_VERSION,
      buildId: "previous-build",
      generatedAt: "2026-08-04T10:00:00.000Z",
      seq: 1,
      stale: false,
      sessions: [],
      diagnostics: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: null, actor: null });

    await expect(api.sessions()).rejects.toBeInstanceOf(WireUpgradeRequiredError);
    await api.sessions().catch((error: unknown) => {
      expect(error).not.toBeInstanceOf(ApiError);
    });
  });

  it("reads only explicitly requested attention IDs through the strict per-session route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:codex:thread/one",
      generation: 7,
      details: [{
        requestId: "request one",
        kind: "question",
        title: "Codex needs your answer",
        toolName: "request_user_input",
        questions: [{ id: "surface", text: "Which surface?" }],
        truncated: false,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.attentionDetails(
      "local:codex:thread/one",
      ["request one", "request/two"],
    )).resolves.toEqual(expect.objectContaining({
      sessionId: "local:codex:thread/one",
      generation: 7,
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Acodex%3Athread%2Fone/attention-details?requestId=request+one&requestId=request%2Ftwo",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("rejects attention detail content for another session or unrequested ID", async () => {
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });
    const response = (sessionId: string, requestId: string) => new Response(JSON.stringify({
      sessionId,
      generation: 7,
      details: [{
        requestId,
        kind: "question",
        title: null,
        toolName: null,
        questions: [{ id: "question", text: "Private question" }],
        truncated: false,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    vi.stubGlobal("fetch", vi.fn(async () => response("local:codex:other", "request-1")));
    await expect(api.attentionDetails("local:codex:one", ["request-1"])).rejects.toThrow(
      "invalid selected attention identity",
    );

    vi.stubGlobal("fetch", vi.fn(async () => response("local:codex:one", "request-private")));
    await expect(api.attentionDetails("local:codex:one", ["request-1"])).rejects.toThrow(
      "invalid selected attention identity",
    );
  });

  it("reads and identity-checks the bounded current todo projection", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:codex:thread/one",
      generation: 7,
      todo: {
        completed: 2,
        total: 4,
        current: "Fix the shared fixture",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.todoDetail("local:codex:thread/one")).resolves.toEqual({
      sessionId: "local:codex:thread/one",
      generation: 7,
      todo: {
        completed: 2,
        total: 4,
        current: "Fix the shared fixture",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Acodex%3Athread%2Fone/todo-detail",
      expect.objectContaining({ credentials: "include" }),
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:codex:other",
      generation: 7,
      todo: null,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(api.todoDetail("local:codex:thread/one")).rejects.toThrow(
      "invalid selected todo identity",
    );
  });

  it("searches only the named transcript with bounded, strictly parsed results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:codex:thread/one",
      matches: [{
        messageId: "message-1",
        role: "assistant",
        createdAt: "2026-08-04T10:00:00.000Z",
        snippet: "Before Needle path after",
        matchStart: 7,
        matchEnd: 18,
      }],
      truncated: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.searchTranscript("local:codex:thread/one", "  Needle path  ", 7)).resolves.toEqual({
      sessionId: "local:codex:thread/one",
      matches: [expect.objectContaining({
        messageId: "message-1",
        snippet: "Before Needle path after",
        matchStart: 7,
        matchEnd: 18,
      })],
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Acodex%3Athread%2Fone/search?q=Needle+path&limit=7",
      expect.anything(),
    );
  });

  it("rejects invalid transcript-search inputs before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.searchTranscript("local:codex:thread-1", "x")).rejects.toThrow();
    await expect(api.searchTranscript("local:codex:thread-1", "needle", 51)).rejects.toThrow();
    await expect(api.searchTranscript("local:codex:thread-1", `ab${"c".repeat(199)}`)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects transcript-search data for another session or outside snippet bounds", async () => {
    const responses = [
      {
        sessionId: "local:codex:another-thread",
        matches: [],
        truncated: false,
      },
      {
        sessionId: "local:codex:thread-1",
        matches: [{
          messageId: "message-1",
          role: "assistant",
          createdAt: null,
          snippet: "needle",
          matchStart: 0,
          matchEnd: 20,
        }],
        truncated: false,
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.searchTranscript("local:codex:thread-1", "needle")).rejects.toThrow(
      "invalid transcript search identity",
    );
    await expect(api.searchTranscript("local:codex:thread-1", "needle")).rejects.toThrow(
      "invalid transcript search response",
    );
  });

  it("reads a registered plan artifact through its session and item identities", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:claude:thread/one",
      itemId: "plan/current",
      path: "/Users/local/.claude/plans/current.md",
      markdown: "# Ship\n\nDo the work as written.\n",
      truncated: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.planFile("local:claude:thread/one", "plan/current")).resolves.toEqual({
      sessionId: "local:claude:thread/one",
      itemId: "plan/current",
      path: "/Users/local/.claude/plans/current.md",
      markdown: "# Ship\n\nDo the work as written.\n",
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Aclaude%3Athread%2Fone/plans/plan%2Fcurrent",
      expect.anything(),
    );
  });

  it("rejects plan-file responses for a different registered item", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:claude:thread-1",
      itemId: "plan-other",
      path: "/Users/local/.claude/plans/other.md",
      markdown: "# Other",
      truncated: false,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.planFile("local:claude:thread-1", "plan-current")).rejects.toThrow(
      "invalid plan-file identity",
    );
  });

  it("loads provider-derived Codex models and their exact effort choices", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      available: true,
      source: "provider-api",
      models: [{
        value: "gpt-codex",
        label: "Codex",
        description: "Balanced",
        isDefault: true,
        defaultEffort: "medium",
        efforts: ["low", "medium", "high"],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.settingsOptions("local:codex:thread/one")).resolves.toEqual({
      available: true,
      source: "provider-api",
      models: [{
        value: "gpt-codex",
        label: "Codex",
        description: "Balanced",
        isDefault: true,
        defaultEffort: "medium",
        efforts: ["low", "medium", "high"],
      }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Acodex%3Athread%2Fone/settings-options",
      expect.anything(),
    );
  });

  it("loads draft model choices directly from the provider on the requested host", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      available: true,
      source: "provider-api",
      models: [{
        value: "gpt-codex",
        label: "Codex",
        description: "Balanced",
        isDefault: true,
        defaultEffort: "medium",
        efforts: ["low", "medium", "high"],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.providerSettingsOptions("codex", "build/one")).resolves.toEqual({
      available: true,
      source: "provider-api",
      models: [{
        value: "gpt-codex",
        label: "Codex",
        description: "Balanced",
        isDefault: true,
        defaultEffort: "medium",
        efforts: ["low", "medium", "high"],
      }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/providers/codex/settings-options?hostId=build%2Fone",
      expect.anything(),
    );
  });

  it("accepts the explicit remote-host result and rejects malformed provider catalogs", async () => {
    const responses = [
      { available: false, reason: "remote-host", models: [] },
      { available: false, reason: "remote-host", models: [{ value: "guess", label: "Guess", description: null }] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.providerSettingsOptions("claude", "remote")).resolves.toEqual({
      available: false,
      reason: "remote-host",
      models: [],
    });
    await expect(api.providerSettingsOptions("claude", "remote")).rejects.toThrow(
      "invalid provider settings options response",
    );
  });

  it("rejects unavailability reasons returned by the wrong settings-options route", async () => {
    const responses = [
      { available: false, reason: "remote-host", models: [] },
      { available: false, reason: "remote-session", models: [] },
      { available: false, reason: "not-manager-owned", models: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.settingsOptions("remote:codex:thread-1")).rejects.toThrow(
      "invalid session settings options response",
    );
    await expect(api.providerSettingsOptions("codex", "local")).rejects.toThrow(
      "invalid provider settings options response",
    );
    await expect(api.providerSettingsOptions("claude", "local")).rejects.toThrow(
      "invalid provider settings options response",
    );
  });

  it("keeps unavailable catalogs explicit and rejects fallback-shaped data", async () => {
    const responses = [
      { available: false, reason: "unsupported-provider", models: [] },
      { available: true, source: "current-value", models: [{ value: "guessed", label: "Guessed", description: null }] },
      { available: true, source: "provider-api", models: [
        { value: "duplicate", label: "One", description: null },
        { value: "duplicate", label: "Two", description: null },
      ] },
      { available: true, source: "provider-api", models: [{
        value: "bad-effort",
        label: "Bad effort",
        description: null,
        isDefault: true,
        defaultEffort: "ultra",
        efforts: ["low", "high"],
      }] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.settingsOptions("local:codex:thread-1")).resolves.toEqual({
      available: false,
      reason: "unsupported-provider",
      models: [],
    });
    await expect(api.settingsOptions("local:codex:thread-1")).rejects.toThrow("invalid session settings options response");
    await expect(api.settingsOptions("local:claude:thread-1")).rejects.toThrow("invalid session settings options response");
    await expect(api.settingsOptions("local:codex:thread-1")).rejects.toThrow("invalid session settings options response");
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
          sessionId: "session-one",
          token: "rotated-lease-token",
          clientId: "browser-client",
          acquiredAt: "2026-08-03T10:04:00.000Z",
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

  it("launches full-access sessions through the one execution profile", async () => {
    let captured: { headers: Headers; body: unknown } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        headers: init?.headers as Headers,
        body: JSON.parse(String(init?.body ?? "{}")),
      };
      return new Response(JSON.stringify({
        session: sessionRecord(),
      }), { status: 201, headers: { "content-type": "application/json" } });
    }));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await api.createSession({
      provider: "codex",
      workspaceId: "workspace-1",
      initialMessage: "Start",
      profile: "full-access",
      model: null,
      effort: null,
      idempotencyKey: "create-session-1",
    });

    expect(captured?.headers.has("x-confirm-full-host")).toBe(false);
    expect(captured?.headers.get("x-csrf-token")).toBe("csrf");
    expect(captured?.body).toEqual(expect.objectContaining({ profile: "full-access" }));
    expect(captured?.body).not.toHaveProperty("mode");
    expect(captured?.body).not.toHaveProperty("accessMode");
  });

  it("accepts the exact resolved-workspace envelope and requests path completion on that host", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/directories?")) {
        return new Response(JSON.stringify({ hostId: "host-studio", paths: ["/srv/project"] }), {
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
          remoteWorkspaceId: "remote-workspace",
          createdAt: "2026-08-04T10:00:00.000Z",
          workspaceIdentity: null,
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
      temporary: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/hosts/host-studio/directories?path=%2Fsrv%2Fpro&limit=30",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      hostId: "host-studio",
      path: "/srv/project",
    });
  });

  it("rejects a resolved workspace response that omits its required current identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      workspace: {
        id: "workspace-local",
        label: "project",
        path: "/tmp/project",
        hostId: "local",
        hostLabel: "This Mac",
        hostKind: "local",
        remoteWorkspaceId: null,
        createdAt: "2026-08-04T10:00:00.000Z",
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const api = new CockpitApi({ csrfToken: "csrf", actor: "Local" });

    await expect(api.resolveWorkspace("local", "/tmp/project")).rejects.toMatchObject({
      message: "The server returned an invalid workspace response.",
      status: 502,
    });
  });

  it("reads and identity-checks strict selected-session facts", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:codex:thread/one",
      generation: 7,
      turnUsage: {
        turnId: "turn-1",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: 15,
        costUsd: 0.001,
      },
      account: { available: false, reason: "remote-session" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });

    await expect(api.sessionFacts("local:codex:thread/one", 7)).resolves.toEqual(
      expect.objectContaining({ sessionId: "local:codex:thread/one", generation: 7 }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/local%3Acodex%3Athread%2Fone/facts?generation=7",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("rejects malformed or stale selected-session fact identities", async () => {
    const api = new CockpitApi({ csrfToken: null, actor: "Local" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      sessionId: "local:codex:other",
      generation: 7,
      turnUsage: null,
      account: { available: true, source: "provider-api", usage: { rawCredential: "secret" }, rateLimits: null },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(api.sessionFacts("local:codex:one", 7)).rejects.toThrow(
      "invalid selected session facts",
    );
  });
});
