import { NextResponse } from "next/server";
import { getModelRoutes, setModelRoute, deleteModelRoute } from "@/models";
import { getModelInfo } from "@/sse/services/model.js";
import { isValidModel } from "@/shared/constants/models";
import { getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

// GET /api/models/routing - Get all model routes
export async function GET() {
  try {
    const routes = await getModelRoutes();
    return NextResponse.json({ routes });
  } catch (error) {
    console.log("Error fetching model routes:", error);
    return NextResponse.json({ error: "Failed to fetch model routes" }, { status: 500 });
  }
}

// PUT /api/models/routing - Set a model route
// Body: { from: "cmc/deepseek/deepseek-v4.1-flash", to: "wb/deepseek-v4.1-flash" }
export async function PUT(request) {
  try {
    const body = await request.json();
    const from = typeof body?.from === "string" ? body.from.trim() : "";
    const to = typeof body?.to === "string" ? body.to.trim() : "";

    if (!from || !to) {
      return NextResponse.json({ error: "Both 'from' and 'to' are required" }, { status: 400 });
    }
    if (from === to) {
      return NextResponse.json({ error: "Source and target are the same model" }, { status: 400 });
    }

    // Refuse to create a cycle: if the target already routes back to the
    // source (or deeper), the request would ping-pong. Routing is resolved
    // once per request so this cannot loop forever, but a cycle still means
    // the user's intent is ambiguous — reject it up front.
    const existing = await getModelRoutes();
    let cursor = to;
    const seen = new Set([from]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = existing[cursor];
    }
    if (cursor === from) {
      return NextResponse.json(
        { error: `Cycle detected: ${to} already routes back to ${from}` },
        { status: 400 }
      );
    }

    // Both ends must resolve to a KNOWN PROVIDER — that is the part that would
    // actually break at request time.
    //
    // Two traps here, both learned the hard way:
    //
    //  1. `parseModel` alone is not enough — it just splits on the first slash
    //     and hands back whatever prefix it found, so "nope/fake-model" parses
    //     "successfully" with provider "nope".
    //  2. `getModelInfo` must be called with skipRouting, or validating the
    //     source would resolve through the very route being validated (or an
    //     existing one) and report the target back — circular.
    //
    // The model id itself is deliberately NOT required to be in the static
    // registry. Several providers expose a larger upstream catalog than the
    // registry mirrors (e.g. commandcode serves deepseek/deepseek-v4.1-flash
    // fine while only deepseek-v4-pro is listed locally), and the chat path
    // does not registry-check model ids either — it parses and dispatches. A
    // hard check here would reject routes that work, so an unrecognised id is
    // surfaced as a warning instead of a 400.
    const [fromInfo, toInfo] = await Promise.all([
      getModelInfo(from, { skipRouting: true }).catch(() => null),
      getModelInfo(to, { skipRouting: true }).catch(() => null),
    ]);
    const fromProvider = fromInfo?.provider ? getProviderByAlias(fromInfo.provider) : null;
    const toProvider = toInfo?.provider ? getProviderByAlias(toInfo.provider) : null;
    if (!fromProvider) {
      return NextResponse.json(
        { error: `Source model "${from}" does not resolve to a known provider` },
        { status: 400 }
      );
    }
    if (!toProvider) {
      return NextResponse.json(
        { error: `Target model "${to}" does not resolve to a known provider` },
        { status: 400 }
      );
    }

    // Advisory only — see note above. Keyed by provider ALIAS ("wb"), not the
    // canonical id ("workbuddy") that getModelInfo returns.
    const warnings = [];
    if (!isValidModel(fromProvider.alias || fromProvider.id, fromInfo.model)) {
      warnings.push(`"${fromInfo.model}" is not in the local model list for ${fromInfo.provider}; it will still be forwarded upstream.`);
    }
    if (!isValidModel(toProvider.alias || toProvider.id, toInfo.model)) {
      warnings.push(`"${toInfo.model}" is not in the local model list for ${toInfo.provider}; it will still be forwarded upstream.`);
    }

    await setModelRoute(from, to);
    return NextResponse.json({ success: true, from, to, warnings });
  } catch (error) {
    console.log("Error updating model route:", error);
    return NextResponse.json({ error: "Failed to update model route" }, { status: 500 });
  }
}

// DELETE /api/models/routing?from=xxx - Delete a model route
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");

    if (!from) {
      return NextResponse.json({ error: "Query param 'from' is required" }, { status: 400 });
    }

    await deleteModelRoute(from);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting model route:", error);
    return NextResponse.json({ error: "Failed to delete model route" }, { status: 500 });
  }
}
