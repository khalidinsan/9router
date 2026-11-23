import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { cookies } from "next/headers";
import { getBranding } from "@/lib/branding";
import { getUsageStats, getChartData } from "@/lib/usageDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";

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
// Same wording as the dashboard's timeAgo(), but this module is a server
// component and shared/utils/datetime.js is a client module.
const ago = (timestamp) => {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return "Never";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return `${Math.max(0, diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

const tokensOf = (row) => (row?.promptTokens || 0) + (row?.completionTokens || 0);

function rankRows(map, limit = 8) {
  return Object.entries(map || {})
    // The map key is the only identity for provider buckets, so keep it.
    .map(([name, row]) => ({ ...row, name, totalTokens: tokensOf(row) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);
}

// Icons live in /public/providers; check the file so a missing logo falls back
// to the brand initials instead of a broken image.
function providerIconFile(providerId) {
  const known = String(providerId || "").startsWith("openai-compatible-") ? "openai" : providerId;
  const src = getProviderIconSrc(known);
  if (!src) return null;
  try {
    return fs.existsSync(path.join(process.cwd(), "public", src)) ? src : null;
  } catch {
    return null;
  }
}

function ProviderMark({ providerId }) {
  const config = AI_PROVIDERS[providerId] || {};
  const src = providerIconFile(providerId);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="size-5 shrink-0 rounded object-contain"
        loading="lazy"
      />
    );
  }
  const initials = config.textIcon || (providerId || "?").slice(0, 2).toUpperCase();
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-bold"
      style={{ backgroundColor: `${config.color || "#6b7280"}22`, color: config.color || "#9ca3af" }}
    >
      {initials}
    </span>
  );
}

function Panel({ title, hint, children, className = "" }) {
  return (
    <section
      className={`rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-4 sm:p-5 ${className}`}
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">{title}</h2>
        {hint ? <span className="text-[11px] text-white/30">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 backdrop-blur-sm">
      <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</p>
      {sub ? <p className="mt-1 text-[11px] text-white/35">{sub}</p> : null}
    </div>
  );
}

function UsageChart({ buckets = [] }) {
  const rows = buckets || [];
  if (!rows.length) {
    return <p className="text-sm text-white/40">No traffic yet.</p>;
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

  return (
    <svg viewBox={`0 0 ${width} ${height + 22}`} className="h-auto w-full" role="img" aria-label="Tokens per bucket">
      {ticks.map((y, i) => (
        <g key={i}>
          <line x1={padX} x2={width - padX} y1={y} y2={y} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          <text x={width - padX} y={y - 4} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.3)">
            {TOKEN(Math.round(maxTokens * (i / 2)))}
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
              opacity="0.9"
            >
              <title>{`${row.label}: ${TOKEN(row.tokens)} tokens · ${NUM(row.requests)} req · ${MONEY(row.cost)}`}</title>
            </rect>
            {i % labelEvery === 0 ? (
              <text x={x + barWidth / 2} y={height + 14} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.3)">
                {row.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function RankList({ rows, grouped, empty, showProvider }) {
  if (!rows.length) return <p className="text-sm text-white/40">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.totalTokens));

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => {
        const providerId = showProvider ? row.provider || row.name : row.name;
        return (
          <li key={`${grouped}-${row.name}`} className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderMark providerId={providerId} />
              <span className="min-w-0 flex-1 truncate text-sm text-white/85" title={row.rawModel || row.name}>
                {row.rawModel || row.name || row.keyName}
                {showProvider && row.rawModel && row.provider ? (
                  <span className="text-white/35"> · {row.provider}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-white/35">
                {TOKEN(row.totalTokens)} · {NUM(row.requests)} req
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, (row.totalTokens / max) * 100)}%`,
                  background: "var(--color-primary)",
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default async function IndexPage({ searchParams }) {
  const params = await searchParams;
  const period = PERIODS.some((p) => p.value === params?.period) ? params.period : "today";

  const cookieStore = await cookies();
  const authed = await verifyDashboardAuthToken(cookieStore.get("auth_token")?.value);

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
    .map((row) => ({ ...row, name: row.keyName, totalTokens: tokensOf(row) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8);

  const activeKeys = stats.activeByApiKey || [];
  const activeCount = activeKeys.reduce((sum, k) => sum + (k.count || 0), 0);
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  const recent = stats.recentRequests || [];
  const periodLabel = PERIODS.find((p) => p.value === period)?.label || period;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#181411] font-sans text-white antialiased selection:bg-[var(--color-primary)] selection:text-white">
      {/* Landing-style backdrop: grid, glow orbs, vignette */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--color-primary) 1px, transparent 1px), linear-gradient(to bottom, var(--color-primary) 1px, transparent 1px)",
            backgroundSize: "50px 50px",
          }}
        />
        <div className="absolute -top-40 left-1/4 h-[600px] w-[600px] rounded-full bg-[var(--color-primary)]/12 blur-[130px]" />
        <div className="absolute bottom-0 right-1/4 h-[520px] w-[520px] rounded-full bg-purple-500/10 blur-[130px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(24,20,17,0.55)_100%)]" />
      </div>

      <div className="relative z-10 mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.name} className="h-9 w-auto object-contain" />
            ) : (
              <div className="flex size-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700">
                <span className="material-symbols-outlined text-[20px] text-white">hub</span>
              </div>
            )}
            <span className="min-w-0">
              <span className="block truncate text-lg font-semibold">{branding.name}</span>
              <span className="block text-[11px] text-white/35">{branding.tagline}</span>
            </span>
          </Link>
          <nav className="flex items-center gap-2">
            {authed ? (
              <Link
                href="/dashboard"
                className="rounded-lg bg-[var(--color-primary)] px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Dashboard
              </Link>
            ) : (
              <Link
                href="/login"
                className="rounded-lg bg-[var(--color-primary)] px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Login
              </Link>
            )}
          </nav>
        </header>

        <div className="flex flex-col gap-2">
          <h1 className="bg-gradient-to-r from-white to-white/40 bg-clip-text text-3xl font-black tracking-tight text-transparent sm:text-4xl">
            Live usage
          </h1>
          <p className="max-w-2xl text-sm text-white/45">
            Requests, tokens and routing activity across every provider and API key — read-only.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((p) => (
            <Link
              key={p.value}
              href={`/?period=${p.value}`}
              scroll={false}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                p.value === period
                  ? "bg-[var(--color-primary)] text-white"
                  : "border border-white/10 text-white/50 hover:text-white"
              }`}
            >
              {p.label}
            </Link>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-white/35">
            <span
              className={`size-1.5 rounded-full ${activeCount > 0 ? "bg-emerald-400" : "bg-white/25"}`}
            />
            {activeCount > 0 ? `${activeCount} in flight` : "idle"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Kpi label="Requests" value={NUM(stats.totalRequests)} sub={periodLabel} />
          <Kpi label="Prompt tokens" value={TOKEN(stats.totalPromptTokens)} sub={`${TOKEN(stats.totalCachedTokens)} cached`} />
          <Kpi label="Completion tokens" value={TOKEN(stats.totalCompletionTokens)} sub={`${TOKEN(totalTokens)} total`} />
          <Kpi label="Cost" value={MONEY(stats.totalCost)} sub="estimated" />
          <Kpi label="Active sessions" value={NUM(activeCount)} sub={`${activeKeys.length} key(s) live`} />
        </div>

        <Panel title="Usage over time" hint="tokens per bucket">
          <UsageChart buckets={chart} />
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title="Top models" hint={`${Object.keys(stats.byModel || {}).length} total`}>
            <RankList rows={models} grouped="model" empty="No model traffic yet." showProvider />
          </Panel>
          <Panel title="Top API keys" hint={`${keyTotals.size} total`}>
            <RankList rows={apiKeys} grouped="key" empty="No API-key traffic yet." />
          </Panel>
          <Panel title="Top providers" hint={`${Object.keys(stats.byProvider || {}).length} total`}>
            <RankList rows={providers} grouped="provider" empty="No provider traffic yet." showProvider />
          </Panel>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Active sessions" hint={activeCount > 0 ? `${activeCount} in flight` : "idle"}>
            {activeKeys.length ? (
              <ul className="flex flex-col gap-2.5">
                {activeKeys.slice(0, 10).map((key) => (
                  <li key={key.keyName} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-white/85" title={key.keyName}>
                        {key.keyName}
                      </p>
                      <p className="truncate text-[11px] text-white/35">
                        {(key.models || []).map((m) => `${m.model}${m.count > 1 ? ` ×${m.count}` : ""}`).join(", ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-white/40">×{key.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-white/40">Nothing in flight right now.</p>
            )}
          </Panel>

          <Panel title="Recent requests" hint={`last ${recent.length}`}>
            {recent.length ? (
              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-[#181411]">
                    <tr className="border-b border-white/10 text-white/35">
                      <th className="py-1.5 text-left font-semibold">Status</th>
                      <th className="py-1.5 text-left font-semibold">Model</th>
                      <th className="py-1.5 text-right font-semibold">In / Out</th>
                      <th className="py-1.5 text-right font-semibold">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {recent.map((row, i) => {
                      const ok = !row.status || row.status === "ok" || row.status === "success";
                      return (
                        <tr key={`${row.timestamp}-${i}`}>
                          <td className="py-1.5">
                            <span className={`block size-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
                          </td>
                          <td className="max-w-[150px] truncate py-1.5 font-mono text-white/75" title={row.model}>
                            {row.model}
                          </td>
                          <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-white/65">
                            {TOKEN(row.promptTokens)}↑ {TOKEN(row.completionTokens)}↓
                          </td>
                          <td className="whitespace-nowrap py-1.5 text-right text-white/35">
                            {row.timestamp ? ago(row.timestamp) : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-white/40">No requests recorded yet.</p>
            )}
          </Panel>
        </div>

        <footer className="pt-2 text-center text-[11px] text-white/25">
          {branding.name} · usage data is read-only on this page
        </footer>
      </div>
    </div>
  );
}
