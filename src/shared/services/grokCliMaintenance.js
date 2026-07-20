/**
 * Background maintenance for grok-cli connections:
 *  - proactive OAuth refresh (before access token expiry)
 *  - permanent refresh failure → disable + reauthRequired
 *  - optional billing snapshot → freeRemainingPct / plan metadata
 *
 * Single interval per process (survives Next.js HMR via global).
 */

import {
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/localDb";
import {
  shouldRefreshCredentials,
  refreshProviderCredentials,
} from "open-sse/services/oauthCredentialManager.js";
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";
import {
  getGrokCliUsage,
  GROK_CLI_FREE_TOKEN_LIMIT,
  GROK_CLI_FREE_WINDOW_MS,
} from "open-sse/services/usage/grok-cli.js";
import { sumConnectionTokensSince } from "@/lib/usageDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const g = (global.__grokCliMaintenance ??= {
  interval: null,
  running: false,
  lastTickAt: 0,
});

const TICK_MS = 5 * 60 * 1000; // 5 minutes
const BILLING_REFRESH_MS = 30 * 60 * 1000; // re-probe billing at most every 30m per account
const MAX_REFRESH_PER_TICK = 8;
const MAX_BILLING_PER_TICK = 5;

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function isBotFlaggedToken(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return false;
  const flag = claims.bot_flag_source;
  return !(flag === undefined || flag === null || flag === false || flag === 0 || flag === "0");
}

async function refreshOne(conn) {
  if (!conn?.refreshToken) return { skipped: true };
  if (!shouldRefreshCredentials("grok-cli", conn)) return { skipped: true };

  const log = {
    info: (tag, msg) => console.log(`[GrokMaint][${tag}] ${msg}`),
    warn: (tag, msg) => console.warn(`[GrokMaint][${tag}] ${msg}`),
    error: (tag, msg) => console.error(`[GrokMaint][${tag}] ${msg}`),
  };

  try {
    const refreshed = await refreshProviderCredentials("grok-cli", conn, log);
    if (!refreshed) return { skipped: true };

    if (isUnrecoverableRefreshError(refreshed)) {
      await updateProviderConnection(conn.id, {
        isActive: false,
        testStatus: "reauth_required",
        lastError: refreshed.error || "unrecoverable_refresh_error",
        lastErrorAt: new Date().toISOString(),
        errorCode: 401,
        providerSpecificData: {
          ...(conn.providerSpecificData || {}),
          reauthRequired: true,
          lastRefreshError: refreshed.error || "unrecoverable",
          lastRefreshErrorAt: new Date().toISOString(),
        },
      });
      console.warn(
        `[GrokMaint] ${conn.email || conn.name || conn.id} DISABLED (refresh permanent fail)`
      );
      return { disabled: true };
    }

    const nextPsd = {
      ...(conn.providerSpecificData || {}),
      ...(refreshed.providerSpecificData || {}),
      reauthRequired: false,
      lastRefreshOkAt: new Date().toISOString(),
    };
    if (refreshed.accessToken && isBotFlaggedToken(refreshed.accessToken)) {
      nextPsd.botFlagged = true;
      nextPsd.botFlagSource = decodeJwtPayload(refreshed.accessToken)?.bot_flag_source ?? 1;
    }

    await updateProviderConnection(conn.id, {
      ...refreshed,
      providerSpecificData: nextPsd,
      testStatus: conn.testStatus === "reauth_required" ? "active" : conn.testStatus,
    });
    return { refreshed: true };
  } catch (e) {
    console.warn(
      `[GrokMaint] refresh failed ${conn.email || conn.id}: ${e.message}`
    );
    return { error: e.message };
  }
}

