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
 */

/** All routes: { "<requestedModel>": "<routedModel>" } */
export async function getModelRoutes() {
  return await routeKv.getAll();
}

/** The routed target for a requested model, or null. Exact match, no parsing. */
export async function resolveModelRoute(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return null;
  const value = await routeKv.get(modelStr);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function setModelRoute(from, to) {
  await routeKv.set(from, to);
}

export async function deleteModelRoute(from) {
  await routeKv.remove(from);
}
