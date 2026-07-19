import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/providers/import-grok-cli
 *
 * Import Grok Build / CLI OAuth tokens into a grok-cli connection.
 * Used by grok-register farm after SSO→Device OAuth convert.
 *
 * Body: {
 *   accessToken, refreshToken?, idToken?, expiresIn?, expiresAt?,
 *   scope?, email?, name?, displayName?, userId?
 * }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const accessToken =
      typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    if (!accessToken) {
      return NextResponse.json({ error: "accessToken is required" }, { status: 400 });
    }

    const refreshToken =
      typeof body.refreshToken === "string" ? body.refreshToken.trim() : null;
    const idToken =
      typeof body.idToken === "string" ? body.idToken.trim() : null;

    let email =
      typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
    let userId =
      typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : null;
    let displayName =
      typeof body.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim()
        : null;

    try {
      const claimSource = idToken || accessToken;
      const parts = claimSource.split(".");
      if (parts.length >= 2) {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        if (!email) email = payload.email || payload.preferred_username || null;
        if (!userId) userId = payload.sub || payload.principal_id || null;
        if (!displayName) {
          const joined = [payload.given_name, payload.family_name]
            .filter(Boolean)
            .join(" ")
            .trim();
          if (joined) displayName = joined;
        }
      }
    } catch {
      /* ignore */
    }

    let expiresAt = null;
    if (typeof body.expiresAt === "string" && body.expiresAt.trim()) {
      expiresAt = body.expiresAt.trim();
    } else if (typeof body.expiresIn === "number" && body.expiresIn > 0) {
      expiresAt = new Date(Date.now() + body.expiresIn * 1000).toISOString();
    }

    const scope =
      typeof body.scope === "string" && body.scope.trim()
        ? body.scope.trim()
        : "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

    const name =
      (typeof body.name === "string" && body.name.trim()) ||
      email ||
      displayName ||
      "Grok CLI";

    const connection = await createProviderConnection({
      provider: "grok-cli",
      authType: "oauth",
      name,
      email: email || null,
      displayName: displayName || name,
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt,
      expiresIn: typeof body.expiresIn === "number" ? body.expiresIn : undefined,
      scope,
      testStatus: "active",
      providerSpecificData: {
        authMethod: "device_code",
        idToken: idToken || null,
        email: email || null,
        userId: userId || null,
        hasGrokCodeAccess: body.hasGrokCodeAccess ?? null,
        subscriptionTier: body.subscriptionTier ?? null,
      },
    });

    return NextResponse.json(
      {
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          name: connection.name,
          email: connection.email,
          displayName: connection.displayName,
          authType: connection.authType,
          isActive: connection.isActive,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.log("import-grok-cli error:", error);
    return NextResponse.json(
      { error: error?.message || "Import failed" },
      { status: 500 },
    );
  }
}
