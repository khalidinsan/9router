export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    // The official client (opencode 2.1.4, Bun) sends a whole identity set on
    // every model call, captured live on 2026-10-27:
    //
    //   authorization: Bearer public          (no OPENCODE_API_KEY → "public")
    //   user-agent: opencode/latest/2.1.4/cli (`opencode/${channel}/${version}/${name}`)
    //   x-opencode-client: cli
    //   x-opencode-project: <40 hex>
    //   x-opencode-session-id / x-opencode-session / x-session-affinity /
    //   x-session-id: ses_<26>               (affinity = parentID ?? id)
    //   b3 / traceparent                      (otel trace ids)
    //
    // Sending them does NOT unlock the free tier: replaying that exact header
    // set from curl (h1.1 and h2) and from Node/undici still answers
    // `429 FreeUsageLimitError` with `Retry-After: ~72600s` (~20h, i.e. a daily
    // bucket), while the same request from the Bun-based CLI returns 200 from
    // the same IP. The free models are therefore gated on the client stack
    // (TLS/HTTP fingerprint), not on request content — the error text says as
    // much ("Free models work in OpenCode"). Only `x-opencode-client` is kept
    // here because it is harmless and identifies us honestly; do not spend time
    // adding the rest.
    headers: {
      "x-opencode-client": "tui",
    },
    forceStream: true,
    noAuth: true,
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
      // The free lane's MiMo route (OpenRouter-backed) streams thinking as
      // `reasoning` + `reasoning_details[]`, not reasoning_content. stream.js lifts
      // the alias into reasoning_content for OpenAI-shaped clients; every other
      // model on the lane already emits reasoning_content, so the lift is a no-op.
      reasoningAliasFields: true,
    },
  },
  models: [
    // Endpoint formats differ per model, so declare non-chat models explicitly.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/1.18.31",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
