"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import Card from "@/shared/components/Card";
import { tzCaption, tzQueryParam, useClientTimeZone } from "@/shared/utils/datetime";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

// Stable per-series colors (hashed from series name so colors don't jump
// between refetches when totals reorder).
const PALETTE = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6",
  "#06b6d4", "#f97316", "#ec4899", "#84cc16", "#14b8a6", "#eab308",
];
function colorFor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export default function UsageChart({ period = "7d" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("tokens");
  // Client time zone: the API buckets the chart in it, so "today" starts at
  // the viewer's midnight, not the server's (UTC).
  const clientTz = useClientTimeZone();
  const caption = tzCaption(clientTz);
  // "total" = one global line, "byKey" = one line per API key (persisted).
  const [split, setSplit] = useState(() => {
    try {
      if (typeof localStorage === "undefined") return "total";
      const saved = localStorage.getItem("usage-chart:split");
      return saved === "byKey" ? "byKey" : "total";
    } catch (e) {
      return "total";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("usage-chart:split", split);
    } catch (e) {
      console.error("Failed to save usage-chart:split:", e);
    }
  }, [split]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/chart?period=${period}${split === "byKey" ? "&by=apiKey" : ""}${tzQueryParam()}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.error("Failed to fetch chart data:", e);
    } finally {
      setLoading(false);
    }
  }, [period, split]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount/param-change (same pre-existing pattern as RequestDetailsTab/UsageTable)
    fetchData();
  }, [fetchData]);

  const isSplit = split === "byKey";
  const seriesList = useMemo(
    () => (isSplit && data && Array.isArray(data.series) ? data.series : []),
    [isSplit, data]
  );

  // recharts rows: one per bucket, one field per series key.
  const rows = useMemo(() => {
    if (!isSplit) return Array.isArray(data) ? data : [];
    if (!data || !Array.isArray(data.labels)) return [];
    return data.labels.map((label, i) => {
      const row = { label };
      for (const s of seriesList) {
        row[s.key] = viewMode === "tokens" ? (s.tokens[i] || 0) : (s.cost[i] || 0);
      }
      return row;
    });
  }, [data, isSplit, seriesList, viewMode]);

  const hasData = isSplit
    ? seriesList.length > 0 && rows.some((r) => seriesList.some((s) => (r[s.key] || 0) > 0))
    : rows.some((d) => d.tokens > 0 || d.cost > 0);

  const tooltipFormatter = (value, name) =>
    viewMode === "tokens" ? [fmtTokens(value), name] : [fmtCost(value), name];

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid w-full grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:w-auto">
          <button
            onClick={() => setViewMode("tokens")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Tokens
          </button>
          <button
            onClick={() => setViewMode("cost")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "cost" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Cost
          </button>
        </div>
        <div className="grid w-full grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:w-auto">
          <button
            onClick={() => setSplit("total")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${split === "total" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Total
          </button>
          <button
            onClick={() => setSplit("byKey")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${split === "byKey" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            By API Key
          </button>
        </div>
      </div>
      {caption && (
        <div className="-mt-1 text-[11px] text-text-muted sm:self-end">Timezone: {caption}</div>
      )}

      {loading ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">Loading...</div>
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">No data for this period</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={viewMode === "tokens" ? fmtTokens : fmtCost}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={
                isSplit
                  ? tooltipFormatter
                  : (value, name) =>
                      name === "tokens" ? [fmtTokens(value), "Tokens"] : [fmtCost(value), "Cost"]
              }
            />
            {isSplit && <Legend wrapperStyle={{ fontSize: "12px" }} />}
            {!isSplit && viewMode === "tokens" && (
              <Area
                type="monotone"
                dataKey="tokens"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#gradTokens)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {!isSplit && viewMode !== "tokens" && (
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#f59e0b"
                strokeWidth={2}
                fill="url(#gradCost)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {isSplit &&
              seriesList.map((s) => {
                const color = colorFor(s.name);
                return (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.name}
                    stroke={color}
                    strokeWidth={2}
                    fill={color}
                    fillOpacity={0.12}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                );
              })}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  period: PropTypes.string,
};
