import { describe, it, expect, vi, beforeEach } from "vitest";

// Tencent bills through one endpoint that mixes recurring subscriptions and
// one-shot bonus grants. Two bugs made the numbers wrong:
//
//  1. Classification used the gap between CycleEndTime and DeductionEndTime.
//     A "Pro Plan Trial Subscription" reports a 0-day gap exactly like a bonus
//     pack, so subscriptions were classified as bonuses — and bonus rows read
//     the plain Capacity fields, which are 0, instead of the Cycle fields that
//     carry the real number. Reported as 0/500 where upstream said 0.54/500.
//
//  2. `YYYY-MM-DD HH:mm:ss` timestamps were parsed in the SERVER's timezone.
//     They are upstream wall-clock (UTC+8), so on a WIB host they landed an
//     hour off — confirmed against the paired epoch fields, which match a
//     UTC+8 reading to the second.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
vi.mock("../../open-sse/providers/index.js", () => ({
  PROVIDERS: { "codebuddy-cn": { headers: {} } },
}));

const { getCodeBuddyUsage } = await import("../../open-sse/services/usage/codebuddy-cn.js");

// A subscription with real usage in the Cycle fields only — the exact shape
// that produced "0 / 500" instead of "0.54 / 500".
const subscription = {
  PackageName: "Pro Plan Trial Subscription",
  SubProductCode: "sp_tcaca_codebuddy_ide",
  CapacityType: 4,
  CapacityUsedPrecise: "0",
  CapacitySizePrecise: "500",
  CycleCapacityUsedPrecise: "0.54",
  CycleCapacitySizePrecise: "500",
  CycleStartTime: "2026-09-14 18:28:42",
  CycleEndTime: "2026-09-21 18:28:41",
  DeductionEndTime: 1789986521000,
};

const bonusPack = {
  PackageName: "Bonus Pack",
  SubProductCode: "sp_tcaca_codebuddyide_bonus_pack",
  CapacityType: 1,
  CapacityUsedPrecise: "0.45",
  CapacitySizePrecise: "250",
  CycleCapacityUsedPrecise: "0.45",
  CycleCapacitySizePrecise: "250",
  CycleEndTime: "2026-09-28 17:34:18",
  DeductionEndTime: 1790586942000,
};

function respond(accounts) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: { Response: { Data: { Accounts: accounts } } } }),
  });
}

describe("CodeBuddy/WorkBuddy quota parsing", () => {
  beforeEach(() => fetchMock.mockReset());

  it("reads subscription usage from the Cycle fields", async () => {
    respond([subscription]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    const q = out.quotas.Weekly;
    // The regression: this reported 0 / 500.
    expect(q.used).toBe(0.54);
    expect(q.total).toBe(500);
  });

  it("classifies a subscription as recurring even with a zero cycle gap", async () => {
    respond([subscription]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    expect(out.quotas.Weekly.recurring).toBe(true);
    // Must not be filed under a Bonus Pack row.
    expect(Object.keys(out.quotas).some((k) => /^Bonus Pack/.test(k))).toBe(false);
  });

  it("still reads bonus packs from the plain Capacity fields", async () => {
    respond([bonusPack]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    const q = out.quotas["Bonus Pack 1"];
    expect(q.used).toBe(0.45);
    expect(q.total).toBe(250);
    expect(q.recurring).toBe(false);
  });

  it("separates a subscription from bonus packs in one response", async () => {
    respond([subscription, bonusPack]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    expect(out.quotas.Weekly.used).toBe(0.54);
    expect(out.quotas["Bonus Pack 1"].used).toBe(0.45);
    expect(out.plan).toBe("Pro Plan Trial Subscription");
  });

  it("parses upstream wall-clock as UTC+8, not the server's zone", async () => {
    respond([subscription]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    // 2026-09-21 18:28:41 +08:00 === 1789986521000, the paired epoch value.
    expect(new Date(out.quotas.Weekly.resetAt).getTime()).toBe(1789986521000);
  });

  it("falls back to CapacityType when SubProductCode is absent", async () => {
    const noSubCode = { ...subscription };
    delete noSubCode.SubProductCode;
    respond([noSubCode]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    expect(out.quotas.Weekly.recurring).toBe(true);
  });

  it("falls back to the timing heuristic when neither signal is present", async () => {
    const bare = {
      PackageName: "Mystery",
      CycleCapacityUsedPrecise: "1",
      CycleCapacitySizePrecise: "10",
      CycleEndTime: "2026-09-21 18:28:41",
      // 30 days after cycle end → recurring by the old heuristic
      DeductionEndTime: 1789986521000 + 30 * 86400000,
    };
    respond([bare]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    const key = Object.keys(out.quotas)[0];
    expect(out.quotas[key].recurring).toBe(true);
  });

  it("labels the cadence from the real cycle length", async () => {
    respond([subscription]);
    const out = await getCodeBuddyUsage("workbuddy", "tok");
    // 2026-09-14 → 2026-09-21 is 7 days.
    expect(Object.keys(out.quotas)).toContain("Weekly");
  });
});
