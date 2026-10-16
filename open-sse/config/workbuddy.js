/**
 * WorkBuddy AI wire constants.
 *
 * Captured from the CodeBuddy Code CLI that WorkBuddy bundles, by proxying a
 * live chat turn through a local capture server. Keep these in sync with the
 * app if Tencent bumps the client version — the gateway accepts older
 * fingerprints, but it is the identity the access token was minted for.
 *
 * Version bumped 2.137.1 → 2.156.0 → 2.161.0 to match the installed
 * WorkBuddy AI 5.8.4 (/Applications/WorkBuddy AI.app .../cli/package.json
 * publishConfig.customPackage.version).
 */
export const WORKBUDDY_BASE_URL =
  process.env.WORKBUDDY_BASE_URL || "https://www.workbuddy.ai";

export const WORKBUDDY_CLIENT_VERSION = "2.161.0";
export const WORKBUDDY_PRODUCT_NAME = "WorkBuddy AI";
export const WORKBUDDY_OAUTH_PLATFORM = "workbuddy-ai";

/** Header names the official client uses for its per-request conversation ids. */
export const WORKBUDDY_CONVERSATION_HEADERS = {
  conversationId: "X-Conversation-ID",
  conversationRequestId: "X-Conversation-Request-ID",
  conversationMessageId: "X-Conversation-Message-ID",
  requestId: "X-Request-ID",
  agentIntent: "X-Agent-Intent",
  agentType: "X-Agent-Type",
};

export const WORKBUDDY_AGENT_INTENT = "craft";
export const WORKBUDDY_AGENT_TYPE = "main";

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

/**
 * Per-request conversation headers for POST /v2/chat/completions.
 *
 * The gateway (workbuddy.ai and codebuddy.ai alike) runs a "channel
 * verification" (渠道校验) on model calls: requests without the official
 * client's conversation metadata are answered 400
 * `{code:11128, msg:"conversation id missing"}` — displayTips: "This call
 * failed channel verification, possibly because it was not sent from an
 * official client."
 *
 * Captured from the installed WorkBuddy AI 5.8.4 bundle (CLI 2.161.0): every
 * model call through `axiosToFetchAdapter` carries all six headers below, and
 * `X-Conversation-Request-ID` is a *non-empty* id (`conversationRequestId` of
 * the run). Empty/absent → 11128. The other five values may be plain UUIDs;
 * ids are emitted as UUIDv7 to match the client exactly (its ids are
 * time-ordered: `01a1422b-67cd-7137-...`). `X-Conversation-Message-ID` and
 * `X-Request-ID` share one value, as the client sends them.
 */
export function workbuddyConversationHeaders({ conversationId, conversationRequestId, messageId }) {
  const h = WORKBUDDY_CONVERSATION_HEADERS;
  return {
    [h.conversationId]: conversationId,
    [h.conversationRequestId]: conversationRequestId,
    [h.conversationMessageId]: messageId,
    [h.requestId]: messageId,
    [h.agentIntent]: WORKBUDDY_AGENT_INTENT,
    [h.agentType]: WORKBUDDY_AGENT_TYPE,
  };
}
