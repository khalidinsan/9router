import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The route store gained an `enabled` flag, which changed the stored shape from
// a bare target string to { target, enabled }. These tests pin the two
// behaviours that matter: a disabled route must not resolve (so the request is
// served by the original model), and a row written by the previous version —
// a plain string — must still load as enabled rather than vanish.

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-route-toggle-"));
  process.env.DATA_DIR = tempDir;
  // The adapter is cached on `global` so it survives module reloads — reset it
  // or the previous test's database leaks into this one.
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
  return tempDir;
}

async function loadRepo() {
  return await import("../../src/lib/db/repos/routingRepo.js");
}

describe("model route enable/disable", () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await setupDb();
  });

  afterEach(() => {
    process.env.DATA_DIR = originalDataDir;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const FROM = "cmc/deepseek/deepseek-v4.1-flash";
  const TO = "wb/deepseek-v4.1-flash";

  it("resolves an enabled route", async () => {
    const repo = await loadRepo();
    await repo.setModelRoute(FROM, TO);
    expect(await repo.resolveModelRoute(FROM)).toBe(TO);
  });

  it("stops resolving once disabled, without losing the target", async () => {
    const repo = await loadRepo();
    await repo.setModelRoute(FROM, TO);
    await repo.setModelRouteEnabled(FROM, false);

    // The whole point: a disabled route falls through to the original model.
    expect(await repo.resolveModelRoute(FROM)).toBeNull();
    // ...but the target is still stored, so re-enabling needs no re-entry.
    const all = await repo.getModelRoutes();
    expect(all[FROM]).toEqual({ target: TO, enabled: false });
  });

  it("resolves again after re-enabling", async () => {
    const repo = await loadRepo();
    await repo.setModelRoute(FROM, TO);
    await repo.setModelRouteEnabled(FROM, false);
    await repo.setModelRouteEnabled(FROM, true);
    expect(await repo.resolveModelRoute(FROM)).toBe(TO);
  });

  it("reports false when toggling a route that does not exist", async () => {
    const repo = await loadRepo();
    expect(await repo.setModelRouteEnabled("nope/missing", false)).toBe(false);
  });

  it("treats a legacy bare-string row as enabled", async () => {
    // Rows written before this change were `key -> "target"`. They must keep
    // working; a migration step would be a worse trade than reading both.
    const repo = await loadRepo();
    const { makeKv } = await import("../../src/lib/db/helpers/kvStore.js");
    await makeKv("modelRoutes").set(FROM, TO);

    expect(await repo.resolveModelRoute(FROM)).toBe(TO);
    expect((await repo.getModelRoutes())[FROM]).toEqual({ target: TO, enabled: true });
  });

  it("ignores malformed rows instead of throwing", async () => {
    const repo = await loadRepo();
    const { makeKv } = await import("../../src/lib/db/helpers/kvStore.js");
    const kv = makeKv("modelRoutes");
    await kv.set("empty/string", "   ");
    await kv.set("bad/shape", { nope: 1 });

    expect(await repo.resolveModelRoute("empty/string")).toBeNull();
    expect(await repo.resolveModelRoute("bad/shape")).toBeNull();
    expect(Object.keys(await repo.getModelRoutes())).toHaveLength(0);
  });

  it("keeps routes independent — disabling one leaves others alone", async () => {
    const repo = await loadRepo();
    await repo.setModelRoute(FROM, TO);
    await repo.setModelRoute("other/model", "wb/kimi-k3");
    await repo.setModelRouteEnabled(FROM, false);

    expect(await repo.resolveModelRoute(FROM)).toBeNull();
    expect(await repo.resolveModelRoute("other/model")).toBe("wb/kimi-k3");
  });
});
