/**
 * Perch Terminal OAuth — Supabase (GoTrue) PKCE against the Perch project.
 *
 * This is exactly what `perch login` does (perchai-cli 2.4.118), reverse
 * engineered from the CLI bundle:
 *
 *   1. GET  {app}/api/perch-terminal/cli-auth/config
 *           → { supabaseUrl, supabaseAnonKey, providers: ["google","github"] }
 *   2. Open {supabaseUrl}/auth/v1/authorize
 *           ?provider=google&redirect_to=<loopback>/callback
 *           &code_challenge=<S256>&code_challenge_method=s256
 *   3. Google/GitHub → Supabase /auth/v1/callback → 302 to the loopback URL
 *      with ?code=<uuid>
 *   4. POST {supabaseUrl}/auth/v1/token?grant_type=pkce
 *           { auth_code, code_verifier }  (apikey: <anonKey>)
 *           → { access_token, refresh_token, expires_in }
 *
 * Owning the whole flow here is what makes the connection self-sustaining: the
 * refresh token is ours from the first mint, so the stored one is never spent
 * by a second client (the CLI or Desktop app signing in again).
 *
 * The anon key and Supabase URL are public (the CLI ships them and the config
 * route serves them unauthenticated), so they are fetched at call time rather
 * than baked into the registry — a project move cannot break a saved session.
 */

const PERCH_APP = process.env.PERCH_APP_URL || "https://app.perchai.app";
const AUTH_CONFIG_PATH = "/api/perch-terminal/cli-auth/config";

let cachedConfig = null;
let cachedAt = 0;
const CONFIG_TTL_MS = 60 * 60 * 1000;

async function perchAuthConfig() {
  if (cachedConfig && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  const response = await fetch(`${PERCH_APP}${AUTH_CONFIG_PATH}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Perch auth config failed: ${response.status}`);
  }
  const data = await response.json();
  if (!data?.supabaseUrl || !data?.supabaseAnonKey) {
    throw new Error("Perch auth config missing supabaseUrl/supabaseAnonKey");
  }
  cachedConfig = {
    supabaseUrl: data.supabaseUrl.replace(/\/+$/, ""),
    anonKey: data.supabaseAnonKey,
    providers: Array.isArray(data.providers) ? data.providers : ["google"],
  };
  cachedAt = Date.now();
  return cachedConfig;
}

const perch = {
  config: {},
  flowType: "authorization_code_pkce",

  /**
   * Resolve the Supabase project at flow start. `meta.provider` picks the
   * identity provider ("google" default, or "github").
   */
  prepareConfig: async (config, meta = {}) => {
    const auth = await perchAuthConfig();
    const wanted = typeof meta.provider === "string" ? meta.provider : "google";
    const provider = auth.providers.includes(wanted) ? wanted : auth.providers[0];
    return {
      ...config,
      supabaseUrl: auth.supabaseUrl,
      anonKey: auth.anonKey,
      provider,
      authorizeUrl: `${auth.supabaseUrl}/auth/v1/authorize`,
      tokenUrl: `${auth.supabaseUrl}/auth/v1/token`,
      pkce: true,
    };
  },

  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      provider: config.provider,
      redirect_to: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "s256",
    });
    // GoTrue carries its own state through redirect_to; a `state` param is not
    // part of its authorize contract and would be rejected as unknown.
    return `${config.authorizeUrl}?${params.toString()}`;
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    // The callback may arrive as a full URL (pasted) rather than a bare code.
    let authCode = typeof code === "string" ? code.trim() : "";
    if (authCode.includes("code=")) {
      try {
        const url = new URL(authCode, "http://127.0.0.1");
        authCode = url.searchParams.get("code") || authCode;
      } catch {
        // not a URL: use it verbatim
      }
    }
    if (!authCode) throw new Error("Missing Perch authorization code");

    const response = await fetch(`${config.tokenUrl}?grant_type=pkce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
      },
      body: JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perch token exchange failed: ${error.slice(0, 300)}`);
    }
    return await response.json();
  },

  mapTokens: (tokens) => {
    let email = null;
    let userId = null;
    try {
      const payload = JSON.parse(
        Buffer.from(String(tokens.access_token).split(".")[1], "base64url").toString("utf8")
      );
      email = payload.email || null;
      userId = payload.sub || null;
    } catch {
      // opaque token: identity stays unknown, login still succeeds
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      email,
      displayName: email || "Perch Terminal",
      providerSpecificData: {
        authMethod: "oauth",
        userId,
        workspaceId: null,
        appUrl: PERCH_APP,
      },
    };
  },
};

export default perch;
export { perchAuthConfig };