async function billingSnapshotOne(conn) {
  if (!conn?.accessToken) return { skipped: true };
  const psd = conn.providerSpecificData || {};
  const last = psd.lastBillingAt ? new Date(psd.lastBillingAt).getTime() : 0;
  if (last && Date.now() - last < BILLING_REFRESH_MS) return { skipped: true };

  try {
    const since = new Date(Date.now() - GROK_CLI_FREE_WINDOW_MS).toISOString();
    let observedTokens = 0;
    try {
      observedTokens = await sumConnectionTokensSince(conn.id, since);
    } catch {
      observedTokens = 0;
    }

    const proxyCfg = await resolveConnectionProxyConfig(psd);
    const proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
    };

    const usage = await getGrokCliUsage(conn.accessToken, psd, proxyOptions, {
      observedTokens,
    });

    const freeQuota =
      usage?.quotas?.["Free tokens (est. 24h)"] ||
      Object.entries(usage?.quotas || {}).find(([k]) =>
        /free tokens/i.test(k)
      )?.[1];

    let freeRemainingPct = null;
    if (freeQuota && freeQuota.unlimited !== true) {
      freeRemainingPct =
        typeof freeQuota.remainingPercentage === "number"
          ? freeQuota.remainingPercentage
          : freeQuota.total > 0
            ? Math.max(0, 100 * (1 - (freeQuota.used || 0) / freeQuota.total))
            : null;
    }

    const nextPsd = {
      ...psd,
      lastBillingAt: new Date().toISOString(),
      plan: usage?.plan || psd.plan || null,
      freeProfile: freeQuota ? true : psd.freeProfile ?? null,
      freeRemainingPct:
        freeRemainingPct != null ? Math.round(freeRemainingPct) : psd.freeRemainingPct,
      observedTokens24h: observedTokens,
      freeTokenLimit: GROK_CLI_FREE_TOKEN_LIMIT,
    };

    // Soft-disable if free bar shows fully exhausted
    const exhausted =
      freeRemainingPct != null && freeRemainingPct <= 0 && freeQuota;

    const updates = {
      providerSpecificData: {
        ...nextPsd,
        quotaExhausted: exhausted ? true : psd.quotaExhausted || false,
      },
    };
    if (exhausted && conn.isActive !== false) {
      updates.isActive = false;
      updates.testStatus = "quota_exhausted";
      updates.lastError = "Free tokens exhausted (billing snapshot)";
      updates.lastErrorAt = new Date().toISOString();
      updates.errorCode = 402;
      console.warn(
        `[GrokMaint] ${conn.email || conn.name} DISABLED (free tokens 0% from billing snapshot)`
      );
    }

    await updateProviderConnection(conn.id, updates);
    return { ok: true, exhausted: !!exhausted };
  } catch (e) {
    console.warn(
      `[GrokMaint] billing snapshot failed ${conn.email || conn.id}: ${e.message}`
    );
    return { error: e.message };
  }
}

export async function runGrokCliMaintenanceTick() {
  if (g.running) return;
  g.running = true;
  g.lastTickAt = Date.now();
  try {
    const connections = await getProviderConnections({ provider: "grok-cli" });
    const active = connections.filter((c) => c.isActive !== false && c.refreshToken);

    // Refresh due tokens first
    let refreshed = 0;
    for (const conn of active) {
      if (refreshed >= MAX_REFRESH_PER_TICK) break;
      if (!shouldRefreshCredentials("grok-cli", conn)) continue;
      const r = await refreshOne(conn);
      if (r.refreshed || r.disabled) refreshed += 1;
    }

    // Billing snapshots (may re-fetch after refresh)
    const stillActive = (
      await getProviderConnections({ provider: "grok-cli", isActive: true })
    ).filter((c) => c.accessToken);
    let billed = 0;
    for (const conn of stillActive) {
      if (billed >= MAX_BILLING_PER_TICK) break;
      const r = await billingSnapshotOne(conn);
      if (r.ok) billed += 1;
    }

    if (refreshed || billed) {
      console.log(
        `[GrokMaint] tick: refreshed=${refreshed} billingSnapshots=${billed} pool=${stillActive.length}`
      );
    }
  } catch (e) {
    console.error("[GrokMaint] tick failed:", e.message);
  } finally {
    g.running = false;
  }
}

export function startGrokCliMaintenance() {
  if (g.interval) return;
  console.log("[GrokMaint] starting (interval 5m)");
  // first tick delayed so DB is ready
  setTimeout(() => {
    runGrokCliMaintenanceTick().catch(() => {});
  }, 20_000);
  g.interval = setInterval(() => {
    runGrokCliMaintenanceTick().catch(() => {});
  }, TICK_MS);
  if (typeof g.interval.unref === "function") g.interval.unref();
}

export function stopGrokCliMaintenance() {
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
}
