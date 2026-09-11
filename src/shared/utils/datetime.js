"use client";

// Central client-side date/time helpers. ALL dashboard date rendering MUST
// go through here so every displayed date follows the viewer's (client)
// time zone — never server time. Relative times (timeAgo) are tz-independent.

import { useEffect, useState } from "react";

// IANA zone of this browser, e.g. "Asia/Jakarta". "" when unavailable
// (SSR prerender — no dates are rendered there anyway, data loads client-side).
export function getClientTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function useClientTimeZone() {
  const [tz, setTz] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only browser-tz read (same pre-existing pattern as RequestDetailsTab/UsageTable)
    if (!tz) setTz(getClientTimeZone());
  }, [tz]);
  return tz;
}

// "Asia/Jakarta (UTC+07:00)" — caption next to tz-sensitive widgets.
export function tzCaption(tz) {
  const zone = tz || getClientTimeZone();
  if (!zone) return "";
  try {
    const offMin = -new Date().getTimezoneOffset();
    const sign = offMin >= 0 ? "+" : "-";
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${zone} (UTC${sign}${hh}:${mm})`;
  } catch {
    return zone;
  }
}

// Query fragment for API fetches: `/api/x?period=today${tzQueryParam()}`.
// Call at fetch time (always client-side) — no hooks, no extra renders.
export function tzQueryParam() {
  const tz = getClientTimeZone();
  return tz ? `&tz=${encodeURIComponent(tz)}` : "";
}

function withZone(tz, extra) {
  return { ...(extra || {}), ...(tz ? { timeZone: tz } : null) };
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Full date+time, e.g. "11/09/2026, 09:07:16" (browser locale). "" if invalid.
export function formatDateTime(value, tz, locale, opts) {
  const d = toDate(value);
  if (!d) return "";
  return d.toLocaleString(locale, withZone(tz, opts));
}

// Date only. "" if invalid.
export function formatDate(value, tz, locale, opts) {
  const d = toDate(value);
  if (!d) return "";
  return d.toLocaleDateString(locale, withZone(tz, opts));
}

// Time only. "" if invalid.
export function formatTimeOnly(value, tz, locale, opts) {
  const d = toDate(value);
  if (!d) return "";
  return d.toLocaleTimeString(locale, withZone(tz, opts));
}

// Relative time, tz-independent: "45s ago" / "12m ago" / "8h ago" / "3d ago".
export function timeAgo(timestamp) {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return "Never";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return `${Math.max(0, diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Auto-updating relative time without re-rendering the parent.
export function TimeAgo({ timestamp }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return <>{timeAgo(timestamp)}</>;
}

// Server console lines start with an ISO bracket ([2026-09-11T02:11:17.123Z])
// since the logger emits ISO. Rewrite it to client-tz wall time; leave any
// other line untouched (e.g. pre-restart [HH:MM:SS] lines).
const ISO_PREFIX_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]/;
export function formatConsoleLine(line, tz) {
  if (typeof line !== "string") return line;
  const m = line.match(ISO_PREFIX_RE);
  if (!m) return line;
  const d = new Date(m[1]);
  if (!Number.isFinite(d.getTime())) return line;
  const zone = tz || getClientTimeZone() || undefined;
  const t = d.toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    ...(zone ? { timeZone: zone } : null),
  });
  return `[${t}]${line.slice(m[0].length)}`;
}
