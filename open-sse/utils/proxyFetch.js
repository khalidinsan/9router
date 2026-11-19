import { Readable } from "stream";
import {
  MEMORY_CONFIG,
  FRESH_RETRY_KEEPALIVE_TIMEOUT_MS,
  STALE_SOCKET_ERROR_CODES,
  NON_STALE_SOCKET_ERROR_CODES,
  STALE_SOCKET_ERROR_SUBSTRINGS,
  resolveKeepAliveTimeouts,
  isFreshSocketReplayEnabled,
} from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { ensureClaudeCliVersion, applyClaudeCliVersion } from "./claudeCliVersion.js";

const CLAUDE_UA_PROBE = /claude-cli\/\d/;
function hasClaudeCliHeader(headers) {
  if (!headers) return false;
  const values = headers instanceof Headers ? [...headers.values()] : Array.isArray(headers) ? headers.map((h) => h[1]) : Object.values(headers);
  return values.some((v) => typeof v === "string" && CLAUDE_UA_PROBE.test(v));
}

const proxyDispatchers = new Map();
const directDispatchers = new Map();

export function resetDirectDispatchersForTests() {
  directDispatchers.clear();
  proxyDispatchers.clear();
}

export function isStaleSocketError(error) {
  if (!error || error.name === "AbortError" || isTlsCertError(error)) return false;
  const code = error?.cause?.code || error?.code || "";
  if (NON_STALE_SOCKET_ERROR_CODES.has(code)) return false;
  if (STALE_SOCKET_ERROR_CODES.has(code)) return true;
  const msg = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
  return STALE_SOCKET_ERROR_SUBSTRINGS.some((sub) => msg.includes(sub));
}

