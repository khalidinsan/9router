/**
 * Grok CLI / Grok Build usage handler
 *
 * Source of truth: official grok-shell/grok-pager traffic to cli-chat-proxy.grok.com
 *   GET /v1/billing?format=credits
 *   GET /v1/user?include=subscription
 *
 * Hybrid shape (fork + upstream v0.5.35):
 * {
 *   config: {
 *     currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
 *     creditUsagePercent: 7.0,          // unified weekly allotment (SuperGrok)
 *     productUsage: [                   // per-product weekly bars
 *       { product: "GrokBuild", usagePercent: 7.0 },
 *       { product: "Api" }
 *     ],
 *     monthlyLimit / includedUsed,      // optional monthly included window
 *     onDemandCap: { val },             // 0 for unified-billing sub accounts
 *     onDemandUsed: { val },
 *     prepaidBalance: { val },
 *     isUnifiedBillingUser: true,
 *     billingPeriodStart, billingPeriodEnd
 *   }
 * }
 *
 * Free Build accounts: billing does NOT expose the rolling free token pool.
 * grok2api estimates ~1_000_000 tokens / rolling 24h from local usage audits
 * (confirmed by free-usage-exhausted: "tokens (actual/limit): N/1000000").
 * Free tokens = observedTokens (local 24h) / 1_000_000 estimated.
 * Do NOT show a fake depleted "On-demand 1/1" bar for free accounts.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_USER_AGENT,
  GROK_CLI_VERSION,
} from "../../config/grokCli.js";

const USAGE = U("grok-cli");
const BILLING_URL = USAGE.url || "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const USER_URL = USAGE.userUrl || "https://cli-chat-proxy.grok.com/v1/user?include=subscription";

/** Free Build rolling window (matches grok2api estimatedFreeTokenLimit + freeUsageWindow). */
export const GROK_CLI_FREE_TOKEN_LIMIT = 1_000_000;
export const GROK_CLI_FREE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FREE_TOKEN_QUOTA_NAME = "Free tokens (est. 24h)";

/** Unwrap protobuf-json `{ val: n }` or plain numbers/strings. */
function unwrapVal(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "object" && !Array.isArray(value) && "val" in value) {
    return toFiniteNumber(value.val, fallback);
  }
  return toFiniteNumber(value, fallback);
}

function normalizePlanKey(value) {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[\s_\-+]+/g, "").replace(/plus$/i, "plus");
}

function isFreePlanName(value) {
  const key = normalizePlanKey(value);
  return (
    key === "free" ||
    key === "grokfree" ||
    key === "freetier" ||
    key === "basic" ||
    key === "grokbasic" ||
    key === "xbasic"
  );
}

function isPaidPlanName(value) {
  const key = normalizePlanKey(value);
  return (
    key === "super" ||
    key === "supergrok" ||
    key === "supergrokpro" ||
    key === "supergrokheavy" ||
    key === "supergroklite" ||
    key === "grokpro" ||
    key === "xpremium" ||
    key === "xpremiumplus" ||
    key === "apikey"
  );
}

function buildGrokCliHeaders(accessToken, providerSpecificData = {}) {
  const psd = providerSpecificData || {};
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": GROK_CLI_USER_AGENT,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "headless",
  };
  const email = psd.email;
  const userId = psd.userId || psd.principalId;
  if (email) headers["x-email"] = email;
  if (userId) headers["x-userid"] = userId;
  return headers;
}

/**
 * Map API tier strings to display names.
 * API often returns "GrokPro" for SuperGrok consumers — show SuperGrok.
 */
