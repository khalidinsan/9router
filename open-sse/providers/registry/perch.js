/**
 * Perch Terminal (perchai.app) — the desktop app + `perchai-cli` backend.
 *
 * Not a public API: this speaks the app's own wire (see config/perch.js). Auth
 * is a Supabase access token from the CLI session, so `authModes` is oauth and
 * the connection stores `accessToken` + `providerSpecificData.refreshToken`.
 *
 * Only the free (Starter) pins are registered — the Pro tier needs a paid plan
 * and would just answer starter_model_blocked on this account.
 *
 * Model ids are Perch's public `/model` slugs; the executor maps each one to the
 * backend option id the route resolves (`manualModelOptionId`).
 */
export default {
  id: "perch",
  alias: "perch",
  aliases: ["perch-terminal", "perchai", "prch"],
  uiAlias: "perch",
  priority: 88,
  display: {
    name: "Perch Terminal",
    icon: "terminal",
    color: "#3D7A52",
    textIcon: "PR",
    website: "https://perchai.app",
    notice: {
      text:
        "Perch-hosted free models via the Perch Terminal backend. Sign in with Google or GitHub (same PKCE flow as `perch login`); 9Router owns the session and renews it automatically. A pasted Perch CLI session also works.",
      signupUrl: "https://perchai.app",
    },
  },
  category: "oauth",
  authType: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  thinkingConfig: {
    options: ["off", "low", "medium", "high"],
    defaultMode: "high",
  },
  transport: {
    baseUrl: "https://app.perchai.app/api/perch-terminal/model-call",
    format: "openai",
    // The route only speaks SSE; the executor always streams and the gateway
    // re-assembles for non-streaming clients.
    forceStream: true,
    timeoutMs: 180_000,
    stallTimeoutMs: 600_000,
    headers: {},
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    retry: {
      "429": 1,
      "502": 1,
      "503": 1,
    },
  },
  models: [
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash (Free)",
      contextLength: 1000000,
      capabilities: { tools: true, reasoning: true, vision: false },
    },
    {
      id: "glm-5.3-flash",
      name: "GLM-5.3 Flash (Free)",
      contextLength: 1000000,
      capabilities: { tools: true, reasoning: true, vision: false },
    },
    {
      id: "laguna-s",
      name: "Poolside Laguna S 2.1 (Free)",
      contextLength: 256000,
      capabilities: { tools: true, reasoning: true, vision: false },
    },
  ],
  passthroughModels: false,
  serviceKinds: ["llm"],
};
