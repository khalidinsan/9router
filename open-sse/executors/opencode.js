import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

const OPENCODE_UA = "opencode/1.18.31";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
const REQ_FIELD = "_opencodeRequest";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 17);
}
// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

// ─── Bun TLS relay ──────────────────────────────────────────────────────────
// opencode.ai/zen fingerprints the TLS client: Node (OpenSSL) anonymous
// requests land in a per-class bucket that is permanently exhausted
// (FreeUsageLimitError 429), while bun (BoringSSL, same stack as the opencode
// TUI) rides the healthy bucket. We therefore relay `oc/*` upstream requests
// through a local bun sidecar: bun fetch → zen, streamed back.
//
// Verified from this repo: curl → 200, bun → 200, node/undici → 429, python3 → 403.

const RELAY_VERSION = "2";
const RELAY_DEFAULT_PORT = Number(process.env.BUN_RELAY_PORT || 20129);
const RELAY_SCRIPT = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const port = Number(process.env.RELAY_PORT || 20129);
try { fs.writeFileSync(path.join(os.tmpdir(), \`9router-bun-relay-\${port}.pid\`), String(process.pid)); } catch {}
const server = Bun.serve({
  port,
  idleTimeout: 0, // opencode SSE keep-alives can gap >10s; default idle timeout kills mid-stream
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return new Response(JSON.stringify({ v: "${RELAY_VERSION}" }), { headers: { "Content-Type": "application/json" } });
    const target = req.headers.get("x-relay-target");
    if (!target) return new Response("missing x-relay-target", { status: 400 });
    const headers = new Headers(req.headers);
    headers.delete("x-relay-target");
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("relay upstream timeout")), 300000);
      req.signal.addEventListener("abort", () => controller.abort(new Error("client disconnected")), { once: true });
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        signal: controller.signal,
        duplex: "half",
      });
      clearTimeout(timer);
      const respHeaders = new Headers(upstream.headers);
      respHeaders.delete("content-length");
      respHeaders.delete("connection");
      respHeaders.delete("content-encoding"); // bun auto-decompresses; avoid double gunzip on the client
      // Error-tolerant pipe: an upstream mid-stream error closes the stream cleanly
      // instead of surfacing as an undici "terminated" TypeError to the client.
      const stream = new ReadableStream({
        async start(c) {
          const reader = upstream.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) { c.close(); return; }
              c.enqueue(value);
            }
          } catch {
            try { c.close(); } catch { /* already closed */ }
          }
        },
        cancel() { try { upstream.body.cancel(); } catch { /* ignore */ } },
      });
      return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
  },
});
console.log("[bun-relay] listening on :" + port);
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveBunBinary() {
  const candidates = [
    process.env.BUN_PATH,
    process.env.BUN_BINARY,
    "bun",
    path.join(os.homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    path.join(os.homedir(), "Library", "Application Support", "kiro-cli", "bun"),
  ].filter(Boolean);

  const run = (bin) => new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 1500);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });

  for (const bin of candidates) {
    try { if (await run(bin)) return bin; } catch { /* next */ }
  }
  return null;
}

async function isRelayHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.v === RELAY_VERSION;
  } catch {
    return false;
  }
}

// Per-provider TLS mode, read from settings (providerStrategies.opencode.tlsMode).
// "bun" (default) relays through the local bun sidecar; "direct" sends straight
// from Node. Cached briefly so per-request lookups don't hammer the settings DB.
const TLS_MODE_TTL_MS = 4000;
let tlsModeCache = null;

async function getTlsMode() {
  if (tlsModeCache && Date.now() < tlsModeCache.expiresAt) return tlsModeCache.value;
  let mode = "bun";
  try {
    const { getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    const s = await getSettings();
    mode = s?.providerStrategies?.opencode?.tlsMode === "direct" ? "direct" : "bun";
  } catch {
    // settings unavailable (standalone/tests) — keep default
  }
  tlsModeCache = { value: mode, expiresAt: Date.now() + TLS_MODE_TTL_MS };
  return mode;
}

async function ensureBunRelay() {
  if (!relayPromise) {
    relayPromise = (async () => {
      // Serialize concurrent start attempts: two cold-start requests racing
      // would otherwise spawn two relays and kill each other's pidfile target.
      if (relayStarting) return relayStarting;
      relayStarting = startBunRelay();
      try {
        return await relayStarting;
      } finally {
        relayStarting = null;
      }
    })();
  }
  return relayPromise;
}

// Kill a stale relay (wrong script version) via its pidfile, so its port can be reused.
// Never touches a live same-version relay — only free ports from dead/stale processes.
async function killStaleRelay(port) {
  if (await isRelayHealthy(port)) return;
  const pidFile = path.join(os.tmpdir(), `9router-bun-relay-${port}.pid`);
  try {
    const pid = Number((await fs.promises.readFile(pidFile, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      await sleep(200);
    }
  } catch {
    // no pidfile — leave the stale process; we'll just use another port
  }
  try { await fs.promises.unlink(pidFile); } catch { /* ignore */ }
}

let relayPromise = null;
let relayStarting = null;

async function startBunRelay() {
  const bunBin = await resolveBunBinary();
  if (!bunBin) return null;

  const scriptPath = path.join(os.tmpdir(), "9router-bun-relay.mjs");
  try {
    await fs.promises.writeFile(scriptPath, RELAY_SCRIPT, "utf8");
  } catch {
    return null;
  }

  for (let port = RELAY_DEFAULT_PORT; port < RELAY_DEFAULT_PORT + 10; port++) {
    if (await isRelayHealthy(port)) return `http://127.0.0.1:${port}`; // reuse existing relay (same version)
    await killStaleRelay(port); // free the port from an outdated relay, if any
    const child = spawn(bunBin, [scriptPath], {
      env: { ...process.env, RELAY_PORT: String(port) },
      stdio: "ignore",
      detached: false,
    });
    child.on("error", () => {});
    child.unref();
    let exited = false;
    child.on("exit", () => { exited = true; });
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if (exited) break; // our spawn died — don't waste the window, move on
      if (await isRelayHealthy(port)) { healthy = true; break; }
    }
    if (healthy) return `http://127.0.0.1:${port}`;
    if (!exited) child.kill();
  }
  return null;
}

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

