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

  it("maps creditUsagePercent as Weekly SuperGrok for unified billing", () => {
    const parsed = parseGrokCliBilling(UNIFIED_WEEKLY_BILLING, SUPERGROK_USER);
    expect(parsed.plan).toBe("SuperGrok");
    expect(parsed.quotas["Weekly SuperGrok"]).toMatchObject({
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

  it("treats omitted zero percent as Weekly SuperGrok 0% used", () => {
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
    expect(parsed.quotas["Weekly SuperGrok"]).toMatchObject({
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(parsed.quotas["On-demand"]).toBeUndefined();
    expect(parsed.exhausted).toBe(false);
  });

  it("treats creditUsagePercent: 0 as full Weekly SuperGrok remaining", () => {
    const zero = {
      config: {
        ...UNIFIED_WEEKLY_BILLING.config,
        creditUsagePercent: 0,
        productUsage: [{ product: "GrokBuild", usagePercent: 0 }],
      },
    };
    const parsed = parseGrokCliBilling(zero, SUPERGROK_USER);
    expect(parsed.quotas["Weekly SuperGrok"]).toMatchObject({
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(parsed.quotas["On-demand"]).toBeUndefined();
  });

  it("estimates free Build tokens instead of fake On-demand 1/1", () => {
    // Free farmed accounts: billing returns cap=0 with no weekly percent.
    // Free accounts currently use a 500k rolling pool; local audits estimate usage.
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, USER_PROFILE, {
      observedTokens: 988,
    });
    expect(parsed.plan).toBe("Free");
    expect(parsed.freeProfile).toBe(true);
    expect(parsed.quotas["On-demand"]).toBeUndefined();
    expect(parsed.quotas["Local usage (rolling 24h)"]).toMatchObject({
      used: 988,
      total: 500_000,
      remainingPercentage: expect.closeTo(99.8024, 3),
      estimated: true,
      unit: "tokens",
    });
    expect(parsed.exhausted).toBe(false);
  });

  it("uses a learned per-account free token limit when upstream changes it", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, USER_PROFILE, {
      observedTokens: 100_000,
      freeTokenLimit: 750_000,
    });
    expect(parsed.quotas["Local usage (rolling 24h)"]).toMatchObject({
      used: 100_000,
      total: 750_000,
      remainingPercentage: expect.closeTo(86.6667, 3),
    });
  });

  it("shows local rolling usage and authoritative upstream snapshot separately", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, USER_PROFILE, {
      observedTokens: 12_000,
      freeTokensActual: 510_000,
      freeTokenLimit: 500_000,
    });
    expect(parsed.quotas["Local usage (rolling 24h)"]).toMatchObject({
      used: 12_000,
      total: 500_000,
      estimated: true,
    });
    expect(parsed.quotas["Upstream quota snapshot"]).toMatchObject({
      used: 510_000,
      total: 500_000,
      estimated: false,
      snapshot: true,
      remainingPercentage: 0,
    });
  });

  it("shows unused free account as 0 / 500_000 tokens", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, USER_PROFILE);
    expect(parsed.plan).toBe("Free");
    expect(parsed.quotas["Local usage (rolling 24h)"]).toMatchObject({
      used: 0,
      total: 500_000,
      remainingPercentage: 100,
    });
    expect(parsed.exhausted).toBe(false);
  });

  it("marks free tokens exhausted when local usage hits the estimate limit", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, USER_PROFILE, {
      observedTokens: 1_065_387,
    });
    expect(parsed.quotas["Local usage (rolling 24h)"].remainingPercentage).toBe(0);
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

  it("does not report paid subscription access as depleted on-demand credit", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, {
      ...USER_PROFILE,
      subscriptionTier: "XPremiumPlus",
    });
    expect(parsed.plan).toBe("XPremiumPlus");
    expect(parsed.subscriptionAccess).toBe(true);
    expect(parsed.quotas).toEqual({});
    expect(parsed.exhausted).toBe(false);
  });

  it("maps creditUsagePercent to a single Weekly SuperGrok bar (not productUsage)", () => {
    const parsed = parseGrokCliBilling(
      {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-07-17T12:42:26.494595+00:00",
            end: "2026-07-24T12:42:26.494595+00:00",
          },
          creditUsagePercent: 99.0,
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
          productUsage: [
            { product: "GrokBuild", usagePercent: 97.0 },
            { product: "GrokImagine", usagePercent: 2.0 },
          ],
          isUnifiedBillingUser: true,
          prepaidBalance: { val: 0 },
          billingPeriodStart: "2026-07-17T12:42:26.494595+00:00",
          billingPeriodEnd: "2026-07-24T12:42:26.494595+00:00",
        },
      },
      { subscriptionTier: "XPremiumPlus", hasGrokCodeAccess: true },
    );
    // Single shared-pool bar from creditUsagePercent
    expect(parsed.quotas["Weekly SuperGrok"]).toMatchObject({
      used: 99,
      total: 100,
      remainingPercentage: 1,
      resetAt: "2026-07-24T12:42:26.494Z",
      unlimited: false,
    });
    // productUsage must NOT become independent quota bars
    expect(Object.keys(parsed.quotas)).toEqual(["Weekly SuperGrok"]);
    expect(parsed.exhausted).toBe(false);
  });

  it("maps current monthly fields and snake-case subscription tier", () => {
    const parsed = parseGrokCliBilling({
      monthlyLimit: { val: 1000 },
      includedUsed: { val: 275 },
      totalUsed: { val: 300 },
      resetAt: "2026-08-01T00:00:00Z",
    }, {
      subscription_tier: "premium_plus",
    });
    expect(parsed.plan).toBe("Premium Plus");
    expect(parsed.quotas["Monthly included"]).toMatchObject({
      used: 275,
      total: 1000,
      remainingPercentage: 72.5,
      resetAt: "2026-08-01T00:00:00.000Z",
    });
  });
});

