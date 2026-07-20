import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";

// POST /api/models/test - Ping a single model via internal completions or embeddings
// Body: { model, kind?, connectionId? }
export async function POST(request) {
  try {
    const body = await request.json();
    const { model, kind, connectionId } = body || {};
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelByKind(model, kind || "llm", undefined, {
      connectionId: connectionId || null,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
