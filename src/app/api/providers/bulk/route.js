import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection, deleteProviderConnection } from "@/models";
import { buildGrokCliManualEnableUpdate } from "open-sse/services/grokCliSafety.js";

export const dynamic = "force-dynamic";

// Bulk enable/disable/delete over an explicit set of connection ids.
//
// The existing /api/providers/test-batch picks its own targets by group
// (provider/oauth/free/apikey/all), so it cannot act on what the user ticked in
// the list. This route takes the ids the UI already holds, which keeps the
// selection in one place (the client) and gives every action the same target set
// in a single round trip instead of N.
//
// Testing is deliberately NOT here: the UI runs it as a client-side loop so each
// row can show live progress, reusing the existing per-connection test endpoint.

const MAX_IDS = 500;

/** Reject anything that is not a bounded array of non-empty string ids. */
function normalizeIds(raw) {
  if (!Array.isArray(raw)) return { error: "ids must be an array" };
  if (raw.length === 0) return { error: "ids must not be empty" };
  if (raw.length > MAX_IDS) return { error: `ids must contain at most ${MAX_IDS} entries` };
  const ids = [];
  for (const id of raw) {
    if (typeof id !== "string" || !id.trim()) return { error: "every id must be a non-empty string" };
    ids.push(id.trim());
  }
  return { ids: [...new Set(ids)] };
}

// Enable/disable. Mirrors the per-connection PUT in ../[id]/route.js, including
// the grok-cli guard: enabling a connection that needs re-auth would put a dead
// account back into rotation, so it is reported as a per-id failure instead.
async function setActive(ids, isActive) {
  const results = [];
  for (const id of ids) {
    try {
      const existing = await getProviderConnectionById(id);
      if (!existing) {
        results.push({ id, ok: false, error: "Connection not found" });
        continue;
      }
      if (isActive && existing.provider === "grok-cli" && (existing.providerSpecificData?.reauthRequired === true || existing.testStatus === "reauth_required")) {
        results.push({ id, ok: false, error: "Requires re-authorization before it can be enabled" });
        continue;
      }

      const update = isActive
        ? (existing.provider === "grok-cli"
            ? buildGrokCliManualEnableUpdate(existing)
            : { isActive: true })
        : { isActive: false };

      await updateProviderConnection(id, update);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error.message || "Update failed" });
    }
  }
  return results;
}

async function removeMany(ids) {
  const results = [];
  for (const id of ids) {
    try {
      const deleted = await deleteProviderConnection(id);
      // Returns false when the row was already gone; reporting ok would let the
      // UI claim a deletion that never happened.
      results.push(deleted ? { id, ok: true } : { id, ok: false, error: "Connection not found" });
    } catch (error) {
      results.push({ id, ok: false, error: error.message || "Delete failed" });
    }
  }
  return results;
}

// POST /api/providers/bulk - { action, ids }
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const { action } = body;
    const parsed = normalizeIds(body.ids);
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { ids } = parsed;

    let results;
    switch (action) {
      case "enable":
        results = await setActive(ids, true);
        break;
      case "disable":
        results = await setActive(ids, false);
        break;
      case "delete":
        results = await removeMany(ids);
        break;
      default:
        return NextResponse.json(
          { error: "Invalid action. Use: enable, disable, delete" },
          { status: 400 }
        );
    }

    const succeeded = results.filter((r) => r.ok).length;
    return NextResponse.json({
      action,
      results,
      summary: { total: results.length, succeeded, failed: results.length - succeeded },
    });
  } catch (error) {
    console.log("Error in bulk provider action:", error);
    return NextResponse.json({ error: "Bulk action failed" }, { status: 500 });
  }
}
