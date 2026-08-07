import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

// ─── Bun TLS relay ──────────────────────────────────────────────────────────
// opencode.ai/zen fingerprints the TLS client: Node (OpenSSL) anonymous
// requests land in a per-class bucket that is permanently exhausted
// (FreeUsageLimitError 429), while bun (BoringSSL, same stack as the opencode
// TUI) rides the healthy bucket. We therefore relay `oc/*` upstream requests
// through a local bun sidecar: bun fetch → zen, streamed back.
//
// Verified from this repo: curl → 200, bun → 200, node/undici → 429, python3 → 403.

const RELAY_VERSION = "1";
const RELAY_DEFAULT_PORT = Number(process.env.BUN_RELAY_PORT || 20129);
const RELAY_SCRIPT = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const port = Number(process.env.RELAY_PORT || 20129);
try { fs.writeFileSync(path.join(os.tmpdir(), \`9router-bun-relay-\${port}.pid\`), String(process.pid)); } catch {}
const server = Bun.serve({
  port,
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
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        signal: req.signal,
        duplex: "half",
      });
      const respHeaders = new Headers(upstream.headers);
      respHeaders.delete("content-length");
      respHeaders.delete("connection");
      respHeaders.delete("content-encoding"); // bun auto-decompresses; avoid double gunzip on the client
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
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

// Kill a stale relay (wrong script version) via its pidfile, so its port can be reused.
async function killStaleRelay(port) {
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
  if (!relayPromise) relayPromise = startBunRelay();
  return relayPromise;
}

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
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if (await isRelayHealthy(port)) { healthy = true; break; }
    }
    if (healthy) return `http://127.0.0.1:${port}`;
    child.kill();
  }
  return null;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body) {
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders() {
    // Mirror the opencode TUI's zen client request shape: no Authorization
    // header (anonymous account-less), x-opencode-client: tui.
    return {
      "Content-Type": "application/json",
      "x-opencode-client": "tui",
      "Accept": "text/event-stream"
    };
  }

  // Route upstream through the local bun relay so zen sees a bun (BoringSSL)
  // TLS fingerprint instead of Node's — the anonymous free tier otherwise
  // 429s Node clients regardless of headers or egress IP.
  async fetch(url, options, proxyOptions) {
    // "direct" mode: skip the relay entirely (Node TLS, old behavior)
    if ((await getTlsMode()) === "direct") return super.fetch(url, options, proxyOptions);

    const relay = await ensureBunRelay().catch(() => null);
    if (!relay) return super.fetch(url, options, proxyOptions);

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
      console.warn(`[OpenCodeExecutor] bun relay failed (${error?.message}), falling back to direct fetch`);
      return super.fetch(url, options, proxyOptions);
    }
  }
}
