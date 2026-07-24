import { NextResponse } from "next/server";
import {
  getProviderConnections,
  getProviderConnectionById,
} from "@/lib/localDb";
import {
  isGrokCliReprobeCandidate,
  reprobeOneGrokCliConnection,
  reprobeDisabledGrokCliAccounts,
} from "@/shared/services/grokCliReprobe";

/**
 * POST /api/providers/grok-cli/reprobe-disabled
 *
 * Re-test auto-disabled grok-cli accounts. modelId is REQUIRED.
 *
 * Body:
 *   modelId: string            // required — probe model (e.g. grok-build)
 *   connectionId?: string      // single account (preferred for UI one-by-one)
 *   connectionIds?: string[]   // batch subset
 *   limit?: number             // batch only
 *   force?: boolean            // ignore 45m cooldown
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const modelId = String(body.modelId || "").trim();
    if (!modelId) {
      return NextResponse.json(
        { error: "modelId is required — pick a model before reprobing" },
        { status: 400 }
      );
    }

    // ── Single connection (UI progress loop) ──
    if (body.connectionId) {
      const conn = await getProviderConnectionById(String(body.connectionId));
      if (!conn || conn.provider !== "grok-cli") {
        return NextResponse.json(
          { error: "Connection not found" },
          { status: 404 }
        );
      }
      if (!isGrokCliReprobeCandidate(conn) && body.force !== true) {
        // Still allow force single re-probe if it has tokens
        if (!conn.accessToken && !conn.refreshToken) {
          return NextResponse.json(
            { error: "Not a re-probe candidate (no tokens or reauth required)" },
            { status: 400 }
          );
        }
      }
      const result = await reprobeOneGrokCliConnection(conn, { modelId });
      return NextResponse.json({
        modelId,
        single: true,
        ...result,
      });
    }

    // ── Batch (maintenance / API scripts) ──
    const summary = await reprobeDisabledGrokCliAccounts({
      limit: body.limit,
      force: body.force === true,
      modelId,
      connectionIds: body.connectionIds,
    });

    return NextResponse.json(summary);
  } catch (error) {
    console.error("[GrokReprobe] API error:", error);
    return NextResponse.json(
      { error: error?.message || "Reprobe failed" },
      { status: 500 }
    );
  }
}

/**
 * GET — list re-probe candidates (no network).
 */
export async function GET() {
  try {
    const all = await getProviderConnections({ provider: "grok-cli" });
    const candidates = all.filter(isGrokCliReprobeCandidate);
    return NextResponse.json({
      total: all.length,
      candidates: candidates.length,
      sample: candidates.map((c) => ({
        id: c.id,
        email: c.email || c.name,
        name: c.name || c.email,
        testStatus: c.testStatus,
        isActive: c.isActive !== false,
        lastError: c.lastError || null,
        lastReprobeAt: c.providerSpecificData?.lastReprobeAt || null,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed" },
      { status: 500 }
    );
  }
}
