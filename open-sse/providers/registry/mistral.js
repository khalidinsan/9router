export default {
  id: "mistral",
  priority: 80,
  alias: "mistral",
  display: {
    name: "Mistral",
    icon: "air",
    color: "#FF7000",
    textIcon: "MI",
    website: "https://mistral.ai",
    notice: {
      apiKeyUrl: "https://console.mistral.ai/api-keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    validateUrl: "https://api.mistral.ai/v1/models",
    quirks: {
      dropClientMetadata: true,
    },
  },
  models: [
    { id: "mistral-large-latest", name: "Mistral Large 3" },
    { id: "codestral-latest", name: "Codestral" },
    { id: "mistral-medium-latest", name: "Mistral Medium 3" },
    // Third-party model served on the Mistral platform (see
    // https://docs.mistral.ai/models/deepseek-v4-flash-1017); 1M context,
    // vision, tools and reasoning all come from the platform catalog.
    {
      id: "deepseek-v4-1-flash-1017",
      name: "DeepSeek V4.1 Flash 1017",
      contextLength: 1048576,
      capabilities: { tools: true, reasoning: true, vision: true },
    },
    { id: "mistral-embed", name: "Mistral Embed", kind: "embedding" },
  ],
  serviceKinds: ["llm","imageToText","embedding"],
  features: {
    // /v1/billing/budget reports the organization's vibe + api budgets.
    usage: true,
    usageApikey: true,
  },
  embeddingConfig: { baseUrl: "https://api.mistral.ai/v1/embeddings", authType: "apikey", authHeader: "bearer" },
};
