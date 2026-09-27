import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage, estimateUsage } from "../../utils/usageTracking.js";
import { FORMATS } from "../../translator/formats.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  // Note: OpenAI Responses usage ({input_tokens, input_tokens_details:{cached_tokens}})
  // also matches this branch. Its prompt is cache-INCLUSIVE and its cache rides in
  // input_tokens_details, so emit it as cached_tokens — the convention
  // canonicalizeUsage() passes through without folding. Reading it here keeps
  // cache accounting correct for /v1/responses and codex traffic.
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.input_tokens_details?.cached_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens,
      // Kiro bills in credits and its turns can carry zero tokens, so this is
      // the only record of the charge. Pass it through verbatim.
      ...(responseBody.usage.kiro_credits !== undefined && {
        kiro_credits: responseBody.usage.kiro_credits,
        kiro_credit_unit: responseBody.usage.kiro_credit_unit,
      }),
      ...(responseBody.usage.estimated === true && { estimated: true }),
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      cached_tokens: usageMetadata.cachedContentTokenCount || 0,
      reasoning_tokens: usageMetadata.thoughtsTokenCount || 0
    };
  }

  // Usage present but carrying no token fields — Kiro reports the charge in
  // credits and may omit token counts entirely. Returning null here discarded
  // the whole usage object, so a billed turn was recorded as if it never
  // happened. Surface what the provider did report.
  if (responseBody.usage && typeof responseBody.usage === "object") {
    const reported = responseBody.usage;
    if (reported.kiro_credits !== undefined) {
      return {
        prompt_tokens: reported.prompt_tokens || 0,
        completion_tokens: reported.completion_tokens || 0,
        total_tokens: reported.total_tokens || 0,
        kiro_credits: reported.kiro_credits,
        kiro_credit_unit: reported.kiro_credit_unit,
        ...(reported.estimated === true && { estimated: true }),
      };
    }
  }

  return null;
}

/**
 * Fill in token counts a provider reported as zero using the shared estimator.
 *
 * Kiro bills in credits and can answer with `usage: {kiro_credits}` and no
 * tokens at all. Recording 0 tokens there understates the turn and, worse,
 * made cost calculation return 0 for a request Kiro actually charged for.
 * Only fills fields that are missing — a real count is never overwritten.
 */
export function fillEstimatedTokens(usage, body, contentLength) {
  if (!usage || typeof usage !== "object") return usage;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  if (prompt > 0 && completion > 0) return usage;

  const estimate = estimateUsage(body, contentLength, FORMATS.OPENAI);
  return {
    ...usage,
    prompt_tokens: prompt || estimate.prompt_tokens || 0,
    completion_tokens: completion || estimate.completion_tokens || 0,
    total_tokens: (prompt || estimate.prompt_tokens || 0) + (completion || estimate.completion_tokens || 0),
    estimated: true,
  };
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    // When the request was remapped by a model route (see routingRepo), `model`
    // is the routed target and this holds the id the client actually asked for.
    // Kept so the dashboard can show "asked for A, ran B" without losing either.
    requestedModel: base.requestedModel || undefined,
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    ...overrides
  };
}

// Build the "done" summary: duration, ttft, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  let inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  if (u.input_tokens !== undefined) {
    // Anthropic-style input_tokens EXCLUDES cache reads/creation; the usage page
    // stores canonical prompt_tokens (cache-inclusive). Print the same total here
    // so the console DONE line matches /dashboard/usage instead of looking ~2x off.
    inTok += cacheRead + cacheCreate;
  }
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE", silent = false }) {
  if (!tokens || typeof tokens !== "object") return;

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  // A provider that reports no token counts still spent a request, and some
  // (Kiro) report the charge in a currency we cannot derive from tokens
  // (`kiro_credits`). Dropping the row made those requests invisible on
  // /dashboard/usage — not shown as zero, but absent entirely, which reads as
  // "the model was never used". Record the request; token counts stay 0.
  const hasCharge = Number.isFinite(Number(tokens.kiro_credits));
  if (inTokens === 0 && outTokens === 0 && !hasCharge) return;

  if (!silent) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
  }

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = canonicalizeUsage(tokens) || {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null
  }).catch(() => {});
}
