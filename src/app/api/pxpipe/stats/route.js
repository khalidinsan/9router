import { NextResponse } from "next/server";
import { getPxpipeStats } from "@/lib/pxpipe/events.js";
import { getQueryTimeZone } from "@/lib/tz";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const recentLimit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    // Client IANA zone (e.g. ?tz=Asia/Jakarta): day windows follow it.
    const { timeZone, error: tzError } = getQueryTimeZone(searchParams);
    if (tzError) {
      return NextResponse.json({ error: tzError }, { status: 400 });
    }
    return NextResponse.json(getPxpipeStats({ recentLimit, timeZone }));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
