import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/grok-cli/import-token
 *
 * Import Grok Build / CLI OAuth tokens (e.g. from farm SSO→device convert)
 * into a grok-cli connection — same shape as the dashboard device_code flow.
 *
 * Body:
 * {
 *   accessToken: string,          // required
 *   refreshToken?: string,
 *   idToken?: string,
 *   expiresIn?: number,
 *   expiresAt?: string,           // ISO; preferred over expiresIn if both set
 *   scope?: string,
 *   email?: string,
 *   name?: string,
 *   displayName?: string,
 *   userId?: string,
 * }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const accessToken =
      typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    if (!accessToken) {
      return NextResponse.json(
        { error: "accessToken is required" },
        { status: 400 },
      );
    }

    const refreshToken =
      typeof body.refreshToken === "string" ? body.refreshToken.trim() : null;
    const idToken =
      typeof body.idToken === "string" ? body.idToken.trim() : null;

    // Identity from body or JWT claims
    let email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim()
        : null;
    let userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId.trim()
        : null;
    let displayName =
      typeof body.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim()
        : null;

    const claimSource = idToken || accessToken;
    try {
      const parts = claimSource.split(".");
      if (parts.length >= 2) {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(
          Buffer.from(padded, "base64").toString("utf8"),
        );
        if (!email) email = payload.email || payload.preferred_username || null;
        if (!userId) userId = payload.sub || payload.principal_id || null;
        if (!displayName) {
          const given = payload.given_name || payload.givenName || "";
          const family = payload.family_name || payload.familyName || "";
          const joined = [given, family].filter(Boolean).join(" ").trim();
          if (joined) displayName = joined;
        }
      }
    } catch {
      /* ignore jwt parse */
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
      expiresIn:
        typeof body.expiresIn === "number" ? body.expiresIn : undefined,
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
    console.log("Grok CLI token import error:", error);
    return NextResponse.json(
      { error: error?.message || "Import failed" },
      { status: 500 },
    );
  }
}
