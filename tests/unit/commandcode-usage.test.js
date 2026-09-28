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
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const BASE = "https://api.commandcode.ai";
const CREDITS_URL = `${BASE}/alpha/billing/credits`;
const SUBS_URL = `${BASE}/alpha/billing/subscriptions`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Verbatim Go-plan payloads captured from a live account.
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

const WHOAMI = {
  user: { name: "Hieu", email: "hieu@example.com" },
  org: { id: "org_1", name: "personal" },
};
const ORG_CREDITS = {
  credits: { monthlyCredits: 12.5, purchasedCredits: 1, freeCredits: 0.5 },
  windowLimits: {
    fiveHour: { used: 2, cap: 10, resetAt: Date.now() + 3_600_000, exceeded: false },
    weekly: { used: 20, cap: 70, resetAt: Date.now() + 86_400_000, exceeded: false },
  },
};
const ORG_SUB = {
  data: {
    planId: "individual-goat",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
  },
};

function mockHappyPath() {
  proxyAwareFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("/alpha/whoami")) return jsonResponse(WHOAMI);
    if (u.includes("/alpha/billing/credits")) return jsonResponse(ORG_CREDITS);
    if (u.includes("/alpha/billing/subscriptions")) return jsonResponse(ORG_SUB);
    return jsonResponse({ error: "unexpected " + u }, 404);
  });
}

describe("commandcode registry usage flags", () => {
  it("is listed for the apikey quota dashboard", () => {
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

  // A plan id that is absent from the map yields allotment 0, which drops the
  // Monthly row silently while the 5h/weekly windows keep rendering. Payloads
  // below are verbatim from live accounts.
  it("sizes the GOAT plan monthly pool at $70", () => {
    const parsed = parseCommandCodeUsage(
      {
        credits: {
          belowThreshold: false,
          creditThreshold: 0,
          monthlyCredits: 69.633978792,
          purchasedCredits: 0,
          freeCredits: 0,
        },
        windowLimits: {
          limited: true,
          exceeded: null,
          fiveHour: { used: 0.366021208, cap: 14, exceeded: false, resetAt: 1789051561193 },
          weekly: { used: 0.366021208, cap: 35, exceeded: false, resetAt: 1789638361193 },
        },
      },
      {
        success: true,
        data: {
          status: "active",
          planId: "individual-goat",
          currentPeriodStart: "2026-09-10T06:03:49.000Z",
          currentPeriodEnd: "2026-10-10T06:03:49.000Z",
        },
      },
    );

    expect(parsed.plan).toBe("GOAT");
    expect(parsed.quotas.session).toMatchObject({ used: 3, total: 100, remaining: 97 });
    expect(parsed.quotas.weekly).toMatchObject({ used: 1, total: 100, remaining: 99 });
    expect(parsed.quotas.Monthly).toMatchObject({ used: 0.366, total: 70 });
    expect(parsed.quotas.Monthly.resetAt).toBe("2026-10-10T06:03:49.000Z");
  });

  it("sizes the Pro plan monthly pool at $80", () => {
    const parsed = parseCommandCodeUsage(
      { credits: { monthlyCredits: 60 }, windowLimits: {} },
      { data: { status: "active", planId: "individual-pro" } },
    );
    expect(parsed.plan).toBe("Pro");
    expect(parsed.quotas.Monthly).toMatchObject({ used: 20, total: 80 });
  });

  it("keeps percent windows when the subscription payload is missing (fail-open)", () => {
    const parsed = parseCommandCodeUsage(ORG_CREDITS, null);
    expect(parsed.plan).toBe("Command Code");
    expect(parsed.quotas.session).toMatchObject({ used: 20, total: 100 });
    expect(parsed.quotas.weekly).toMatchObject({ used: 29, total: 100 });
    expect(parsed.quotas.Monthly).toBeUndefined();
  });
});

describe("getUsageForProvider(commandcode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a message when apiKey is missing", async () => {
    const usage = await getUsageForProvider({ provider: "commandcode" });
    expect(usage.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("GETs whoami then credits + subscriptions with orgId and Bearer apiKey", async () => {
    mockHappyPath();
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_test",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("GOAT");

    const urls = proxyAwareFetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.startsWith(`${BASE}/alpha/whoami`))).toBe(true);
    expect(urls.some((u) => u.includes("/alpha/billing/credits") && u.includes("orgId=org_1"))).toBe(true);
    expect(urls.some((u) => u.includes("/alpha/billing/subscriptions") && u.includes("orgId=org_1"))).toBe(true);
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer user_test");
    for (const [, opts] of proxyAwareFetch.mock.calls) {
      expect(opts.method).toBe("GET");
    }

    // fiveHour 2/10 and weekly 20/70 are surfaced as 0-100 percent bars;
    // the Monthly dollar pot is sized from the plan allotment minus remaining.
    expect(usage.quotas.session).toMatchObject({ used: 20, total: 100, remaining: 80 });
    expect(usage.quotas.weekly).toMatchObject({ used: 29, total: 100, remaining: 71 });
    expect(usage.quotas.Monthly).toMatchObject({ used: 57.5, total: 70 });
  });

  it("falls back to the registry billing urls when the base is default", async () => {
    mockHappyPath();
    await getUsageForProvider({ provider: "commandcode", apiKey: "user_test" });
    const urls = proxyAwareFetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.startsWith(CREDITS_URL))).toBe(true);
    expect(urls.some((u) => u.startsWith(SUBS_URL))).toBe(true);
  });

  it("returns an auth message when whoami rejects the key", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "bad",
    });
    expect(usage.message).toMatch(/auth|key|401/i);
  });

  it("returns an auth message when credits rejects the key", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(WHOAMI))
      .mockResolvedValueOnce(jsonResponse({ error: "no" }, 403))
      .mockResolvedValueOnce(jsonResponse({}, 200));
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "bad",
    });
    expect(usage.message).toMatch(/auth|key|401|403/i);
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
    // The monthly dollar pot must survive normalization — dropping it is how a
    // plan change silently reduced this tracker to two percent bars.
    expect(rows).toHaveLength(3);
    // Assert the stable quota key, not the human-readable label: `name` is a
    // display string this module is free to rename.
    expect(rows[0]).toMatchObject({ quotaType: "session", used: 24, remaining: 76 });
    expect(rows[1]).toMatchObject({ quotaType: "weekly", used: 98, remaining: 2 });
    expect(rows[2]).toMatchObject({ quotaType: "Monthly", used: 5.8868, total: 10 });
    expect(rows[2].remaining).toBeUndefined();
    // `session` is the key the dashboard maps to the "5h" label.
    expect(rows[0].name).toBe("5h");
  });
});
