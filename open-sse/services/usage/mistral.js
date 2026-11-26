/**
 * Mistral usage — GET https://api.mistral.ai/v1/billing/budget
 * Auth: Bearer <apiKey>
 *
 * Mistral meters two budgets per organization:
 *   • vibe_budget — the Vibe (Le Chat plan) allowance
 *   • api_budget  — console/Studio keys, pay-as-you-go token budget
 *
 * A Vibe-type key is meant to draw on vibe_budget, but the API gates inference
 * on api_budget: once that hits 100% every completion answers
 * `402 billing_api_budget_exhausted` (code 2303) even while vibe_budget has
 * room (mistralai/mistral-vibe#1589). Reporting both buckets is what makes that
 * error readable instead of looking like the gateway picked the wrong quota.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

// Order matters: the Vibe allowance is the one a Vibe key is supposed to spend.
const BUCKETS = [
  { key: "vibe_budget", label: "Vibe budget" },
  { key: "api_budget", label: "API budget" },
];

function buildQuota(bucket) {
  const total = toFiniteNumber(bucket?.initial_budget, 0);
  // usage_percentage is the used share on a 0-100 scale, decimals included:
  // 6.19 means 6.19% of initial_budget has been spent.
  const usedPercent = Math.min(100, Math.max(0, toFiniteNumber(bucket?.usage_percentage, 0)));
  const used = Math.round(((total * usedPercent) / 100) * 100) / 100;

  return {
    used,
    total,
    resetAt: typeof bucket?.reset_at === "string" ? bucket.reset_at : null,
    unlimited: false,
    // payg_enabled lets the budget overspend into pay-as-you-go instead of
    // hard-failing, so a full bar is informational rather than a lockout.
    paygEnabled: bucket?.payg_enabled === true,
    unit: typeof bucket?.currency === "string" ? bucket.currency.toUpperCase() : null,
  };
}

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 * @param {object|null} providerSpecificData
 */
export async function getMistralUsage(apiKey = null, proxyOptions = null, providerSpecificData = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Mistral API key not available. Add a key to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      BUDGET_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return { plan: "Mistral", message: "Mistral authentication failed. Check the API key." };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: "Mistral",
        message: `Mistral budget API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { plan: "Mistral", message: "Mistral budget response was not JSON." };
    }

    const quotas = {};
    for (const { key, label } of BUCKETS) {
      const bucket = data[key];
      if (!bucket || typeof bucket !== "object") continue;
      quotas[label] = buildQuota(bucket);
    }

    // The flat fields describe the budget that gates inference (api_budget);
    // fall back to them when the named buckets are missing.
    if (Object.keys(quotas).length === 0 && data.initial_budget != null) {
      quotas["API budget"] = buildQuota(data);
    }

    if (Object.keys(quotas).length === 0) {
      return { plan: "Mistral", message: "Mistral returned no budget data for this key." };
    }

    const planName = typeof providerSpecificData?.plan === "string" ? providerSpecificData.plan : null;
    const planType = typeof providerSpecificData?.planType === "string" ? providerSpecificData.planType : null;
    const plan = [planName, planType].filter(Boolean).join(" · ") || "Mistral";

    return { plan, quotas };
  } catch (error) {
    return { message: `Mistral error: ${error.message}` };
  }
}
