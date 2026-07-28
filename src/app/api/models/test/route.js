import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { pingModelByKind } from "./ping";
import { isGrokCliAuthoritativeFreeUsageExhausted } from "open-sse/services/accountFallback.js";
import {
  buildGrokCliAuthoritativeQuotaExhaustedUpdate,
  buildGrokCliSuccessUpdate,
} from "open-sse/services/grokCliSafety.js";

// POST /api/models/test - Ping a single model via internal completions or embeddings
// Body: { model, kind?, connectionId? }
export async function POST(request) {
  try {
    const body = await request.json();
    const { model, kind, connectionId, allowInactive } = body || {};
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const [modelProvider, ...modelParts] = String(model).split("/");
    if (connectionId && ["gcli", "grok-cli", "grok-build", "gb"].includes(modelProvider)) {
      const connection = await getProviderConnectionById(String(connectionId));
      if (!connection || connection.provider !== "grok-cli") {
        return NextResponse.json({ ok: false, error: "Grok CLI connection not found" }, { status: 404 });
      }
      const {
        GROK_CLI_PROBE_REFRESHED_CREDENTIALS,
        probeGrokCliConnection,
      } = await import("@/shared/services/grokCliProbe");
      const result = await probeGrokCliConnection(connection, modelParts.join("/"));
      const refreshedCredentials = result[GROK_CLI_PROBE_REFRESHED_CREDENTIALS];
      if (refreshedCredentials) {
        await updateProviderConnection(connection.id, {
          ...refreshedCredentials,
          providerSpecificData: {
            ...(connection.providerSpecificData || {}),
            ...(refreshedCredentials.providerSpecificData || {}),
            reauthRequired: false,
          },
        });
      }
      if (result.ok) {
        await updateProviderConnection(
          connection.id,
          buildGrokCliSuccessUpdate(connection)
        );
      } else if (
        isGrokCliAuthoritativeFreeUsageExhausted(
          "grok-cli",
          result.status,
          result.error
        )
      ) {
        await updateProviderConnection(
          connection.id,
          buildGrokCliAuthoritativeQuotaExhaustedUpdate(
            connection,
            result.status,
            result.error
          )
        );
      }
      return NextResponse.json({ ...result, connectionId: String(connectionId), isolated: true });
    }
    const result = await pingModelByKind(model, kind || "llm", undefined, {
      connectionId: connectionId || null,
      allowInactive: allowInactive === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
