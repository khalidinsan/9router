import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/kiro/import
 *
 * Import and validate a refresh token.
 *
 * `authMethod` is preserved when the caller knows it (the kiro-cli import path
 * sends "github"/"google"). It is not cosmetic: the executor uses it to pick
 * the endpoint surface, and resolveDefaultProfileArn() maps social methods to
 * the social profile ARN. Collapsing a social account to "imported" would
 * resolve the Builder ID ARN instead.
 *
 * For IDC (organization) tokens, accepts clientId/clientSecret/region so the
 * token can be refreshed via the regional AWS OIDC endpoint.
 */
export async function POST(request) {
  try {
    const { refreshToken, clientId, clientSecret, region, authMethod, profileArn } = await request.json();

    if (!refreshToken || typeof refreshToken !== "string") {
      return NextResponse.json(
        { error: "Refresh token is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();
    const isIdc = !!(clientId && clientSecret);

    // For IDC tokens, refresh via the regional OIDC endpoint with client credentials.
    // For social/builder-id tokens, use the standard social refresh endpoint.
    const providerSpecificData = isIdc
      ? { clientId, clientSecret, region: region || "us-east-1", authMethod: "idc" }
      : {};

    const tokenData = await kiroService.refreshToken(refreshToken.trim(), providerSpecificData);

    const email = kiroService.extractEmailFromJWT(tokenData.accessToken);
    const SOCIAL_METHODS = new Set(["github", "google", "builder-id"]);
    const resolvedAuthMethod = isIdc
      ? "idc"
      : (SOCIAL_METHODS.has(authMethod) ? authMethod : "imported");
    const providerLabel = isIdc
      ? "Enterprise"
      : (resolvedAuthMethod === "imported" ? "Imported" : resolvedAuthMethod);
    const resolvedProfileArn = profileArn || tokenData.profileArn || null;

    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken || refreshToken.trim(),
      expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
      email: email || null,
      providerSpecificData: {
        profileArn: resolvedProfileArn,
        authMethod: resolvedAuthMethod,
        provider: providerLabel,
        ...(isIdc ? { clientId, clientSecret, region: region || "us-east-1" } : {}),
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Kiro import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
