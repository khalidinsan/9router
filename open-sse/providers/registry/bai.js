export default {
  id: "bai",
  priority: 100,
  alias: "bai",
  aliases: [
    "b-ai",
    "bai-ai",
    "bai-api",
  ],
  uiAlias: "bai",
  display: {
    name: "B.AI",
    icon: "bai",
    color: "#000000",
    textIcon: "BA",
    website: "https://b.ai",
    notice: {
      text: "OpenAI-compatible API gateway. Sign up at b.ai, create an API key (starts with sk_...) from the API Key management page, and connect it here. Supports DeepSeek, Mimo, Hy3 and other models.",
      apiKeyUrl: "https://b.ai/user-center/",
    },
  },
  category: "apikey",
  thinkingConfig: {
    options: ["low", "medium", "high", "xhigh", "max"],
    defaultMode: "high",
  },
  transport: {
    baseUrl: "https://api.b.ai/v1/chat/completions",
    validateUrl: "https://api.b.ai/v1/models",
    format: "openai",
  },
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1000000 },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp", contextLength: 100000 },
    { id: "hy3", name: "Hy3", contextLength: 262144 },
    { id: "mimo-v2.5", name: "MiMo V2.5", contextLength: 1000000 },
  ],
  passthroughModels: true,
  serviceKinds: ["llm"],
};
