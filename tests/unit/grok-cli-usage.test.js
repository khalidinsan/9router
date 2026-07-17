import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseGrokCliBilling } from "../../open-sse/services/usage/grok-cli.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EXHAUSTED_BILLING = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-08T00:00:00+00:00",
      end: "2026-07-15T00:00:00+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-07-08T00:00:00+00:00",
    billingPeriodEnd: "2026-07-15T00:00:00+00:00",
  },
};

/** Live SuperGrok shape: onDemandCap=0 but creditUsagePercent set. */
const UNIFIED_WEEKLY_BILLING = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-13T07:11:02.938098+00:00",
      end: "2026-07-20T07:11:02.938098+00:00",
    },
    creditUsagePercent: 7.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [
      { product: "GrokBuild", usagePercent: 7.0 },
      { product: "Api" },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-07-13T07:11:02.938098+00:00",
    billingPeriodEnd: "2026-07-20T07:11:02.938098+00:00",
  },
};

const ACTIVE_BILLING = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-08T00:00:00+00:00",
      end: "2026-07-15T00:00:00+00:00",
    },
    onDemandCap: { val: 100 },
    onDemandUsed: { val: 35 },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 12.5 },
    billingPeriodStart: "2026-07-08T00:00:00+00:00",
    billingPeriodEnd: "2026-07-15T00:00:00+00:00",
  },
};

const USER_PROFILE = {
  userId: "d84768dd-224d-4052-ba49-0d336fa9160c",
  email: "user@example.com",
  hasGrokCodeAccess: true,
  subscriptionTier: null,
};

const SUPERGROK_USER = {
  ...USER_PROFILE,
  // Live API field; value is often "GrokPro" for SuperGrok consumers
  subscriptionTier: "GrokPro",
};

describe("grok-cli registry usage flag", () => {
  it("exposes transport.usage urls", () => {
    const cfg = PROVIDERS["grok-cli"];
    expect(cfg.usage?.url).toContain("/v1/billing");
    expect(cfg.usage?.userUrl).toContain("/v1/user");
  });

  it("is listed in USAGE_SUPPORTED_PROVIDERS", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("grok-cli");
  });
});

describe("parseGrokCliBilling", () => {
  it("maps on-demand cap/used + prepaid balance", () => {
    const parsed = parseGrokCliBilling(ACTIVE_BILLING, USER_PROFILE);
    expect(parsed.plan).toBe("Grok Code");
    expect(parsed.quotas["On-demand"]).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });
    // Prepaid is remaining-balance style: 0 used of current pot
    expect(parsed.quotas.Prepaid).toMatchObject({
      used: 0,
      total: 12.5,
      remainingPercentage: 100,
    });
    expect(parsed.exhausted).toBe(false);
  });

  it("maps creditUsagePercent as Weekly for SuperGrok unified billing", () => {
    const parsed = parseGrokCliBilling(UNIFIED_WEEKLY_BILLING, SUPERGROK_USER);
    expect(parsed.plan).toBe("SuperGrok");
    expect(parsed.quotas.Weekly).toMatchObject({
      used: 7,
      total: 100,
      remainingPercentage: 93,
    });
    // Same % as aggregate — do not double-count GrokBuild
    expect(parsed.quotas["Grok Build"]).toBeUndefined();
    // Cap 0 must NOT synthesize depleted On-demand when percent exists
    expect(parsed.quotas["On-demand"]).toBeUndefined();
    expect(parsed.exhausted).toBe(false);
  });

  it("treats omitted zero percent as Weekly 0% used (unused SuperGrok)", () => {
    // protobuf-json often omits zero fields; unused accounts look like this.
    const unused = {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T07:11:02.938098+00:00",
          end: "2026-07-20T07:11:02.938098+00:00",
        },
        // no creditUsagePercent
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        productUsage: [{ product: "GrokBuild" }, { product: "Api" }],
        isUnifiedBillingUser: true,
        prepaidBalance: { val: 0 },
        billingPeriodEnd: "2026-07-20T07:11:02.938098+00:00",
      },
    };
    const parsed = parseGrokCliBilling(unused, SUPERGROK_USER);
    expect(parsed.plan).toBe("SuperGrok");
    expect(parsed.quotas.Weekly).toMatchObject({
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(parsed.quotas["On-demand"]).toBeUndefined();
    expect(parsed.exhausted).toBe(false);
  });

  it("treats creditUsagePercent: 0 as full Weekly remaining", () => {
    const zero = {
      config: {
        ...UNIFIED_WEEKLY_BILLING.config,
        creditUsagePercent: 0,
        productUsage: [{ product: "GrokBuild", usagePercent: 0 }],
      },
    };
    const parsed = parseGrokCliBilling(zero, SUPERGROK_USER);
    expect(parsed.quotas.Weekly).toMatchObject({
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(parsed.quotas["On-demand"]).toBeUndefined();
  });

  it("marks depleted free/promo account as exhausted", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, USER_PROFILE);
    expect(parsed.quotas["On-demand"].remainingPercentage).toBe(0);
    expect(parsed.exhausted).toBe(true);
  });

  it("maps GrokPro subscriptionTier to SuperGrok", () => {
    const parsed = parseGrokCliBilling(ACTIVE_BILLING, SUPERGROK_USER);
    expect(parsed.plan).toBe("SuperGrok");
  });

  it("accepts super_grok alias for plan name", () => {
    const parsed = parseGrokCliBilling(ACTIVE_BILLING, {
      ...USER_PROFILE,
      subscriptionTier: "super_grok",
    });
    expect(parsed.plan).toBe("SuperGrok");
  });
});

