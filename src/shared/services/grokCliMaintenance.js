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
  deleteProviderConnection,
} from "@/lib/localDb";
import {
  shouldRefreshCredentials,
  refreshProviderCredentials,
} from "open-sse/services/oauthCredentialManager.js";
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";
import { isGrokCliAuthoritativeFreeUsageExhausted } from "open-sse/services/accountFallback.js";
import { buildGrokCliAuthoritativeQuotaExhaustedUpdate } from "open-sse/services/grokCliSafety.js";
import {
  getGrokCliUsage,
  GROK_CLI_FREE_TOKEN_LIMIT,
  GROK_CLI_FREE_WINDOW_MS,
} from "open-sse/services/usage/grok-cli.js";
import { sumConnectionTokensSince } from "@/lib/usageDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import {
  probeGrokCliAccountQuality,
  GROK_CLI_QUALITY_PROBE_NUMBER,
  GROK_CLI_QUALITY_PROBE_PROMPT,
  GROK_CLI_DEGRADED_STATUS,
} from "@/shared/services/grokCliQuality";

const g = (global.__grokCliMaintenance ??= {
  interval: null,
  running: false,
  lastTickAt: 0,
  // Id of the last account probed by the quality sweep, so successive ticks
  // walk the whole pool instead of re-probing the same first N every time.
  qualitySweepCursor: null,
});

const TICK_MS = 5 * 60 * 1000; // 5 minutes
const BILLING_REFRESH_MS = 30 * 60 * 1000; // refresh billing at most every 30m per account
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

    const learnedFreeTokenLimit = Number(psd.freeTokenLimit) > 0
      ? Number(psd.freeTokenLimit)
      : GROK_CLI_FREE_TOKEN_LIMIT;
    const usage = await getGrokCliUsage(conn.accessToken, psd, proxyOptions, {
      observedTokens,
      freeTokenLimit: learnedFreeTokenLimit,
    });

    const freeQuota =
      usage?.quotas?.["Local usage (rolling 24h)"] ||
      Object.entries(usage?.quotas || {}).find(([k]) =>
        /local usage.*24h|free tokens.*24h/i.test(k)
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
      freeTokenLimit: learnedFreeTokenLimit,
    };

    // The free bar is a local rolling estimate, not authoritative upstream quota.
    // Never disable an account from billing metadata alone; only an isolated
    // inference probe may confirm quota exhaustion.
    const estimatedExhausted =
      freeRemainingPct != null && freeRemainingPct <= 0 && freeQuota;

    const updates = {
      providerSpecificData: {
        ...nextPsd,
        estimatedQuotaExhausted: !!estimatedExhausted,
        lastEstimatedQuotaAt: estimatedExhausted ? new Date().toISOString() : null,
      },
    };

    await updateProviderConnection(conn.id, updates);
    return { ok: true, exhausted: false, estimatedExhausted: !!estimatedExhausted };
  } catch (e) {
    console.warn(
      `[GrokMaint] billing snapshot failed ${conn.email || conn.id}: ${e.message}`
    );
    return { error: e.message };
  }
}

/**
 * Pick the next `limit` accounts to probe, continuing from where the previous
 * sweep stopped and wrapping around the end.
 *
 * Without this the sweep re-probed the same first `limit` rows forever:
 * `getProviderConnections` sorts by priority, so `.slice(0, limit)` always
 * returned accounts 1..N and the rest of the pool was never validated — the
 * exact opposite of the self-healing the sweep exists to provide. It only
 * advanced when one of those first rows was blocked or deleted.
 *
 * The cursor is the id of the last probed account, not an index: accounts get
 * blocked, deleted or reordered between ticks, so an index would drift onto the
 * wrong row. If the cursor account is gone, start from the top.
 *
 * @param {Array} connections priority-sorted pool
 * @param {number} limit how many to take
 * @param {string|null} cursor id of the last account probed
 * @returns {{ picked: Array, nextCursor: string|null }}
 */
export function pickSweepWindow(connections, limit, cursor) {
  const pool = Array.isArray(connections) ? connections : [];
  if (pool.length === 0) return { picked: [], nextCursor: null };
  const size = Math.max(1, Math.min(Number(limit) || 1, pool.length));

  let start = 0;
  if (cursor) {
    const lastIndex = pool.findIndex((c) => c.id === cursor);
    // Not found (deleted/blocked/deactivated) → restart from the top.
    if (lastIndex !== -1) start = (lastIndex + 1) % pool.length;
  }

  const picked = [];
  for (let i = 0; i < size; i += 1) {
    picked.push(pool[(start + i) % pool.length]);
  }

  return { picked, nextCursor: picked[picked.length - 1]?.id ?? null };
}

/**
 * Sweep connections for the 407 degradation and act on the verdict.
 *
 * `deleteProviderConnection` is only ever called for definitively degraded
 * accounts (HTTP 200 + wrong digits). Accounts that merely errored, timed out,
 * or were unreachable are left alone — they may recover, and the quality probe
 * cannot prove they are bad.
 *
 * Disabled by default: this spends real inference quota and deletes rows. Turn
 * it on with GROK_CLI_QUALITY_SWEEP=1.
 *
 * @param {{ limit?: number, dryRun?: boolean, purge?: boolean, log?: Console }} [options]
 */
