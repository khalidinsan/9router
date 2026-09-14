import { makeKv } from "../helpers/kvStore.js";

const routeKv = makeKv("modelRoutes");

/**
 * Model routing (remap) — `existing model A -> existing model B`.
 *
 * Distinct from modelAliases, which maps a short FREETEXT name to a model and
 * cannot contain "/". A routing key IS a real model id and usually contains
 * slashes ("cmc/deepseek/deepseek-v4.1-flash"), which is why it is stored and
 * looked up as an exact whole string rather than through parseModel — that
 * function splits on the FIRST slash and would mangle the key.
 *
 * Lookup happens before parseModel (see src/sse/services/model.js), so a hit
 * replaces the request string entirely and every downstream consumer — executor,
 * usage history, request details — sees the routed model.
 *
 * Stored value is `{ target, enabled }`. Older rows are a bare string (the
 * target); normalizeRoute() accepts both so an existing KV survives the upgrade
 * without a migration step.
 */

function normalizeRoute(value) {
  if (typeof value === "string") {
    const target = value.trim();
    return target ? { target, enabled: true } : null;
  }
  if (value && typeof value === "object") {
    const target = typeof value.target === "string" ? value.target.trim() : "";
    if (!target) return null;
    // Absent `enabled` means an older row: treat as on, matching prior behavior.
    return { target, enabled: value.enabled !== false };
  }
  return null;
}

/** All routes: { "<requestedModel>": { target, enabled } } */
export async function getModelRoutes() {
  const raw = await routeKv.getAll();
  const out = {};
  for (const [from, value] of Object.entries(raw || {})) {
    const route = normalizeRoute(value);
    if (route) out[from] = route;
  }
  return out;
}

/**
 * The routed target for a requested model, or null.
 * Returns null for a disabled route so callers need no extra check.
 * Exact match, no parsing.
 */
export async function resolveModelRoute(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return null;
  const route = normalizeRoute(await routeKv.get(modelStr));
  if (!route || !route.enabled) return null;
  return route.target;
}

export async function setModelRoute(from, to, enabled = true) {
  await routeKv.set(from, { target: to, enabled: enabled !== false });
}

/** Flip a route on/off without touching its target. */
export async function setModelRouteEnabled(from, enabled) {
  const route = normalizeRoute(await routeKv.get(from));
  if (!route) return false;
  await routeKv.set(from, { target: route.target, enabled: enabled !== false });
  return true;
}

export async function deleteModelRoute(from) {
  await routeKv.remove(from);
}
