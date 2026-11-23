import { NextResponse } from "next/server";
import { saveBrandingAsset, removeBrandingAsset } from "@/lib/branding";

export const dynamic = "force-dynamic";

// Writes stay in the protected /api/settings namespace; the read side is the
// public /api/branding/asset route.
export async function POST(request) {
  try {
    const body = await request.json();
    const url = saveBrandingAsset(body?.type, body?.dataUrl);
    return NextResponse.json({ ok: true, type: body.type, url });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to save branding asset" },
      { status: 400 },
    );
  }
}

export async function DELETE(request) {
  const type = request.nextUrl.searchParams.get("type");
  try {
    removeBrandingAsset(type);
    return NextResponse.json({ ok: true, type });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to remove branding asset" },
      { status: 400 },
    );
  }
}
