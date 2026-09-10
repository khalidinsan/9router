import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => {
  const payload = url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }
    : {
        models: {
          "gemini-3.8-flash-high": {
            displayName: "Gemini 3.8 Flash (High)",
            quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-25T12:00:00Z" },
          },
          "gemini-3.8-flash-medium": {
            displayName: "Gemini 3.8 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
          },
          "gemini-3.8-flash-low": {
            displayName: "Gemini 3.8 Flash (Low)",
            quotaInfo: { remainingFraction: 0.35, resetTime: "2026-08-25T12:00:00Z" },
          },
          "internal-model": {
            displayName: "Internal",
            isInternal: true,
            quotaInfo: { remainingFraction: 0.5 },
          },
        },
      };
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    // The usage fetcher reads text() and parses it itself, so a body truncated
    // by a cold-start timeout can be retried once. A real Response serves both,
    // and only the quota call goes through that path (the models payload is
    // ~123KB); subscription discovery still reads json().
    text: async () => JSON.stringify(payload),
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity quota tracker: Gemini 3.8 Flash usage bars", () => {
  // Braces matter: `() => mock.mockClear()` returns the mock, which is a
  // function, and vitest treats a hook's return value as a cleanup callback —
  // it would then invoke the mock with no arguments after every test.
  beforeEach(() => {
    proxyAwareFetch.mockClear();
  });

  it("returns Gemini 3.8 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
      displayName: "Gemini 3.8 Flash (High)",
    });
    expect(usage.quotas["gemini-3.8-flash-medium"]).toMatchObject({
      used: 400,
      total: 1000,
      remainingPercentage: 60,
    });
    expect(usage.quotas["gemini-3.8-flash-low"]).toMatchObject({
      used: 650,
      total: 1000,
      remainingPercentage: 35,
    });
  });
});
