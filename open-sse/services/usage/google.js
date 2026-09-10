/**
 * Google usage handlers (Gemini CLI + Antigravity)
 */

import { CLIENT_METADATA, ANTIGRAVITY_HEADERS, LOAD_CODE_ASSIST_METADATA } from "../../config/appConstants.js";
import { ANTIGRAVITY_OAUTH_CLIENT } from "../../providers/shared.js";
import { U, parseResetTime, normalizeCloudCodeProjectId, fetchWithTimeout } from "./shared.js";

// Antigravity API config — urls from registry (daily host), CLI fingerprint UA.
// MITM-verified: agy calls loadCodeAssist/fetchAvailableModels/
// retrieveUserQuotaSummary on daily-cloudcode-pa with {"project":"aicode-consumers"}.
const ANTIGRAVITY_CONFIG = {
  ...U("antigravity"),
  ...ANTIGRAVITY_OAUTH_CLIENT,
  userAgent: ANTIGRAVITY_HEADERS["User-Agent"],
};

// Grouped weekly + 5-hour quotas — same source as `agy /usage`
// (RetrieveUserQuotaSummary). fetchAvailableModels only carries a single
// per-model window, so weekly limits are invisible without this call.
const ANTIGRAVITY_SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

// The official agy CLI always sends the fixed consumer project — even for
// accounts that own a real GCP project. The per-account pool shows different
// numbers (weekly 100% vs agy's 68%) and 429s while agy stays healthy.
const ANTIGRAVITY_CONSUMER_PROJECT = "aicode-consumers";

/**
 * Find the quota group governing a model (e.g. claude- or gpt- prefixed
 * models map to the "3p" group, gemini- models to the Gemini group).
 * Returns null when unknown — callers must fail open, never treat
 * unknown as exhausted.
 */
export function findAntigravityGroupForModel(groups, model) {
  if (!Array.isArray(groups) || groups.length === 0 || !model) return null;
  const prefix = String(model).split("-")[0].toLowerCase();
  if (!prefix) return null;
  for (const g of groups) {
    const hay = `${g.description || ""} ${g.name || ""}`.toLowerCase();
    if (hay.includes(prefix)) return g;
  }
  if (prefix === "gemini") return groups.find((g) => g.key === "gemini") || null;
  return null;
}

/**
 * Normalize a retrieveUserQuotaSummary payload into stable group buckets.
 */
export function normalizeAntigravityQuotaGroups(summary) {
  if (!summary || !Array.isArray(summary.groups)) return [];
  return summary.groups.map((g) => {
    const buckets = Array.isArray(g.buckets) ? g.buckets : [];
    const key = buckets.length > 0
      ? String(buckets[0].bucketId || "").split("-").slice(0, -1).join("-") || null
      : null;
    return {
      key,
      name: g.displayName || key || "Models",
      description: g.description || null,
      buckets: buckets.map((b) => ({
        id: b.bucketId || null,
        name: b.displayName || b.bucketId || null,
        window: b.window || null,
        remainingPercentage: b.remainingFraction == null ? null : Number(b.remainingFraction) * 100,
        resetAt: parseResetTime(b.resetTime),
        disabled: b.disabled === true,
        description: b.description || null,
      })),
    };
  });
}

/**
 * Gemini CLI Usage — fetch per-model quota via Cloud Code Assist API.
 * Uses retrieveUserQuota (same endpoint as `gemini /stats`) returning
 * per-model buckets with remainingFraction + resetTime.
 */
export async function getGeminiUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { plan: "Free", message: "Gemini CLI access token not available." };
  }

  try {
    // Resolve project id: prefer connection-stored id, else loadCodeAssist lookup.
    // #1271: OAuth save stores projectId on the connection, not providerSpecificData.
    let projectId = normalizeCloudCodeProjectId(providerSpecificData?.projectId);
    let plan = "Free";

    if (!projectId) {
      const subInfo = await getGeminiSubscriptionInfo(accessToken, proxyOptions);
      projectId = normalizeCloudCodeProjectId(subInfo?.cloudaicompanionProject);
      plan = subInfo?.currentTier?.name || plan;
    }

    if (!projectId) {
      return {
        plan,
        message: "Gemini CLI project ID not available. Reconnect Gemini CLI, or configure a Google Cloud project with Gemini Code Assist access before checking quota.",
      };
    }

    const response = await fetchWithTimeout(
      U("gemini-cli").quotaUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: projectId }),
      },
      10000,
      proxyOptions
    );

    if (!response.ok) {
      return { plan, message: `Gemini CLI quota error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    if (Array.isArray(data.buckets)) {
      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;

        const remainingFraction = Number(bucket.remainingFraction) || 0;
        const total = 1000; // Normalized base, matches antigravity convention
        const remaining = Math.round(total * remainingFraction);
        const used = Math.max(0, total - remaining);

        quotas[bucket.modelId] = {
          used,
          total,
          resetAt: parseResetTime(bucket.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
        };
      }
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Gemini CLI error: ${error.message}` };
  }
}

