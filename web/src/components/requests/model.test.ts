import { describe, expect, it } from "vitest";
import { approvalTier, isExactRespondableRequest, type ExactQuestionRequest } from "./model";

const exact: ExactQuestionRequest = {
  id: "request-1", label: "request_user_input", state: "waiting", source: "provider-api", confidence: "exact",
  exposure: "provider-exposed", truncated: false, respondable: true, questions: [],
};

describe("request exactness", () => {
  it("withdraws controls for every uncertain boundary", () => {
    expect(isExactRespondableRequest(exact)).toBe(true);
    expect(isExactRespondableRequest({ ...exact, id: null })).toBe(false);
    expect(isExactRespondableRequest({ ...exact, source: "transcript" })).toBe(false);
    expect(isExactRespondableRequest({ ...exact, confidence: "heuristic" })).toBe(false);
    expect(isExactRespondableRequest({ ...exact, truncated: true })).toBe(false);
  });
});

describe("approval tier", () => {
  const base = { id: "a", label: "Run command", command: null, reason: null, workspaceRoot: "/work/app", writes: [], network: null, deleteCount: null, remoteHost: null, sessionsOnHost: null, canPersist: false };
  it("is conservative for unknown and escaped paths", () => {
    expect(approvalTier({ ...base, paths: null })).toBe("outside");
    expect(approvalTier({ ...base, paths: ["relative/file"] })).toBe("outside");
    expect(approvalTier({ ...base, paths: ["/work/application/file"] })).toBe("outside");
    expect(approvalTier({ ...base, paths: ["/work/app/src/file.ts"] })).toBe("workspace");
    expect(approvalTier({ ...base, paths: ["/work/app/src/file.ts"], remoteHost: "studio" })).toBe("remote");
  });
});
