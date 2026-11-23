import fs from "node:fs";
import { NextResponse } from "next/server";
import { readBrandingAsset } from "@/lib/branding";

export const dynamic = "force-dynamic";

// Public: the login page and the installed-app icon load this before auth.
// Only images written by /api/settings/branding-asset live here.
export async function GET(request) {
  const type = request.nextUrl.searchParams.get("type");
  const asset = readBrandingAsset(type);
  if (!asset) {
    return new NextResponse("Not found", { status: 404 });
  }

  let body;
  try {
    body = fs.readFileSync(asset.file);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(body.length),
      // The URL carries ?v=<mtime>, so a cached copy can never go stale.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
