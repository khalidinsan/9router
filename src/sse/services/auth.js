import {
  getProviderConnections,
  validateApiKey,
  updateProviderConnection,
  getSettings,
  getProxyPools,
} from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import {
  formatRetryAfter,
  checkFallbackError,
  isModelLockActive,
  buildModelLockUpdate,
  getEarliestModelLockUntil,
  isGrokCliChatPermissionDenied,
  isGrokCliFreeOrCreditExhausted,
  buildGrokCliPermissionDeniedUpdate,
} from "open-sse/services/accountFallback.js";
import {
  buildGrokCliSuspectedQuotaUpdate,
  isGrokCliHardBlocked,
  recordGrokCli402,
} from "open-sse/services/grokCliSafety.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

/** Higher score = prefer this grok-cli connection first.
 *  bot_flag / botFlagged is IGNORED — only real request failures matter. */
function scoreGrokCliConnection(conn) {
  const psd = conn?.providerSpecificData || {};
  let score = 0;
  // Do NOT penalize botFlagged — JWT flag is informational; use until chat 403 / quota error
  if (psd.reauthRequired === true) score -= 800;
  if (psd.quotaExhausted === true || conn?.testStatus === "quota_exhausted") score -= 900;
  if (conn?.testStatus === "suspected_quota") score -= 300;
  if (psd.freeProfile === true) score += 50;
  // More free remaining % is better (unknown → neutral)
  const rem = Number(psd.freeRemainingPct);
  if (Number.isFinite(rem)) score += Math.max(0, Math.min(100, rem));
  // Prefer less recently used (spread load)
  if (conn?.lastUsedAt) {
    const ageMin = (Date.now() - new Date(conn.lastUsedAt).getTime()) / 60000;
    if (Number.isFinite(ageMin)) score += Math.min(30, ageMin / 10);
  } else {
    score += 20;
  }
  // Lower priority number is better (fill-first style)
  score -= (conn?.priority || 0) * 0.01;
  return score;
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Internal re-probe of disabled grok-cli accounts (dashboard / maintenance)
  const allowInactivePin = options?.allowInactivePin === true;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    let connections = await getProviderConnections({ provider: providerId });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    const isGrokCli = providerId === "grok-cli" || providerId === "gcli";
    const useAllForReprobe = allowInactivePin && isGrokCli;
    if (!useAllForReprobe) {
      connections = connections.filter(c => c.isActive !== false);
    }

    // Filter out model-locked, excluded, and (non-reprobe) grok-cli rows that already failed hard.
    // botFlagged / JWT bot_flag: IGNORE completely — pick like any other active
    // account; only drop after real request errors (403 chat, quota, reauth).
    let skippedHard = 0;
    const availableConnections = connections.filter((c) => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      const psd = c.providerSpecificData || {};
      if (isGrokCli && !useAllForReprobe && isGrokCliHardBlocked(c)) {
        skippedHard += 1;
        return false;
      }
      return true;
    });

    log.debug(
      "AUTH",
      `${provider} | available: ${availableConnections.length}/${connections.length}` +
        (isGrokCli ? ` (hard-skip=${skippedHard})` : "")
    );
    connections.forEach((c) => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug(
          "AUTH",
          `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`
        );
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter((c) => isModelLockActive(c, model));
      const expiries = lockedConns.map((c) => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn(
          "AUTH",
          `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`
        );
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null,
        };
      }
      // Helpful reason when rows exist but all hard-filtered (quota/reauth/etc.)
      const reasons = [];
      if (skippedHard > 0) reasons.push(`${skippedHard} reauth/quota/denied`);
      const lockedN = connections.filter((c) => isModelLockActive(c, model)).length;
      if (lockedN > 0) reasons.push(`${lockedN} model-locked`);
      log.warn(
        "AUTH",
        `${provider} | all ${connections.length} accounts unavailable` +
          (reasons.length ? ` (${reasons.join(", ")})` : "")
      );
      return null;
    }

    // grok-cli: prefer clean accounts with more free remaining, then least recently used
    if (providerId === "grok-cli" || providerId === "gcli") {
      availableConnections.sort((a, b) => scoreGrokCliConnection(b) - scoreGrokCliConnection(a));
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified — hard-fail when unavailable
    // (used by per-account model test via x-connection-id)
    // IMPORTANT: when pin is set, NEVER return another account (caller must not fallback).
    if (preferredConnectionId) {
      if (excludeSet.has(preferredConnectionId)) {
        return {
          pinFailed: true,
          error: "Pinned connection was excluded",
          preferredConnectionId,
        };
      }

      connection = availableConnections.find((c) => c.id === preferredConnectionId);

      // Re-probe disabled / hard-skipped accounts (quota 402, chat 403, etc.)
      if (!connection && allowInactivePin) {
        const allForPin = await getProviderConnections({ provider: providerId });
        const pinned = allForPin.find((c) => c.id === preferredConnectionId);
        if (
          pinned &&
          (pinned.accessToken || pinned.refreshToken) &&
          pinned.providerSpecificData?.reauthRequired !== true &&
          pinned.testStatus !== "reauth_required"
        ) {
          connection = pinned;
          log.info(
            "AUTH",
            `${provider} | re-probe pin ${connection.id?.slice(0, 8)} ` +
              `(${connection.email || connection.name || "unnamed"}) ` +
              `status=${connection.testStatus || "?"} active=${connection.isActive !== false}`
          );
        }
      }

      if (connection) {
        // Prefer email in logs — name is often a generic given/family from JWT
        const label = connection.email || connection.name || connection.displayName || "unnamed";
        log.info(
          "AUTH",
          `${provider} | pinned ${connection.id?.slice(0, 8)} (${label})`
        );
      } else {
        const allLookup = allowInactivePin
          ? await getProviderConnections({ provider: providerId })
          : connections;
        const exists =
          allLookup.find((c) => c.id === preferredConnectionId) ||
          connections.find((c) => c.id === preferredConnectionId);
        let reason = "Pinned connection unavailable";
        if (!exists) reason = "Pinned connection not found";
        else if (exists.isActive === false && !allowInactivePin)
          reason = "Pinned connection is disabled";
        else if (isModelLockActive(exists, model) && !allowInactivePin)
          reason = "Pinned connection is model-locked";
        else if (exists.providerSpecificData?.reauthRequired || exists.testStatus === "reauth_required")
          reason = "Pinned connection needs reauth";
        else if (!exists.accessToken && !exists.refreshToken)
          reason = "Pinned connection has no tokens";
        log.warn("AUTH", `${provider} | pin failed: ${reason} (${preferredConnectionId.slice(0, 8)})`);
        return {
          pinFailed: true,
          error: reason,
          preferredConnectionId,
        };
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin" && providerId !== "grok-cli" && providerId !== "gcli") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default fill-first — for grok-cli list is already score-sorted (best first)
      connection = availableConnections[0];
      if (providerId === "grok-cli" || providerId === "gcli") {
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1,
        });
      }
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      // Prefer email for logs/UI identity (JWT name is often recycled given/family)
      connectionName:
        connection.email ||
        connection.displayName ||
        connection.name ||
        connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);

  // grok-cli: 403 permission-denied on chat → disable only (never auto-delete)
  if (isGrokCliChatPermissionDenied(provider, status, errorText)) {
    const reason =
      typeof errorText === "string" ? errorText.slice(0, 200) : "permission-denied";
    try {
      await updateProviderConnection(connectionId, {
        ...buildGrokCliPermissionDeniedUpdate(),
        lastError: reason,
        providerSpecificData: {
          ...(conn?.providerSpecificData || {}),
          permissionDenied: true,
          lastPermissionDeniedAt: new Date().toISOString(),
        },
      });
      log.warn(
        "AUTH",
        `${connName} DISABLED (grok-cli 403 permission-denied / chat endpoint denied)`
      );
      console.error(
        `❌ grok-cli [403]: chat permission-denied — disabled ${connName}`
      );
    } catch (e) {
      log.warn("AUTH", `${connName} disable failed: ${e.message}`);
    }
    return { shouldFallback: true, cooldownMs: 0, disabled: true };
  }

  // Grok CLI 402 may be a shared/transient upstream gate. Never permanently
  // disable from normal traffic. Mark this account as suspected and let an
  // isolated direct probe confirm it; the circuit breaker stops pool sweeps.
  if (isGrokCliFreeOrCreditExhausted(provider, status, errorText)) {
    const reason =
      typeof errorText === "string" ? errorText.slice(0, 200) : "quota suspected";
    const circuit = recordGrokCli402(connectionId, errorText);
    const suspectedUpdate = buildGrokCliSuspectedQuotaUpdate(conn);
    try {
      await updateProviderConnection(connectionId, {
        ...suspectedUpdate,
        lastError: reason,
        providerSpecificData: {
          ...suspectedUpdate.providerSpecificData,
          lastQuotaCheckAt: new Date().toISOString(),
        },
      });
      log.warn(
        "AUTH",
        `${connName} suspected grok-cli quota [402]` +
          (circuit.isOpen ? `; provider circuit open until ${circuit.openUntil}` : "")
      );
    } catch (e) {
      log.warn("AUTH", `${connName} suspected-quota update failed: ${e.message}`);
    }
    return {
      shouldFallback: !circuit.isOpen,
      cooldownMs: 0,
      suspectedQuota: true,
      circuitOpen: circuit.isOpen,
      circuitOpenUntil: circuit.openUntil,
    };
  }

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
