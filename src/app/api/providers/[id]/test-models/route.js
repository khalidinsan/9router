import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId — pin every probe to this account via x-connection-id.
 *
 * Body (optional):
 *   models?: string[]          // subset of model ids
 *   concurrency?: number       // default 3 (after warm-up)
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const providerId = connection.provider;
    const isCompatible =
      isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      kind: m.kind || m.type || "llm",
    }));

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    // Compatible providers: fetch live model list when catalog empty
    if (isCompatible && models.length === 0) {
      try {
        const modelsRes = await fetch(`${baseUrl}/api/providers/${id}/models`);
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({
            id: m.id || m.name,
            name: m.name || m.id,
            kind: m.kind || m.type || "llm",
          }));
        }
      } catch {
        /* fallback to empty */
      }
    }

    // Optional subset filter
    if (Array.isArray(body.models) && body.models.length > 0) {
      const want = new Set(body.models.map(String));
      models = models.filter((m) => want.has(m.id));
      // Allow probing ids not in catalog (custom model ids)
      for (const mid of want) {
        if (!models.some((m) => m.id === mid)) {
          models.push({ id: mid, name: mid, kind: "llm" });
        }
      }
    }

    // LLM-only by default for account test panel (media models have own pages)
    models = models.filter((m) => !m.kind || m.kind === "llm");

    if (models.length === 0) {
      return NextResponse.json(
        { error: "No models configured for this provider" },
        { status: 400 }
      );
    }

    const concurrency = Math.max(1, Math.min(5, Number(body.concurrency) || 3));
    const pin = { connectionId: id };

    // Warm first model (token refresh) then batch the rest
    const [first, ...rest] = models;
    const firstResult = await pingModelByKind(
      `${alias}/${first.id}`,
      first.kind || "llm",
      baseUrl,
      pin
    );
    const results = [
      {
        modelId: first.id,
        name: first.name || first.id,
        kind: first.kind || "llm",
        ...firstResult,
      },
    ];

    // Concurrent batches
    for (let i = 0; i < rest.length; i += concurrency) {
      const batch = rest.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (model) => {
          const result = await pingModelByKind(
            `${alias}/${model.id}`,
            model.kind || "llm",
            baseUrl,
            pin
          );
          return {
            modelId: model.id,
            name: model.name || model.id,
            kind: model.kind || "llm",
            ...result,
          };
        })
      );
      results.push(...batchResults);
    }

    const okCount = results.filter((r) => r.ok).length;
    return NextResponse.json({
      provider: providerId,
      connectionId: id,
      alias,
      okCount,
      failCount: results.length - okCount,
      results,
    });
  } catch (error) {
    console.log("Error testing models:", error);
    return NextResponse.json(
      { error: error?.message || "Test failed" },
      { status: 500 }
    );
  }
}
