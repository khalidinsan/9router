import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";
import { getQueryTimeZone } from "@/lib/tz";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const { timeZone, error: tzError } = getQueryTimeZone(searchParams);
    if (tzError) {
      return NextResponse.json({ error: tzError }, { status: 400 });
    }
    const logs = await getRecentLogs(200, timeZone);
    return NextResponse.json(logs);
  } catch (error) {
    console.error("Error fetching logs:", error);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
