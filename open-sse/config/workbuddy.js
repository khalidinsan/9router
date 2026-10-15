/**
 * WorkBuddy AI wire constants.
 *
 * Captured from the CodeBuddy Code CLI that WorkBuddy bundles, by proxying a
 * live chat turn through a local capture server. Keep these in sync with the
 * app if Tencent bumps the client version — the gateway accepts older
 * fingerprints, but it is the identity the access token was minted for.
 *
 * Version bumped 2.137.1 → 2.156.0 to match the installed WorkBuddy AI 5.7.6
 * (/Applications/WorkBuddy AI.app .../cli/package.json
 * publishConfig.customPackage.version).
 */
export const WORKBUDDY_BASE_URL =
  process.env.WORKBUDDY_BASE_URL || "https://www.workbuddy.ai";

export const WORKBUDDY_CLIENT_VERSION = "2.156.0";
export const WORKBUDDY_PRODUCT_NAME = "WorkBuddy AI";
export const WORKBUDDY_OAUTH_PLATFORM = "workbuddy-ai";

/** Chat-turn headers, including the CLI fingerprint and the account identity. */
export function workbuddyChatHeaders(extra = {}) {
  const headers = {
    "User-Agent": `CLI/${WORKBUDDY_CLIENT_VERSION} ${WORKBUDDY_PRODUCT_NAME}/${WORKBUDDY_CLIENT_VERSION}`,
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": WORKBUDDY_CLIENT_VERSION,
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "X-Domain": new URL(WORKBUDDY_BASE_URL).host,
  };
  return { ...headers, ...extra };
}

/**
 * Static (unauthenticated) headers for the OAuth state/token endpoints, which
 * must explicitly opt out of auth so the gateway treats them as public.
 */
export function workbuddyOAuthHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": workbuddyChatHeaders()["User-Agent"],
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": new URL(WORKBUDDY_BASE_URL).host,
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-Product": "SaaS",
    ...extra,
  };
}

export function workbuddyRefreshHeaders(refreshToken, extra = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": workbuddyChatHeaders()["User-Agent"],
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": new URL(WORKBUDDY_BASE_URL).host,
    "X-Refresh-Token": refreshToken,
    "X-Auth-Refresh-Source": "plugin",
    "X-Product": "SaaS",
    ...extra,
  };
}
