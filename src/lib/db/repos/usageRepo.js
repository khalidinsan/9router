import { EventEmitter } from "events";
import { createHash } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";
import { resolveTimeZone, buildChartEdges, startOfDayInTz } from "../../tz.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

// Stable, non-reversible group id for an API key. Masked prefixes MUST NOT
// be used as ids: key format is sk-{machineId}-{keyId}-{crc} with one
// machineId per server, so the first 8 chars are identical for every key
// and masked buckets merge unrelated keys. Raw keys MUST NOT leak into
// dashboard JSON either (see AUDIT-002) — hence a truncated sha256.
function hashApiKey(rawKey) {
  return createHash("sha256").update(String(rawKey)).digest("hex").slice(0, 16);
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
// Display-only stale guard for the per-API-key live map (no load-balancing
// impact). Real streams finish in seconds/minutes; anything older is a leak.
const ACTIVE_APIKEY_STALE_MS = 60 * 60 * 1000;
// Bucket for requests without an API key. Stored per model+provider in the
// aggregates so the lastUsed overlay can match it exactly.
const LOCAL_API_KEY = "local-no-key";
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };
if (!global._pendingByApiKey) global._pendingByApiKey = {};

const pendingRequests = global._pendingRequests;
const pendingByApiKey = global._pendingByApiKey;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false, apiKey = null) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  // Per-API-key live presence (display-only; feeds the "Active now" panel).
  // Keyed by FULL raw key — never by masked prefix. Key format is
  // sk-{machineId}-{keyId}-{crc} with one machineId per server, so the first
  // 8 chars are identical for every key and masked buckets would merge them.
  const akVal = (typeof apiKey === "string" && apiKey) ? apiKey : LOCAL_API_KEY;
  if (!pendingByApiKey[akVal]) pendingByApiKey[akVal] = { count: 0, models: {}, updatedAt: 0 };
  const akRec = pendingByApiKey[akVal];
  akRec.count = Math.max(0, akRec.count + (started ? 1 : -1));
  if (!akRec.models[modelKey]) akRec.models[modelKey] = 0;
  akRec.models[modelKey] = Math.max(0, akRec.models[modelKey] + (started ? 1 : -1));
  if (akRec.models[modelKey] === 0) delete akRec.models[modelKey];
  akRec.updatedAt = Date.now();
  if (akRec.count === 0) delete pendingByApiKey[akVal];

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

export function getConnectionPendingRequests(connectionId) {
  if (!connectionId || !pendingRequests.byAccount[connectionId]) return 0;
  return Object.values(pendingRequests.byAccount[connectionId]).reduce((sum, n) => sum + (n || 0), 0);
}

/**
 * Build the live per-API-key presence list from the in-flight map.
 * @param {Object} nameMap - raw apiKey -> display name
 */
