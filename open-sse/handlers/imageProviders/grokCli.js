/**
 * Grok CLI free image generation / edit via cli-chat-proxy Responses API.
 *
 * Official paid path fails with free CLI OAuth tokens:
 *   POST https://api.x.ai/v1/images/generations → 403
 *
 * Working free path:
 *   POST https://cli-chat-proxy.grok.com/v1/responses
 *   tools: [{ type: "image_generation" }]
 *   extract output[].type === "image_generation_call" → result (base64 JPEG)
 *
 * Same token pool / headers as chat (grok-cli). Shows under Media → Image.
 * Video free tool path is not documented here — use provider xAI (api.x.ai) for video.
 *
 * Error mapping (pastebin free image gen/edit):
 *   missing prompt / bad input → 400
 *   invalid/missing client or CLI creds → 401
 *   free-quota / rate limit → 429
 *   upstream rejects params → 400/422
 *   timeout → 504
 *   no image_generation_call / unavailable → 502/503
 * Never leak CLI tokens, full headers, or unbounded upstream bodies.
 */
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import {
  GROK_CLI_BASE_URL,
  grokCliChatHeaders,
} from "../../config/grokCli.js";

const RESPONSES_URL = `${GROK_CLI_BASE_URL}/responses`;
const DEFAULT_MODEL = "grok-4.5";
const FETCH_TIMEOUT_MS = Number(process.env.GROK_CLI_IMAGE_TIMEOUT_MS || 180000);
const MAX_N = 4;
const MAX_PUBLIC_ERR = 280;

/** Typed error so imageGenerationCore can preserve HTTP status. */
export class GrokCliImageError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=502]
   * @param {{ code?: string }} [opts]
   */
  constructor(message, status = HTTP_STATUS.BAD_GATEWAY, opts = {}) {
    super(sanitizePublicMessage(message));
    this.name = "GrokCliImageError";
    this.status = status;
    this.statusCode = status;
    if (opts.code) this.code = opts.code;
  }
}

function sanitizePublicMessage(msg) {
  let s = String(msg || "Image generation failed").replace(/\s+/g, " ").trim();
  // Strip bearer / JWT-ish / long base64 blobs
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
  s = s.replace(/\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-.]{10,}/g, "[redacted-token]");
  s = s.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{40,}/gi, "data:image…[redacted]");
  s = s.replace(/[A-Za-z0-9+/]{120,}={0,2}/g, "[redacted-b64]");
  if (s.length > MAX_PUBLIC_ERR) s = `${s.slice(0, MAX_PUBLIC_ERR)}…`;
  return s;
}

function looksLikeQuota(msg) {
  const m = String(msg || "").toLowerCase();
  return /quota|rate.?limit|too many requests|exhaust|usage.?limit|free.?limit|resource.?exhausted|429|capacity/.test(m);
}

/**
 * Map upstream HTTP + message → public status (pastebin table).
 * @param {number} httpStatus
 * @param {string} rawMsg
 */
function mapUpstreamError(httpStatus, rawMsg) {
  const msg = sanitizePublicMessage(rawMsg || `Upstream HTTP ${httpStatus}`);
  const s = Number(httpStatus) || 0;

  if (s === 400 || s === 422) {
    return new GrokCliImageError(msg, s === 422 ? 422 : HTTP_STATUS.BAD_REQUEST, { code: "invalid_request" });
  }
  if (s === 401) {
    return new GrokCliImageError(msg || "Unauthorized", HTTP_STATUS.UNAUTHORIZED, { code: "unauthorized" });
  }
  if (s === 402 || s === 403) {
    if (looksLikeQuota(rawMsg)) {
      return new GrokCliImageError(msg || "Free image quota exhausted", HTTP_STATUS.RATE_LIMITED, {
        code: "quota_exhausted",
      });
    }
    return new GrokCliImageError(msg || "Forbidden", HTTP_STATUS.FORBIDDEN, { code: "permission_denied" });
  }
  if (s === 429 || looksLikeQuota(rawMsg)) {
    return new GrokCliImageError(msg || "Rate limited / free quota exhausted", HTTP_STATUS.RATE_LIMITED, {
      code: "rate_limited",
    });
  }
  if (s === 408 || s === 504) {
    return new GrokCliImageError(msg || "Upstream timeout", HTTP_STATUS.GATEWAY_TIMEOUT, { code: "timeout" });
  }
  if (s === 503) {
    return new GrokCliImageError(msg || "Upstream unavailable", HTTP_STATUS.SERVICE_UNAVAILABLE, {
      code: "unavailable",
    });
  }
  if (s >= 500 || s === 0) {
    return new GrokCliImageError(msg || "Upstream error", HTTP_STATUS.BAD_GATEWAY, { code: "upstream_error" });
  }
  return new GrokCliImageError(msg, s >= 400 && s < 600 ? s : HTTP_STATUS.BAD_GATEWAY);
}

