export default {
  id: "kimchi",
  priority: 15,
  alias: "kimchi",
  display: {
    name: "Kimchi",
    icon: "kimchi",
    color: "#FF6B35",
    textIcon: "KC",
    website: "https://kimchi.dev",
    notice: {
      apiKeyUrl: "https://app.kimchi.dev",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://llm.kimchi.dev/openai/v1/chat/completions",
    format: "openai",
    headers: {
      "User-Agent": "kimchi/0.1.42",
    },
    reasoningInject: {
      scope: "all",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "kimi-k2.7", name: "Kimi K2.7" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "glm-5.2-fp8", name: "GLM 5.2 FP8" },
    { id: "nemotron-3-ultra-fp4", name: "Nemotron 3 Ultra FP4" },
  ],
  serviceKinds: ["llm"],
  features: {
    usage: true,
    usageApikey: true,
  },
};
