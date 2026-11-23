import Link from "next/link";
import { getBranding } from "@/lib/branding";
import { getUsageStats, getChartData } from "@/lib/usageDb";

// Public landing page: a read-only usage board. It reads the same aggregates the
// dashboard uses, so it needs the same dynamic rendering (no static snapshot).
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const branding = await getBranding();
  return {
    title: `${branding.name} - Usage`,
    description: `${branding.name} live request, token and model usage.`,
    icons: { icon: branding.faviconUrl || "/favicon.svg" },
  };
}

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

const TOKEN = (n) => {
  const value = Number(n) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
};
const MONEY = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const NUM = (n) => (Number(n) || 0).toLocaleString("en-US");

const tokensOf = (row) => (row?.promptTokens || 0) + (row?.completionTokens || 0);

function rankRows(map, limit = 8) {
  return Object.entries(map || {})
    // The map key is the only identity for provider buckets, so keep it.
    .map(([name, row]) => ({ ...row, name, totalTokens: tokensOf(row) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);
}

function Panel({ title, hint, children }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
        {hint ? <span className="text-xs text-text-muted">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-main tabular-nums">{value}</p>
      {sub ? <p className="text-xs text-text-muted mt-1">{sub}</p> : null}
    </div>
  );
}

function UsageChart({ buckets = [] }) {
  const rows = buckets || [];
  if (!rows.length) {
    return <p className="text-sm text-text-muted">No traffic yet.</p>;
  }

  const width = 760;
  const height = 190;
  const padX = 8;
  const padY = 18;
  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens || 0));
  const barSlot = (width - padX * 2) / rows.length;
  const barWidth = Math.max(2, Math.min(28, barSlot * 0.62));
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));
  const ticks = [0, 0.5, 1].map((f) => padY + (height - padY * 2) * (1 - f));
  const tickValues = [0, 0.5, 1].map((f) => Math.round(maxTokens * f));

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height + 22}`}
        className="w-full h-auto"
        role="img"
        aria-label="Tokens per bucket"
      >
        {ticks.map((y, i) => (
          <g key={i}>
            <line x1={padX} x2={width - padX} y1={y} y2={y} stroke="var(--color-border)" strokeWidth="1" />
            <text x={width - padX} y={y - 4} textAnchor="end" fontSize="9" fill="var(--color-text-muted)">
              {TOKEN(tickValues[i])}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          const h = ((row.tokens || 0) / maxTokens) * (height - padY * 2);
          const x = padX + i * barSlot + (barSlot - barWidth) / 2;
          const y = height - padY - h;
          return (
            <g key={`${row.label}-${i}`}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(h, row.tokens > 0 ? 2 : 0)}
                rx="2"
                fill="var(--color-primary)"
                opacity="0.85"
              >
                <title>{`${row.label}: ${TOKEN(row.tokens)} tokens · ${NUM(row.requests)} req · ${MONEY(row.cost)}`}</title>
              </rect>
              {i % labelEvery === 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={height + 14}
                  textAnchor="middle"
                  fontSize="9"
                  fill="var(--color-text-muted)"
                >
                  {row.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RankList({ rows, grouped, empty }) {
  if (!rows.length) return <p className="text-sm text-text-muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.totalTokens));

  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <li key={`${grouped}-${row.name}`} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 min-w-0">
            <span className="truncate text-sm text-text-main" title={row.rawModel || row.name}>
              {row.rawModel || row.name || row.keyName}
              {row.rawModel && row.provider ? <span className="text-text-muted"> · {row.provider}</span> : null}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-text-muted">
              {TOKEN(row.totalTokens)} tok · {NUM(row.requests)} req
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-border/60 overflow-hidden">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max(2, (row.totalTokens / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function IndexPage({ searchParams }) {
  const params = await searchParams;
  const period = PERIODS.some((p) => p.value === params?.period) ? params.period : "today";

  const branding = await getBranding();
  const [stats, chart] = await Promise.all([getUsageStats(period), getChartData(period)]);

  const models = rankRows(stats.byModel);
  const providers = rankRows(stats.byProvider);

  // The aggregate map is per (key, model, provider); the board ranks keys alone.
  const keyTotals = new Map();
  for (const row of Object.values(stats.byApiKey || {})) {
    const name = row.keyName || "Unknown key";
    const prev = keyTotals.get(name) || { keyName: name, requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    prev.requests += row.requests || 0;
    prev.promptTokens += row.promptTokens || 0;
    prev.completionTokens += row.completionTokens || 0;
    prev.cost += row.cost || 0;
    keyTotals.set(name, prev);
  }
  const apiKeys = [...keyTotals.values()]
    .map((row) => ({ ...row, totalTokens: tokensOf(row) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8);

  const activeKeys = stats.activeByApiKey || [];
  const activeCount = activeKeys.reduce((sum, k) => sum + (k.count || 0), 0);
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  const recent = stats.recentRequests || [];

  return (
    <main className="min-h-screen bg-bg text-text-main">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 flex flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.name} className="h-9 w-auto object-contain" />
            ) : (
              <div className="flex size-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700">
                <span className="material-symbols-outlined text-white text-[20px]">hub</span>
              </div>
            )}
            <div className="min-w-0">
              <h1 className="text-lg font-semibold truncate">{branding.name}</h1>
              <p className="text-xs text-text-muted">
                Live usage · {branding.tagline}
              </p>
            </div>
          </div>
          <nav className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-primary/60 transition-colors"
            >
              Dashboard
            </Link>
            <Link
              href="/login"
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover transition-colors"
            >
              Login
            </Link>
          </nav>
        </header>

        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((p) => (
            <Link
              key={p.value}
              href={`/?period=${p.value}`}
              scroll={false}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                p.value === period
                  ? "bg-primary text-white"
                  : "border border-border text-text-muted hover:text-text-main"
              }`}
            >
              {p.label}
            </Link>
          ))}
          <span className="ml-auto text-xs text-text-muted">
            {activeCount > 0 ? `${activeCount} request(s) in flight` : "idle"}
          </span>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Kpi label="Requests" value={NUM(stats.totalRequests)} sub={`${PERIODS.find((p) => p.value === period)?.label}`} />
          <Kpi label="Prompt tokens" value={TOKEN(stats.totalPromptTokens)} sub={`${TOKEN(stats.totalCachedTokens)} cached`} />
          <Kpi label="Completion tokens" value={TOKEN(stats.totalCompletionTokens)} sub={`${TOKEN(totalTokens)} total`} />
          <Kpi label="Cost" value={MONEY(stats.totalCost)} sub="estimated" />
          <Kpi label="Active sessions" value={NUM(activeCount)} sub={`${activeKeys.length} key(s) live`} />
        </div>

        <Panel title="Usage over time" hint="tokens per bucket">
          <UsageChart buckets={chart} />
        </Panel>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Panel title="Top models" hint={`${Object.keys(stats.byModel || {}).length} total`}>
            <RankList rows={models} grouped="model" empty="No model traffic yet." />
          </Panel>
          <Panel title="Top API keys" hint={`${keyTotals.size} total`}>
            <RankList rows={apiKeys} grouped="key" empty="No API-key traffic yet." />
          </Panel>
          <Panel title="Top providers" hint={`${Object.keys(stats.byProvider || {}).length} total`}>
            <RankList rows={providers} grouped="provider" empty="No provider traffic yet." />
          </Panel>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Active sessions" hint={activeCount > 0 ? `${activeCount} in flight` : "idle"}>
            {activeKeys.length ? (
              <ul className="flex flex-col gap-2">
                {activeKeys.slice(0, 10).map((key) => (
                  <li key={key.keyName} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate" title={key.keyName}>{key.keyName}</p>
                      <p className="text-xs text-text-muted truncate">
                        {(key.models || []).map((m) => `${m.model}${m.count > 1 ? ` ×${m.count}` : ""}`).join(", ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-text-muted">×{key.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">Nothing in flight right now.</p>
            )}
          </Panel>

          <Panel title="Recent requests" hint={`last ${recent.length}`}>
            {recent.length ? (
              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-border text-text-muted">
                      <th className="py-1.5 text-left font-semibold">Status</th>
                      <th className="py-1.5 text-left font-semibold">Model</th>
                      <th className="py-1.5 text-right font-semibold">In / Out</th>
                      <th className="py-1.5 text-right font-semibold">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {recent.map((row, i) => {
                      const ok = !row.status || row.status === "ok" || row.status === "success";
                      return (
                        <tr key={`${row.timestamp}-${i}`}>
                          <td className="py-1.5">
                            <span className={`block size-1.5 rounded-full ${ok ? "bg-success" : "bg-error"}`} />
                          </td>
                          <td className="py-1.5 font-mono truncate max-w-[150px]" title={row.model}>
                            {row.model}
                          </td>
                          <td className="py-1.5 text-right whitespace-nowrap tabular-nums">
                            {TOKEN(row.promptTokens)}↑ {TOKEN(row.completionTokens)}↓
                          </td>
                          <td className="py-1.5 text-right whitespace-nowrap text-text-muted">
                            {row.timestamp ? new Date(row.timestamp).toLocaleTimeString("en-GB", { hour12: false }) : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-text-muted">No requests recorded yet.</p>
            )}
          </Panel>
        </div>

        <footer className="pt-2 text-center text-xs text-text-muted">
          {branding.name} · usage data is read-only on this page
        </footer>
      </div>
    </main>
  );
}
