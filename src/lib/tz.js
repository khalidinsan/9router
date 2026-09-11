// Central server-side time-zone helpers.
//
// The server runs in UTC but dashboard viewers may be anywhere (e.g. WIB =
// UTC+7). Anything user-facing that depends on wall-clock days MUST go
// through here with the client's IANA zone — never server-local Date
// methods (getHours/setHours/toLocaleString without timeZone, ...).

const tzFormatterCache = new Map();

function tzPartsFormatter(timeZone) {
  let f = tzFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    tzFormatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tzFormatterCache.has(tz) || !!tzPartsFormatter(tz);
  } catch {
    return false;
  }
}

export function resolveTimeZone(tz) {
  return isValidTimeZone(tz) ? tz : undefined;
}

// Whole-minute offset of tz wall clock vs UTC at instant ts (DST-safe).
export function tzOffsetMs(timeZone, ts) {
  const parts = {};
  for (const p of tzPartsFormatter(timeZone).formatToParts(new Date(ts))) parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour % 24), +parts.minute, +parts.second);
  return Math.round((asUTC - ts) / 60000) * 60000;
}

// UTC ms of the tz-local midnight starting the tz-day that contains ts.
export function startOfDayInTz(timeZone, ts) {
  const off = tzOffsetMs(timeZone, ts);
  const wall = new Date(ts + off);
  const midnightWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  let start = midnightWall - off;
  // DST safety: re-derive offset at the result, adjust once.
  const off2 = tzOffsetMs(timeZone, start + 3600000);
  if (off2 !== off) start = midnightWall - off2;
  return start;
}

// "YYYY-MM-DD" calendar day of ts in tz.
export function dayKeyInTz(timeZone, ts) {
  const w = new Date(ts + tzOffsetMs(timeZone, ts));
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}-${String(w.getUTCDate()).padStart(2, "0")}`;
}

// Absolute bucket edges for a chart/stats period in tz (N buckets → N+1 edges).
export function buildChartEdges(period, timeZone, now) {
  if (period === "today" || period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startTime = period === "today" ? startOfDayInTz(timeZone, now) : now - bucketCount * bucketMs;
    const edges = Array.from({ length: bucketCount + 1 }, (_, i) => startTime + i * bucketMs);
    const labels = edges.slice(0, bucketCount).map((ts) =>
      new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }));
    return { labels, edges, bucketCount };
  }
  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const startOfToday = startOfDayInTz(timeZone, now);
  const labels = [];
  const edges = [];
  // Buckets = last N tz-days including today: bucket i covers
  // [start of (today-(N-1-i)), start of next day).
  for (let i = 0; i <= bucketCount; i++) {
    // noon-ish of the target day: immune to midnight DST ambiguity
    const probe = startOfToday - (bucketCount - 1 - i) * 86400000 + 43200000;
    const edge = startOfDayInTz(timeZone, probe);
    edges.push(edge);
    if (i < bucketCount) {
      labels.push(new Date(edge).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }));
    }
  }
  return { labels, edges, bucketCount };
}

// Route helper for ?tz=Asia/Jakarta → { timeZone } or { error } (→ 400).
export function getQueryTimeZone(searchParams) {
  const tzParam = searchParams.get("tz") || "";
  if (!tzParam) return { timeZone: undefined };
  if (!isValidTimeZone(tzParam)) {
    return { error: "Invalid tz (expected IANA name, e.g. Asia/Jakarta)" };
  }
  return { timeZone: tzParam };
}