// Always fetch through the package's own undici instance so fetch and the
// Agents below come from the same copy — dispatcher options are only guaranteed
// to match within one undici version.
let undiciFetch = null;
async function rawFetch(url, options) {
  undiciFetch ??= (await import("undici")).fetch;
  return undiciFetch(url, options);
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsCertError(err) {
  const code = err?.cause?.code || err?.code;
  return TLS_CERT_ERRORS.has(code);
}
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;
// Connect deadline for the manual MITM-bypass socket. Without it a black-holed
// address hangs the request forever; BaseExecutor's timeoutMs cannot help
// because no Response object exists yet for it to abort.
const MITM_CONNECT_TIMEOUT_MS = 8000;
// IPv4/IPv6 addresses proven dead per hostname, so the next request skips them.
// TTL-bounded: a network change must not blacklist a family permanently.
const DEAD_ADDRESS_TTL_MS = 5 * 60 * 1000;
const deadAddresses = new Map(); // hostname -> Map(ip -> expiresAt)
// Family-level routing failures, tracked separately from per-address ones.
// EHOSTUNREACH/ENETUNREACH means there is no route to ANY address of that
// family, so trying a second address from it only burns another connect
// deadline — while a timeout on one IPv4 address says nothing about the next.
const deadFamilies = new Map(); // hostname -> Map(6|4 -> expiresAt)

function ipFamily(ip) {
  return String(ip).includes(":") ? 6 : 4;
}

function markAddressDead(hostname, ip) {
  if (!hostname || !ip) return;
  let perHost = deadAddresses.get(hostname);
  if (!perHost) { perHost = new Map(); deadAddresses.set(hostname, perHost); }
  perHost.set(ip, Date.now() + DEAD_ADDRESS_TTL_MS);
}

function markFamilyDead(hostname, ip) {
  if (!hostname || !ip) return;
  let perHost = deadFamilies.get(hostname);
  if (!perHost) { perHost = new Map(); deadFamilies.set(hostname, perHost); }
  perHost.set(ipFamily(ip), Date.now() + DEAD_ADDRESS_TTL_MS);
}

function isFamilyDead(hostname, family) {
  const perHost = deadFamilies.get(hostname);
  if (!perHost) return false;
  const expiry = perHost.get(family);
  if (!expiry) return false;
  if (Date.now() > expiry) { perHost.delete(family); return false; }
  return true;
}

function isAddressDead(hostname, ip) {
  if (isFamilyDead(hostname, ipFamily(ip))) return true;
  const perHost = deadAddresses.get(hostname);
  if (!perHost) return false;
  const expiry = perHost.get(ip);
  if (!expiry) return false;
  if (Date.now() > expiry) { perHost.delete(ip); return false; }
  return true;
}

// Exported for tests only
export function _clearDeadAddresses() {
  deadAddresses.clear();
  deadFamilies.clear();
}
export function _isAddressDead(hostname, ip) {
  return isAddressDead(hostname, ip);
}
export function _markFamilyDead(hostname, ip) {
  markFamilyDead(hostname, ip);
}
export function _isFamilyDead(hostname, family) {
  return isFamilyDead(hostname, family);
}
export function _mitmConnectTimeoutMs() {
  return MITM_CONNECT_TIMEOUT_MS;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/** scheme://host:port only — never credentials. */
function safeProxyHost(proxyUrl) {
  try {
    const parsed = new URL(String(proxyUrl));
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "unparseable-proxy-url";
  }
}

/** Destination host only, never the full URL (which may carry a query/path). */
function safeTargetHost(url) {
  try {
    return new URL(typeof url === "string" ? url : url.toString()).host;
  } catch {
    return "unparseable-url";
  }
}

/**
 * Resolve a hostname to candidate IPs, both families, in preference order.
 *
 * IPv4 leads. An earlier version put IPv6 first on the theory that a
 * black-holed A record could take the provider down — but the far more common
 * shape is a host with no IPv6 route at all (EHOSTUNREACH on every AAAA),
 * which costs a full connect deadline per address before IPv4 is even tried.
 * A timeout on an IPv4 address still falls through to IPv6, so a genuinely
 * black-holed A record is handled either way.
 */
async function resolveRealIPs(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ips;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const resolve6 = promisify(resolver.resolve6.bind(resolver));

    const [v4, v6] = await Promise.all([
      resolve4(hostname).catch(() => []),
      resolve6(hostname).catch(() => []),
    ]);

    const ips = [
      ...(v4 || []).slice(0, 2),
      ...(v6 || []).slice(0, 2),
    ].filter((ip) => !isAddressDead(hostname, ip));

    if (ips.length === 0) {
      console.warn(`[ProxyFetch] no usable address for ${hostname} (all candidates known-dead)`);
      return null;
    }

    DNS_CACHE.set(hostname, { ips, expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return ips;
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

// ISP DPI (VN → api.anthropic.com) RSTs Node's default TLS ClientHello curve
// list; a single curve rewrites the fingerprint enough to pass. Empirically:
// default agent = ECONNRESET 100%, X25519 = through 100%.
const TLS_ECDH_CURVE = process.env.NINEROUTER_TLS_ECDH_CURVE || "X25519";

// autoSelectFamilyAttemptTimeout = happy eyeballs (RFC 8305): race both address
// families, fall over in 250ms — replaces the old global ipv4first flag, which fixed
// one broken-family network by breaking the other (see claude-code#20240).
// requestTls must stay TLS-options-only (connect-level options belong in `connect`).
const EYEBALLS_CONNECT = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 };
function buildConnectOptions(insecure) {
  return { ...EYEBALLS_CONNECT, ecdhCurve: TLS_ECDH_CURVE, ...(insecure ? { rejectUnauthorized: false } : {}) };
}

function evictOldest(cacheMap) {
  if (cacheMap.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
    cacheMap.delete(cacheMap.keys().next().value);
  }
}

async function getOrCreateDirectAgent(key, insecure, keepAliveTimeout, keepAliveMaxTimeout) {
  const cached = directDispatchers.get(key);
  if (cached) return cached;
  const { Agent } = await import("undici");
  evictOldest(directDispatchers);
  const agent = new Agent({
    connect: buildConnectOptions(insecure),
    keepAliveTimeout,
    keepAliveMaxTimeout,
  });
  directDispatchers.set(key, agent);
  return agent;
}

/**
 * Shared direct dispatcher with capped keep-alive TTL. Prevents undici from
 * reusing idle sockets that upstream edges (NVIDIA NIM, Cloudflare) silently
 * dropped without sending a TCP RST.
 */
export function getDirectDispatcher(insecure = false) {
  const { keepAliveTimeout, keepAliveMaxTimeout } = resolveKeepAliveTimeouts();
  const key = `direct::${insecure ? "insecure" : "secure"}::${keepAliveTimeout}::${keepAliveMaxTimeout}`;
  return getOrCreateDirectAgent(key, insecure, keepAliveTimeout, keepAliveMaxTimeout);
}

/**
 * No-keep-alive retry dispatcher (`keepAliveTimeout: 1ms`) — guarantees a fresh
 * TCP/TLS connection after a poisoned pooled socket or a connect timeout.
 */
export function getFreshRetryDispatcher(insecure = false) {
  const key = `fresh::${insecure ? "insecure" : "secure"}`;
  return getOrCreateDirectAgent(
    key,
    insecure,
    FRESH_RETRY_KEEPALIVE_TIMEOUT_MS,
    FRESH_RETRY_KEEPALIVE_TIMEOUT_MS
  );
}

/**
 * Create proxy or direct dispatcher lazily (undici-compatible).
 * Always returns a dispatcher — the direct path needs the custom Agent too,
 * otherwise the default global agent's ClientHello gets RST-ed by DPI.
 */
async function getDispatcher(proxyUrl, insecure = false, forceFreshSocket = false) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    return forceFreshSocket ? getFreshRetryDispatcher(insecure) : getDirectDispatcher(insecure);
  }

  const key = `${normalized}::${insecure ? "insecure" : "secure"}`;
  if (!proxyDispatchers.has(key)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent({
      uri: normalized,
      connect: EYEBALLS_CONNECT,
      requestTls: { ecdhCurve: TLS_ECDH_CURVE, ...(insecure ? { rejectUnauthorized: false } : {}) },
    });
    proxyDispatchers.set(key, dispatcher);
  }

  return proxyDispatchers.get(key);
}

function isBodyReplaySafe(body) {
  return !(body && typeof body.getReader === "function" && body.locked);
}

async function fetchWithTlsFallback(url, options, proxyUrl, forceFreshSocket = false) {
  try {
    // Protocol adapters may need Node's HTTP/1 transport on the direct path.
    // Keep proxy/no-proxy resolution and strict-proxy enforcement here.
    if (!proxyUrl && options.directFetch) return await options.directFetch(url, options);
    const dispatcher = await getDispatcher(proxyUrl, false, forceFreshSocket);
    return await rawFetch(url, { ...options, dispatcher });
  } catch (err) {
    const isStrictSsl = options.strictTls === true || process.env.STRICT_SSL === "true" || process.env.STRICT_SSL === "1";
    if (!isStrictSsl && isTlsCertError(err)) {
      if (!isBodyReplaySafe(options.body)) {
        throw err;
      }
      // ponytail: in-memory insecure agent fallback for self-signed MITM corporate/antivirus certs
      console.warn(`[ProxyFetch] TLS cert verification failed (${err.cause?.code || err.code}), retrying with insecure TLS: ${url}`);
      const insecureDispatcher = await getDispatcher(proxyUrl, true, forceFreshSocket);
      return await rawFetch(url, { ...options, dispatcher: insecureDispatcher });
    }

    // Stale keep-alive recovery: a pooled socket died before returning headers. Replay
    // once on the fresh-socket dispatcher instead of waiting out the connect timeout.
    if (
      !proxyUrl
      && !forceFreshSocket
      && !options.directFetch
      && !options.signal?.aborted
      && isBodyReplaySafe(options.body)
      && isFreshSocketReplayEnabled()
      && isStaleSocketError(err)
    ) {
      dbg("FETCH", `stale keep-alive socket (${err.cause?.code || err.code || err.message}), retrying on fresh socket: ${url}`);
      return await fetchWithTlsFallback(url, options, proxyUrl, true);
    }
    throw err;
  }
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 *
 * A pinned address can be unreachable while the host is perfectly healthy
 * (observed: Google's A records time out from some networks, AAAA works in
 * ~30ms). Every attempt therefore carries a hard connect deadline, and a
 * dead address is remembered so the next call tries the other family first.
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  // A caller-supplied abort must also tear down the socket, not just the request.
  const callerSignal = options?.signal;
  if (callerSignal?.aborted) throw callerSignal.reason ?? new Error("Aborted");

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      reject(error);
    };

    // Hard deadline: without this a black-holed address hangs the request
    // forever (the request-level timeoutMs in BaseExecutor never fires because
    // no response object exists yet to abort).
    const connectTimer = setTimeout(
      () => fail(new Error(`connect timeout after ${MITM_CONNECT_TIMEOUT_MS}ms to ${realIP}`)),
      MITM_CONNECT_TIMEOUT_MS
    );
    const onAbort = () => fail(callerSignal?.reason ?? new Error("Aborted"));
    callerSignal?.addEventListener?.("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(connectTimer);
      callerSignal?.removeEventListener?.("abort", onAbort);
    };

    socket.connect(HTTPS_PORT, realIP, () => {
      clearTimeout(connectTimer);
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        if (settled) return;
        settled = true;
        cleanup();
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", (e) => { cleanup(); fail(e); });
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", (e) => { cleanup(); fail(e); });
  });
}

/**
 * Does the SYSTEM resolver send this host to loopback?
 *
 * That redirect is the only reason the MITM bypass exists: MITM writes
 * /etc/hosts entries pointing these hosts at 127.0.0.1, and the bypass pins the
 * real IP so 9router's own traffic skips its own interceptor.
 *
 * When MITM is off there is no entry, the system resolver already returns the
 * real IPs, and the bypass is pure overhead — it re-implements DNS+TCP+TLS by
 * hand and, on a network where those pinned addresses are unreachable, burns
 * four connect deadlines before falling through to the plain fetch that would
 * have worked immediately. Measured: bypass 203ms vs plain fetch 51ms for the
 * same request.
 *
 * Probed per host and cached briefly, so enabling MITM still engages the
 * bypass within one TTL without a settings/DB dependency here.
 */
const MITM_PROBE_TTL_MS = 30 * 1000;
const mitmProbeCache = new Map(); // hostname -> { redirects, expiresAt }

async function systemDnsRedirectsToLoopback(hostname) {
  const cached = mitmProbeCache.get(hostname);
  if (cached && Date.now() < cached.expiresAt) return cached.redirects;

  let redirects = false;
  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const { address } = await promisify(dns.lookup)(hostname);
    redirects = address === "127.0.0.1" || address === "::1" || address === "0.0.0.0";
  } catch {
    // Unresolvable here — leave it to the normal path to surface the error.
    redirects = false;
  }

  mitmProbeCache.set(hostname, { redirects, expiresAt: Date.now() + MITM_PROBE_TTL_MS });
  return redirects;
}

