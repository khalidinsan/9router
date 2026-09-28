export default {
  id: "tokenharbor",
  priority: 100,
  alias: "tokenharbor",
  aliases: [
    "th",
    "thh",
    "token-harbor",
    "tokenharbour",
  ],
  uiAlias: "tokenharbor",
  display: {
    name: "Token Harbor",
    icon: "tokenharbor",
    color: "#0EA5E9",
    textIcon: "TH",
    website: "https://tokenharbor.ai",
    notice: {
      text: "OpenAI-compatible API gateway. Pay once in credits, spend across every assistant (Claude, GPT, Grok, Gemini, DeepSeek, Kimi, GLM, Qwen, dsb). Key starts with thk_live_.",
      apiKeyUrl: "https://tokenharbor.ai/dashboard/api-keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  thinkingConfig: {
    options: ["low", "medium", "high", "xhigh", "max"],
    defaultMode: "high",
  },
  transport: {
    // `thinkingFormat` is deliberately NOT declared: Token Harbor forwards
    // requests verbatim, so each model must resolve its own thinking wire
    // format through providers/capabilities.js.
    baseUrl: "https://tokenharbor.ai/v1/chat/completions",
    validateUrl: "https://tokenharbor.ai/v1/models",
    format: "openai",
    retry: {
      429: 2,
    },
  },
  // Seed snapshot from live /v1/models (25 entries). Latest catalogue is
  // fetched via modelsFetcher; other ids still accepted via passthroughModels.
  models: [
    { id: "th-orchestra", name: "TH Orchestra", contextLength: 1000000 },
    { id: "claude-opus-5", name: "Claude Opus 5", contextLength: 1000000 },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", contextLength: 1000000 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
    { id: "claude-fable-5", name: "Claude Fable 5", contextLength: 1000000 },
    { id: "grok-4.6", name: "Grok 4.6", contextLength: 500000 },
    { id: "grok-4.7", name: "Grok 4.7", contextLength: 500000 },
    { id: "kimi-k3", name: "Kimi K3", contextLength: 1000000 },
    { id: "glm-5.3", name: "GLM-5.3", contextLength: 1000000 },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", contextLength: 1000000 },
    { id: "mimo-v2.5", name: "MiMo V2.5", contextLength: 1000000 },
    { id: "mimo-v2.5:free", name: "MiMo V2.5 (Free)", contextLength: 1000000 },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextLength: 1000000 },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1000000 },
    { id: "deepseek-v4-flash:free", name: "DeepSeek V4 Flash (Free)", contextLength: 1000000 },
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)", contextLength: 1000000 },
    { id: "qwen3.8-27b", name: "Qwen3.8 27B", contextLength: 1000000 },
    { id: "qwen3.8-27b:free", name: "Qwen3.8 27B (Free)", contextLength: 1000000 },
    { id: "qwen3.8-max", name: "Qwen3.8 Max", contextLength: 1000000 },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextLength: 1050000 },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextLength: 1050000 },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextLength: 1050000 },
    { id: "gpt-6-astra", name: "GPT-6 Astra", contextLength: 272000 },
    { id: "gpt-6-sol", name: "GPT-6 Sol", contextLength: 1050000 },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", contextLength: 1000000 },
  ],
  passthroughModels: true,
  modelsFetcher: { url: "https://tokenharbor.ai/v1/models", type: "openai" },
  serviceKinds: ["llm"],
};
