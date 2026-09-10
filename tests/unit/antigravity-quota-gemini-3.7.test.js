import { describe, expect, it, vi, beforeEach } from "vitest";

const modelsBody = {
  models: {
    "gemini-3.7-flash-high": {
      displayName: "Gemini 3.7 Flash (High)",
      quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-25T12:00:00Z" },
    },
    "gemini-3.7-flash-medium": {
      displayName: "Gemini 3.7 Flash (Medium)",
      quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
    },
    "gemini-3.7-flash-low": {
      displayName: "Gemini 3.7 Flash (Low)",
      quotaInfo: { remainingFraction: 0.35, resetTime: "2026-08-25T12:00:00Z" },
    },
    "internal-model": {
      displayName: "Internal",
      isInternal: true,
      quotaInfo: { remainingFraction: 0.5 },
    },
  },
};

const subBody = { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } };

const proxyAwareFetch = vi.fn(async (url) => {
  // Guard: vitest's runner occasionally invokes the mock with no args after a
  // test settles (stack: runWithTimeout → Mock). Production call sites always
  // pass defined URLs (audited).
  if (typeof url !== "string") {
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }
  const body = url.includes(":loadCodeAssist") ? subBody : modelsBody;
  const text = JSON.stringify(body);
  return { ok: true, status: 200, json: async () => body, text: async () => text };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity quota tracker: Gemini 3.7 Flash usage bars", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns Gemini 3.7 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.7-flash-high"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
      displayName: "Gemini 3.7 Flash (High)",
    });
    expect(usage.quotas["gemini-3.7-flash-medium"]).toMatchObject({
      used: 400,
      total: 1000,
      remainingPercentage: 60,
    });
    expect(usage.quotas["gemini-3.7-flash-low"]).toMatchObject({
      used: 650,
      total: 1000,
      remainingPercentage: 35,
    });
  });
});