function stripDataUrl(value) {
  const v = String(value || "").trim();
  if (v.startsWith("data:") && v.includes(",")) return v.split(",", 1)[1];
  return v;
}

function normalizeImageRef(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    if (value.url) return normalizeImageRef(value.url);
    if (value.image_url) return normalizeImageRef(value.image_url);
    const raw = value.b64_json || value.base64 || value.data;
    if (raw) return `data:image/png;base64,${stripDataUrl(String(raw))}`;
    return null;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://")) return s;
  return `data:image/png;base64,${stripDataUrl(s)}`;
}

function collectImageRefs(body, maxRefs = 3) {
  const values = [];
  if (body?.image != null) values.push(body.image);
  if (body?.image_url != null) values.push(body.image_url);
  if (Array.isArray(body?.images)) values.push(...body.images);
  else if (body?.images != null) values.push(body.images);

  const refs = [];
  for (const v of values) {
    const n = normalizeImageRef(v);
    if (n) refs.push(n);
    if (refs.length >= maxRefs) break;
  }
  return refs;
}

function stripImageSuffix(model) {
  const m = String(model || "");
  if (m.endsWith("-image")) return m.slice(0, -"-image".length) || DEFAULT_MODEL;
  if (m === "grok-2-image-1212" || m === "grok-image") return DEFAULT_MODEL;
  return m || DEFAULT_MODEL;
}

function buildImageTool(body) {
  const tool = { type: "image_generation" };
  if (body?.size) tool.size = body.size;
  if (body?.quality) tool.quality = body.quality;
  if (body?.background) tool.background = body.background;
  if (body?.output_format) tool.output_format = String(body.output_format).toLowerCase();
  return tool;
}

function buildContent(prompt, refs, isEdit) {
  const content = [];
  for (const ref of refs) {
    content.push({ type: "input_image", image_url: ref });
  }
  const instruction = isEdit
    ? `Edit this image: ${prompt}. Use the image_generation tool.`
    : `Generate an image: ${prompt}. Use the image_generation tool.`;
  content.push({ type: "input_text", text: instruction });
  return content;
}

export function extractGeneratedImages(response) {
  const images = [];
  for (const item of response?.output || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "image_generation_call") continue;
    let raw = item.result || item.image || "";
    if (typeof raw === "object" && raw) {
      raw = raw.b64_json || raw.base64 || raw.data || "";
    }
    raw = stripDataUrl(String(raw || ""));
    if (raw) images.push(raw);
  }
  return images;
}

function normalizeUsage(usage = {}) {
  const tin = Number(usage.input_tokens || 0) || 0;
  const tout = Number(usage.output_tokens || 0) || 0;
  const total = Number(usage.total_tokens || tin + tout) || tin + tout;
  return {
    input_tokens: tin,
    output_tokens: tout,
    prompt_tokens: tin,
    completion_tokens: tout,
    total_tokens: total,
  };
}

function addUsage(acc, usage) {
  const u = normalizeUsage(usage);
  acc.input_tokens += u.input_tokens;
  acc.output_tokens += u.output_tokens;
  acc.prompt_tokens += u.prompt_tokens;
  acc.completion_tokens += u.completion_tokens;
  acc.total_tokens += u.total_tokens;
}

function buildHeaders(creds) {
  const token = creds?.accessToken || creds?.apiKey || "";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...grokCliChatHeaders(),
    "x-grok-session-id": randomUUID(),
    "x-grok-req-id": randomUUID(),
  };
}

