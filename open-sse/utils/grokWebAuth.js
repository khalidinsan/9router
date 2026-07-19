/**
 * Grok Web SSO helpers — aligned with grok2api's BuildSSOCookie / import sanitize.
 *
 * Cookie formats accepted in connection.apiKey:
 *  1) raw JWT
 *  2) sso=<jwt>
 *  3) sso=<jwt>; sso-rw=<jwt> [; cf_clearance=...]
 *
 * Optional Cloudflare cookies may also live in:
 *   credentials.providerSpecificData.cloudflareCookies
 *   credentials.providerSpecificData.cf_clearance
 */

const CF_COOKIE_NAMES = new Set([
  "cf_clearance",
  "cf_chl_rc_i",
  "cf_chl_2",
  "cf_chl_prog",
  "cf_chl_seq",
  "__cf_bm",
]);

/**
 * Strip "sso=" prefix and take first segment before ';' for a bare token.
 */
export function sanitizeSSOToken(value) {
  let token = String(value || "").trim();
  if (!token) return "";
  if (token.toLowerCase().startsWith("sso=")) {
    token = token.slice(4).trim();
  }
  // If full header was pasted but we only want the bare JWT:
  if (token.includes(";") && !token.includes("=")) {
    token = token.split(";")[0].trim();
  }
  // If still looks like "sso=jwt; sso-rw=..." don't strip further here —
  // callers that want the bare JWT should use extractSSOTokenFromCredential.
  return token.replace(/[\r\n\x00]/g, "").trim();
}

/**
 * Parse a credential string into { sso, ssoRw, cloudflareParts[] }.
 */
export function parseGrokCookieCredential(raw) {
  const input = String(raw || "").trim();
  const out = { sso: "", ssoRw: "", cloudflareParts: [] };
  if (!input) return out;

  // Full cookie header style
  if (input.includes("=") && (input.includes("sso") || input.includes("cf_"))) {
    const parts = input.split(";").map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name || !value) continue;
      const low = name.toLowerCase();
      if (low === "sso") out.sso = value;
      else if (low === "sso-rw") out.ssoRw = value;
      else if (CF_COOKIE_NAMES.has(low) || low.startsWith("cf_")) {
        out.cloudflareParts.push(`${low}=${value}`);
      }
    }
    // Bare first segment fallback if someone pasted "jwt; other"
    if (!out.sso && parts[0] && !parts[0].includes("=")) {
      out.sso = parts[0];
    }
    return out;
  }

  // "sso=jwt" without extra pairs
  if (input.toLowerCase().startsWith("sso=")) {
    out.sso = input.slice(4).trim();
    // cut trailing junk after ;
    if (out.sso.includes(";")) out.sso = out.sso.split(";")[0].trim();
    return out;
  }

  // raw JWT (or token) — cut at ; just in case
  out.sso = input.includes(";") ? input.split(";")[0].trim() : input;
  return out;
}

/**
 * Sanitize cloudflare cookie string — keep only CF-related pairs.
 * Mirrors grok2api SanitizeCloudflareCookies spirit.
 */
export function sanitizeCloudflareCookies(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const kept = [];
  for (const part of input.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim().toLowerCase();
    const val = trimmed.slice(eq + 1).trim();
    if (!val) continue;
    if (CF_COOKIE_NAMES.has(name) || name.startsWith("cf_")) {
      // drop control chars
      if (/[\r\n\x00]/.test(val)) continue;
      kept.push(`${name}=${val}`);
    }
  }
  return kept.join("; ");
}

/**
 * Build Cookie header exactly like grok2api BuildSSOCookie:
 *   sso=<token>; sso-rw=<token|ssoRw> [; cf_...]
 */
export function buildSSOCookie(apiKey, providerSpecificData = {}) {
  const parsed = parseGrokCookieCredential(apiKey);
  const sso = (parsed.sso || "").replace(/[\r\n\x00]/g, "").trim();
  if (!sso) return "";

  // Prefer explicit sso-rw from paste; else mirror sso (grok2api behavior)
  const ssoRw = (parsed.ssoRw || sso).replace(/[\r\n\x00]/g, "").trim();

  const cfFromPsd = sanitizeCloudflareCookies(
    providerSpecificData?.cloudflareCookies
      || providerSpecificData?.cfCookies
      || (providerSpecificData?.cf_clearance
        ? `cf_clearance=${providerSpecificData.cf_clearance}`
        : "")
  );
  const cfFromPaste = sanitizeCloudflareCookies(parsed.cloudflareParts.join("; "));
  // Merge unique CF pairs (paste first, then psd)
  const cfMap = new Map();
  for (const src of [cfFromPaste, cfFromPsd]) {
    if (!src) continue;
    for (const part of src.split(";")) {
      const t = part.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      cfMap.set(t.slice(0, eq), t);
    }
  }

  let cookie = `sso=${sso}; sso-rw=${ssoRw}`;
  if (cfMap.size > 0) {
    cookie += "; " + Array.from(cfMap.values()).join("; ");
  }
  return cookie;
}

/**
 * Chrome-like browser headers for grok.com (aligned with grok2api applyAppHeaders).
 */
export function buildGrokWebHeaders({ cookie, userAgent, statsigId, requestId, traceId, spanId }) {
  const ua = userAgent
    || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  const headers = {
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: "https://grok.com",
    Pragma: "no-cache",
    Priority: "u=1, i",
    Referer: "https://grok.com/",
    "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": ua,
    "x-xai-request-id": requestId || crypto.randomUUID(),
  };
  if (statsigId) headers["x-statsig-id"] = statsigId;
  if (traceId && spanId) {
    headers.traceparent = `00-${traceId}-${spanId}-00`;
  }
  return headers;
}

/**
 * Classify upstream 401/403 body the way grok2api does.
 */
export function classifyGrokWebError(status, bodyText = "") {
  const body = String(bodyText || "");
  const lower = body.toLowerCase();
  if (status === 429) {
    return {
      code: "HTTP_429",
      message: "Grok rate limited. Wait and retry, or rotate accounts.",
    };
  }
  if (status === 401 || status === 403) {
    if (lower.includes("anti-bot") || body.includes('"code":7') || body.includes('"code": 7')) {
      return {
        code: "anti_bot_rejected",
        message:
          "Grok Web anti-bot rejected the request (code 7). " +
          "Check proxy/IP, User-Agent, and that SSO + Cloudflare cookies come from the same browser session. " +
          (body ? `Upstream: ${body.slice(0, 240)}` : ""),
      };
    }
    if (lower.includes("usage limit") || lower.includes("usage quota")) {
      return {
        code: "usage_limit",
        message: `Grok Web usage limit: ${body.slice(0, 240) || "quota exhausted"}`,
      };
    }
    return {
      code: `HTTP_${status}`,
      message:
        `Grok auth failed (HTTP ${status}). Re-paste sso cookie from grok.com ` +
        `(or full "sso=...; sso-rw=..."). ${body ? `Upstream: ${body.slice(0, 240)}` : ""}`,
    };
  }
  return {
    code: `HTTP_${status}`,
    message: body ? `Grok returned HTTP ${status}: ${body.slice(0, 240)}` : `Grok returned HTTP ${status}`,
  };
}
