import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { toProviderConnectionResponse } from "@/lib/providerConnectionResponse";
import {
  startMistralSignIn,
  pollMistralSignIn,
  fetchMistralAccount,
} from "open-sse/services/mistralSignIn.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/mistral/browser-sign-in → start an attempt, return the URL
export async function POST() {
  try {
    const started = await startMistralSignIn();
    return NextResponse.json(started);
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to start Mistral sign-in" },
      { status: 502 },
    );
  }
}

// GET /api/oauth/mistral/browser-sign-in?processId=… → poll; saves on success
export async function GET(request) {
  const processId = request.nextUrl.searchParams.get("processId");
  if (!processId) {
    return NextResponse.json({ error: "processId is required" }, { status: 400 });
  }

  try {
    const result = await pollMistralSignIn(processId);
    if (result.status !== "completed") {
      const { apiKey, ...rest } = result;
      return NextResponse.json(rest);
    }

    const account = await fetchMistralAccount(result.apiKey);
    const plan = account?.plan_name || null;
    const connection = await createProviderConnection({
      provider: "mistral",
      authType: "apikey",
      name: plan ? `Mistral Vibe (${plan})` : "Mistral Vibe",
      apiKey: result.apiKey,
      isActive: true,
      testStatus: "active",
      // keyType is documentation for humans reading the DB: a Vibe key bills
      // against the plan's Vibe Code allowance, not the Studio API allowance.
      providerSpecificData: {
        authMethod: "browser-sign-in",
        keyType: "vibe",
        ...(plan ? { plan } : {}),
        ...(account?.plan_type ? { planType: account.plan_type } : {}),
      },
      allowOverwrite: true,
    });

    return NextResponse.json({
      status: "success",
      connection: toProviderConnectionResponse(connection),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: error?.message || "Mistral sign-in failed" },
      { status: 502 },
    );
  }
}
