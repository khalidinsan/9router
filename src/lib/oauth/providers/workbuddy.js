import { WORKBUDDY_OAUTH_CONFIG } from "../constants/oauth.js";
import {
  WORKBUDDY_OAUTH_PLATFORM,
  workbuddyOAuthHeaders,
} from "open-sse/config/workbuddy.js";

/**
 * WorkBuddy AI — browser OAuth polling flow, same shape as CodeBuddy.
 *
 *   1) POST /v2/plugin/auth/state?platform=workbuddy-ai → { state, authUrl }
 *   2) user signs in at authUrl
 *   3) GET  /v2/plugin/auth/token?state=<state> → accessToken (11217 while pending)
 *
 * Requests carry X-No-Authorization / X-No-User-Id so the gateway treats the
 * auth handshake as public.
 *
 * The access token is a Keycloak JWT minted by the workbuddy.ai realm and
 * carries the account identity:
 *   sub                → account id the gateway wants echoed in x-user-id
 *   preferred_username → the human handle the official CLI displays
 *   email              → verified address (also what the UI lists)
 *
 * Anything unparseable yields {} so login still succeeds on an opaque token.
 */
function decodeWorkbuddyClaims(accessToken) {
  if (typeof accessToken !== "string") return {};
  const parts = accessToken.split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return {
      sub: payload.sub || null,
      email: payload.email || null,
      preferredUsername: payload.preferred_username || null,
    };
  } catch {
    return {};
  }
}

const workbuddy = {
  config: WORKBUDDY_OAUTH_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(
      `${config.stateUrl}?platform=${WORKBUDDY_OAUTH_PLATFORM}`,
      {
        method: "POST",
        headers: workbuddyOAuthHeaders(),
        body: "{}",
      }
    );
    if (!response.ok) {
      throw new Error(`WorkBuddy state request failed: ${await response.text()}`);
    }
    const data = await response.json();
    if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
      throw new Error(`WorkBuddy state error: ${data.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: data.data.state,
      verification_uri: data.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      _isWorkBuddy: true,
    };
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(
      `${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`,
      {
        method: "GET",
        headers: workbuddyOAuthHeaders({
          "X-No-Enterprise-Id": "true",
          "X-No-Department-Info": "true",
        }),
      }
    );
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = await response.json();
    if (data.code === 0 && data.data?.accessToken) {
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
          // The gateway expects the account sub as x-user-id on chat turns.
          _userId: data.data.userId || data.data.uid || null,
        },
      };
    }
    if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  mapTokens: (tokens) => {
    // The access token is a Keycloak JWT carrying the account identity. Decode
    // once and reuse: `sub` is the account id the gateway wants echoed back in
    // x-user-id, while `preferred_username`/`email` name the connection so the
    // UI shows a real account handle instead of "Account 1".
    const claims = decodeWorkbuddyClaims(tokens.access_token);
    const userId = tokens._userId || claims.sub || null;
    // preferred_username is the handle the official CLI shows; email is the
    // fallback for realms that only populate the verified address.
    const accountName = claims.preferredUsername || claims.email || null;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 86400,
      // createProviderConnection names OAuth rows from `name`, and falls back
      // to `Account <n>` when it is missing.
      ...(accountName ? { name: accountName, displayName: accountName } : {}),
      ...(claims.email ? { email: claims.email } : {}),
      providerSpecificData: userId ? { userId } : {},
    };
  },
};

export default workbuddy;
