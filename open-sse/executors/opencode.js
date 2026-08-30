import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENCODE_UA = "opencode";
// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set(["muse-spark-1.2-contributor-free"]);

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

// ─── opencode session id (upstream) ─────────────────────────────────────────
function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  return RESPONSES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  return resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
    generate: generateSessionId,
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
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);
    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");

    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": lower["x-opencode-session"] || this._currentSessionId || generateSessionId(),
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
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