function buildUpstreamBody(model, body) {
  const prompt = String(body?.prompt || "").trim();
  if (!prompt) {
    throw new GrokCliImageError("prompt is required", HTTP_STATUS.BAD_REQUEST, { code: "missing_prompt" });
  }

  const refs = collectImageRefs(body, 3);
  const isEdit = refs.length > 0;
  const upstreamModel = stripImageSuffix(model);

  return {
    model: upstreamModel,
    input: [
      {
        role: "user",
        content: buildContent(prompt, refs, isEdit),
      },
    ],
    tools: [buildImageTool(body)],
    stream: false,
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: 1024,
  };
}

async function postResponses(body, creds, log) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: buildHeaders(creds),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw mapUpstreamError(
        res.status || 502,
        `Grok CLI image: HTTP ${res.status} invalid JSON (${text.slice(0, 120)})`
      );
    }
    if (!res.ok) {
      const msg =
        json?.error?.message ||
        (typeof json?.error === "string" ? json.error : null) ||
        json?.detail ||
        text.slice(0, 200);
      throw mapUpstreamError(
        res.status,
        typeof msg === "string" ? msg : `Grok CLI image HTTP ${res.status}`
      );
    }
    return json;
  } catch (e) {
    if (e instanceof GrokCliImageError) throw e;
    if (e?.name === "AbortError") {
      throw new GrokCliImageError(
        `Grok CLI image timeout after ${FETCH_TIMEOUT_MS}ms`,
        HTTP_STATUS.GATEWAY_TIMEOUT,
        { code: "timeout" }
      );
    }
    // Network / DNS / connect
    const netMsg = e?.cause?.code || e?.code || e?.message || "network error";
    throw new GrokCliImageError(
      `Grok CLI image unavailable: ${netMsg}`,
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      { code: "unavailable" }
    );
  } finally {
    clearTimeout(timer);
  }
}

export default {
  // Full control: n-loop + 180s timeout (pastebin free path)
  useExecutor: true,

  buildUrl: () => RESPONSES_URL,
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log) {
    if (!credentials?.accessToken && !credentials?.apiKey) {
      throw new GrokCliImageError(
        "Grok CLI image requires accessToken (CLI OAuth pool)",
        HTTP_STATUS.UNAUTHORIZED,
        { code: "missing_credentials" }
      );
    }

    let n = 1;
    try {
      n = parseInt(body?.n ?? 1, 10);
    } catch {
      n = 1;
    }
    if (!Number.isFinite(n)) n = 1;
    n = Math.max(1, Math.min(n, MAX_N));

    const upstreamBody = buildUpstreamBody(model, body);
    const isEdit = collectImageRefs(body, 1).length > 0;
    log?.info?.(
      "IMAGE",
      `grok-cli ${isEdit ? "edit" : "generate"} model=${upstreamBody.model} n=${n}`
    );

    const generated = [];
    const usageAcc = {
      input_tokens: 0,
      output_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    let attempts = 0;
    const maxAttempts = n + 2;
    let lastNoImage = null;
    while (generated.length < n && attempts < maxAttempts) {
      attempts += 1;
      const json = await postResponses(upstreamBody, credentials, log);
      const images = extractGeneratedImages(json);
      if (!images.length) {
        const err =
          json?.error?.message ||
          (typeof json?.error === "string" ? json.error : null) ||
          "no image_generation_call (free image entitlement may be missing)";
        lastNoImage = typeof err === "string" ? err : "no image_generation_call";
        if (looksLikeQuota(lastNoImage)) {
          throw new GrokCliImageError(
            lastNoImage,
            HTTP_STATUS.RATE_LIMITED,
            { code: "quota_exhausted" }
          );
        }
        // Retry a couple times before failing hard
        if (attempts >= maxAttempts) break;
        continue;
      }
      generated.push(...images);
      addUsage(usageAcc, json.usage || {});
      log?.debug?.(
        "IMAGE",
        `grok-cli got ${images.length} image(s), total=${generated.length}/${n}`
      );
    }

    if (!generated.length) {
      throw new GrokCliImageError(
        lastNoImage || "no image_generation_call in response",
        HTTP_STATUS.BAD_GATEWAY,
        { code: "no_image_result" }
      );
    }

    return {
      created: nowSec(),
      data: generated.slice(0, n).map((b64_json) => ({ b64_json })),
      usage: usageAcc,
      model: stripImageSuffix(model),
    };
  },

  normalize: (responseBody) => responseBody,
};

export const GROK_CLI_IMAGE_TIMEOUT_MS = FETCH_TIMEOUT_MS;
