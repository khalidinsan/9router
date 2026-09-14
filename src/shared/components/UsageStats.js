"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { FREE_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";
import { timeAgo, TimeAgo, tzQueryParam } from "@/shared/utils/datetime";

// Keep providers without serviceKinds (default LLM) or with "llm" in serviceKinds
function isLLMProvider(id) {
  const p = AI_PROVIDERS[id];
  if (!p?.serviceKinds) return true;
  return p.serviceKinds.includes("llm");
}
import Badge from "./Badge";
import Card from "./Card";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";
import UsageTable, { fmt, fmtTime } from "@/app/(dashboard)/dashboard/usage/components/UsageTable";
import dynamic from "next/dynamic";
// Lazy-load: keeps @xyflow/react out of the shared bundle until topology renders
const ProviderTopology = dynamic(() => import("@/app/(dashboard)/dashboard/usage/components/ProviderTopology"), { ssr: false });
import UsageChart from "@/app/(dashboard)/dashboard/usage/components/UsageChart";
import ActiveApiKeys from "@/app/(dashboard)/dashboard/usage/components/ActiveApiKeys";

// Relative-time helpers live in the central datetime module.
function RecentRequests({ requests = [] }) {
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden" padding="sm" style={{ height: 480 }}>
      {/* Header */}
      <div className="px-1 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Recent Requests</span>
      </div>

      {!requests.length ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No requests yet.</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full min-w-[300px] border-collapse text-xs">
            <thead className="sticky top-0 bg-bg z-10">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-semibold text-text-muted w-2"></th>
                <th className="py-1.5 text-left font-semibold text-text-muted">Model</th>
                <th className="py-1.5 text-right font-semibold text-text-muted whitespace-nowrap">In / Out</th>
                <th className="py-1.5 text-right font-semibold text-text-muted">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {requests.map((r, i) => {
                const ok = !r.status || r.status === "ok" || r.status === "success";
                return (
                  <tr key={i} className="hover:bg-bg-subtle transition-colors">
                    <td className="py-1.5">
                      <span className={`block w-1.5 h-1.5 rounded-full ${ok ? "bg-success" : "bg-error"}`} />
                    </td>
                    <td className="py-1.5 font-mono truncate max-w-[120px]" title={r.model}>{r.model}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <span className="text-primary">{fmt(r.promptTokens)}↑</span>
                      {" "}
                      <span className="text-success">{fmt(r.completionTokens)}↓</span>
                    </td>
                    <td className="py-1.5 text-right text-text-muted whitespace-nowrap"><TimeAgo timestamp={r.timestamp} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function sortData(dataMap, pendingMap = {}, sortBy, sortOrder) {
  return Object.entries(dataMap || {})
    .map(([key, data]) => {
      const totalTokens = (data.promptTokens || 0) + (data.completionTokens || 0);
      const totalCost = data.cost || 0;
      // ponytail: cost split is a token-share allocation of the (rate-accurate)
      // server total, not a per-rate recompute. cached is a subset of prompt, so
      // peel it out of the input share. Upgrade to a stored per-component cost
      // breakdown if exact cached-rate cost display is needed.
      const cachedTokens = data.cachedTokens || 0;
      const nonCachedInput = Math.max(0, (data.promptTokens || 0) - cachedTokens);
      const inputCost = totalTokens > 0 ? nonCachedInput * (totalCost / totalTokens) : 0;
      const cachedCost = totalTokens > 0 ? cachedTokens * (totalCost / totalTokens) : 0;
      const outputCost = totalTokens > 0 ? (data.completionTokens || 0) * (totalCost / totalTokens) : 0;
      return { ...data, key, totalTokens, totalCost, inputCost, cachedCost, outputCost, pending: pendingMap[key] || 0 };
    })
    .sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (typeof valA === "string") valA = valA.toLowerCase();
      if (typeof valB === "string") valB = valB.toLowerCase();
      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });
}

function getGroupKey(item, keyField) {
  switch (keyField) {
    case "rawModel": return item.rawModel || "Unknown Model";
    case "accountName": return item.accountName || (item.connectionId ? `Account ${item.connectionId.slice(0, 8)}...` : "Unknown Account");
    // Stable id = FULL raw key (apiKeyKey). Never group by display keyName or
    // masked prefix: masked prefixes collide across keys on one server.
    case "apiKeyKey": return item.apiKeyKey || item.keyName || "Unknown Key";
    // keyId = key identity WITHOUT model/provider: one accordion per key,
    // per-model rows inside. Falls back to apiKeyKey for stale payloads.
    case "keyId": return item.keyId || item.apiKeyKey || item.keyName || "Unknown Key";
    case "keyName": return item.apiKeyKey || item.keyName || "Unknown Key";
    case "endpoint": return item.endpoint || "Unknown Endpoint";
    default: return item[keyField] || "Unknown";
  }
}

function groupDataByKey(data, keyField, labelField) {
  if (!Array.isArray(data)) return [];
  const groups = {};
  data.forEach((item) => {
    const gk = getGroupKey(item, keyField);
    if (!groups[gk]) {
      groups[gk] = {
        groupKey: gk,
        label: labelField ? (item[labelField] || gk) : gk,
        summary: { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, totalCost: 0, inputCost: 0, cachedCost: 0, outputCost: 0, lastUsed: null, pending: 0 },
        items: [],
      };
    }
    const s = groups[gk].summary;
    s.requests += item.requests || 0;
    s.promptTokens += item.promptTokens || 0;
    s.completionTokens += item.completionTokens || 0;
    s.cachedTokens += item.cachedTokens || 0;
    s.totalTokens += item.totalTokens || 0;
    s.cost += item.cost || 0;
    s.totalCost += item.totalCost || item.cost || 0;
    s.inputCost += item.inputCost || 0;
    s.cachedCost += item.cachedCost || 0;
    s.outputCost += item.outputCost || 0;
    s.pending += item.pending || 0;
    if (item.lastUsed && (!s.lastUsed || new Date(item.lastUsed) > new Date(s.lastUsed))) {
      s.lastUsed = item.lastUsed;
    }
    groups[gk].items.push(item);
  });
  return Object.values(groups);
}

// Sortable group-summary fields (sortBy -> summary field)
const GROUP_SUMMARY_NUMERIC = {
  requests: "requests",
  promptTokens: "promptTokens",
  cachedTokens: "cachedTokens",
  completionTokens: "completionTokens",
  totalTokens: "totalTokens",
  inputCost: "inputCost",
  cachedCost: "cachedCost",
  outputCost: "outputCost",
  cost: "cost",
  totalCost: "cost",
};

// Sort groups by their SUMMARY values (not by first-seen insertion order),
// so "sort by total tokens/cost" actually orders the group rows.
function sortGroups(groups, sortBy, sortOrder) {
  const dir = sortOrder === "asc" ? 1 : -1;
  const numField = GROUP_SUMMARY_NUMERIC[sortBy];
  return [...groups].sort((a, b) => {
    if (numField) {
      return ((a.summary[numField] || 0) - (b.summary[numField] || 0)) * dir;
    }
    if (sortBy === "lastUsed") {
      const ta = a.summary.lastUsed ? new Date(a.summary.lastUsed).getTime() : -1;
      const tb = b.summary.lastUsed ? new Date(b.summary.lastUsed).getTime() : -1;
      return (ta - tb) * dir;
    }
    const la = String(a.label || a.groupKey || "").toLowerCase();
    const lb = String(b.label || b.groupKey || "").toLowerCase();
    if (la < lb) return -1 * dir;
    if (la > lb) return 1 * dir;
    return 0;
  });
}

const MODEL_COLUMNS = [
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ACCOUNT_COLUMNS = [
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "accountName", label: "Account" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const API_KEY_COLUMNS = [
  { field: "keyName", label: "API Key Name" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ENDPOINT_COLUMNS = [
  { field: "endpoint", label: "Endpoint" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const TABLE_OPTIONS = [
  { value: "model", label: "Usage by Model" },
  { value: "account", label: "Usage by Account" },
  { value: "apiKey", label: "Usage by API Key" },
  { value: "endpoint", label: "Usage by Endpoint" },
];

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

export default function UsageStats({ period: periodProp, setPeriod: setPeriodProp, hidePeriodSelector = false } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  // "Usage by ..." remembers the last choice across refreshes (localStorage).
  // Fresh visitors default to apiKey.
  const [tableView, setTableView] = useState(() => {
    try {
      if (typeof localStorage === "undefined") return "apiKey";
      const saved = localStorage.getItem("usage-stats:table-view");
      return TABLE_OPTIONS.some((o) => o.value === saved) ? saved : "apiKey";
    } catch (e) {
      return "apiKey";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("usage-stats:table-view", tableView);
    } catch (e) {
      console.error("Failed to save usage-stats:table-view:", e);
    }
  }, [tableView]);
  const [viewMode, setViewMode] = useState("tokens");
  const [providers, setProviders] = useState([]);
  const [periodLocal, setPeriodLocal] = useState("today");
  const isInitialLoad = useRef(true);
  const hasLoadedStats = useRef(false);
  const period = periodProp ?? periodLocal;
  const setPeriod = setPeriodProp ?? setPeriodLocal;

  // Sort defaults follow the active tab: biggest usage first.
  const sortBy = searchParams.get("sortBy") || (viewMode === "tokens" ? "totalTokens" : "cost");
  const sortOrder = searchParams.get("sortOrder") || "desc";

  // When the table view or tokens/costs tab changes, a sortBy from the other
  // context is meaningless (e.g. totalTokens while looking at costs, or
  // keyName while looking at models) — reset to that context's default so
  // the table never looks "ngaco".
  const BASE_SORT_FIELDS = {
    model: ["rawModel", "provider", "requests", "lastUsed"],
    account: ["rawModel", "provider", "accountName", "requests", "lastUsed"],
    apiKey: ["keyName", "apiKeyKey", "rawModel", "provider", "requests", "lastUsed"],
    endpoint: ["endpoint", "rawModel", "provider", "requests", "lastUsed"],
  };
  const MODE_SORT_FIELDS = {
    tokens: ["promptTokens", "cachedTokens", "completionTokens", "totalTokens"],
    costs: ["inputCost", "cachedCost", "outputCost", "cost", "totalCost"],
  };
  useEffect(() => {
    const valid = new Set([...(BASE_SORT_FIELDS[tableView] || []), ...(MODE_SORT_FIELDS[viewMode] || [])]);
    const currentSortBy = searchParams.get("sortBy");
    if (currentSortBy && !valid.has(currentSortBy)) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("sortBy", viewMode === "tokens" ? "totalTokens" : "cost");
      params.set("sortOrder", "desc");
      router.replace(`?${params.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableView, viewMode]);

  // Fetch connected providers once, deduplicate by provider type
  // Always include noAuth free providers (e.g. opencode) regardless of connections
  useEffect(() => {
    Promise.all([
      fetch("/api/providers").then((r) => r.ok ? r.json() : null),
      fetch("/api/provider-nodes").then((r) => r.ok ? r.json() : null),
    ])
      .then(([d, nodesData]) => {
        // Build node name lookup for custom providers
        const nodeNameMap = {};
        for (const node of (nodesData?.nodes || [])) {
          nodeNameMap[node.id] = node.name;
        }
        const seen = new Set();
        const unique = (d?.connections || []).filter((c) => {
          if (c.isActive === false) return false;
          if (!isLLMProvider(c.provider)) return false;
          if (seen.has(c.provider)) return false;
          seen.add(c.provider);
          return true;
        }).map((c) => ({
          ...c,
          nodeName: nodeNameMap[c.provider] || null,
        }));
        const noAuthProviders = Object.values(FREE_PROVIDERS)
          .filter((p) => p.noAuth && !seen.has(p.id) && isLLMProvider(p.id))
          .map((p) => ({ provider: p.id, name: p.name }));
        setProviders([...unique, ...noAuthProviders]);
      })
      .catch(() => {});
  }, []);

  // Fetch filtered stats via REST when period changes
  useEffect(() => {
    // First load: show full spinner; subsequent: show subtle fetching indicator
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      setLoading(true);
    } else {
      setFetching(true);
    }

    fetch(`/api/usage/stats?period=${period}${tzQueryParam()}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          hasLoadedStats.current = true;
          setStats((prev) => ({ ...prev, ...data }));
        }
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setFetching(false);
      });
  }, [period]);

  // SSE connection - real-time updates for activeRequests + recentRequests only
  useEffect(() => {
    const es = new EventSource("/api/usage/stream");

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Always merge only real-time fields, never overwrite full stats from REST
        setStats((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeRequests: data.activeRequests,
            activeByApiKey: data.activeByApiKey,
            recentRequests: data.recentRequests,
            errorProvider: data.errorProvider,
            pending: data.pending,
          };
        });
        if (hasLoadedStats.current) setLoading(false);
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };

    es.onerror = () => setLoading(false);

    return () => es.close();
  }, []);

  const toggleSort = useCallback((tableType, field) => {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get("sortBy") === field) {
      params.set("sortOrder", params.get("sortOrder") === "asc" ? "desc" : "asc");
    } else {
      params.set("sortBy", field);
      params.set("sortOrder", "asc");
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  // Compute active table data
  const activeTableConfig = useMemo(() => {
    if (!stats) return null;
    switch (tableView) {
      case "model": {
        const pendingMap = stats.pending?.byModel || {};
        return {
          columns: MODEL_COLUMNS,
          groupedData: sortGroups(groupDataByKey(sortData(stats.byModel, pendingMap, sortBy, sortOrder), "rawModel"), sortBy, sortOrder),
          storageKey: "usage-stats:expanded-models",
          emptyMessage: "No usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "account": {
        const pendingMap = {};
        if (stats?.pending?.byAccount) {
          Object.entries(stats.byAccount || {}).forEach(([accountKey, data]) => {
            const connPending = stats.pending.byAccount[data.connectionId];
            if (connPending) {
              const modelKey = data.provider ? `${data.rawModel} (${data.provider})` : data.rawModel;
              pendingMap[accountKey] = connPending[modelKey] || 0;
            }
          });
        }
        return {
          columns: ACCOUNT_COLUMNS,
          groupedData: sortGroups(groupDataByKey(sortData(stats.byAccount, pendingMap, sortBy, sortOrder), "accountName"), sortBy, sortOrder),
          storageKey: "usage-stats:expanded-accounts",
          emptyMessage: "No account-specific usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.accountName || `Account ${item.connectionId?.slice(0, 8)}...`}</td>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "apiKey": {
        return {
          columns: API_KEY_COLUMNS,
          groupedData: sortGroups(groupDataByKey(sortData(stats.byApiKey, {}, sortBy, sortOrder), "keyId", "keyName"), sortBy, sortOrder),
          storageKey: "usage-stats:expanded-apikeys",
          emptyMessage: "No API key usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium">{item.keyName}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant="neutral" size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "endpoint":
      default: {
        return {
          columns: ENDPOINT_COLUMNS,
          groupedData: sortGroups(groupDataByKey(sortData(stats.byEndpoint, {}, sortBy, sortOrder), "endpoint"), sortBy, sortOrder),
          storageKey: "usage-stats:expanded-endpoints",
          emptyMessage: "No endpoint usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium font-mono text-sm">{item.endpoint}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant="neutral" size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
    }
  }, [stats, tableView, sortBy, sortOrder]);

  if (!stats && !loading) return <div className="text-text-muted">Failed to load usage statistics.</div>;

  const spinner = (
    <div className="flex items-center justify-center py-12 text-text-muted">
      <span className="material-symbols-outlined text-[32px] animate-spin">progress_activity</span>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Period selector (hidden when controlled by parent) */}
      {!hidePeriodSelector && (
        <div className="flex w-full items-center gap-2 sm:w-auto sm:self-end">
          <div className="grid flex-1 grid-cols-5 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex sm:flex-none">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                disabled={fetching}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${period === p.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {fetching && (
            <span className="material-symbols-outlined text-[16px] text-text-muted animate-spin">progress_activity</span>
          )}
        </div>
      )}

      {/* Overview cards */}
      {loading ? spinner : <OverviewCards stats={stats} />}

      {/* Provider topology + Recent Requests */}
      {loading ? spinner : (
        <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <ProviderTopology
            providers={providers}
            activeRequests={stats.activeRequests || []}
            lastProvider={stats.recentRequests?.[0]?.provider || ""}
            errorProvider={stats.errorProvider || ""}
          />
          <RecentRequests requests={stats.recentRequests || []} />
        </div>
      )}

      {/* Token / Cost chart - sync period */}
      {loading ? spinner : <UsageChart period={period} />}

      {/* Live per-API-key presence (SSE-driven) */}
      {loading ? spinner : <ActiveApiKeys active={stats.activeByApiKey || []} />}

      {/* Table with dropdown selector */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <select
            value={tableView}
            onChange={(e) => setTableView(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 sm:w-auto"
            style={{ colorScheme: 'auto' }}
          >
            {TABLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex">
            <button
              onClick={() => setViewMode("tokens")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Tokens
            </button>
            <button
              onClick={() => setViewMode("costs")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "costs" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Costs
            </button>
          </div>
        </div>
        {loading ? spinner : activeTableConfig && (
          <UsageTable
            title=""
            columns={activeTableConfig.columns}
            groupedData={activeTableConfig.groupedData}
            tableType={tableView}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onToggleSort={toggleSort}
            viewMode={viewMode}
            storageKey={activeTableConfig.storageKey}
            renderSummaryCells={activeTableConfig.renderSummaryCells}
            renderDetailCells={activeTableConfig.renderDetailCells}
            emptyMessage={activeTableConfig.emptyMessage}
          />
        )}
      </div>
    </div>
  );
}