function encodeVarint(value) {
  const bytes = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0n);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeFixed32Field(fieldNumber, value) {
  const body = Buffer.alloc(4);
  body.writeFloatLE(value, 0);
  return Buffer.concat([encodeTag(fieldNumber, 5), body]);
}

function encodeLengthDelimited(fieldNumber, body) {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(body.length), body]);
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

function encodeTimestampField(fieldNumber, seconds, nanos) {
  const parts = [];
  if (seconds !== 0) parts.push(encodeVarintField(1, seconds));
  if (nanos !== 0) parts.push(encodeVarintField(2, nanos));
  return encodeLengthDelimited(fieldNumber, Buffer.concat(parts));
}

/** Framed GetGrokCreditsConfig response for a usage ratio 0..1. */
function buildCreditsResponseBuffer(usageRatio, resetSeconds = 1784825940, resetNanos = 867850000) {
  const creditsInfo = Buffer.concat([
    encodeFixed32Field(1, usageRatio),
    encodeTimestampField(5, resetSeconds, resetNanos),
  ]);
  const topMessage = encodeLengthDelimited(1, creditsInfo);
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(topMessage.length, 1);
  return Buffer.concat([header, topMessage]);
}

function binaryResponse(buffer, status = 200) {
  return new Response(buffer, {
    status,
    headers: { "content-type": "application/grpc-web+proto" },
  });
}

function accessTokenWithTier(tier) {
  const payload = Buffer.from(JSON.stringify({ tier })).toString("base64url");
  return `header.${payload}.signature`;
}

