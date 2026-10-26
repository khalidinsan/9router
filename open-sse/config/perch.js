/**
 * Perch Terminal (perchai.app) wire constants.
 *
 * Perch has no public API — this is the desktop app / official CLI wire,
 * captured live from `perchai-cli` 2.4.118 by proxying a real turn:
 *
 *   POST {APP}/api/perch-terminal/turn-ticket     → { ticket, ticketId, runId }
 *   POST {APP}/api/perch-terminal/model-call      → SSE (answer_delta / done)
 *
 * Auth is a Supabase access token (JWT, iss=<project>.supabase.co) stored by the
 * CLI in the macOS keychain (`app.perchai.cli-auth`), refreshed with the
 * project's public anon key fetched from /api/perch-terminal/cli-auth/config.
 *
 * The model-call route gates on `perch_surface_required`: it rejects a request
 * whose body does not look like a real Perch turn. Measured empirically, the
 * only thing that matters is a system message of >= 200 characters (a 199-char
 * system prompt is refused, 200 is accepted; the content itself is irrelevant).
 * PERCH_SYSTEM_MARKER below satisfies that, exactly like mimo-free's
 * MIMO_SYSTEM_MARKER satisfies Xiaomi's "Illegal access" gate.
 *
 * Wire note: every turn needs a ticket minted for the SAME runId it is sent
 * with. Tickets live ~5 minutes; a turn that outlives one re-mints.
 */

export const PERCH_APP_URL = process.env.PERCH_APP_URL || "https://app.perchai.app";

export const PERCH_TICKET_PATH = "/api/perch-terminal/turn-ticket";
export const PERCH_MODEL_CALL_PATH = "/api/perch-terminal/model-call";
export const PERCH_AUTH_CONFIG_PATH = "/api/perch-terminal/cli-auth/config";

export const PERCH_TICKET_HEADER = "x-perch-turn-ticket";
export const PERCH_LOCALE_HEADER = "x-perch-locale";
export const PERCH_CALL_DELTA_HEADER = "x-perch-call-delta";

/** Agent prefix the published CLI sends. Server-side attribution reads it. */
export const PERCH_CLI_UA_PREFIX = "perchai-cli/";
export const PERCH_CLI_VERSION = "2.4.118";

export function perchUserAgent() {
  return `${PERCH_CLI_UA_PREFIX}${PERCH_CLI_VERSION}`;
}

/**
 * The surface gate: a >=200-character system prompt. Content is not inspected
 * (a 300-char run of "a" passes), so this is the shortest honest marker.
 */
export const PERCH_SYSTEM_MARKER =
  "You are Perch, a terminal-native agent operator. Answer the user's request " +
  "directly and completely, using the tools available to you when they help. " +
  "Be concise, be accurate, and do not invent facts. When a request is " +
  "ambiguous, state the assumption you made and continue rather than stalling.";

/** Per-turn attribution the route expects in the body. */
export function perchAttribution({ userId, workspaceId, runId, lane, surface }) {
  return {
    userId: userId || null,
    workspaceId: workspaceId || null,
    runId,
    lane,
    source: surface,
    billingMultiplier: null,
  };
}

export const PERCH_TICKET_TTL_MS = 5 * 60 * 1000;
export const PERCH_TICKET_RENEW_BEFORE_MS = 30 * 1000;

/**
 * The connection's single credential field carries the Perch CLI session.
 *
 * Perch rotates its Supabase access token hourly, so a bare access token would
 * stop working within the hour. Accepting the CLI's own session object keeps
 * the refresh token alongside it:
 *
 *   security find-generic-password -s app.perchai.cli-auth -w
 *
 * A bare JWT is still accepted (it works until it expires) so a quick paste is
 * not rejected outright.
 */
export function parsePerchCredential(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { accessToken: null, refreshToken: null, userId: null, workspaceId: null, expiresAt: null, email: null };

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      const expiresAt =
        typeof parsed.expiresAt === "number"
          ? new Date(parsed.expiresAt * 1000).toISOString()
          : typeof parsed.expiresAt === "string" && parsed.expiresAt.trim()
            ? parsed.expiresAt.trim()
            : null;
      return {
        accessToken: parsed.accessToken || parsed.access_token || null,
        refreshToken: parsed.refreshToken || parsed.refresh_token || null,
        userId: parsed.userId || parsed.user_id || null,
        workspaceId: parsed.workspaceId || parsed.workspace_id || null,
        expiresAt,
        email: parsed.email || null,
      };
    } catch {
      // malformed JSON: fall through and treat it as a bare token
    }
  }

  // "access|refresh" is the compact form for hand-edited connections.
  if (value.includes("|")) {
    const [accessToken, refreshToken] = value.split("|");
    return {
      accessToken: accessToken?.trim() || null,
      refreshToken: refreshToken?.trim() || null,
      userId: null,
      workspaceId: null,
      expiresAt: null,
      email: null,
    };
  }

  return { accessToken: value, refreshToken: null, userId: null, workspaceId: null, expiresAt: null, email: null };
}

/** The credential a connection carries, from either field the gateway fills. */
export function perchCredentialFrom(credentials) {
  return parsePerchCredential(
    credentials?.accessToken || credentials?.apiKey || credentials?.providerSpecificData?.perchSession
  );
}

/**
 * How long one turn may wait for the per-account turn window before giving up.
 *
 * The mint route answers 429 `turn_rate_limited` with a short reset (observed
 * 4–8s) while the account is between turns. Waiting here keeps a burst of
 * requests from being reported as an account failure.
 */
export const PERCH_MINT_MAX_WAIT_MS = 30_000;

/**
 * Wait implied by a 429 body, clamped to what is left of `deadline`.
 *
 * The refusal is a JSON string inside an error message ("reset after 8s"), so
 * parse it defensively and default to a short pause.
 */
export function perchRateLimitWaitMs(rawBody, deadline = Infinity) {
  const match = /reset after (\d+)\s*s/i.exec(typeof rawBody === "string" ? rawBody : "");
  const seconds = match ? Number(match[1]) : 5;
  const target = Math.min(Date.now() + Math.max(1, seconds) * 1000 + 500, deadline);
  return Math.max(500, target - Date.now());
}
