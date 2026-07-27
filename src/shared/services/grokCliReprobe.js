/**
 * Re-probe disabled grok-cli accounts (402 quota / 403 permission-denied).
 *
 * Free Grok Build quota rolls ~24h; 402/403 often recover later.
 * Strategy: isolated direct Responses API probe for exactly one connection.
 * On success → isActive=true + clear hard-fail flags.
 *
 * Manual disable (isActive=false + testStatus still active) is NEVER re-probed.
 */

import {
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/localDb";
import { buildGrokCliReprobeEnabledUpdate } from "open-sse/services/accountFallback.js";
import { GROK_CLI_MODEL } from "open-sse/config/grokCli.js";
import { getDefaultModel, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import {
  GROK_CLI_PROBE_REFRESHED_CREDENTIALS,
  probeGrokCliConnection,
} from "@/shared/services/grokCliProbe";
import {
  buildGrokCliConfirmedQuotaUpdate,
  buildGrokCliManualEnableUpdate,
} from "open-sse/services/grokCliSafety.js";

/** Statuses that were auto-disabled and may recover */
export const GROK_CLI_REPROBE_STATUSES = new Set([
  "quota_exhausted",
  "permission_denied",
  "unavailable",
]);

const DEFAULT_LIMIT = 8;
const MIN_INTERVAL_MS = 45 * 60 * 1000; // don't re-probe same account more than every 45m

const g = (global.__grokCliReprobe ??= {
  running: false,
  lastRunAt: 0,
});

function probeModelId() {
  const alias = PROVIDER_ID_TO_ALIAS["grok-cli"] || "gcli";
  return getDefaultModel(alias) || getDefaultModel("gcli") || GROK_CLI_MODEL || "grok-build";
}

/**
 * @param {object} conn
 * @returns {boolean}
 */
export function isGrokCliReprobeCandidate(conn) {
  if (!conn || conn.provider !== "grok-cli") return false;
  if (!conn.accessToken && !conn.refreshToken) return false;
  if (conn.providerSpecificData?.reauthRequired === true) return false;
  if (conn.testStatus === "reauth_required") return false;

  const st = String(conn.testStatus || "");
  // Auto-disabled by 402/403/quota path
  if (conn.isActive === false && GROK_CLI_REPROBE_STATUSES.has(st)) return true;
  // Still "active" flag but hard-skipped in rotation (edge cases)
  if (conn.isActive !== false && GROK_CLI_REPROBE_STATUSES.has(st)) return true;
  // PSD hard flags with inactive
  const psd = conn.providerSpecificData || {};
  if (
    conn.isActive === false &&
    (psd.quotaExhausted === true || psd.permissionDenied === true)
  ) {
    return true;
  }
  return false;
}

function tooSoon(conn, now = Date.now()) {
  const last = conn.providerSpecificData?.lastReprobeAt;
  if (!last) return false;
  const t = new Date(last).getTime();
  if (Number.isNaN(t)) return false;
  return now - t < MIN_INTERVAL_MS;
}

/**
 * Re-probe one disabled connection. Optionally refresh token first.
 * @returns {Promise<{ id: string, email?: string, ok: boolean, enabled: boolean, error?: string, latencyMs?: number, status?: number }>}
 */
export async function reprobeOneGrokCliConnection(conn, options = {}) {
  const modelId = options.modelId || probeModelId();
  const email = conn.email || conn.name || conn.id;
  const psd = conn.providerSpecificData || {};
  const nowIso = new Date().toISOString();

  // Direct, isolated upstream probe: exactly this connection, no local account
  // selector, no fallback, and no account mutation inside the probe itself.
  const result = await probeGrokCliConnection(conn, modelId);
  const refreshedCredentials = result[GROK_CLI_PROBE_REFRESHED_CREDENTIALS];
  if (refreshedCredentials) {
    await updateProviderConnection(conn.id, {
      ...refreshedCredentials,
      providerSpecificData: {
        ...psd,
        ...(refreshedCredentials.providerSpecificData || {}),
        reauthRequired: false,
      },
    });
  }

  // Re-read row after a possible isolated refresh.
  const latest =
    (await getProviderConnections({ provider: "grok-cli" })).find(
      (c) => c.id === conn.id
    ) || conn;
  const freshPsd = latest.providerSpecificData || psd;

  if (result.ok) {
    const enabledUpdate = buildGrokCliManualEnableUpdate(latest);
    await updateProviderConnection(conn.id, {
      ...buildGrokCliReprobeEnabledUpdate(),
      ...enabledUpdate,
      providerSpecificData: {
        ...enabledUpdate.providerSpecificData,
        lastReprobeAt: nowIso,
        lastReprobeOkAt: nowIso,
        lastReprobeOk: true,
        lastReprobeError: null,
        lastReprobeModel: modelId,
        lastReprobeLatencyMs: result.latencyMs ?? null,
      },
    });
    console.info(
      `[GrokReprobe] ENABLED ${email} id=${conn.id.slice(0, 8)} model=${modelId} ${result.latencyMs || "?"}ms`
    );
    return {
      id: conn.id,
      email,
      ok: true,
      enabled: true,
      latencyMs: result.latencyMs,
      status: result.status,
      modelId,
    };
  }

  const quotaUpdate = Number(result.status) === 402
    ? buildGrokCliConfirmedQuotaUpdate(latest, new Date(), {
        tokenFingerprint: result.tokenFingerprint,
        modelId,
      })
    : {
        providerSpecificData: {
          ...freshPsd,
          quotaConfirmationCount: 0,
          quotaConfirmationAt: null,
          quotaConfirmationTokenFingerprint: null,
          quotaConfirmationModel: null,
        },
      };
  await updateProviderConnection(conn.id, {
    ...quotaUpdate,
    providerSpecificData: {
      ...freshPsd,
      ...(quotaUpdate.providerSpecificData || {}),
      lastReprobeAt: nowIso,
      lastReprobeOk: false,
      lastReprobeError: String(result.error || "probe failed").slice(0, 240),
      lastReprobeModel: modelId,
      lastReprobeLatencyMs: result.latencyMs ?? null,
      lastReprobeTokenFingerprint: result.tokenFingerprint || null,
    },
    lastError: String(result.error || "reprobe failed").slice(0, 200),
    lastErrorAt: nowIso,
  });
  console.warn(
    `[GrokReprobe] still down ${email} id=${conn.id.slice(0, 8)}: ${String(result.error || "").slice(0, 120)}`
  );
  return {
    id: conn.id,
    email,
    ok: false,
    enabled: false,
    error: result.error || "probe failed",
    latencyMs: result.latencyMs,
    status: result.status,
    modelId,
  };
}

/**
 * Batch re-probe disabled grok-cli accounts.
 * @param {{ limit?: number, force?: boolean, modelId?: string, connectionIds?: string[] }} [options]
 */
export async function reprobeDisabledGrokCliAccounts(options = {}) {
  if (g.running) {
    return { running: true, candidates: 0, probed: 0, enabled: 0, results: [] };
  }
  const modelId = String(options.modelId || "").trim();
  if (!modelId) {
    throw new Error("modelId is required — pick a model before reprobing");
  }
  g.running = true;
  g.lastRunAt = Date.now();
  try {
    const limit = Math.max(1, Math.min(50, Number(options.limit) || DEFAULT_LIMIT));
    const force = options.force === true;
    const all = await getProviderConnections({ provider: "grok-cli" });
    let candidates = all.filter(isGrokCliReprobeCandidate);

    if (Array.isArray(options.connectionIds) && options.connectionIds.length > 0) {
      const want = new Set(options.connectionIds.map(String));
      candidates = candidates.filter((c) => want.has(c.id));
    }

    if (!force) {
      candidates = candidates.filter((c) => !tooSoon(c));
    }

    // Prefer oldest lastReprobeAt / lastErrorAt first
    candidates.sort((a, b) => {
      const ta = new Date(
        a.providerSpecificData?.lastReprobeAt || a.lastErrorAt || a.updatedAt || 0
      ).getTime();
      const tb = new Date(
        b.providerSpecificData?.lastReprobeAt || b.lastErrorAt || b.updatedAt || 0
      ).getTime();
      return ta - tb;
    });

    const batch = candidates.slice(0, limit);
    const results = [];
    let enabled = 0;

    for (const conn of batch) {
      try {
        const r = await reprobeOneGrokCliConnection(conn, {
          modelId,
          baseUrl: options.baseUrl,
        });
        results.push(r);
        if (r.enabled) enabled += 1;
      } catch (e) {
        results.push({
          id: conn.id,
          email: conn.email || conn.name,
          ok: false,
          enabled: false,
          error: e.message || String(e),
        });
      }
    }

    console.log(
      `[GrokReprobe] done model=${modelId} candidates=${candidates.length} probed=${batch.length} enabled=${enabled}`
    );
    return {
      running: false,
      candidates: candidates.length,
      probed: batch.length,
      enabled,
      modelId,
      results,
    };
  } finally {
    g.running = false;
  }
}
