import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  deleteProviderConnection: mocks.deleteProviderConnection,
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(() => null),
}));

vi.mock("../utils/logger.js", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const FREE_TIER_ERROR = JSON.stringify({
  error: {
    message:
      "You've used this period's free allowance. Your next rolling 7-day period starts at 2026-08-30T14:17:40.804326+00:00. Use the paid model 'deepseek-v4-flash' to keep going, or subscribe to a Token Harbor Pass for a recurring included allowance across more models. https://tokenharbor.ai/pricing",
    type: "free_tier_limit_reached",
    code: "free_tier_limit_reached",
  },
});

describe("markAccountUnavailable tokenharbor free-tier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        name: "rizky.saputra706@yani43.com",
        provider: "tokenharbor",
        backoffLevel: 0,
        providerSpecificData: {},
      },
    ]);
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("disables the account on free_tier_limit_reached 429 (no model lock)", async () => {
    const result = await markAccountUnavailable(
      "conn-1",
      429,
      FREE_TIER_ERROR,
      "tokenharbor",
      "deepseek-v4-flash:free"
    );

    expect(result).toMatchObject({
      shouldFallback: true,
      cooldownMs: 0,
      disabled: true,
      authoritativeQuotaExhausted: true,
    });

    const [connId, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(connId).toBe("conn-1");
    expect(update.isActive).toBe(false);
    expect(update.testStatus).toBe("quota_exhausted");
    expect(update.providerSpecificData.quotaExhausted).toBe(true);
    expect(update.providerSpecificData.quotaErrorCode).toBe("free_tier_limit_reached");
    expect(update.providerSpecificData.freeTierResetsAt).toBe("2026-08-30T14:17:40.804Z");
  });

  it("keeps the model-lock path for generic 429 (rate limit without free-tier code)", async () => {
    const result = await markAccountUnavailable(
      "conn-1",
      429,
      "rate limited, retry later",
      "tokenharbor",
      "deepseek-v4-flash:free"
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.authoritativeQuotaExhausted).toBeUndefined();
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    expect(update.isActive).toBeUndefined(); // not disabled
    expect(Object.keys(update).some(k => k.startsWith("modelLock_"))).toBe(true);
  });

  it("does not disable other providers hitting the same upstream code", async () => {
    await markAccountUnavailable("conn-1", 429, FREE_TIER_ERROR, "kimchi", "m");
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    expect(update.isActive).toBeUndefined();
  });

  it("deletes the connection when the account is flagged (402 can't serve)", async () => {
    const flaggedError = JSON.stringify({
      error: { message: "We can't serve our models on this account right now." },
    });
    const result = await markAccountUnavailable(
      "conn-1",
      402,
      flaggedError,
      "tokenharbor",
      "deepseek-v4-flash:free"
    );

    expect(result).toMatchObject({ shouldFallback: true, deleted: true });
    expect(mocks.deleteProviderConnection).toHaveBeenCalledWith("conn-1");
    // No lock/update written for a deleted account
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps the account on generic 402 (payment required, not flagged)", async () => {
    const result = await markAccountUnavailable(
      "conn-1",
      402,
      "payment required, add credits",
      "tokenharbor",
      "deepseek-v4-flash:free"
    );
    expect(result.deleted).toBeUndefined();
    expect(mocks.deleteProviderConnection).not.toHaveBeenCalled();
  });
});
