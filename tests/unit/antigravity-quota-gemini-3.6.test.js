import { describe, expect, it, vi, beforeEach } from "vitest";

const modelsBody = {
  models: {
    "gemini-3.6-flash-high": {
      displayName: "Gemini 3.6 Flash (High)",
      quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
    },
    "gemini-3.6-flash-medium": {
      displayName: "Gemini 3.6 Flash (Medium)",
      quotaInfo: { remainingFraction: 0.5, resetTime: "2026-07-25T12:00:00Z" },
    },
    "gemini-3.6-flash-low": {
      displayName: "Gemini 3.6 Flash (Low)",
      quotaInfo: { remainingFraction: 0.2, resetTime: "2026-07-25T12:00:00Z" },
    },
    "gemini-3.5-flash-low": {
      displayName: "Gemini 3.5 Flash (Medium)",
      quotaInfo: { remainingFraction: 0.9, resetTime: "2026-07-25T12:00:00Z" },
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
  // pass defined URLs (audited) — the exact-URL assertion below proves it.
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

describe("Antigravity quota tracker: Gemini 3.6 Flash usage bars", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns Gemini 3.6 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.6-flash-high"]).toMatchObject({
      used: 200,
      total: 1000,
      remainingPercentage: 80,
      displayName: "Gemini 3.6 Flash (High)",
    });
    expect(usage.quotas["gemini-3.6-flash-medium"]).toMatchObject({
      used: 500,
      total: 1000,
      remainingPercentage: 50,
    });
    expect(usage.quotas["gemini-3.6-flash-low"]).toMatchObject({
      used: 800,
      total: 1000,
      remainingPercentage: 20,
    });

    // The fetcher hits daily loadCodeAssist + models + summary with the CLI UA.
    const urls = proxyAwareFetch.mock.calls.map(([u]) => u).filter((u) => typeof u === "string");
    expect(urls).toEqual([
      expect.stringContaining(":loadCodeAssist"),
      expect.stringContaining(":fetchAvailableModels"),
      expect.stringContaining(":retrieveUserQuotaSummary"),
    ]);
    expect(urls.every((u) => u.startsWith("https://daily-cloudcode-pa.googleapis.com/"))).toBe(true);
  });

  it("filters out internal models but keeps every renamed upstream model", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    // Upstream renames models over time (e.g. -high → -tiered); a hardcoded
    // allow-list silently drops the models users actually call.
    expect(usage.quotas).not.toHaveProperty("internal-model");
    expect(Object.keys(usage.quotas)).toEqual([
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.5-flash-low",
    ]);
  });
});
