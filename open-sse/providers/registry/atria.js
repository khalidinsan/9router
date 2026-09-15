export default {
  id: "atria",
  priority: 100,
  alias: "atria",
  aliases: [
    "atr",
    "atria-asi",
    "atria-dawn",
  ],
  uiAlias: "atria",
  display: {
    name: "Atria",
    icon: "atria",
    color: "#5B4BFF",
    textIcon: "AT",
    website: "https://www.atria-asi.ai",
    notice: {
      text: "Official API by Shanghai AI Laboratory. Agentic 744B MoE (GLM-5.2 base) with native reasoning and a 256K context window. Text-only input — images and PDFs are rejected. Model id is case-sensitive. Key starts with atr_.",
      apiKeyUrl: "https://api.atria-asi.ai/console/keys",
    },
  },
  category: "apikey",
  thinkingConfig: {
    options: ["low", "medium", "high", "xhigh", "max"],
    defaultMode: "high",
  },
  transport: {
    baseUrl: "https://api.atria-asi.ai/v1/chat/completions",
    validateUrl: "https://api.atria-asi.ai/v1/models",
    format: "openai",
  },
  // Live catalogue is fetched via modelsFetcher; the model id is
  // case-sensitive upstream, so keep this snapshot verbatim.
  models: [
    { id: "Atria-Dawn-Preview", name: "Atria Dawn Preview", contextLength: 256000 },
  ],
  passthroughModels: true,
  modelsFetcher: { url: "https://api.atria-asi.ai/v1/models", type: "openai" },
  serviceKinds: ["llm"],
};
