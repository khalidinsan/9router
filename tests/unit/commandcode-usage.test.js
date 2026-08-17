import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseCommandCodeUsage } from "../../open-sse/services/usage/commandcode.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const CREDITS_URL = "https://api.commandcode.ai/alpha/billing/credits";
const SUBS_URL = "https://api.commandcode.ai/alpha/billing/subscriptions";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_CREDITS = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 4.1131886036,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: {
      used: 0.716961732,
      cap: 3,
      exceeded: false,
      resetAt: 1786779660625,
    },
    weekly: {
      used: 5.8868113964,
      cap: 6,
      exceeded: false,
      resetAt: 1786967006089,
    },
  },
};

const SAMPLE_SUB = {
  success: true,
  data: {
    status: "active",
    planId: "individual-go",
    currentPeriodStart: "2026-08-10T11:37:39.000Z",
    currentPeriodEnd: "2026-09-10T11:37:39.000Z",
  },
};

describe("commandcode registry usage flags", () => {
  it("exposes alpha billing urls and apikey usage flags", () => {
    expect(PROVIDERS.commandcode.usage?.url).toBe(CREDITS_URL);
    expect(PROVIDERS.commandcode.usage?.subscriptionsUrl).toBe(SUBS_URL);
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("commandcode");
    expect(USAGE_APIKEY_PROVIDERS).toContain("commandcode");
  });
});

describe("parseCommandCodeUsage", () => {
  it("maps 5h/weekly as Codex percent windows and monthly dollars", () => {
    const parsed = parseCommandCodeUsage(SAMPLE_CREDITS, SAMPLE_SUB);
    expect(parsed.plan).toBe("Go");
    expect(parsed.limitReached).toBe(false);
    expect(parsed.quotas.session).toMatchObject({
      used: 24,
      total: 100,
      remaining: 76,
      unlimited: false,
    });
    expect(parsed.quotas.session.resetAt).toBe(new Date(1786779660625).toISOString());
    expect(parsed.quotas.weekly).toMatchObject({
      used: 98,
      total: 100,
      remaining: 2,
      unlimited: false,
    });
    expect(parsed.quotas.Monthly).toMatchObject({
      used: 5.8868,
      total: 10,
    });
    expect(parsed.quotas.Monthly.remaining).toBeUndefined();
    expect(parsed.quotas.Monthly.resetAt).toBe("2026-09-10T11:37:39.000Z");
  });

  it("marks limitReached when a window is exceeded", () => {
    const parsed = parseCommandCodeUsage({
      credits: { monthlyCredits: 0 },
      windowLimits: {
        fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: 1 },
        weekly: { used: 6, cap: 6, exceeded: false, resetAt: 2 },
      },
    }, SAMPLE_SUB);
    expect(parsed.limitReached).toBe(true);
    expect(parsed.quotas.session.used).toBe(100);
    expect(parsed.quotas.session.remaining).toBe(0);
  });
});

describe("getUsageForProvider(commandcode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GETs credits + subscriptions with Bearer apiKey", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_CREDITS))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_SUB));

    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_test",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Go");
    expect(usage.quotas.session.remaining).toBe(76);
    expect(usage.quotas.weekly.remaining).toBe(2);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    const urls = proxyAwareFetch.mock.calls.map(([url]) => url).sort();
    expect(urls).toEqual([CREDITS_URL, SUBS_URL].sort());
    for (const [, opts] of proxyAwareFetch.mock.calls) {
      expect(opts.method).toBe("GET");
      expect(opts.headers.Authorization).toBe("Bearer user_test");
    }
  });

  it("returns message on missing key / 401", async () => {
    const missing = await getUsageForProvider({ provider: "commandcode" });
    expect(missing.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "no" }, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401));
    const auth = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "bad",
    });
    expect(auth.message).toMatch(/auth|key|401/i);
  });
});

describe("parseQuotaData(commandcode)", () => {
  it("forwards Codex remaining percent for session/weekly", () => {
    const rows = parseQuotaData("commandcode", {
      plan: "Go",
      quotas: {
        session: { used: 24, total: 100, remaining: 76, resetAt: "2026-08-15T07:41:00.625Z" },
        weekly: { used: 98, total: 100, remaining: 2, resetAt: "2026-08-17T11:43:26.089Z" },
        Monthly: { used: 5.8868, total: 10, resetAt: "2026-09-10T11:37:39.000Z" },
      },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ name: "session", used: 24, remaining: 76 });
    expect(rows[1]).toMatchObject({ name: "weekly", used: 98, remaining: 2 });
    expect(rows[2]).toMatchObject({ name: "Monthly", used: 5.8868, total: 10 });
    expect(rows[2].remaining).toBeUndefined();
  });
});