function formatPlanName(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const key = trimmed.toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = {
    grokpro: "SuperGrok",
    supergrok: "SuperGrok",
    super: "SuperGrok",
    grokcode: "Grok Code",
    grokbuild: "Grok Build",
    free: "Free",
  };
  if (aliases[key]) return aliases[key];

  // Unknown tiers: keep API token as-is (e.g. XPremiumPlus); only normalize separators.
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function subscriptionTier(user, config) {
  const rawTier =
    user?.subscriptionTier ??
    user?.subscriptionTiers ??
    user?.subscription_tier ??
    user?.subscription?.tier ??
    config?.subscriptionTier ??
    config?.subscriptionTiers ??
    config?.subscription_tier;
  return typeof rawTier === "string" ? rawTier.trim() : "";
}

function resolvePlan(user, config, { freeProfile = false } = {}) {
  const tier = subscriptionTier(user, config);
  if (isFreePlanName(tier) || freeProfile) return "Free";
  const named = formatPlanName(tier);
  if (named) return named;
  // hasGrokCodeAccess is true for free Build accounts too — do not treat as paid.
  if (user?.hasGrokCodeAccess === true && !freeProfile) return "Grok Code";
  if (config?.isUnifiedBillingUser === true) return "Grok Build";
  return "Grok Build";
}

/**
 * Paid billing signals (mirrors grok2api Billing.IsPaid, without plan name).
 * creditUsagePercent alone is NOT paid — free accounts can have a %.
 */
function hasPaidBillingSignals(config, root) {
  const monthlyLimit = unwrapVal(
    config.monthlyLimit ?? config.monthly_limit ?? root.monthlyLimit ?? root.monthly_limit,
    NaN,
  );
  const onDemandCap = unwrapVal(config.onDemandCap ?? root.onDemandCap, NaN);
  const onDemandUsed = unwrapVal(config.onDemandUsed ?? root.onDemandUsed, NaN);
  const prepaid = unwrapVal(config.prepaidBalance ?? root.prepaidBalance, NaN);
  return (
    (Number.isFinite(monthlyLimit) && monthlyLimit > 0) ||
    (Number.isFinite(onDemandCap) && onDemandCap > 0) ||
    (Number.isFinite(onDemandUsed) && onDemandUsed > 0) ||
    (Number.isFinite(prepaid) && prepaid > 0)
  );
}

function freeTokenQuota(observedTokens) {
  const used = Math.max(0, Math.floor(toFiniteNumber(observedTokens, 0)));
  const total = GROK_CLI_FREE_TOKEN_LIMIT;
  const remaining = Math.max(0, total - used);
  return {
    used,
    total,
    remainingPercentage: (remaining / total) * 100,
    // Rolling 24h window — exact wall-clock reset is unknown without exhaustion probe.
    resetAt: null,
    unlimited: false,
    estimated: true,
    unit: "tokens",
  };
}

function periodLabel(config) {
  const type = config?.currentPeriod?.type;
  if (typeof type === "string") {
    if (/WEEKLY/i.test(type)) return "Weekly";
    if (/MONTHLY/i.test(type)) return "Monthly";
    if (/DAILY/i.test(type)) return "Daily";
  }
  return "Weekly";
}

function productLabel(product) {
  if (typeof product !== "string" || !product.trim()) return "Usage";
  const key = product.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = {
    grokbuild: "Grok Build",
    api: "API",
    grok: "Grok",
  };
  if (aliases[key]) return aliases[key];
  return product
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Percent-used (0–100+) → dashboard quota row (remaining % of allotment). */
function percentQuota(usagePercent, resetAt) {
  const usedPct = Math.min(100, Math.max(0, toFiniteNumber(usagePercent, 0)));
  return {
    used: usedPct,
    total: 100,
    remainingPercentage: Math.max(0, 100 - usedPct),
    resetAt: resetAt || null,
    unlimited: false,
  };
}

function makeQuota({ used, total, resetAt, unlimited = false }) {
  const safeTotal = Math.max(0, toFiniteNumber(total, 0));
  const safeUsed = Math.max(0, toFiniteNumber(used, 0));
  // Do NOT set absolute `remaining` — QuotaTable's getRemainingPercentage treats
  // `remaining` as a 0–100 percentage (same trap as Qoder credits).
  if (unlimited || safeTotal === 0) {
    return {
      used: safeUsed,
      total: 0,
      remainingPercentage: unlimited ? 100 : 0,
      resetAt: resetAt || null,
      unlimited: true,
    };
  }
  const remaining = Math.max(0, safeTotal - safeUsed);
  const remainingPercentage = (remaining / safeTotal) * 100;
  return {
    used: safeUsed,
    total: safeTotal,
    remainingPercentage,
    resetAt: resetAt || null,
    unlimited: false,
  };
}

/**
 * Map billing JSON → normalized quotas object for the dashboard.
 * Returns { quotas, periodEnd, exhausted, subscriptionAccess, plan } or empty quotas.
 *
 * @param {object|null} billing
 * @param {object|null} user
 * @param {{ observedTokens?: number }} [options]
 *   observedTokens — tokens used through this connection in the free rolling window
 *   (typically last 24h from local usageHistory). Used only for Free estimate bars.
 */
export function parseGrokCliBilling(billing, user = null, options = {}) {
  const observedTokens = Math.max(0, Math.floor(toFiniteNumber(options?.observedTokens, 0)));
  const root = billing && typeof billing === "object" ? billing : {};
  const config =
    root.config && typeof root.config === "object" && !Array.isArray(root.config)
      ? root.config
      : root;

  const periodEnd =
    parseResetTime(config.billingPeriodEnd) ||
    parseResetTime(config.billing_period_end) ||
    parseResetTime(config.currentPeriod?.end) ||
    parseResetTime(config.resetAt || config.resetsAt || config.periodEnd) ||
    parseResetTime(root.billingPeriodEnd) ||
    parseResetTime(root.billing_period_end) ||
    parseResetTime(root.resetAt || root.resetsAt || root.periodEnd) ||
    null;

  const quotas = {};
  const label = periodLabel(config);
  const tier = subscriptionTier(user, config);
  // Free/Basic tiers are not "subscription access" (paid).
  const subscriptionAccess =
    Boolean(tier) && !isFreePlanName(tier) && !/^(none|null)$/i.test(tier);
  const paidPlan = isPaidPlanName(tier);
  const freePlan = isFreePlanName(tier);
  const paidBilling = hasPaidBillingSignals(config, root);

  // ── Primary (unified billing / SuperGrok): weekly credit % ──────────────
  // Official CLI /usage surfaces creditUsagePercent + productUsage, not on-demand $.
  // IMPORTANT: protobuf-json often OMITS zero fields. Unused SuperGrok accounts
  // may have no creditUsagePercent / usagePercent at all — that means 0% used,
  // not "exhausted free promo".
  const creditUsagePercent = unwrapVal(
    config.creditUsagePercent ?? root.creditUsagePercent,
    NaN,
  );
  const productUsage = Array.isArray(config.productUsage)
    ? config.productUsage
    : Array.isArray(root.productUsage)
      ? root.productUsage
      : [];

  const productPercents = productUsage
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const pct = unwrapVal(row.usagePercent ?? row.percent ?? row.usedPercent, NaN);
      if (!Number.isFinite(pct)) return null;
      return { product: row.product, usagePercent: pct };
    })
    .filter(Boolean);

  if (Number.isFinite(creditUsagePercent)) {
    // Aggregate weekly bar (matches official CLI weekly usage %)
    quotas[label] = percentQuota(creditUsagePercent, periodEnd);
    // Extra per-product bars only when they diverge from the aggregate
    for (const row of productPercents) {
      const usedPct = Math.min(100, Math.max(0, row.usagePercent));
      if (Math.abs(usedPct - Math.min(100, Math.max(0, creditUsagePercent))) < 0.01) continue;
      const name = productLabel(row.product);
      if (!quotas[name]) quotas[name] = percentQuota(row.usagePercent, periodEnd);
    }
  } else if (productPercents.length === 1) {
    quotas[label] = percentQuota(productPercents[0].usagePercent, periodEnd);
  } else if (productPercents.length > 1) {
    for (const row of productPercents) {
      const name = productLabel(row.product);
      if (!quotas[name]) quotas[name] = percentQuota(row.usagePercent, periodEnd);
    }
  }

  // Unused SuperGrok: productUsage rows without usagePercent, and/or zero
  // fields omitted entirely. Prefer Weekly@0% over a fake depleted On-demand bar.
  // Do NOT use hasGrokCodeAccess / "Grok Code" alone — free/promo exhausted
  // accounts often share that flag + isUnifiedBillingUser + WEEKLY period.
  if (Object.keys(quotas).length === 0) {
    const isUnified =
      config.isUnifiedBillingUser === true || root.isUnifiedBillingUser === true;
    const weeklyPeriod = /WEEKLY/i.test(String(config.currentPeriod?.type || ""));
    const isSuperGrokTier = formatPlanName(tier) === "SuperGrok";
    const hasProductRows = productUsage.length > 0;

    if (hasProductRows || (isUnified && weeklyPeriod && isSuperGrokTier)) {
      quotas[label] = percentQuota(0, periodEnd);
    }
  }

  // Optional monthly included window (upstream v0.5.35 — plain /v1/billing style)
  const monthlyLimit = unwrapVal(
    config.monthlyLimit ?? config.monthly_limit ?? root.monthlyLimit ?? root.monthly_limit,
    NaN,
  );
  const includedUsed = unwrapVal(
    config.includedUsed ?? config.included_used ?? root.includedUsed ?? root.included_used,
    NaN,
  );
  const totalUsed = unwrapVal(
    config.totalUsed ?? config.total_used ?? root.totalUsed ?? root.total_used,
    NaN,
  );
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0) {
    quotas["Monthly included"] = makeQuota({
      used: Number.isFinite(includedUsed)
        ? includedUsed
        : Number.isFinite(totalUsed)
          ? totalUsed
          : 0,
      total: monthlyLimit,
      resetAt: periodEnd,
    });
  }

  const hasPercentOrIncludedQuota = Object.keys(quotas).length > 0;

  // ── On-demand spending window (non-unified / dollar-cap accounts) ───────
  const onDemandCap = unwrapVal(config.onDemandCap ?? root.onDemandCap, NaN);
  const onDemandUsed = unwrapVal(config.onDemandUsed ?? root.onDemandUsed, NaN);
  if (Number.isFinite(onDemandCap) && onDemandCap > 0) {
    const used = Number.isFinite(onDemandUsed) ? Math.max(0, onDemandUsed) : 0;
    quotas["On-demand"] = makeQuota({
      used,
      total: onDemandCap,
      resetAt: periodEnd,
    });
  }

  // Prepaid top-up balance (remaining credits; no fixed allotment known)
  const prepaid = unwrapVal(config.prepaidBalance ?? root.prepaidBalance, NaN);
  if (Number.isFinite(prepaid) && prepaid > 0) {
    // Show full bar against the current balance (0 spent of this remaining pot).
    quotas["Prepaid"] = {
      used: 0,
      total: prepaid,
      remainingPercentage: 100,
      resetAt: null,
      unlimited: false,
    };
  }

  // Opportunistic richer credit envelopes (future / other account types)
  const creditBags = [
    root.credits,
    root.creditBalance,
    root.usage,
    config.credits,
    config.includedCredits,
    config.subscriptionCredits,
  ].filter((bag) => bag && typeof bag === "object" && !Array.isArray(bag));

  for (const bag of creditBags) {
    const total = unwrapVal(
      bag.total ?? bag.limit ?? bag.cap ?? bag.allocation ?? bag.amount,
      NaN,
    );
    const used = unwrapVal(bag.used ?? bag.spent ?? bag.consumed, NaN);
    const remaining = unwrapVal(bag.remaining ?? bag.balance ?? bag.left, NaN);
    if (Number.isFinite(total) && total > 0) {
      const resolvedUsed = Number.isFinite(used)
        ? used
        : Number.isFinite(remaining)
          ? Math.max(0, total - remaining)
          : 0;
      if (!quotas.Credits) {
        quotas.Credits = makeQuota({
          used: resolvedUsed,
          total,
          resetAt: parseResetTime(bag.resetAt || bag.resetsAt || bag.end) || periodEnd,
        });
      }
    } else if (Number.isFinite(remaining) && remaining >= 0 && !quotas.Credits) {
      quotas.Credits = {
        used: 0,
        total: remaining > 0 ? remaining : 1,
        remainingPercentage: remaining > 0 ? 100 : 0,
        resetAt: periodEnd,
        unlimited: false,
      };
    }
  }

  // ── Free Build rolling token estimate (grok2api-style) ──────────────────
  // Billing API does not return free token used/limit. When there is no paid
  // allotment and no paid tier, surface local 24h observed tokens vs ~1M.
  const freeProfile =
    freePlan ||
    (!paidPlan &&
      !subscriptionAccess &&
      !paidBilling &&
      !hasPercentOrIncludedQuota &&
      Object.keys(quotas).length === 0);

  if (freeProfile && Object.keys(quotas).length === 0) {
    quotas[FREE_TOKEN_QUOTA_NAME] = freeTokenQuota(observedTokens);
  }

  // Exhausted when every finite quota bar is at 0% remaining
  const exhausted =
    Object.keys(quotas).length > 0 &&
    Object.values(quotas).every(
      (q) => q.unlimited !== true && (q.remainingPercentage ?? 100) <= 0,
    );

  return {
    plan: resolvePlan(user, config, { freeProfile }),
    quotas,
    periodEnd,
    exhausted,
    subscriptionAccess,
    freeProfile,
    rawConfig: config,
  };
}