export function _clearMitmProbeCache() {
  mitmProbeCache.clear();
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  // Keep the spoofed Claude Code version current (new models require a minimum CLI version).
  // Refresh in the background: the request uses the version already known, so an
  // unreachable npm registry can never add latency to the chat path.
  if (hasClaudeCliHeader(options?.headers)) {
    void ensureClaudeCliVersion(rawFetch);
    options = { ...options, headers: applyClaudeCliVersion(options.headers) };
  }
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const baseHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) };
    const relayHeaders = {
      ...baseHeaders,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return await rawFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;
  const forceFreshSocket = proxyOptions?.forceFreshSocket === true || options?.forceFreshSocket === true;

  // Protocol adapters that own their transport (wreq-js TLS impersonation)
  // cannot use an undici dispatcher: they must drive the proxy themselves.
  // Only adapters that declare `proxyCapable` opt in — any other adapter
  // ignores the proxy URL and would leave over the direct interface, so they
  // keep the undici path below.
  if (proxyUrl && options?.directFetch?.proxyCapable === true) {
    try {
      const res = await options.directFetch(url, { ...options, proxyUrl }, proxyUrl);
      // Reported only after the adapter that holds the tunnel returned.
      const via = res?.headers?.get?.("x-9r-proxy-via");
      dbg("PROXY", `PROXY ROUTING VERIFIED | ${safeTargetHost(targetUrl)} | transport=adapter | proxy=${via || safeProxyHost(proxyUrl)} | status=${res?.status}`);
      return res;
    } catch (err) {
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${err.message}`);
      }
      throw err;
    }
  }

  // MITM DNS bypass: only while MITM is actually intercepting this host.
  // See systemDnsRedirectsToLoopback — when MITM is off the system resolver is
  // already correct and this whole path is overhead that can stall the request.
  if (shouldBypassMitmDns(targetUrl)) {
    const hostname = new URL(targetUrl).hostname;
    const intercepted = await systemDnsRedirectsToLoopback(hostname);

    if (!intercepted) {
      dbg("TLS", `MITM bypass skipped for ${hostname} (system DNS not redirected)`);
    } else {
      if (proxyUrl) {
        try {
          return await fetchWithTlsFallback(url, options, proxyUrl, forceFreshSocket);
        } catch (proxyError) {
          if (proxyOptions?.strictProxy === true) {
            throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
          }
          console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
        }
      }
      // No proxy — manually resolve real IP to bypass DNS spoof.
      // Try each candidate address in turn; a dead family must not hang the request.
      const parsedUrl = new URL(targetUrl);
      const ips = await resolveRealIPs(parsedUrl.hostname);
      if (ips?.length) {
        let lastError = null;
        for (const ip of ips) {
          try {
            return await createBypassRequest(parsedUrl, ip, options);
          } catch (error) {
            lastError = error;
            const msg = String(error?.message || "");
            // EHOSTUNREACH/ENETUNREACH is a routing verdict: this host has no
            // route to that whole family, so the next address from it will fail
            // identically. Remember the family and skip the rest of it.
            if (/EHOSTUNREACH|ENETUNREACH|EAFNOSUPPORT|EADDRNOTAVAIL/i.test(msg)) {
              markFamilyDead(parsedUrl.hostname, ip);
              markAddressDead(parsedUrl.hostname, ip);
              console.warn(`[ProxyFetch] MITM bypass: ${ip} unreachable (no route for IPv${ipFamily(ip)}); skipping family`);
              continue;
            }
            // A connect timeout / refused connection proves only THIS address
            // unreachable — a sibling from the same family may still work.
            if (/connect timeout|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
              markAddressDead(parsedUrl.hostname, ip);
              console.warn(`[ProxyFetch] MITM bypass: ${ip} unreachable (${msg}); trying next address`);
              continue;
            }
            console.warn(`[ProxyFetch] MITM bypass failed: ${msg}`);
            break;
          }
        }
        if (lastError) console.warn(`[ProxyFetch] MITM bypass exhausted for ${parsedUrl.hostname}: ${lastError.message}`);
      }
    }
  }

  if (proxyUrl) {
    try {
      return await fetchWithTlsFallback(url, options, proxyUrl, forceFreshSocket);
    } catch (proxyError) {
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return fetchWithTlsFallback(url, options, null, forceFreshSocket);
    }
  }

  // Strict mode means "never leave over the direct IP". Reaching here with a
  // proxy configured but unresolved is exactly that case — an inactive or
  // empty pool, or every proxy removed — so refuse instead of silently
  // exposing the real address (#4333). The catch blocks above only cover a
  // proxy that was actually tried.
  //
  // Gate on a proxy being *intended*: callers like the Qoder executor set
  // strictProxy to mean "do not replay this request directly if the proxy
  // fails" (a replayed COSY signature returns 403), not "a proxy is required".
  // With nothing configured they must keep working.
  const proxyIntended = proxyOptions?.proxyPoolId
    || proxyOptions?.enabled === true
    || proxyOptions?.connectionProxyEnabled === true
    || !!normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (proxyOptions?.strictProxy === true && proxyIntended) {
    throw new Error("[ProxyFetch] Proxy required but none resolved (strictProxy=true)");
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return fetchWithTlsFallback(url, options, null, forceFreshSocket);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
