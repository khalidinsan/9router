import { NextResponse } from "next/server";
import { getBranding } from "@/lib/branding";

export const dynamic = "force-dynamic";

// Public: the login page and the PWA manifest need the label before auth.
export async function GET() {
  const branding = await getBranding();
  return NextResponse.json(branding, { headers: { "Cache-Control": "no-store" } });
}
