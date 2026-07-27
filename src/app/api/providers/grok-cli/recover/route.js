import { NextResponse } from "next/server";
import {
  getProviderConnections,
  getProviderConnectionById,
  updateProviderConnection,
} from "@/lib/localDb";
import {
  GROK_CLI_PROBE_REFRESHED_CREDENTIALS,
  probeGrokCliConnection,
} from "@/shared/services/grokCliProbe";
import { buildGrokCliManualEnableUpdate } from "open-sse/services/grokCliSafety.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function isRecoveryCandidate(connection) {
  if (!connection || connection.provider !== "grok-cli") return false;
  if (!connection.accessToken && !connection.refreshToken) return false;
  const psd = connection.providerSpecificData || {};
  if (psd.reauthRequired === true || connection.testStatus === "reauth_required") return false;
  return (
    connection.isActive === false ||
    ["quota_exhausted", "suspected_quota", "permission_denied", "unavailable"].includes(
      String(connection.testStatus || "")
    ) ||
    psd.quotaExhausted === true ||
    psd.permissionDenied === true
  );
}

/**
 * POST /api/providers/grok-cli/recover
 * Body: { modelId, apply?: false, limit?: 10, connectionIds?: string[] }
 *
 * Dry-run is the default. Every candidate is probed directly against the Grok
 * CLI Responses endpoint; apply mode only re-enables accounts that return 200.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const modelId = String(body.modelId || "grok-4.5").trim();
    const apply = body.apply === true;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(body.limit) || DEFAULT_LIMIT));
    const all = await getProviderConnections({ provider: "grok-cli" });
    let candidates = all.filter(isRecoveryCandidate);

    if (Array.isArray(body.connectionIds) && body.connectionIds.length > 0) {
      const wanted = new Set(body.connectionIds.map(String));
      candidates = candidates.filter((connection) => wanted.has(connection.id));
    }

    candidates.sort((a, b) =>
      new Date(a.lastErrorAt || a.updatedAt || 0).getTime() -
      new Date(b.lastErrorAt || b.updatedAt || 0).getTime()
    );

    const selected = candidates.slice(0, limit);
    const results = [];
    let recoverable = 0;
    let recovered = 0;

    // Deliberately sequential: avoid triggering a shared upstream gate while
    // repairing a large pool.
    for (const connection of selected) {
      const probe = await probeGrokCliConnection(connection, modelId, {
        refreshCredentials: apply,
      });
      const refreshedCredentials = probe[GROK_CLI_PROBE_REFRESHED_CREDENTIALS];
      if (apply && refreshedCredentials) {
        await updateProviderConnection(connection.id, {
          ...refreshedCredentials,
          providerSpecificData: {
            ...(connection.providerSpecificData || {}),
            ...(refreshedCredentials.providerSpecificData || {}),
            reauthRequired: false,
          },
        });
      }
      let enabled = false;
      if (probe.ok) {
        recoverable += 1;
        if (apply) {
          const latest = await getProviderConnectionById(connection.id);
          if (!latest || !isRecoveryCandidate(latest)) {
            results.push({
              id: connection.id,
              email: connection.email || connection.name || connection.id,
              ok: true,
              status: probe.status,
              error: "State changed during probe; skipped apply",
              latencyMs: probe.latencyMs,
              tokenFingerprint: probe.tokenFingerprint,
              enabled: false,
            });
            continue;
          }
          const now = new Date();
          const update = buildGrokCliManualEnableUpdate(latest, now);
          await updateProviderConnection(connection.id, {
            ...update,
            providerSpecificData: {
              ...update.providerSpecificData,
              recoveredAt: now.toISOString(),
              recoveryModel: modelId,
              recoveryTokenFingerprint: probe.tokenFingerprint || null,
            },
          });
          enabled = true;
          recovered += 1;
        }
      }
      results.push({
        id: connection.id,
        email: connection.email || connection.name || connection.id,
        ok: probe.ok,
        status: probe.status,
        error: probe.error ? String(probe.error).slice(0, 240) : null,
        latencyMs: probe.latencyMs,
        tokenFingerprint: probe.tokenFingerprint,
        enabled,
      });
    }

    return NextResponse.json({
      dryRun: !apply,
      apply,
      modelId,
      total: all.length,
      candidates: candidates.length,
      probed: selected.length,
      recoverable,
      recovered,
      remaining: Math.max(0, candidates.length - selected.length),
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Grok CLI recovery failed" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const all = await getProviderConnections({ provider: "grok-cli" });
    const candidates = all.filter(isRecoveryCandidate);
    return NextResponse.json({
      total: all.length,
      candidates: candidates.length,
      note: "POST is dry-run by default; pass apply:true only after reviewing results.",
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}
