import { beforeEach, describe, expect, it } from "vitest";
import {
  GROK_CLI_MAX_FALLBACK_ACCOUNTS,
  buildGrokCliConfirmedQuotaUpdate,
  buildGrokCliManualEnableUpdate,
  buildGrokCliSuspectedQuotaUpdate,
  checkGrokCli402Circuit,
  isGrokCliHardBlocked,
  recordGrokCli402,
  resetGrokCliSafetyStateForTests,
} from "../../open-sse/services/grokCliSafety.js";

describe("Grok CLI safety policy", () => {
  beforeEach(() => resetGrokCliSafetyStateForTests());

  it("caps one request to three fallback accounts", () => {
    expect(GROK_CLI_MAX_FALLBACK_ACCOUNTS).toBe(3);
  });

  it("opens the circuit after the same 402 hits three distinct accounts", () => {
    const error = "[402]: You have run out of credits or need a Grok subscription.";
    expect(recordGrokCli402("a", error, 1_000).isOpen).toBe(false);
    expect(recordGrokCli402("b", error, 2_000).isOpen).toBe(false);
    const third = recordGrokCli402("c", error, 3_000);
    expect(third.isOpen).toBe(true);
    expect(checkGrokCli402Circuit(3_001).isOpen).toBe(true);
  });

  it("aggregates equivalent structured and text spending-limit errors", () => {
    expect(recordGrokCli402("a", JSON.stringify({ code: "personal-team-blocked:spending-limit" }), 1_000).isOpen).toBe(false);
    expect(recordGrokCli402("b", "You have run out of credits or need a Grok subscription", 2_000).isOpen).toBe(false);
    expect(recordGrokCli402("c", "spending limit", 3_000).isOpen).toBe(true);
  });

  it("does not count repeated 402s from one account as distinct accounts", () => {
    const error = "spending-limit";
    recordGrokCli402("a", error, 1_000);
    recordGrokCli402("a", error, 2_000);
    expect(recordGrokCli402("a", error, 3_000).isOpen).toBe(false);
  });

  it("manual enable clears stale quota and permission flags atomically", () => {
    const conn = {
      testStatus: "quota_exhausted",
      providerSpecificData: {
        quotaExhausted: true,
        permissionDenied: true,
        reauthRequired: false,
        quotaConfirmationCount: 9,
      },
    };
    const update = buildGrokCliManualEnableUpdate(conn, new Date("2026-01-01T00:00:00Z"));
    expect(update).toMatchObject({ isActive: true, testStatus: "active", lastError: null });
    expect(update.providerSpecificData).toMatchObject({
      quotaExhausted: false,
      permissionDenied: false,
      quotaConfirmationCount: 0,
      reauthRequired: false,
    });
    expect(isGrokCliHardBlocked({ ...conn, ...update })).toBe(false);
  });

  it("normal traffic only marks suspected quota and isolated confirmations disable on the second probe", () => {
    const conn = { isActive: true, providerSpecificData: {} };
    const suspected = buildGrokCliSuspectedQuotaUpdate(conn, new Date("2026-01-01T00:00:00Z"));
    expect(suspected.isActive).toBeUndefined();
    expect(suspected.testStatus).toBe("active");

    const first = buildGrokCliConfirmedQuotaUpdate(conn, new Date("2026-01-01T00:01:00Z"), {
      tokenFingerprint: "fp-1",
      modelId: "grok-4.5",
    });
    expect(first.isActive).toBeUndefined();
    expect(first.testStatus).toBe("suspected_quota");

    const secondConn = { ...conn, providerSpecificData: first.providerSpecificData };
    const second = buildGrokCliConfirmedQuotaUpdate(secondConn, new Date("2026-01-01T00:02:00Z"), {
      tokenFingerprint: "fp-1",
      modelId: "grok-4.5",
    });
    expect(second.isActive).toBe(false);
    expect(second.testStatus).toBe("quota_exhausted");
  });

  it("does not combine confirmations across credential fingerprints", () => {
    const first = buildGrokCliConfirmedQuotaUpdate(
      { providerSpecificData: {} },
      new Date("2026-01-01T00:01:00Z"),
      { tokenFingerprint: "old-token", modelId: "grok-4.5" }
    );
    const second = buildGrokCliConfirmedQuotaUpdate(
      { providerSpecificData: first.providerSpecificData },
      new Date("2026-01-01T00:02:00Z"),
      { tokenFingerprint: "new-token", modelId: "grok-4.5" }
    );
    expect(second.isActive).toBeUndefined();
    expect(second.providerSpecificData.quotaConfirmationCount).toBe(1);
  });
});
