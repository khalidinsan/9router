/**
 * Grok CLI / Grok Build (cli-chat-proxy.grok.com)
 *
 * Source of truth: wire capture of official @xai-official/grok 0.2.99
 * talking to https://cli-chat-proxy.grok.com (OpenAI Responses API).
 *
 * Distinct from:
 *  - `xai`      → api.x.ai (API key / xAI API OAuth PKCE)
 *  - `grok-web` → grok.com web SSO cookie
 *
 * Model catalog: upstream Grok Build entry + fork catalog (Composer, effort
 * variants, and extra IDs still accepted by /v1/responses for some accounts).
 */
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_MODEL,
  GROK_CLI_USER_AGENT,
  GROK_CLI_VERSION,
} from "../../config/grokCli.js";

export default {
  id: "grok-cli",
  priority: 275,
  alias: "gcli",
  aliases: ["grok-build", "gb"],
  uiAlias: "gcli",
  display: {
    name: "Grok CLI (Grok Build)",
    icon: "auto_awesome",
    color: "#1DA1F2",
    textIcon: "GC",
    website: "https://x.ai",
    notice: {
      text: "Sign in with your xAI / Grok account via device code. Uses Grok Build subscription credits (cli-chat-proxy.grok.com).",
      signupUrl: "https://grok.com/supergrok",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  thinkingConfig: {
    options: ["low", "medium", "high", "xhigh"],
    defaultMode: "high",
  },
  transport: {
    baseUrl: `${GROK_CLI_BASE_URL}/responses`,
    format: "openai-responses",
    forceStream: true,
    modelsUrl: `${GROK_CLI_BASE_URL}/models`,
    userUrl: `${GROK_CLI_BASE_URL}/user`,
    billingUrl: `${GROK_CLI_BASE_URL}/billing`,
    clientVersion: GROK_CLI_VERSION,
    clientIdentifier: GROK_CLI_CLIENT_IDENTIFIER,
    tokenAuth: "xai-grok-cli",
    headers: {
      "User-Agent": GROK_CLI_USER_AGENT,
      "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
      "x-grok-client-version": GROK_CLI_VERSION,
    },
    // Compaction threshold mirrored from CLI (x-compaction-at)
    compactionAt: 400000,
    // Quota tracker: official CLI polls billing?format=credits + user?include=subscription
    usage: {
      url: `${GROK_CLI_BASE_URL}/billing?format=credits`,
      userUrl: `${GROK_CLI_BASE_URL}/user?include=subscription`,
    },
    retry: {
      429: { attempts: 2, delayMs: 2000 },
      502: { attempts: 2, delayMs: 1500 },
      503: { attempts: 2, delayMs: 1500 },
    },
  },
  // Model catalog notes (probed against cli-chat-proxy + local Grok CLI):
  // Official /v1/models menu varies by account; keep full fork list so nothing is lost.
  models: [
    // ── Upstream primary Grok Build entry ──
    {
      id: GROK_CLI_MODEL,
      name: "Grok Build",
      contextLength: 500000,
      maxOutputTokens: 64000,
      thinking: false,
    },

    // ── Official / commonly listed ──
    { id: "grok-4.5", name: "Grok 4.5" },
    // Virtual effort variants → strip suffix, send reasoning.effort (upstream id grok-4.5)
    { id: "grok-4.5-high", name: "Grok 4.5 (High)", upstreamModelId: "grok-4.5" },
    { id: "grok-4.5-medium", name: "Grok 4.5 (Medium)", upstreamModelId: "grok-4.5" },
    { id: "grok-4.5-low", name: "Grok 4.5 (Low)", upstreamModelId: "grok-4.5" },
    // Official Composer id from /v1/models (name: "Composer 2.5"); rejects reasoningEffort
    { id: "grok-composer-2.5-fast", name: "Composer 2.5 Fast", thinking: false },
    // Short alias accepted by API (maps to same family; also rejects reasoningEffort)
    { id: "composer-2.5", name: "Composer 2.5", thinking: false, upstreamModelId: "grok-composer-2.5-fast" },

    // ── Extra IDs accepted by cli-chat-proxy (not in official menu for all accounts) ──
    // Keep explicit grok-build id even when GROK_CLI_MODEL already is "grok-build"
    // (dedupe only if constant changes later).
    { id: "grok-4", name: "Grok 4" },
    { id: "grok-4-fast-reasoning", name: "Grok 4 Fast Reasoning" },
    { id: "grok-4.20", name: "Grok 4.20" },
    { id: "grok-4.20-multi-agent", name: "Grok 4.20 Multi-Agent" },
    { id: "grok-3", name: "Grok 3" },
    { id: "grok-code-fast-1", name: "Grok Code Fast" },
  ],
  features: {
    usage: true,
  },
  oauth: {
    // Same public client_id as Grok CLI / existing xai OAuth
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    refreshUrl: "https://auth.x.ai/oauth2/token",
    // HAR scope includes conversations read/write beyond the api-only xai scope
    scope:
      "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
    referrer: "grok-build",
    refreshLeadMs: 5 * 60 * 1000,
  },
};