function buildActiveByApiKey(nameMap = {}) {
  const nowTs = Date.now();
  const out = [];
  for (const [ak, rec] of Object.entries(pendingByApiKey)) {
    if (!rec || rec.count <= 0 || nowTs - (rec.updatedAt || 0) > ACTIVE_APIKEY_STALE_MS) {
      delete pendingByApiKey[ak];
      continue;
    }
    const isLocal = ak === LOCAL_API_KEY;
    out.push({
      apiKeyMasked: isLocal ? null : maskApiKey(ak),
      keyName: isLocal ? "Local (No API Key)" : (nameMap[ak] || `${ak.slice(0, 12)}...`),
      count: rec.count,
      models: Object.entries(rec.models || {}).map(([model, count]) => ({ model, count })),
      lastSeen: new Date(rec.updatedAt).toISOString(),
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  let apiKeyNameMap = {};
  try {
    const { getApiKeys } = await import("./apiKeysRepo.js");
    for (const k of (await getApiKeys()) || []) {
      if (k?.key) apiKeyNameMap[k.key] = k.name || k.key;
    }
  } catch {}
  const activeByApiKey = buildActiveByApiKey(apiKeyNameMap);
  return { activeRequests, recentRequests, errorProvider, activeByApiKey };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    let inserted = false;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      const existing = db.get(
        `SELECT id, endpoint FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKey, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null,
          promptTokens, completionTokens,
        ]
      );

      if (existing) {
        if (!existing.endpoint && entry.endpoint) {
          db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
        }
        return;
      }

      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({}),
        ]
      );

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      inserted = true;
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ?`, [cutoffKey]);
}

export async function getUsageStats(period = "all", timeZone) {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) apiKeyMap[k.key] = { name: k.name, id: k.id, createdAt: k.createdAt };

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = db.all(`SELECT timestamp, provider, model, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`);
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    activeByApiKey: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  // Live per-API-key presence (same data as getActiveRequests, names from apiKeyMap)
  {
    const apiKeyNameMap = {};
    for (const [k, v] of Object.entries(apiKeyMap)) apiKeyNameMap[k] = v?.name || k;
    stats.activeByApiKey = buildActiveByApiKey(apiKeyNameMap);
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [tenMinutesAgo.toISOString(), now.toISOString()]
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  // With a client time zone, every period is an exact live scan of the tz
  // window (day boundaries follow the viewer's midnight, not the server's).
  // Without tz, 7d+ keep the fast pre-aggregated daily summaries.
  const tz = resolveTimeZone(timeZone);
  if (tz) ensureChartIndex(db);
  const useDailySummary = !tz && period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCachedTokens += day.cachedTokens || 0;
      stats.totalCost += day.cost || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        stats.byProvider[prov].cost += p.cost || 0;
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        // Group id = stable hash of the FULL raw key. Masked prefixes collide
        // (every key shares sk-{machineId}-…) and raw keys must not leak into
        // dashboard JSON (see hashApiKey / AUDIT-002). Stored aggregates carry
        // the raw key in meta.apiKey; fall back to the stored key's first
        // segment for rows written before meta existed.
        const storedRaw = ak.apiKey && typeof ak.apiKey === "string" ? ak.apiKey : null;
        const firstSeg = akKey.split("|")[0] || "";
        const rawForId = storedRaw || (firstSeg && firstSeg !== "local-no-key" ? firstSeg : null);
        const mapKey = rawForId
          ? `${hashApiKey(rawForId)}|${rawModel}|${provider || "unknown"}`
          : `local-no-key|${rawModel}|${provider || "unknown"}`;
        const keyInfo = rawForId ? apiKeyMap[rawForId] : null;
        const keyName = keyInfo?.name || (rawForId ? `${rawForId.slice(0, 12)}...` : "Local (No API Key)");
        const apiKeyMasked = rawForId ? maskApiKey(rawForId) : null;
        if (!stats.byApiKey[mapKey]) {
          stats.byApiKey[mapKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: mapKey, lastUsed: dateKey };
        }
        stats.byApiKey[mapKey].requests += ak.requests || 0;
        stats.byApiKey[mapKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[mapKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[mapKey].cachedTokens += ak.cachedTokens || 0;
        stats.byApiKey[mapKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[mapKey].lastUsed || "")) stats.byApiKey[mapKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history
    const overlayCutoff = maxDays ? Date.now() - maxDays * 86400000 : 0;
    const histRows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()]
    );
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      // Overlay key must match the aggregate map keys: hashed id per
      // model+provider (and per-model local buckets, not one bare key).
      const overlayKey = (e.apiKey && typeof e.apiKey === "string")
        ? `${hashApiKey(e.apiKey)}|${e.model}|${e.provider || "unknown"}`
        : `local-no-key|${e.model}|${e.provider || "unknown"}`;
      if (stats.byApiKey[overlayKey] && new Date(ts) > new Date(stats.byApiKey[overlayKey].lastUsed)) stats.byApiKey[overlayKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // Live history scan (exact). Cutoff follows the client's zone when tz
    // is given; otherwise server-local (legacy).
    let cutoff;
    if (tz) {
      const nowMs = Date.now();
      if (period === "today") {
        cutoff = new Date(startOfDayInTz(tz, nowMs)).toISOString();
      } else if (period === "24h") {
        cutoff = new Date(nowMs - PERIOD_MS["24h"]).toISOString();
      } else if (period === "all") {
        cutoff = new Date(0).toISOString();
      } else {
        const days = { "7d": 7, "30d": 30, "60d": 60 }[period] || 7;
        cutoff = new Date(startOfDayInTz(tz, nowMs - (days - 1) * 86400000)).toISOString();
      }
    } else if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
      [cutoff]
    );

    for (const r of filtered) {
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = tokens.prompt_tokens || 0;
      const completionTokens = tokens.completion_tokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      // byApiKey keyed by stable HASH of the full raw key — same convention
      // as the daily pipeline. Masked prefixes (first 8 chars) are identical
      // for every key on this server (sk-{machineId}-…), so masked buckets
      // merge unrelated keys; raw keys must not leak (see hashApiKey).
      const rawApiKey = (r.apiKey && typeof r.apiKey === "string") ? r.apiKey : null;
      if (rawApiKey) {
        const keyId = hashApiKey(rawApiKey);
        const keyInfo = apiKeyMap[rawApiKey];
        const keyName = keyInfo?.name || rawApiKey.slice(0, 12) + "...";
        const apiKeyMasked = maskApiKey(rawApiKey);
        const akKey = `${keyId}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: akKey, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      } else {
        const akKey = `local-no-key|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: akKey, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

export async function getChartData(period = "7d", timeZone) {
  const db = await getAdapter();
  const now = Date.now();

  // Client-timezone path: bucket edges + labels follow the viewer's tz
  // (e.g. WIB) instead of server-local time. Exact for every period.
  const tz = resolveTimeZone(timeZone);
  if (tz) {
    ensureChartIndex(db);
    const { labels, edges, bucketCount } = buildChartEdges(period, tz, now);
    const buckets = labels.map((label) => ({ label, tokens: 0, cost: 0 }));
    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? ORDER BY timestamp ASC`,
      [new Date(edges[0]).toISOString()]
    );
    let idx = 0;
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (Number.isNaN(t) || t < edges[0]) continue;
      while (idx < bucketCount - 1 && t >= edges[idx + 1]) idx++;
      if (t > now || t >= edges[bucketCount]) continue;
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
    }
    return buckets;
  }

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
    }
    return buckets;
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
    };
  });
}

const CHART_SERIES_LIMIT = 10;

// (moved to src/lib/tz.js — single source of truth for client time zones)

let chartIndexEnsured = false;
function ensureChartIndex(db) {
  if (chartIndexEnsured) return;
  chartIndexEnsured = true;
  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_usageHistory_timestamp ON usageHistory(timestamp)`);
  } catch {}
}

/**
 * Per-API-key chart series: token/cost buckets per key so the dashboard can
 * show "which key was active when". today/24h = live hourly scan of
 * usageHistory; 7d/30d/60d = daily buckets from usageDaily (whose byApiKey
 * has always been keyed by FULL raw key). Top N keys + merged Others.
 * With a valid timeZone, all periods bucket by the client's tz instead.
 */
export async function getChartDataByApiKey(period = "7d", timeZone) {
  const db = await getAdapter();
  const now = Date.now();

  let apiKeyNameMap = {};
  try {
    const { getApiKeys } = await import("./apiKeysRepo.js");
    for (const k of (await getApiKeys()) || []) {
      if (k?.key) apiKeyNameMap[k.key] = k.name || k.key;
    }
  } catch {}

  const nameOf = (raw) => (!raw || raw === LOCAL_API_KEY
    ? "Local (No API Key)"
    : (apiKeyNameMap[raw] || `${raw.slice(0, 12)}...`));
  const maskedOf = (raw) => (!raw || raw === LOCAL_API_KEY ? null : maskApiKey(raw));

  // Client-timezone path: live-scan every period with tz bucket edges.
  const tz = resolveTimeZone(timeZone);
  if (tz) {
    ensureChartIndex(db);
    const { labels: tzLabels, edges, bucketCount: tzCount } = buildChartEdges(period, tz, now);
    const tzPerRaw = {};
    const tzEnsure = (raw) => {
      if (!tzPerRaw[raw]) tzPerRaw[raw] = { tokens: new Array(tzCount).fill(0), cost: new Array(tzCount).fill(0) };
      return tzPerRaw[raw];
    };
    const rows = db.all(
      `SELECT timestamp, apiKey, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? ORDER BY timestamp ASC`,
      [new Date(edges[0]).toISOString()]
    );
    let idx = 0;
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (Number.isNaN(t) || t < edges[0]) continue;
      while (idx < tzCount - 1 && t >= edges[idx + 1]) idx++;
      if (t > now || t >= edges[tzCount]) continue;
      const raw = (r.apiKey && typeof r.apiKey === "string") ? r.apiKey : LOCAL_API_KEY;
      const s = tzEnsure(raw);
      s.tokens[idx] += (r.promptTokens || 0) + (r.completionTokens || 0);
      s.cost[idx] += r.cost || 0;
    }
    const ranked = Object.entries(tzPerRaw)
      .map(([raw, s]) => ({ raw, ...s, total: s.tokens.reduce((a, b) => a + b, 0) }))
      .filter((e) => e.total > 0)
      .sort((a, b) => b.total - a.total);
    return finalizeChartSeries(tzLabels, ranked, nameOf, maskedOf);
  }

  let labels;
  let bucketCount;
  const perRaw = {};
  const ensure = (raw) => {
    if (!perRaw[raw]) perRaw[raw] = { tokens: new Array(bucketCount).fill(0), cost: new Array(bucketCount).fill(0) };
    return perRaw[raw];
  };

  if (period === "today" || period === "24h") {
    bucketCount = 24;
    const bucketMs = 3600000;
    let startTime;
    if (period === "today") {
      const sod = new Date();
      sod.setHours(0, 0, 0, 0);
      startTime = sod.getTime();
    } else {
      startTime = now - bucketCount * bucketMs;
    }
    const endTime = period === "today" ? startTime + bucketCount * bucketMs : now;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    labels = Array.from({ length: bucketCount }, (_, i) => labelFn(startTime + i * bucketMs));

    const rows = db.all(
      `SELECT timestamp, apiKey, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > endTime) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      const raw = (r.apiKey && typeof r.apiKey === "string") ? r.apiKey : LOCAL_API_KEY;
      const s = ensure(raw);
      s.tokens[idx] += (r.promptTokens || 0) + (r.completionTokens || 0);
      s.cost[idx] += r.cost || 0;
    }
  } else {
    bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
    const today = new Date();
    const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const dayRows = loadDaysInRange(db, bucketCount);
    const dayMap = {};
    for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

    labels = [];
    const dateKeys = [];
    for (let i = 0; i < bucketCount; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - (bucketCount - 1 - i));
      labels.push(labelFn(d));
      dateKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    dateKeys.forEach((dateKey, idx) => {
      const dayData = dayMap[dateKey];
      if (!dayData) return;
      for (const ak of Object.values(dayData.byApiKey || {})) {
        const raw = (ak.apiKey && typeof ak.apiKey === "string") ? ak.apiKey : LOCAL_API_KEY;
        const s = ensure(raw);
        s.tokens[idx] += (ak.promptTokens || 0) + (ak.completionTokens || 0);
        s.cost[idx] += ak.cost || 0;
      }
    });
  }

  const ranked = Object.entries(perRaw)
    .map(([raw, s]) => ({ raw, ...s, total: s.tokens.reduce((a, b) => a + b, 0) }))
    .filter((e) => e.total > 0)
    .sort((a, b) => b.total - a.total);

  return finalizeChartSeries(labels, ranked, nameOf, maskedOf);
}

/**
 * Shared tail for per-API-key chart series: top N keys + merged Others.
 */
function finalizeChartSeries(labels, ranked, nameOf, maskedOf) {
  const bucketCount = labels.length;
  const series = ranked.slice(0, CHART_SERIES_LIMIT).map((e, i) => ({
    key: `k${i}`, name: nameOf(e.raw), masked: maskedOf(e.raw), tokens: e.tokens, cost: e.cost,
  }));
  const rest = ranked.slice(CHART_SERIES_LIMIT);
  if (rest.length > 0) {
    const oT = new Array(bucketCount).fill(0);
    const oC = new Array(bucketCount).fill(0);
    for (const e of rest) {
      e.tokens.forEach((v, i) => { oT[i] += v; });
      e.cost.forEach((v, i) => { oC[i] += v; });
    }
    series.push({ key: `k${series.length}`, name: `Others (${rest.length})`, masked: null, tokens: oT, cost: oC });
  }
  return { labels, series };
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Same dd-MM-yyyy HH:mm:ss shape, rendered in the client's zone.
function formatLogDateTz(date, tz) {
  const parts = {};
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  for (const p of f.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

/**
 * Sum prompt+completion tokens for a connection since an ISO timestamp (or Date/ms).
 * Used by Grok CLI free-tier estimate (rolling ~1M tokens / 24h, same as grok2api).
 */
export async function sumConnectionTokensSince(connectionId, since) {
  if (!connectionId) return 0;
  try {
    const db = await getAdapter();
    const sinceIso =
      since instanceof Date
        ? since.toISOString()
        : typeof since === "number"
          ? new Date(since).toISOString()
          : String(since || "");
    if (!sinceIso) return 0;

    const row = db.get(
      `SELECT
         COALESCE(SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)), 0) AS total
       FROM usageHistory
       WHERE connectionId = ? AND timestamp >= ?`,
      [connectionId, sinceIso],
    );
    const total = Number(row?.total ?? 0);
    return Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  } catch (e) {
    console.error("[usageRepo] sumConnectionTokensSince failed:", e.message);
    return 0;
  }
}

export async function getRecentLogs(limit = 200, timeZone) {
  try {
    const db = await getAdapter();
    const tz = resolveTimeZone(timeZone);
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = tz ? formatLogDateTz(new Date(r.timestamp), tz) : formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}
