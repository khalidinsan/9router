/**
 * Command Code usage — CLI alpha billing (works on Go; no Provider API).
 *
 * GET /alpha/billing/credits
 * GET /alpha/billing/subscriptions  (plan label + monthly period; fail-open)
 *
 * Window bars match Codex: `session` (5h) + `weekly` as 0–100 percent used.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

const USAGE = U("commandcode");
const CREDITS_URL = USAGE.url || "https://api.commandcode.ai/alpha/billing/credits";
const SUBSCRIPTIONS_URL =
  USAGE.subscriptionsUrl || "https://api.commandcode.ai/alpha/billing/subscriptions";

const PLAN_LABELS = {
  "individual-go": "Go",
  "individual-pro": "Pro",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

/** Monthly included credits (USD) by planId — CLI catalog. */
const PLAN_MONTHLY_CREDITS = {
  "individual-go": 10,
  "individual-pro": 30,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

function roundPct(value) {
  return Math.max(0, Math.min(100, Math.round(toFiniteNumber(value, 0))));
}

function formatCodexWindow(window) {
  if (!window || typeof window !== "object") return null;
  const cap = toFiniteNumber(window.cap, 0);
  const usedAbs = toFiniteNumber(window.used, 0);
  const used = cap > 0 ? roundPct((usedAbs / cap) * 100) : window.exceeded ? 100 : 0;
  return {
    used,
    total: 100,
    remaining: Math.max(0, 100 - used),
    resetAt: parseResetTime(window.resetAt ?? window.reset_at ?? null),
    unlimited: false,
  };
}

function subscriptionPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const data = raw.data && typeof raw.data === "object" ? raw.data : raw;
  return data.planId || data.status ? data : null;
}

/**
 * @param {object} credits
 * @param {object|null} subscription
 */
export function parseCommandCodeUsage(credits, subscription = null) {
  const windows = credits?.windowLimits && typeof credits.windowLimits === "object"
    ? credits.windowLimits
    : {};
  const creditBag = credits?.credits && typeof credits.credits === "object"
    ? credits.credits
    : {};
  const sub = subscriptionPayload(subscription);
  const planId = typeof sub?.planId === "string" ? sub.planId : "";
  const plan = PLAN_LABELS[planId] || (planId ? planId : "Command Code");

  const quotas = {};
  const session = formatCodexWindow(windows.fiveHour || windows.five_hour);
  const weekly = formatCodexWindow(windows.weekly);
  if (session) quotas.session = session;
  if (weekly) quotas.weekly = weekly;

  const monthlyAllotment = toFiniteNumber(PLAN_MONTHLY_CREDITS[planId], 0);
  const monthlyRemaining = toFiniteNumber(creditBag.monthlyCredits ?? creditBag.opensourceMonthlyCredits, NaN);
  if (monthlyAllotment > 0 && Number.isFinite(monthlyRemaining)) {
    const used = Math.max(0, monthlyAllotment - monthlyRemaining);
    quotas.Monthly = {
      used: Number(used.toFixed(4)),
      total: monthlyAllotment,
      resetAt: parseResetTime(sub?.currentPeriodEnd ?? sub?.current_period_end ?? null),
      unlimited: false,
    };
  }

  const limitReached = Boolean(
    windows.exceeded
    || windows.fiveHour?.exceeded
    || windows.five_hour?.exceeded
    || windows.weekly?.exceeded,
  );

  if (!quotas.session && !quotas.weekly && !quotas.Monthly) {
    return { plan, message: "Command Code connected. No usage windows reported." };
  }

  return { plan, limitReached, quotas };
}

export async function getCommandCodeUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Command Code API key not available. Add a key to view usage." };
  }

  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    Accept: "application/json",
  };

  try {
    const [creditsRes, subsRes] = await Promise.all([
      proxyAwareFetch(CREDITS_URL, { method: "GET", headers }, proxyOptions),
      proxyAwareFetch(SUBSCRIPTIONS_URL, { method: "GET", headers }, proxyOptions).catch(() => null),
    ]);

    if (creditsRes.status === 401 || creditsRes.status === 403) {
      return {
        plan: "Command Code",
        message: "Command Code authentication failed. Check the API key.",
      };
    }

    if (!creditsRes.ok) {
      return {
        plan: "Command Code",
        message: `Command Code usage API error (${creditsRes.status}).`,
      };
    }

    const credits = await creditsRes.json().catch(() => null);
    if (!credits || typeof credits !== "object") {
      return { message: "Command Code usage response was not JSON." };
    }

    const subscription = subsRes?.ok ? await subsRes.json().catch(() => null) : null;
    return parseCommandCodeUsage(credits, subscription);
  } catch (error) {
    return { message: `Failed to fetch Command Code usage: ${error.message}` };
  }
}