export function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
const stableOpencodeSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode:auth:${digest}`;
  }
  return "opencode:default";
}

export function stableSessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateSessionId();
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

function lastUserText(body) {
  try {
    if (!body || typeof body !== "object") return "";
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (!arr) return typeof body.input === "string" ? body.input.slice(-600) : "";
    for (let i = arr.length - 1; i >= 0; i--) {
      const msg = arr[i];
      if (!msg) continue;
      if (msg.role && msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content === "string" && content.trim()) return content.trim().slice(-600);
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (typeof part === "string" ? part : part?.text || part?.input_text || ""))
          .join(" ")
          .trim();
        if (text) return text.slice(-600);
      }
    }
  } catch {
    return "";
  }
  return "";
}

// The real CLI sends the current user message id (stable per turn, same on
// retries) as x-opencode-request. Derive it deterministically from the
// session plus the last user message so retries share the id.
export function deriveRequestId(sessionId, body) {
  const text = lastUserText(body);
  if (!text) return generateRequestId();
  const digest = crypto
    .createHash("sha256")
    .update(`opencode-req\0${sessionId || ""}\0${text}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  const id = `msg_${timeHex}${randomPart}`;
  return OPENCODE_REQUEST_RE.test(id) ? id : generateRequestId();
}

function normalizeRequestId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return OPENCODE_REQUEST_RE.test(normalized) ? normalized : null;
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return translateSessionId(hinted, clientTool);

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return translateSessionId(viaManager, clientTool);
  }

  return stableSessionId(credentials);
}

function resolveOpencodeRequestId(body, credentials, sessionId) {
  const raw = credentials?.rawHeaders || {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.toLowerCase() === "x-opencode-request") {
      const normalized = normalizeRequestId(value);
      if (normalized) return normalized;
      break;
    }
  }
  return deriveRequestId(sessionId, body);
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: OpenCode Free uses public/pooled credentials
    // (`Bearer public`) routing to an upstream OpenAI/Console account pool.
    // OpenAI Responses API strictly enforces that reasoning `encrypted_content`
    // can only be decrypted by the exact caller/account that issued it; sending it
    // across different accounts or rotating proxy relays triggers:
    // [invalid_request_error] reasoning `encrypted_content` was not issued to this caller (400).
    // Furthermore, under stateless mode (store=false), omitting encrypted_content
    // causes OpenAI to reject the referenced reasoning item as "not found or was deleted".
    // Dropping prior reasoning items allows multi-turn conversations and tool-calling
    // loops to succeed cleanly.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
      [REQ_FIELD]: resolveOpencodeRequestId(body, sourceCredentials, session),
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    // Zen rejects non-streaming requests on free models with 403 FreeTierError;
    // always stream upstream and let the handler layer aggregate for non-stream clients.
    if (body && typeof body === "object") body.stream = true;
    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      // Free-tier fingerprint tools are required even when an agent client
      // already supplied tools. ZCode/Claude Code requests normally have
      // non-empty tool arrays; skipping cloaking here triggers 403 FreeTierError.
      applyFingerprintTools(body, true);
    } else if (body && typeof body === "object") {
      applyFingerprintTools(body, false);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  async execute(args) {
    return super.execute({ ...args, credentials: this.prepareRequestCredentials(args) });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/zen/v1/responses`;
    if (isMessagesModel(model)) return `${base}/zen/v1/messages`;
    return `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];
    const downstreamReq = normalizeRequestId(lower["x-opencode-request"]);
    const requestId = credentials?.[REQ_FIELD] || downstreamReq || generateRequestId();

    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": session,
      "x-opencode-request": requestId,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }

  // Route upstream through the local bun relay so zen sees a bun (BoringSSL)
  // TLS fingerprint instead of Node's — the anonymous free tier otherwise
  // 429s Node clients regardless of headers or egress IP.
  async fetch(url, options, proxyOptions) {
    // "direct" mode: skip the relay entirely (Node TLS, old behavior)
    if ((await getTlsMode()) === "direct") return super.fetch(url, options, proxyOptions);

    let relay = await ensureBunRelay().catch(() => null);
    if (relay) {
      const viaRelay = await this.fetchViaRelay(relay, url, options, proxyOptions);
      if (viaRelay) return viaRelay;
      // Relay died/refused — reset the cache and try to respawn once before
      // falling back to direct (which may 429 on Node's TLS fingerprint).
      relayPromise = null;
      relay = await ensureBunRelay().catch(() => null);
      if (relay) {
        const retry = await this.fetchViaRelay(relay, url, options, proxyOptions);
        if (retry) return retry;
      }
    }
    return super.fetch(url, options, proxyOptions);
  }

  async fetchViaRelay(relay, url, options, proxyOptions) {
    const headers = new Headers(options.headers || {});
    headers.set("x-relay-target", url);
    headers.delete("host");
    headers.delete("content-length");

    try {
      return await proxyAwareFetch(relay, {
        ...options,
        headers,
        body: options.body ?? null,
      }, proxyOptions);
    } catch (error) {
      console.warn(`[OpenCodeExecutor] bun relay failed (${error?.message}), respawning`);
      return null;
    }
  }
}
