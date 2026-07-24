/**
 * Re-probe disabled grok-cli accounts (402 quota / 403 permission-denied).
 *
 * Free Grok Build quota rolls ~24h; 402/403 often recover later.
 * Strategy: chat-ping a probe model with x-9r-allow-inactive pin.
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
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";
import {
  shouldRefreshCredentials,
  refreshProviderCredentials,
} from "open-sse/services/oauthCredentialManager.js";

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
  const alias = PROVIDER_ID_TO_ALIAS["grok-cli"] || "gcli";
  const fullModel = `${alias}/${modelId}`;
  const baseUrl =
    options.baseUrl ||
    `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
  const email = conn.email || conn.name || conn.id;
  const psd = conn.providerSpecificData || {};
  const nowIso = new Date().toISOString();

  let working = conn;

  // Best-effort token refresh if near expiry
  try {
    if (conn.refreshToken && shouldRefreshCredentials("grok-cli", conn)) {
      const log = {
        info: (t, m) => console.log(`[GrokReprobe][${t}] ${m}`),
        warn: (t, m) => console.warn(`[GrokReprobe][${t}] ${m}`),
        error: (t, m) => console.error(`[GrokReprobe][${t}] ${m}`),
      };
      const refreshed = await refreshProviderCredentials("grok-cli", conn, log);
      if (refreshed?.accessToken) {
        working = { ...conn, ...refreshed };
        await updateProviderConnection(conn.id, {
          ...refreshed,
          providerSpecificData: {
            ...psd,
            ...(refreshed.providerSpecificData || {}),
            reauthRequired: false,
          },
        });
      }
    }
  } catch (e) {
    console.warn(`[GrokReprobe] refresh skip ${email}: ${e.message}`);
  }

  // Same path as dashboard "Test models on this account" (pinned chat completions).
  // allowInactive: pin works while isActive=false / quota_exhausted.
  // Chat handler must NOT fallback or markAccountUnavailable on this path.
  const result = await pingModelByKind(fullModel, "llm", baseUrl, {
    connectionId: conn.id,
    allowInactive: true,
  });

  // Re-read row (ping path may have updated tokens / lastError via other handlers)
  const latest =
    (await getProviderConnections({ provider: "grok-cli" })).find(
      (c) => c.id === conn.id
    ) || conn;
  const freshPsd = latest.providerSpecificData || psd;

  if (result.ok) {
    await updateProviderConnection(conn.id, {
      ...buildGrokCliReprobeEnabledUpdate(),
      providerSpecificData: {
        ...freshPsd,
        quotaExhausted: false,
        permissionDenied: false,
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

  // Stay disabled — only stamp reprobe metadata (do not flip isActive / spam DISABLE)
  await updateProviderConnection(conn.id, {
    // keep isActive / testStatus as-is (already disabled)
    providerSpecificData: {
      ...freshPsd,
      lastReprobeAt: nowIso,
      lastReprobeOk: false,
      lastReprobeError: String(result.error || "probe failed").slice(0, 240),
      lastReprobeModel: modelId,
      lastReprobeLatencyMs: result.latencyMs ?? null,
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
