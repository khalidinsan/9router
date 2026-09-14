import { describe, expect, it } from "vitest";
import { pickSweepWindow } from "../../src/shared/services/grokCliMaintenance.js";

// Minimal stand-ins — pickSweepWindow only reads `id`.
const pool = (n) => Array.from({ length: n }, (_, i) => ({ id: `acc-${i + 1}` }));
const ids = (rows) => rows.map((r) => r.id);

describe("pickSweepWindow", () => {
  it("starts at the top when there is no cursor", () => {
    const { picked, nextCursor } = pickSweepWindow(pool(12), 3, null);
    expect(ids(picked)).toEqual(["acc-1", "acc-2", "acc-3"]);
    expect(nextCursor).toBe("acc-3");
  });

  it("resumes after the cursor instead of re-probing the same rows", () => {
    // The bug: successive ticks all returned acc-1..acc-3, so acc-4+ were never
    // probed. Each tick must move the window forward.
    let cursor = null;
    const seen = [];
    for (let tick = 0; tick < 4; tick += 1) {
      const { picked, nextCursor } = pickSweepWindow(pool(12), 3, cursor);
      seen.push(...ids(picked));
      cursor = nextCursor;
    }
    expect(seen).toEqual([
      "acc-1", "acc-2", "acc-3",
      "acc-4", "acc-5", "acc-6",
      "acc-7", "acc-8", "acc-9",
      "acc-10", "acc-11", "acc-12",
    ]);
  });

  it("wraps around the end of the pool", () => {
    const { picked } = pickSweepWindow(pool(12), 3, "acc-12");
    expect(ids(picked)).toEqual(["acc-1", "acc-2", "acc-3"]);
  });

  it("restarts from the top when the cursor account is gone", () => {
    // A deleted/blocked account disappears from the pool between ticks.
    const { picked } = pickSweepWindow(pool(12), 3, "acc-does-not-exist");
    expect(ids(picked)).toEqual(["acc-1", "acc-2", "acc-3"]);
  });

  it("handles a pool smaller than the limit without duplicates", () => {
    const { picked, nextCursor } = pickSweepWindow(pool(2), 5, null);
    // size is clamped to the pool, so no account is probed twice in one tick
    expect(ids(picked)).toEqual(["acc-1", "acc-2"]);
    expect(nextCursor).toBe("acc-2");
  });

  it("covers every account exactly once per full lap", () => {
    const total = 12;
    let cursor = null;
    const seen = [];
    for (let tick = 0; tick < total / 3; tick += 1) {
      const { picked, nextCursor } = pickSweepWindow(pool(total), 3, cursor);
      seen.push(...ids(picked));
      cursor = nextCursor;
    }
    expect(new Set(seen).size).toBe(total);
    expect(seen.length).toBe(total);
  });

  it("is a no-op on an empty pool", () => {
    expect(pickSweepWindow([], 3, null)).toEqual({ picked: [], nextCursor: null });
  });
});