export async function sweepGrokCliAccountQuality(options = {}) {
  const { limit = 3, dryRun = false, purge = false, log = console } = options;
  const pool = (await getProviderConnections({ provider: "grok-cli", isActive: true }))
    .filter((c) => c.accessToken);
  // Walk the pool across ticks instead of re-probing the same leading rows.
  const { picked: connections, nextCursor } = pickSweepWindow(pool, limit, g.qualitySweepCursor);
  g.qualitySweepCursor = nextCursor;

  const summary = {
    probed: 0,
    ok: 0,
    degraded: 0,
    inconclusive: 0,
    blocked: 0,
    deleted: 0,
    degradedEmails: [],
    // Which slice of the pool this tick covered, so a caller can see the walk.
    poolSize: pool.length,
    probedIds: connections.map((c) => c.id),
  };

  for (const conn of connections) {
    const probe = await probeGrokCliAccountQuality(conn);
    summary.probed += 1;

    if (probe.ok) {
      summary.ok += 1;
      continue;
    }

    // One observation is never enough to delete an account. A degraded account
    // must reproduce the wrong number on a second, independent turn.
    if (!probe.wrong) {
      summary.inconclusive += 1;
      log.warn(
        `[GrokMaint] quality inconclusive ${conn.email || conn.id}: ${probe.error || `digits=${probe.digits}`}`
      );
      continue;
    }

    const confirm = await probeGrokCliAccountQuality(conn);
    if (!confirm.wrong || confirm.digits !== probe.digits) {
      summary.inconclusive += 1;
      log.warn(
        `[GrokMaint] quality inconclusive ${conn.email || conn.id}: `
          + `first=${probe.digits} confirm=${confirm.digits || "none"}`
      );
      continue;
    }

    summary.degraded += 1;
    summary.degradedEmails.push(conn.email || conn.id);
    log.warn(
      `[GrokMaint] DEGRADED ${conn.email || conn.id}: print ${GROK_CLI_QUALITY_PROBE_NUMBER} -> ${probe.digits}`
    );

    if (dryRun) continue;

    if (purge) {
      try {
        await deleteProviderConnection(conn.id);
        summary.deleted += 1;
      } catch (e) {
        log.error(`[GrokMaint] delete failed ${conn.email || conn.id}: ${e.message}`);
      }
      continue;
    }

    // Without purge, block the account instead of deleting it. The basic reprobe
    // only checks reachability, which a degraded account passes — so without this
    // flag it would be silently re-enabled.
    try {
      await updateProviderConnection(conn.id, {
        isActive: false,
        testStatus: GROK_CLI_DEGRADED_STATUS,
        lastError: `degraded account: ${GROK_CLI_QUALITY_PROBE_PROMPT} -> ${probe.digits}`,
        lastErrorAt: new Date().toISOString(),
        providerSpecificData: {
          ...(conn.providerSpecificData || {}),
          degradedAccount: true,
          degradedAt: new Date().toISOString(),
          degradedProbeDigits: probe.digits,
        },
      });
      summary.blocked += 1;
    } catch (e) {
      log.error(`[GrokMaint] block failed ${conn.email || conn.id}: ${e.message}`);
    }
  }

  return summary;
}

export async function runGrokCliMaintenanceTick() {
  if (g.running) return;
  g.running = true;
  g.lastTickAt = Date.now();
  try {
    const connections = await getProviderConnections({ provider: "grok-cli" });

    // One-time/ongoing reconciliation for rows created before authoritative
    // 429 handling existed: their lastError proves rolling quota exhaustion,
    // but stale canonical fields may still say active/suspected.
    for (const conn of connections) {
      if (
        conn.isActive !== false &&
        isGrokCliAuthoritativeFreeUsageExhausted(
          "grok-cli",
          conn.errorCode || 429,
          conn.lastError
        )
      ) {
        await updateProviderConnection(
          conn.id,
          buildGrokCliAuthoritativeQuotaExhaustedUpdate(
            conn,
            /\[429\]/.test(String(conn.lastError || "")) ? 429 : conn.errorCode || 429,
            conn.lastError
          )
        );
      }
    }

    const active = (
      await getProviderConnections({ provider: "grok-cli" })
    ).filter((c) => c.isActive !== false && c.refreshToken);

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

    // Quality sweep: only when explicitly enabled, and bounded per tick. The
    // canary script (scripts/grok-cli-canary.mjs) remains the bulk tool; this
    // exists so the pool self-heals between manual runs.
    let quality = null;
    if (process.env.GROK_CLI_QUALITY_SWEEP === "1") {
      const purge = process.env.GROK_CLI_QUALITY_PURGE === "1";
      const limit = Number(process.env.GROK_CLI_QUALITY_SWEEP_LIMIT) || 3;
      quality = await sweepGrokCliAccountQuality({ limit, purge, dryRun: !purge });
    }

    if (refreshed || billed || quality?.probed) {
      const qualityNote = quality
        ? ` quality=${quality.ok}ok/${quality.degraded}degraded/${quality.inconclusive}inconclusive`
          + (quality.deleted ? ` deleted=${quality.deleted}` : "")
          + (quality.poolSize ? ` walked=${quality.probed}/${quality.poolSize}` : "")
        : "";
      console.log(
        `[GrokMaint] tick: refreshed=${refreshed} billingSnapshots=${billed} pool=${stillActive.length}${qualityNote}`
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