describe("getUsageForProvider(grok-cli)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns normalized quotas from billing + user endpoints", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(ACTIVE_BILLING))
      .mockResolvedValueOnce(jsonResponse(USER_PROFILE));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
      providerSpecificData: {
        email: "user@example.com",
        userId: "d84768dd-224d-4052-ba49-0d336fa9160c",
      },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Grok Code");
    expect(usage.quotas["On-demand"]).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });
    expect(usage.quotas.Prepaid).toMatchObject({
      used: 0,
      total: 12.5,
      remainingPercentage: 100,
    });

    // Official CLI fingerprint headers
    const billingCall = proxyAwareFetch.mock.calls[0];
    expect(billingCall[0]).toContain("/v1/billing");
    expect(billingCall[1].headers.Authorization).toBe("Bearer test-token");
    expect(billingCall[1].headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(billingCall[1].headers["x-userid"]).toBe(
      "d84768dd-224d-4052-ba49-0d336fa9160c",
    );
  });

  it("returns Weekly percent for SuperGrok unified billing", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(UNIFIED_WEEKLY_BILLING))
      .mockResolvedValueOnce(jsonResponse(SUPERGROK_USER));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("SuperGrok");
    expect(usage.quotas.Weekly).toMatchObject({
      used: 7,
      total: 100,
      remainingPercentage: 93,
    });
    expect(usage.quotas["On-demand"]).toBeUndefined();
  });

  it("surfaces auth-expired message on 401", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(USER_PROFILE));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "expired",
    });

    expect(usage.message).toMatch(/expired|re-authorize/i);
  });

  it("returns depleted on-demand bar without blocking message when cap is zero", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(jsonResponse(USER_PROFILE));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
    });

    // Dashboard hides QuotaTable when `message` is set — keep message empty
    // so the 0% bar still renders for exhausted free/promo accounts.
    expect(usage.message).toBeUndefined();
    expect(usage.quotas["On-demand"].remainingPercentage).toBe(0);
    expect(usage.quotas["On-demand"].total).toBe(1);
  });
});

describe("parseQuotaData(grok-cli)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("grok-cli", {
      plan: "SuperGrok",
      quotas: {
        Weekly: {
          used: 7,
          total: 100,
          remainingPercentage: 93,
          resetAt: "2026-07-20T07:11:02.938Z",
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Weekly",
      used: 7,
      total: 100,
      remainingPercentage: 93,
    });
  });
});