/**
 * Get Gemini CLI subscription info via loadCodeAssist
 */
async function getGeminiSubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(
      U("gemini-cli").loadCodeAssistUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: CLIENT_METADATA }),
      },
      10000,
      proxyOptions
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Fetch + parse a quota endpoint with one retry on parse failure (so a slow
 * cold-start response that truncated mid-body gets a second shot).
 * @returns {object|null} parsed body, or null on 401/403/error
 */
async function fetchWithRetryParsed(url, config, proxyOptions, optional = false) {
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    try {
      const res = await fetchWithTimeout(url, config, 20000, proxyOptions);
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (parseError) {
        // Truncated mid-body (cold-start timeout) — retry once, then give up.
        if (attempt === 1) continue;
        throw new Error(`Invalid JSON (${text.length}B): ${parseError.message}`);
      }
    } catch (e) {
      if (e.name === "AbortError" || /fetch failed|ECONN|timeout/i.test(String(e.message || e))) {
        if (attempt === 1) continue;
      }
      if (optional) {
        console.warn(`[Antigravity Usage] ${url.split(":").pop()} unavailable: ${e.message}`);
        return null;
      }
      throw e;
    }
  }
  return null;
}

/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reused for the plan display. The quota
    // pool itself is always the fixed consumer project (agy behavior).
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);

    const config = {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "x-request-source": "local", // our MITM anti-loop flag (agy sends only UA/Auth/CT)
      },
      body: JSON.stringify({ project: ANTIGRAVITY_CONSUMER_PROJECT }),
    };

    // The models payload is ~123KB; cold-start DNS can push it past 10s when
    // the dashboard refreshes every connection at once. 20s + one retry on a
    // parse failure keeps a slow response from truncating mid-body.
    const modelsBody = await fetchWithRetryParsed(ANTIGRAVITY_CONFIG.quotaApiUrl, config, proxyOptions);
    // Grouped weekly + 5h quotas (agy /usage source). Non-fatal when it fails.
    const summaryBody = await fetchWithRetryParsed(ANTIGRAVITY_SUMMARY_URL, config, proxyOptions, true);

    const quotas = {};

    // Grouped weekly + 5h quotas (agy /usage source). Best effort.
    let groups = [];
    if (summaryBody) {
      groups = Array.isArray(summaryBody.groups) ? normalizeAntigravityQuotaGroups(summaryBody) : [];
    }

    // Parse model quotas (inspired by vscode-antigravity-cockpit).
    // NOTE: no hardcoded model filter — upstream renames models over time
    // (e.g. gemini-3.7-flash-high → gemini-3.7-flash-tiered) and a stale list
    // silently drops the models users actually call. All non-internal models
    // with quotaInfo are kept; router lookups ignore unknown keys.
    if (modelsBody?.models) {
      for (const [modelKey, info] of Object.entries(modelsBody.models)) {
        // Skip models without quota info
        if (!info.quotaInfo) {
          continue;
        }

        // Skip internal models
        if (info.isInternal) {
          continue;
        }

        // A missing remainingFraction means the model is governed by its
        // group bucket (e.g. Claude/GPT share the 3p-weekly pool), NOT that
        // it is exhausted. Record unknown as null so routing fails open
        // instead of cache-blocking a healthy model until reset.
        const hasFraction = info.quotaInfo.remainingFraction != null;
        const remainingFraction = hasFraction ? Number(info.quotaInfo.remainingFraction) : null;
        const remainingPercentage = hasFraction ? remainingFraction * 100 : null;

        // Convert percentage to used/total for UI compatibility
        const total = hasFraction ? 1000 : null; // Normalized base
        const remaining = hasFraction ? Math.round(total * remainingFraction) : null;
        const used = hasFraction ? total - remaining : null;

        // Use modelKey as key (matches PROVIDER_MODELS id)
        quotas[modelKey] = {
          used,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage,
          unlimited: false,
          displayName: info.displayName || modelKey,
        };
      }
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      groups,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "x-request-source": "local", // our MITM anti-loop flag
      },
      body: JSON.stringify({ metadata: LOAD_CODE_ASSIST_METADATA }),
    }, 10000, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  }
}
