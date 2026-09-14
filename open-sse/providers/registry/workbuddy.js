/**
 * WorkBuddy AI (workbuddy.ai) — Tencent's agent desktop app.
 *
 * Same vendor family as CodeBuddy: WorkBuddy 5.5.2 bundles the CodeBuddy Code
 * CLI (`@genie/agent-cli`, "CodeBuddy Code" 2.137.1) and ships the same unified
 * gateway on /v2/chat/completions. It is a separate product however, with its
 * own Keycloak realm, so accounts do NOT cross over automatically:
 *
 *   workbuddy.ai  → https://www.workbuddy.ai/auth/realms/copilot   (this file)
 *   codebuddy.ai  → https://www.codebuddy.ai/auth/realms/copilot   (codebuddy-intl)
 *
 * Wire fingerprint captured from the bundled CLI (proxied through a local
 * capture server while it made a real chat call):
 *   POST /v2/chat/completions
 *   authorization: Bearer <JWT, iss=workbuddy.ai realm>
 *   x-user-id:  <account sub>
 *   x-domain:   www.workbuddy.ai
 *   x-product:  SaaS
 *   x-ide-type / x-ide-name: CLI
 *   x-ide-version: 2.137.1
 *   user-agent: CLI/2.137.1 WorkBuddy AI/2.137.1
 *
 * The bundled CLI defaults to model alias ids (fast-model, balanced-model,
 * primary-model, deep-model) which the gateway resolves server-side.
 */
import {
  WORKBUDDY_BASE_URL,
  WORKBUDDY_CLIENT_VERSION,
  WORKBUDDY_PRODUCT_NAME,
  workbuddyChatHeaders,
} from "../../config/workbuddy.js";

export default {
  id: "workbuddy",
  alias: "wb",
  uiAlias: "wb",
  hidden: false,
  priority: 91,
  display: {
    name: "WorkBuddy AI",
    icon: "work",
    color: "#0A7CFF",
    website: "https://www.workbuddy.ai",
    notice: {
      signupUrl: "https://www.workbuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  thinkingConfig: {
    options: ["low", "medium", "high"],
    defaultMode: "high",
  },
  transport: {
    baseUrl: `${WORKBUDDY_BASE_URL}/v2/chat/completions`,
    forceStream: true,
    thinkingFormat: "openai",
    headers: workbuddyChatHeaders(),
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    usage: {
      url: `${WORKBUDDY_BASE_URL}/v2/billing/meter/get-user-resource`,
    },
    clientVersion: WORKBUDDY_CLIENT_VERSION,
    productName: WORKBUDDY_PRODUCT_NAME,
  },
  // Catalog from the WorkBuddy 5.5.2 product config. The alias tier is what the
  // bundled CLI itself sends; the gateway resolves each alias to the account's
  // current default for that tier.
  models: [
    { id: "fast-model", name: "Fast (alias)", thinking: false },
    { id: "balanced-model", name: "Balanced (alias)" },
    { id: "primary-model", name: "Primary (alias)" },
    { id: "deep-model", name: "Deep (alias)" },
    { id: "default-model", name: "Default (alias)" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v3-2-volc", name: "DeepSeek V3.2" },
    { id: "hy3", name: "Hunyuan 3" },
    { id: "hy4-preview", name: "Hunyuan 4 Preview" },
    { id: "hy4-preview-f", name: "Hunyuan 4 Preview F" },
  ],
  oauth: {
    baseUrl: WORKBUDDY_BASE_URL,
    stateUrl: `${WORKBUDDY_BASE_URL}/v2/plugin/auth/state`,
    tokenUrl: `${WORKBUDDY_BASE_URL}/v2/plugin/auth/token`,
    refreshUrl: `${WORKBUDDY_BASE_URL}/v2/plugin/auth/token/refresh`,
    userAgent: workbuddyChatHeaders()["User-Agent"],
    platform: "workbuddy-ai",
    pollInterval: 5000,
  },
  features: {
    usage: true,
  },
};
