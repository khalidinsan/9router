import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { cookies } from "next/headers";
import { getBranding } from "@/lib/branding";
import { getUsageStats, getChartData } from "@/lib/usageDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";

// Public index: a read-only usage board on a solid, opaque surface. Content is
// the same aggregate the dashboard serves — nothing here is client-side state.
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

const GROUPS = [
  { value: "models", label: "Models" },
  { value: "keys", label: "API keys" },
  { value: "providers", label: "Providers" },
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
const PCT = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");

const tokensOf = (row) => (row?.promptTokens || 0) + (row?.completionTokens || 0);

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

function ProviderMark({ providerId, size = 5 }) {
  const config = AI_PROVIDERS[providerId] || {};
  const src = providerIconFile(providerId);
  const cls = `shrink-0 rounded object-contain ${size === 5 ? "size-5" : "size-4"}`;
  if (src) return <img src={src} alt="" className={cls} loading="lazy" />;
  const initials = config.textIcon || (providerId || "?").slice(0, 2).toUpperCase();
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded text-[9px] font-bold ${size === 5 ? "size-5" : "size-4 text-[8px]"}`}
      style={{ backgroundColor: `${config.color || "#6b7280"}22`, color: config.color || "#9ca3af" }}
    >
      {initials}
    </span>
  );
}

function Panel({ title, hint, children, flush = false }) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#232b36] bg-[#161b22]">
      <div className="flex items-center justify-between gap-3 border-b border-[#232b36] px-5 py-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-gray-500">{title}</h2>
        {hint ? <span className="text-[11px] text-gray-600">{hint}</span> : null}
      </div>
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="min-w-0 rounded-xl border border-[#232b36] bg-[#161b22] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-500">{label}</p>
      <p className="mt-1 truncate text-2xl font-black tabular-nums text-white">{value}</p>
      {sub ? <p className="mt-0.5 truncate text-[11px] text-gray-500">{sub}</p> : null}
    </div>
  );
}

function UsageChart({ buckets = [] }) {
  const rows = buckets || [];
  if (!rows.length) return <p className="text-sm text-gray-500">No traffic yet.</p>;

  const width = 760;
  const height = 170;
  const padX = 8;
  const padY = 16;
  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens || 0));
  const barSlot = (width - padX * 2) / rows.length;
  const barWidth = Math.max(2, Math.min(26, barSlot * 0.6));
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));
  const ticks = [0, 0.5, 1].map((f) => padY + (height - padY * 2) * (1 - f));

  return (
    <svg viewBox={`0 0 ${width} ${height + 20}`} className="h-auto w-full" role="img" aria-label="Tokens per bucket">
      {ticks.map((y, i) => (
        <g key={i}>
          <line x1={padX} x2={width - padX} y1={y} y2={y} stroke="#232b36" strokeWidth="1" strokeDasharray={i === 0 ? "" : "3 5"} />
          <text x={width - padX} y={y - 3} textAnchor="end" fontSize="9" fill="#5b6674">
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
              rx="1.5"
              fill="var(--color-primary)"
              opacity="0.9"
            >
              <title>{`${row.label}: ${TOKEN(row.tokens)} tokens · ${NUM(row.requests)} req · ${MONEY(row.cost)}`}</title>
            </rect>
            {i % labelEvery === 0 ? (
              <text x={x + barWidth / 2} y={height + 12} textAnchor="middle" fontSize="9" fill="#5b6674">
                {row.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// One leaderboard instead of three identical columns. The group is a link, so
// the page still needs no client JavaScript.
function Leaderboard({ rows, group, total }) {
  if (!rows.length) return <p className="p-5 text-sm text-gray-500">Nothing recorded for this period.</p>;
  return (
    <ol>
      {rows.map((row, i) => {
        const share = total > 0 ? row.totalTokens / total : 0;
        const providerId = group === "models" ? row.provider || row.name : row.name;
        const label = group === "keys" ? row.keyName : row.rawModel || row.name;
        const top = i < 3;
        return (
          <li
            key={`${group}-${row.name}`}
            className="flex items-center gap-3 border-b border-[#232b36] px-5 py-2.5 last:border-0 hover:bg-white/[0.02]"
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-black tabular-nums ${
                top ? "bg-[var(--color-primary)] text-[#0f1216]" : "bg-white/[0.06] text-gray-400"
              }`}
            >
              {i + 1}
            </span>
            <ProviderMark providerId={providerId} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm text-gray-100" title={label}>{label}</span>
                <span className="shrink-0 text-xs font-bold tabular-nums text-white">{TOKEN(row.totalTokens)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#232b36]">
                  <div className="h-full" style={{ width: `${Math.max(2, share * 100)}%`, background: "var(--color-primary)" }} />
                </div>
                <span className="w-12 shrink-0 tabular-nums text-right">{PCT(row.totalTokens, total)}</span>
                <span className="shrink-0 tabular-nums">{NUM(row.requests)} req</span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default async function IndexPage({ searchParams }) {
  const params = await searchParams;
  const period = PERIODS.some((p) => p.value === params?.period) ? params.period : "today";
  const group = GROUPS.some((g) => g.value === params?.group) ? params.group : "models";

  const cookieStore = await cookies();
  const authed = await verifyDashboardAuthToken(cookieStore.get("auth_token")?.value);

  const branding = await getBranding();
  const [stats, chart] = await Promise.all([getUsageStats(period), getChartData(period)]);

  const models = rankRows(stats.byModel);
  const providers = rankRows(stats.byProvider);
  const groupTotal = (map) => Object.values(map || {}).reduce((sum, r) => sum + tokensOf(r), 0);

  // The aggregate map is per (key, model, provider); the board ranks keys alone.
  const keyTotals = new Map();
  for (const row of Object.values(stats.byApiKey || {})) {
    const name = row.keyName || "Unknown key";
    const prev = keyTotals.get(name) || { keyName: name, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
    prev.requests += row.requests || 0;
    prev.promptTokens += row.promptTokens || 0;
    prev.completionTokens += row.completionTokens || 0;
    prev.cachedTokens += row.cachedTokens || 0;
    prev.cost += row.cost || 0;
    keyTotals.set(name, prev);
  }
  const apiKeys = [...keyTotals.values()]
    .map((row) => ({ ...row, name: row.keyName, totalTokens: tokensOf(row) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const activeKeys = stats.activeByApiKey || [];
  const activeCount = activeKeys.reduce((sum, k) => sum + (k.count || 0), 0);
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  const recent = stats.recentRequests || [];
  const periodLabel = PERIODS.find((p) => p.value === period)?.label || period;
  const leaderboard = group === "models" ? models : group === "keys" ? apiKeys.slice(0, 8) : providers;
  const leaderboardTotal =
    group === "models" ? groupTotal(stats.byModel) : group === "keys" ? apiKeys.reduce((s, r) => s + r.totalTokens, 0) : groupTotal(stats.byProvider);

  return (
    <div className="min-h-screen bg-[#0f1216] font-sans text-gray-100 antialiased selection:bg-[var(--color-primary)] selection:text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.name} className="h-8 w-auto object-contain" />
            ) : (
              <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--color-primary)]">
                <span className="material-symbols-outlined text-[18px] text-white">hub</span>
              </div>
            )}
            <span className="min-w-0">
              <span className="block truncate text-base font-bold">{branding.name}</span>
              <span className="block text-[10px] uppercase tracking-[0.18em] text-gray-600">Live usage</span>
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-xs font-medium text-gray-400">
            <a href="https://github.com/khalidinsan/9router#readme" target="_blank" rel="noopener noreferrer" className="hidden hover:text-white sm:inline">
              Docs
            </a>
            <Link
              href={authed ? "/dashboard" : "/login"}
              className="rounded-lg px-3.5 py-1.5 text-xs font-bold text-[#0f1216] transition-opacity hover:opacity-90"
              style={{ background: "var(--color-primary)" }}
            >
              {authed ? "Dashboard" : "Login"}
            </Link>
          </nav>
        </header>

        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((p) => (
            <a
              key={p.value}
              href={`/?period=${p.value}&group=${group}`}
              className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                p.value === period
                  ? "text-[#0f1216]"
                  : "border border-[#232b36] text-gray-400 hover:text-white"
              }`}
              style={p.value === period ? { background: "var(--color-primary)" } : undefined}
            >
              {p.label}
            </a>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-gray-500">
            <span className={`size-1.5 rounded-full ${activeCount > 0 ? "bg-emerald-400" : "bg-gray-600"}`} />
            {activeCount > 0 ? `${activeCount} in flight` : "idle"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Kpi label={`Requests · ${periodLabel}`} value={NUM(stats.totalRequests)} sub="all providers" />
          <Kpi label="Prompt tokens" value={TOKEN(stats.totalPromptTokens)} sub={`${TOKEN(stats.totalCachedTokens)} cached`} />
          <Kpi label="Completion tokens" value={TOKEN(stats.totalCompletionTokens)} sub={`${TOKEN(totalTokens)} total`} />
          <Kpi label="Cost" value={MONEY(stats.totalCost)} sub="estimated" />
          <Kpi label="Active sessions" value={NUM(activeCount)} sub={`${activeKeys.length} key(s) live`} />
        </div>

        <Panel title="Usage over time" hint="tokens per bucket">
          <UsageChart buckets={chart} />
        </Panel>

        <Panel
          title="Leaderboard"
          hint={GROUPS.find((g) => g.value === group)?.label}
          flush
        >
          <div className="flex gap-1 border-b border-[#232b36] px-5 pt-3">
            {GROUPS.map((g) => (
              <a
                key={g.value}
                href={`/?period=${period}&group=${g.value}`}
                className={`rounded-t-md px-3 py-1.5 text-xs font-bold transition-colors ${
                  g.value === group
                    ? "border-b-2 border-[var(--color-primary)] text-white"
                    : "text-gray-500 hover:text-gray-200"
                }`}
              >
                {g.label}
              </a>
            ))}
          </div>
          <Leaderboard rows={leaderboard} group={group} total={leaderboardTotal} />
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Active sessions" hint={activeCount > 0 ? `${activeCount} in flight` : "idle"}>
            {activeKeys.length ? (
              <ul className="flex flex-col gap-2.5">
                {activeKeys.slice(0, 10).map((key) => (
                  <li key={key.keyName} className="flex items-start justify-between gap-3 rounded-lg border border-[#232b36] bg-[#12171e] px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-gray-100" title={key.keyName}>{key.keyName}</p>
                      <p className="truncate text-[11px] text-gray-500">
                        {(key.models || []).map((m) => `${m.model}${m.count > 1 ? ` ×${m.count}` : ""}`).join(", ")}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-[var(--color-primary)]/15 px-2 py-0.5 text-[11px] font-bold tabular-nums text-[var(--color-primary)]">
                      ×{key.count}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Nothing in flight right now.</p>
            )}
          </Panel>

          <Panel title="Recent requests" hint={`last ${recent.length}`} flush>
            {recent.length ? (
              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-[#161b22]">
                    <tr className="border-b border-[#232b36] text-gray-500">
                      <th className="py-2 pl-5 text-left font-bold">Status</th>
                      <th className="py-2 text-left font-bold">Model</th>
                      <th className="py-2 text-right font-bold">In / Out</th>
                      <th className="py-2 pr-5 text-right font-bold">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#232b36]/60">
                    {recent.map((row, i) => {
                      const ok = !row.status || row.status === "ok" || row.status === "success";
                      return (
                        <tr key={`${row.timestamp}-${i}`} className="hover:bg-white/[0.02]">
                          <td className="py-2 pl-5">
                            <span className={`block size-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
                          </td>
                          <td className="max-w-[150px] truncate py-2 font-mono text-gray-300" title={`${row.model} · ${row.apiKeyName || ""}`}>
                            <span className="block truncate">{row.model}</span>
                            {row.apiKeyName && (
                              <span className="block truncate font-sans text-[10px] text-gray-500">
                                {row.apiKeyName}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-2 text-right tabular-nums text-gray-400">
                            {TOKEN(row.promptTokens)}↑ {TOKEN(row.completionTokens)}↓
                          </td>
                          <td className="whitespace-nowrap py-2 pr-5 text-right text-gray-500">
                            {row.timestamp ? ago(row.timestamp) : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="p-5 text-sm text-gray-500">No requests recorded yet.</p>
            )}
          </Panel>
        </div>

        <Panel title="Token usage by API key" hint={`${apiKeys.length} key(s) · ${periodLabel}`} flush>
          {apiKeys.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="bg-[#12171e]">
                  <tr className="border-b border-[#232b36] text-gray-500">
                    <th className="py-2 pl-5 text-left font-bold">API key</th>
                    <th className="py-2 text-right font-bold">Requests</th>
                    <th className="py-2 text-right font-bold">Prompt</th>
                    <th className="py-2 text-right font-bold">Completion</th>
                    <th className="py-2 text-right font-bold">Cached</th>
                    <th className="py-2 text-right font-bold">Total</th>
                    <th className="py-2 text-right font-bold">Cost</th>
                    <th className="py-2 pr-5 text-right font-bold">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#232b36]/60">
                  {apiKeys.map((row) => {
                    const share = totalTokens > 0 ? row.totalTokens / totalTokens : 0;
                    return (
                      <tr key={row.keyName} className="hover:bg-white/[0.02]">
                        <td className="max-w-[180px] truncate py-2 pl-5 font-medium text-gray-100" title={row.keyName}>
                          {row.keyName}
                        </td>
                        <td className="py-2 text-right tabular-nums text-gray-400">{NUM(row.requests)}</td>
                        <td className="py-2 text-right tabular-nums text-gray-400">{TOKEN(row.promptTokens)}</td>
                        <td className="py-2 text-right tabular-nums text-gray-400">{TOKEN(row.completionTokens)}</td>
                        <td className="py-2 text-right tabular-nums text-gray-500">{TOKEN(row.cachedTokens)}</td>
                        <td className="py-2 text-right font-bold tabular-nums text-white">{TOKEN(row.totalTokens)}</td>
                        <td className="py-2 text-right tabular-nums text-gray-400">{MONEY(row.cost)}</td>
                        <td className="py-2 pr-5">
                          <div className="flex items-center justify-end gap-2">
                            <div className="h-1 w-16 overflow-hidden rounded-full bg-[#232b36]">
                              <div className="h-full" style={{ width: `${Math.max(2, share * 100)}%`, background: "var(--color-primary)" }} />
                            </div>
                            <span className="w-11 tabular-nums text-right text-gray-400">{PCT(row.totalTokens, totalTokens)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-5 text-sm text-gray-500">No API-key traffic in this period.</p>
          )}
        </Panel>

        <footer className="flex flex-col gap-2 border-t border-[#232b36] pt-4 text-[11px] text-gray-600 sm:flex-row sm:items-center sm:justify-between">
          <span>{branding.name} · read-only</span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>
              Built on{" "}
              <a
                href="https://github.com/decolua/9router"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 underline decoration-dotted underline-offset-2 hover:text-white"
              >
                9Router by decolua
              </a>
            </span>
            <span className="text-gray-700">·</span>
            <span>
              Developed by{" "}
              <a
                href="https://khalid.id"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 underline decoration-dotted underline-offset-2 hover:text-white"
              >
                Khalid Insan
              </a>
            </span>
          </span>
        </footer>
      </div>
    </div>
  );
}