/**
 * @param {string} accessToken
 * @param {object|null} providerSpecificData
 * @param {object|null} proxyOptions
 * @param {{ observedTokens?: number }} [options]
 */
export async function getGrokCliUsage(
  accessToken,
  providerSpecificData = null,
  proxyOptions = null,
  options = {},
) {
  if (!accessToken) {
    return { message: "Grok CLI access token not available." };
  }

  const headers = buildGrokCliHeaders(accessToken, providerSpecificData);
  const observedTokens = options?.observedTokens;

  try {
    // Fetch billing + user profile in parallel (same pattern as official CLI startup)
    const [billingRes, userRes] = await Promise.all([
      proxyAwareFetch(
        BILLING_URL,
        { method: "GET", headers },
        proxyOptions,
      ),
      proxyAwareFetch(
        USER_URL,
        { method: "GET", headers },
        proxyOptions,
      ).catch(() => null),
    ]);

    if (billingRes.status === 401 || billingRes.status === 403) {
      return { message: "Grok CLI authentication expired. Please re-authorize." };
    }

    if (!billingRes.ok) {
      const errText = await billingRes.text().catch(() => "");
      const trimmed = errText ? `: ${errText.slice(0, 200)}` : "";
      return { message: `Grok CLI billing API error (${billingRes.status})${trimmed}` };
    }

    const billing = await billingRes.json().catch(() => null);
    if (!billing || typeof billing !== "object") {
      return { message: "Grok CLI billing response was not JSON." };
    }

    let user = null;
    if (userRes?.ok) {
      user = await userRes.json().catch(() => null);
    }

    const parsed = parseGrokCliBilling(billing, user, { observedTokens });

    if (!parsed.quotas || Object.keys(parsed.quotas).length === 0) {
      return {
        plan: parsed.plan,
        message: parsed.subscriptionAccess
          ? "Subscription access is active; Grok does not expose a numeric included quota."
          : "Grok Build connected, but no credit allotment was returned. Free promo may be exhausted — upgrade at https://grok.com/supergrok or add credits at https://grok.com/?_s=usage.",
        quotas: {},
      };
    }

    // Dashboard hides QuotaTable whenever `message` is set, so only attach a
    // message when there are no quota rows to render.
    return {
      plan: parsed.plan,
      quotas: parsed.quotas,
    };
  } catch (error) {
    return { message: `Grok CLI usage error: ${error.message}` };
  }
}