const EMPTY_GRPC_WEB_FRAME = Buffer.from([0, 0, 0, 0, 0]);
const GRPC_CREDITS_URL =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

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
    expect(billingCall[1].headers["x-grok-client-version"]).toBe("0.2.99");
    expect(billingCall[1].headers["x-grok-client-identifier"]).toBe("grok-shell");
    expect(billingCall[1].headers["x-userid"]).toBe(
      "d84768dd-224d-4052-ba49-0d336fa9160c",
    );
    // REST already has numeric quotas — do not hit gRPC fallback
    expect(proxyAwareFetch.mock.calls).toHaveLength(2);
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
    expect(usage.quotas["Weekly SuperGrok"]).toMatchObject({
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
    // Auth failure must not attempt gRPC fallback
    expect(proxyAwareFetch.mock.calls).toHaveLength(2);
  });

  it("returns free token estimate without blocking message when cap is zero", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(jsonResponse(USER_PROFILE));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
      observedTokens: 988,
    });

    // Dashboard hides QuotaTable when `message` is set — keep message empty
    // so the free estimate bar still renders.
    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Free");
    expect(usage.quotas["On-demand"]).toBeUndefined();
    expect(usage.quotas["Local usage (rolling 24h)"]).toMatchObject({
      used: 988,
      total: 500_000,
    });
    // Free rolling quota is resolved locally; do not hit the paid gRPC endpoint.
    expect(proxyAwareFetch.mock.calls).toHaveLength(2);
  });

  it("falls back to GetGrokCreditsConfig gRPC when paid sub has no REST numeric quota", async () => {
    const accessToken = accessTokenWithTier(5);
    const resetSeconds = 1784825940;
    const resetNanos = 867850000;
    const resetAt = new Date(
      resetSeconds * 1000 + Math.round(resetNanos / 1_000_000),
    ).toISOString();

    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(
        jsonResponse({
          ...USER_PROFILE,
          subscriptionTier: "XPremiumPlus",
        }),
      )
      .mockResolvedValueOnce(binaryResponse(buildCreditsResponseBuffer(0.35, resetSeconds, resetNanos)));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken,
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("SuperGrok Heavy");
    expect(usage.quotas["Weekly SuperGrok"]).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
      resetAt,
      unlimited: false,
    });

    const grpcCall = proxyAwareFetch.mock.calls[2];
    expect(grpcCall[0]).toBe(GRPC_CREDITS_URL);
    expect(grpcCall[1].method).toBe("POST");
    expect(grpcCall[1].headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(grpcCall[1].headers["Content-Type"]).toBe("application/grpc-web+proto");
    expect(grpcCall[1].headers["X-Grpc-Web"]).toBe("1");
    // Empty gRPC-web request frame is required (flag 0 + length 0)
    expect(Buffer.from(grpcCall[1].body)).toEqual(EMPTY_GRPC_WEB_FRAME);
  });

  it("keeps subscription message when REST empty and gRPC fails open", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(
        jsonResponse({
          ...USER_PROFILE,
          subscriptionTier: "XPremiumPlus",
        }),
      )
      .mockResolvedValueOnce(binaryResponse(Buffer.alloc(0), 500));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
    });

    expect(usage.plan).toBe("XPremiumPlus");
    expect(usage.message).toMatch(/active.*numeric included quota/i);
    expect(usage.quotas).toEqual({});
  });

  it("does not throw when gRPC network fails after empty REST quotas", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(
        jsonResponse({
          ...USER_PROFILE,
          subscriptionTier: "XPremiumPlus",
        }),
      )
      .mockRejectedValueOnce(new Error("network down"));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
    });

    expect(usage.message).toMatch(/active.*numeric included quota/i);
    expect(usage.quotas).toEqual({});
  });
});

describe("parseQuotaData(grok-cli)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("grok-cli", {
      plan: "SuperGrok",
      quotas: {
        "Weekly SuperGrok": {
          used: 7,
          total: 100,
          remainingPercentage: 93,
          resetAt: "2026-07-20T07:11:02.938Z",
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Weekly SuperGrok",
      used: 7,
      total: 100,
      remainingPercentage: 93,
    });
  });
});
