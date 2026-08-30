// Wire capture of official grok 1.0.3 (macos aarch64) → cli-chat-proxy.grok.com
export const GROK_CLI_VERSION = "1.0.3";
export const GROK_CLI_MODEL = "grok-build";
export const GROK_CLI_BASE_URL = process.env.GROK_CLI_PROXY_BASE_URL || "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";
export const GROK_CLI_AUTHENTICATE_RESPONSE = "authenticate-response";
export const GROK_CLI_CLIENT_MODE = "headless";
export const GROK_CLI_COMPACTION_AT = 400000;
export const GROK_CLI_COMPACTIONS_REMAINING = 1;

/** Static headers shared by chat / models / billing / image. */
export function grokCliStaticHeaders() {
  return {
    "User-Agent": GROK_CLI_USER_AGENT,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-xai-token-auth": GROK_CLI_TOKEN_AUTH,
    "x-authenticateresponse": GROK_CLI_AUTHENTICATE_RESPONSE,
    "x-grok-client-mode": GROK_CLI_CLIENT_MODE,
  };
}

/** Extra chat-turn headers from official grok-shell/1.0.3 POST /v1/responses. */
export function grokCliChatHeaders() {
  return {
    ...grokCliStaticHeaders(),
    "x-compaction-at": String(GROK_CLI_COMPACTION_AT),
    "x-compactions-remaining": String(GROK_CLI_COMPACTIONS_REMAINING),
    "x-grok-doom-loop-check": "true",
  };
}

export function supportsGrokCliReasoningEffort(model) {
  // ponytail: unknown models omit effort until live metadata reaches dispatch.
  // grok-4.5 / grok-4.6 accept reasoning.effort (low/medium/high/xhigh).
  // Omitting effort makes the model *describe* tool requests as text instead of emitting
  // structured function_call items.
  return /^grok-4\.[56](?:$|-)/.test(String(model || ""));
}
