import { NextResponse } from "next/server";
import { getChartData, getChartDataByApiKey } from "@/lib/usageDb";
import { getQueryTimeZone } from "@/lib/tz";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);
const VALID_BY = new Set(["apiKey"]);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const by = searchParams.get("by") || "";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    if (by && !VALID_BY.has(by)) {
      return NextResponse.json({ error: "Invalid by (supported: apiKey)" }, { status: 400 });
    }
    // IANA client time zone (e.g. ?tz=Asia/Jakarta): buckets + labels follow it.
    // Absent → server-local legacy behavior.
    const { timeZone, error: tzError } = getQueryTimeZone(searchParams);
    if (tzError) {
      return NextResponse.json({ error: tzError }, { status: 400 });
    }

    const data = by === "apiKey" ? await getChartDataByApiKey(period, timeZone) : await getChartData(period, timeZone);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
