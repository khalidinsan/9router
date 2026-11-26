import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData, getRemainingPercentage } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shape returned by GET /v1/billing/budget for the account that reports
// `402 billing_api_budget_exhausted` on a Vibe-type key.
const EXHAUSTED_API_BUDGET = {
  vibe_budget: {
    usage_percentage: 0.061912092,
    initial_budget: 255.0,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
  api_budget: {
    usage_percentage: 100.0,
    initial_budget: 25.5,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
  usage_percentage: 100.0,
  initial_budget: 25.5,
  currency: "EUR",
  reset_at: "2026-12-01T00:00:00Z",
};

const connection = {
  provider: "mistral",
  apiKey: "mstrl_test_key",
  providerSpecificData: { authMethod: "browser-sign-in", keyType: "vibe", plan: "INDIVIDUAL", planType: "CHAT" },
};

describe("Mistral usage", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

  it("registers both usage flags so the dashboard fetches it for API-key connections", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("mistral");
    expect(USAGE_APIKEY_PROVIDERS).toContain("mistral");
  });

  it("reports the vibe and api budgets of the organization", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse(EXHAUSTED_API_BUDGET));
    const usage = await getUsageForProvider(connection);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(BUDGET_URL);
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer mstrl_test_key");

    expect(usage.plan).toBe("INDIVIDUAL · CHAT");
    expect(usage.quotas["Vibe budget"]).toMatchObject({
      used: 0.16,
      total: 255,
      resetAt: "2026-12-01T00:00:00Z",
      unit: "EUR",
    });
    expect(usage.quotas["API budget"]).toMatchObject({ used: 25.5, total: 25.5 });
  });

  it("renders a spent API budget next to an untouched Vibe budget", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse(EXHAUSTED_API_BUDGET));
    const usage = await getUsageForProvider(connection);
    const rows = parseQuotaData("mistral", usage);

    expect(rows.map((r) => r.name)).toEqual(["Vibe budget", "API budget"]);
    expect(rows[0].unit).toBe("EUR");
    expect(getRemainingPercentage(rows[0])).toBe(100);
    expect(getRemainingPercentage(rows[1])).toBe(0);
  });

  it("shows a console key only the budget it can spend", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse(EXHAUSTED_API_BUDGET));
    const usage = await getUsageForProvider({
      ...connection,
      providerSpecificData: { authMethod: "manual", keyType: "api" },
    });

    expect(usage.keyType).toBe("api");
    expect(usage.quotas["Vibe budget"]).toBeUndefined();
    expect(usage.quotas["API budget"]).toMatchObject({ used: 25.5, total: 25.5 });
  });

  it("surfaces an auth failure instead of a quota", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ detail: "Invalid API Key" }, 401));
    const usage = await getUsageForProvider(connection);
    expect(usage.message).toMatch(/authentication failed/i);
    expect(usage.quotas).toBeUndefined();
  });

  it("asks for a key when the connection has none", async () => {
    const usage = await getUsageForProvider({ provider: "mistral", apiKey: null });
    expect(usage.message).toMatch(/API key not available/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
