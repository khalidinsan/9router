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
 */
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
    // The access token is a Keycloak JWT; its `sub` is the account id the
    // gateway wants echoed back in x-user-id.
    let userId = tokens._userId || null;
    if (!userId && typeof tokens.access_token === "string") {
      try {
        const payload = JSON.parse(
          Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8")
        );
        userId = payload.sub || null;
      } catch {
        userId = null;
      }
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 86400,
      providerSpecificData: userId ? { userId } : {},
    };
  },
};

export default workbuddy;
