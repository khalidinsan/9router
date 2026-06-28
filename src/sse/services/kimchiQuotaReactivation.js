import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { buildKimchiQuotaReactivatedUpdate } from "open-sse/services/accountFallback.js";

/**
 * Reactivate Kimchi provider connections whose monthly quota was exhausted and
 * whose `rateLimitedUntil` has now passed (i.e. a new month has started).
 *
 * Queries all deactivated ("quota_exhausted") kimchi connections and, for each
 * whose cooldown timestamp is in the past, restores it to an active state.
 *
 * @returns {Promise<number>} count of accounts reactivated this run
 */
export async function reactivateExpiredKimchiAccounts() {
  let connections;
  try {
    connections = await getProviderConnections({ provider: "kimchi", isActive: false });
  } catch (e) {
    console.warn("[AUTH] Kimchi quota reactivation: failed to query connections:", e.message);
    return 0;
  }

  if (!connections || connections.length === 0) return 0;

  const now = Date.now();
  let reactivated = 0;

  for (const conn of connections) {
    if (conn.testStatus !== "quota_exhausted") continue;
    if (!conn.rateLimitedUntil) continue;

    const untilMs = new Date(conn.rateLimitedUntil).getTime();
    if (Number.isNaN(untilMs) || untilMs > now) continue;

    try {
      await updateProviderConnection(conn.id, buildKimchiQuotaReactivatedUpdate());
      reactivated++;
      console.info("[AUTH] Kimchi quota reactivated:", conn.name || conn.id, "(cooldown expired", conn.rateLimitedUntil, ")");
    } catch (e) {
      console.warn("[AUTH] Kimchi quota reactivation failed for", conn.name || conn.id, ":", e.message);
    }
  }

  if (reactivated > 0) {
    console.info("[AUTH] Kimchi quota reactivation:", reactivated, "account(s) reactivated");
  }
  return reactivated;
}
