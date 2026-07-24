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
 */
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_USER_AGENT,
  GROK_CLI_VERSION,
} from "../../config/grokCli.js";

const RESPONSES_URL = `${GROK_CLI_BASE_URL}/responses`;
const DEFAULT_MODEL = "grok-4.5";
const FETCH_TIMEOUT_MS = Number(process.env.GROK_CLI_IMAGE_TIMEOUT_MS || 180000);
const MAX_N = 4;

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
    "User-Agent": GROK_CLI_USER_AGENT,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "headless",
    "x-grok-session-id": randomUUID(),
    "x-grok-req-id": randomUUID(),
  };
}

function buildUpstreamBody(model, body) {
  const prompt = String(body?.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");

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
      throw new Error(
        `Grok CLI image: HTTP ${res.status} invalid JSON (${text.slice(0, 180)})`
      );
    }
    if (!res.ok) {
      const msg =
        json?.error?.message ||
        json?.error ||
        json?.detail ||
        text.slice(0, 240);
      throw new Error(
        typeof msg === "string"
          ? `Grok CLI image HTTP ${res.status}: ${msg}`
          : `Grok CLI image HTTP ${res.status}`
      );
    }
    return json;
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Grok CLI image timeout after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw e;
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
      throw new Error("Grok CLI image requires accessToken (CLI OAuth pool)");
    }

    let n = 1;
    try {
      n = parseInt(body?.n ?? 1, 10);
    } catch {
      n = 1;
    }
    n = Math.max(1, Math.min(Number.isFinite(n) ? n : 1, MAX_N));

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
    while (generated.length < n && attempts < maxAttempts) {
      attempts += 1;
      const json = await postResponses(upstreamBody, credentials, log);
      const images = extractGeneratedImages(json);
      if (!images.length) {
        const err =
          json?.error?.message ||
          json?.error ||
          "no image_generation_call (free image entitlement may be missing)";
        throw new Error(typeof err === "string" ? err : JSON.stringify(err));
      }
      generated.push(...images);
      addUsage(usageAcc, json.usage || {});
      log?.debug?.(
        "IMAGE",
        `grok-cli got ${images.length} image(s), total=${generated.length}/${n}`
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
