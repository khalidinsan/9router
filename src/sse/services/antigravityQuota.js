/**
 * Antigravity live quota cache — in-memory, refreshed on demand.
 * Used by auth.js pre-filter to skip accounts with exhausted model quota.
 * Also triggered by 409/429 error handler to sync exact resetAt from upstream.
 */

import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getAntigravityUsage, findAntigravityGroupForModel } from "open-sse/services/usage/google.js";
import * as log from "../utils/logger.js";

// In-memory cache: connectionId → { [modelId]: { remainingPercentage, resetAt } }
const quotaCache = new Map();
// Grouped weekly + 5h quotas (agy /usage source): connectionId → normalized groups
const quotaGroupCache = new Map();
// Track last refresh per connection to avoid hammering
const lastRefreshAt = new Map();
// In-flight refresh promises — dedup concurrent 409/429 bursts
const inflightRefresh = new Map();

const MIN_REFRESH_INTERVAL_MS = 30_000; // 30s between refreshes per connection

/**
 * Get the quota cache (read-only reference for auth.js pre-filter).
 */
export function getAntigravityQuotaCache() {
  return quotaCache;
}

/**
 * Get the quota group cache (read-only reference).
 */
export function getAntigravityQuotaGroups() {
  return quotaGroupCache;
}

/**
 * Resolve the effective quota for a model on a connection.
 * Prefers the explicit per-model bucket; falls back to the governing group
 * weekly bucket (Claude/GPT share the 3p-weekly pool and carry no
 * per-model remainingFraction). Returns null when unknown — callers must
 * fail open, never treat unknown as exhausted.
 * @returns {{ remainingPercentage: number|null, resetAt: string|null, source: string }|null}
 */
export function resolveAntigravityQuota(connectionId, model) {
  const models = quotaCache.get(connectionId);
  const entry = model ? models?.[model] : null;
  if (entry && entry.remainingPercentage != null) {
    return { remainingPercentage: entry.remainingPercentage, resetAt: entry.resetAt || null, source: "model" };
  }
  const groups = quotaGroupCache.get(connectionId);
  const group = findAntigravityGroupForModel(groups, model);
  const weekly = group?.buckets?.find((b) => b.window === "weekly");
  if (weekly && weekly.remainingPercentage != null) {
    // A disabled 5h bucket means weekly is hit — weekly reset governs.
    return { remainingPercentage: weekly.remainingPercentage, resetAt: weekly.resetAt || entry?.resetAt || null, source: "group-weekly" };
  }
  if (entry) {
    return { remainingPercentage: null, resetAt: entry.resetAt || null, source: "model-unknown" };
  }
  return null;
}

/**
 * Refresh quota for a single antigravity connection from upstream API.
 * Updates in-memory cache only. Cache expiry is the upstream model resetAt.
 * @returns {object|null} quotas map or null on failure
 */
export async function refreshAntigravityQuota(connectionId, accessToken, providerSpecificData) {
  const now = Date.now();
  // Coalesce concurrent refreshes before applying the interval gate.
  const inflight = inflightRefresh.get(connectionId);
  if (inflight) return inflight;

  const lastRefresh = lastRefreshAt.get(connectionId) || 0;
  if (now - lastRefresh < MIN_REFRESH_INTERVAL_MS) {
    log.debug("AG_QUOTA", `${connectionId.slice(0, 8)} | skip refresh (${Math.round((now - lastRefresh) / 1000)}s ago)`);
    return quotaCache.get(connectionId) || null;
  }

  // Record every attempt so failed quota calls cannot amplify an upstream 429 burst.
  lastRefreshAt.set(connectionId, now);
  const promise = _doRefresh(connectionId, accessToken, providerSpecificData, now);
  inflightRefresh.set(connectionId, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(connectionId);
  }
}

async function _doRefresh(connectionId, accessToken, providerSpecificData, now) {
  try {
    const proxyCfg = await resolveConnectionProxyConfig(providerSpecificData || {});
    const proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
      vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
      strictProxy: proxyCfg.strictProxy === true,
    };

    const usage = await getAntigravityUsage(accessToken, providerSpecificData, proxyOptions);
    // 401/403 usage responses can contain an empty quotas object plus message.
    // Preserve known cache instead of replacing it with an upstream error response.
    if (!usage?.quotas || usage.message) return null;

    // Update in-memory cache. Caller logs CACHE_BLOCK only if requested model is exhausted.
    quotaCache.set(connectionId, usage.quotas);
    if (Array.isArray(usage.groups)) quotaGroupCache.set(connectionId, usage.groups);

    return usage.quotas;
  } catch (e) {
    log.warn("AG_QUOTA", `${connectionId.slice(0, 8)} | refresh failed: ${e.message}`);
    return null;
  }
}

/**
 * Handle Antigravity 409/429 — refresh RAM cache and return model resetAt when exhausted.
 * Called from chat handler error path.
 * @returns {number|null} resetAt timestamp ms (for resetsAtMs passthrough) or null
 */
export async function handleAntigravityQuotaError(connectionId, status, model, accessToken, providerSpecificData) {
  log.info("AG_QUOTA", `${connectionId.slice(0, 8)} | ${status} on ${model} — refreshing quota`);

  // Throttle applies to error paths too: one quota request per account/30s.
  // The first 409/429 populates cache; concurrent or repeated errors reuse it.
  await refreshAntigravityQuota(connectionId, accessToken, providerSpecificData);
  const quota = resolveAntigravityQuota(connectionId, model);
  // Unknown quota fails open: only block a model proven exhausted. A null
  // remainingPercentage means group-governed with no group data yet.
  if (!quota || quota.remainingPercentage == null || quota.remainingPercentage > 0 || !quota.resetAt) return null;

  const resetMs = new Date(quota.resetAt).getTime();
  if (resetMs <= Date.now()) return null;

  log.warn("AG_QUOTA", `${connectionId.slice(0, 8)} | UPSTREAM_${status} ${model} — quota exhausted; CACHE_BLOCK until ${quota.resetAt}`);
  return resetMs;
}
