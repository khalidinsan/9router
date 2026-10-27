/**
 * WorkBuddy AI wire constants.
 *
 * Verified against the installed WorkBuddy AI 5.8.4 bundle
 * (/Applications/WorkBuddy AI.app) rather than only a one-off capture:
 *
 *  - `Contents/Info.plist` → CFBundleShortVersionString 5.8.4
 *  - `cli/product.json` → genieVersion 5.8.4, platform "CLI",
 *    endpoint https://www.workbuddy.ai
 *  - `cli/package.json` → version 0.0.0, but
 *    publishConfig.customPackage.version 2.161.0 (the bundled
 *    `@genie/agent-cli`, a.k.a. CodeBuddy Code). The desktop reads exactly
 *    those two fields to build the client fingerprint
 *    (`resolveBundledCliVersion` in app.asar).
 *
 * The desktop launches the CLI sidecar with CLIENT_INFO_* env vars
 * (`getCachedBaseEnv` in app.asar):
 *
 *   CLIENT_INFO_PLATFORM=WorkBuddy      CLIENT_INFO_PLATFORM_VERSION=5.8.4
 *   CLIENT_INFO_IDE_TYPE=WorkBuddy      CLIENT_INFO_PRODUCT_NAME=WorkBuddy AI
 *   CLIENT_INFO_PRODUCT_VERSION=5.8.4   CLIENT_INFO_PLUGIN_NAME=workbuddy-desktop
 *   CLIENT_INFO_USER_AGENT_EXTENSION=CLI/2.161.0
 *
 * and the CLI's UserAgentHttpInterceptor composes
 * `<platform>/<platformVersion> <product>/<productVersion> <extension>`.
 * A live sidecar on 5.8.4 therefore sends exactly:
 *
 *   User-Agent: WorkBuddy/5.8.4 CLI/2.161.0
 *
 * (confirmed in ~/.workbuddy-ai/logs ... `[CloudProductManager] fetch cloud
 * product request headers: {"user-agent":"WorkBuddy/5.8.4 CLI/2.161.0",...}`).
 * The renderer process sends `workbuddy-ai/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0`.
 *
 * Bump BOTH numbers when Tencent ships a new desktop build: the gateway
 * accepts older fingerprints, but this is the identity the access token was
 * minted for.
 */
export const WORKBUDDY_BASE_URL =
  process.env.WORKBUDDY_BASE_URL || "https://www.workbuddy.ai";

/** Bundled `@genie/agent-cli` (CodeBuddy Code) version — the UA extension. */
export const WORKBUDDY_CLIENT_VERSION = "2.161.0";

/** Desktop app version (CFBundleShortVersionString / product.json genieVersion). */
export const WORKBUDDY_APP_VERSION = "5.8.4";

export const WORKBUDDY_PRODUCT_NAME = "WorkBuddy AI";
export const WORKBUDDY_OAUTH_PLATFORM = "workbuddy-ai";

/** Header names the official client uses for its per-request conversation ids. */
export const WORKBUDDY_CONVERSATION_HEADERS = {
  conversationId: "X-Conversation-ID",
  conversationRequestId: "X-Conversation-Request-ID",
  conversationMessageId: "X-Conversation-Message-ID",
  requestId: "X-Request-ID",
  rootRequestId: "X-Root-Request-ID",
  agentIntent: "X-Agent-Intent",
  agentType: "X-Agent-Type",
  agentPurpose: "X-Agent-Purpose",
};

export const WORKBUDDY_AGENT_INTENT = "craft";
export const WORKBUDDY_AGENT_TYPE = "main";
/**
 * `resolveModelCallAgentType` (CLI) → "main" for a plain chat turn, and the
 * purpose enum's `Conversation = "conversation"` is what the CLI echoes in
 * X-Agent-Purpose for it.
 */
export const WORKBUDDY_AGENT_PURPOSE = "conversation";

/** Chat-turn headers, including the desktop+CLI fingerprint. */
export function workbuddyChatHeaders(extra = {}) {
  const headers = {
    // Desktop-sidecar fingerprint: platform/platformVersion + UA extension.
    "User-Agent": `WorkBuddy/${WORKBUDDY_APP_VERSION} CLI/${WORKBUDDY_CLIENT_VERSION}`,
    "X-Product": "SaaS",
    // Desktop-launched CLI reports the desktop platform as its IDE identity
    // (CLIENT_INFO_IDE_TYPE / CLIENT_INFO_PLATFORM), and X-IDE-Version is the
    // desktop version, not the CLI version.
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": WORKBUDDY_APP_VERSION,
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
 * Read out of the installed WorkBuddy AI 5.8.4 bundle (CLI 2.161.0): every
 * model call through `axiosToFetchAdapter` carries the headers below, and
 * `X-Conversation-Request-ID` must be a *non-empty* id — the CLI validates its
 * own client-supplied ids as "lowercase UUIDv7 encoded as 32 hexadecimal
 * characters" (`assertClientConversationRequestId`), and generates them with
 * `uuidv7().replace(/-/g, "")`. Empty/absent → 11128.
 *
 *  - X-Conversation-ID       = session id, a plain UUIDv4 (see the `*.jsonl`
 *                              session files under ~/.workbuddy-ai/projects)
 *  - X-Conversation-Request-ID = bare-hex UUIDv7, fresh per turn
 *  - X-Conversation-Message-ID = X-Request-ID = bare-hex UUIDv7, fresh per call
 *                              (live log: `requestId=01a17b38a11e7517bd1a81950cb643fe`)
 *  - X-Root-Request-ID       = meta.rootRequestId || conversationRequestId
 *  - X-Agent-Intent          = session meta "codebuddy.ai/mode" || "craft"
 *  - X-Agent-Type            = "main" (team / subagent only for those runs)
 *  - X-Agent-Purpose         = "conversation" for a normal chat turn
 */
export function workbuddyConversationHeaders({
  conversationId,
  conversationRequestId,
  messageId,
  rootRequestId,
  agentPurpose = WORKBUDDY_AGENT_PURPOSE,
}) {
  const h = WORKBUDDY_CONVERSATION_HEADERS;
  return {
    [h.conversationId]: conversationId,
    [h.conversationRequestId]: conversationRequestId,
    [h.conversationMessageId]: messageId,
    [h.requestId]: messageId,
    // `resolveRootRequestId`: meta.rootRequestId || conversationRequestId.
    [h.rootRequestId]: rootRequestId || conversationRequestId,
    [h.agentIntent]: WORKBUDDY_AGENT_INTENT,
    [h.agentType]: WORKBUDDY_AGENT_TYPE,
    ...(agentPurpose ? { [h.agentPurpose]: agentPurpose } : {}),
  };
}
