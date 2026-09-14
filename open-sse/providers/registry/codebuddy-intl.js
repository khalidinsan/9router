// CodeBuddy international (codebuddy.ai) — mirrors codebuddy-cn registry shape,
// swapping the Tencent CN domain for the .ai endpoint set. All OAuth/plugin URLs
// use the /v2/plugin prefix with platform=ide (CN uses platform=CLI).
export default {
  id: "codebuddy-intl",
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Chat gateway is OpenAI-compatible SSE (same /v2/chat/completions path as CN).
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy intl speaks the same unified OpenAI reasoning_effort shape as CN.
    thinkingFormat: "openai",
    // Fingerprint captured from the CodeBuddy CLI that WorkBuddy 5.5.2 bundles
    // (CLI/2.137.1). The gateway accepts the older IDE fingerprint too — both
    // were verified 200 — but the CLI identity is the one this token was minted
    // for, so prefer it.
    headers: {
      "User-Agent": "CLI/2.137.1 WorkBuddy AI/2.137.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Intl billing endpoint mirrors CN shape (data.Response.Data.Accounts[]).
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // Catalog from the WorkBuddy 5.5.2 product config (Tencent ships the same
  // CodeBuddy backend for workbuddy.ai and codebuddy.ai). The alias tier
  // (fast/balanced/primary/deep/default) is what the CLI itself sends; the
  // concrete ids below are the named models the same gateway accepts.
  // Probed live against /v2/chat/completions: all listed ids stream EXCEPT
  // gpt-5.6-* (11134 provider unavailable) and hy4-preview (14003 rate limit),
  // which stay listed because availability is per-account and transient.
  models: [
    // Alias tier — resolved server-side; stable across catalog changes.
    { id: "fast-model", name: "Fast (alias)" },
    { id: "balanced-model", name: "Balanced (alias)" },
    { id: "primary-model", name: "Primary (alias)" },
    { id: "deep-model", name: "Deep (alias)" },
    { id: "default-model", name: "Default (alias)" },

    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
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
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
