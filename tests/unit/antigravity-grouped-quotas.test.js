import { describe, it, expect, vi, beforeEach } from "vitest";

const fixtures = {
  summary: null,
  summaryThrows: false,
};

const proxyAwareFetch = vi.fn(async (url) => {
  let body;
  if (url.includes(":loadCodeAssist")) {
    body = { cloudaicompanionProject: "project-1", currentTier: { name: "Antigravity" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } };
  } else if (url.includes(":retrieveUserQuotaSummary")) {
    if (fixtures.summaryThrows) throw new Error("upstream 429");
    body = fixtures.summary;
  } else {
    body = {
      models: {
        "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { remainingFraction: 0.6836, resetTime: "2026-09-08T15:57:25Z" } },
        "gemini-3.7-flash-tiered": { quotaInfo: { remainingFraction: 1, resetTime: "2026-09-08T15:57:25Z" } },
        "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", quotaInfo: { resetTime: "2026-09-09T00:42:01Z" } },
        "internal-model": { isInternal: true, quotaInfo: { remainingFraction: 1, resetTime: "2026-09-08T15:57:25Z" } },
        "no-quota": { displayName: "No Quota" },
      },
    };
  }
  const json = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => json,
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-09-15T05:20:42Z", remainingFraction: 0.6836 },
        { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-09-08T15:57:25Z", remainingFraction: 0.5841 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-09-09T00:42:01Z", remainingFraction: 0, description: "You have hit your weekly limit" },
        { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-09-08T15:57:25Z", remainingFraction: 1, disabled: true, description: "weekly hit, 5h does not apply" },
      ],
    },
  ],
};

describe("Antigravity grouped quotas (agy /usage parity)", () => {
  beforeEach(() => {
    proxyAwareFetch.mockClear();
    fixtures.summary = SUMMARY;
    fixtures.summaryThrows = false;
  });

  it("returns normalized weekly + 5h groups with percents, resets, and disabled flag", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("token", {});

    expect(usage.groups).toHaveLength(2);
    const gemini = usage.groups[0];
    expect(gemini.key).toBe("gemini");
    expect(gemini.buckets[0]).toMatchObject({ window: "weekly", remainingPercentage: 68.36 });
    expect(gemini.buckets[0].resetAt).toContain("2026-09-15");
    const threeP = usage.groups[1];
    expect(threeP.key).toBe("3p");
    expect(threeP.buckets[0].remainingPercentage).toBe(0);
    expect(threeP.buckets[1]).toMatchObject({ window: "5h", disabled: true, remainingPercentage: 100 });
  });

  it("records group-governed models as unknown instead of exhausted", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("token", {});

    // No remainingFraction upstream → null (fail-open), never fake 0%.
    expect(usage.quotas["claude-sonnet-4-6"]).toMatchObject({
      remainingPercentage: null,
      used: null,
      total: null,
    });
    expect(usage.quotas["claude-sonnet-4-6"].resetAt).toContain("2026-09-09");
    expect(usage.quotas["gemini-3-flash"].remainingPercentage).toBeCloseTo(68.36, 4);
  });

  it("keeps every non-internal model instead of a stale hardcoded list", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("token", {});

    // Per-model keys plus the weekly-overlay keys (upstream weekly feature).
    expect(Object.keys(usage.quotas).sort()).toEqual([
      "claude-sonnet-4-6",
      "claude_gpt_weekly",
      "gemini-3-flash",
      "gemini-3.7-flash-tiered",
      "gemini_weekly",
    ]);
  });

  it("still returns models when the summary call fails", async () => {
    fixtures.summaryThrows = true;
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("token", {});

    expect(usage.groups).toEqual([]);
    expect(usage.quotas["gemini-3-flash"].remainingPercentage).toBeCloseTo(68.36, 4);
  });

  it("maps models to their governing group, unknown to null", async () => {
    const { findAntigravityGroupForModel, normalizeAntigravityQuotaGroups } = await import(
      "../../open-sse/services/usage/google.js"
    );
    const groups = normalizeAntigravityQuotaGroups(SUMMARY);

    expect(findAntigravityGroupForModel(groups, "claude-sonnet-4-6")?.name).toBe("Claude and GPT models");
    expect(findAntigravityGroupForModel(groups, "gpt-oss-120b-medium")?.name).toBe("Claude and GPT models");
    expect(findAntigravityGroupForModel(groups, "gemini-3.8-flash-high")?.name).toBe("Gemini Models");
    expect(findAntigravityGroupForModel(groups, "chat_20706")).toBeNull();
    expect(findAntigravityGroupForModel([], "gemini-3-flash")).toBeNull();
  });
});
