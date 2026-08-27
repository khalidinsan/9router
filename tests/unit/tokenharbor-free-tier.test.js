import { describe, expect, it } from "vitest";
import {
  isTokenHarborFreeTierExhausted,
  parseTokenHarborFreeTierResetsAt,
  buildTokenHarborFreeTierExhaustedUpdate,
  isTokenHarborAccountFlagged,
} from "../../open-sse/services/accountFallback.js";

const FREE_TIER_ERROR = JSON.stringify({
  error: {
    message:
      "You've used this period's free allowance. Your next rolling 7-day period starts at 2026-08-30T14:17:40.804326+00:00. Use the paid model 'deepseek-v4-flash' to keep going, or subscribe to a Token Harbor Pass for a recurring included allowance across more models. https://tokenharbor.ai/pricing",
    type: "free_tier_limit_reached",
    code: "free_tier_limit_reached",
  },
});

const FLAGGED_ERROR = JSON.stringify({
  error: {
    message: "We can't serve our models on this account right now.",
  },
});

describe("Token Harbor free-tier exhaustion policy", () => {
  it("classifies free_tier_limit_reached 429 as authoritative per-account state", () => {
    expect(isTokenHarborFreeTierExhausted("tokenharbor", 429, FREE_TIER_ERROR)).toBe(true);
    // Only tokenharbor provider
    expect(isTokenHarborFreeTierExhausted("kimchi", 429, FREE_TIER_ERROR)).toBe(false);
    expect(isTokenHarborFreeTierExhausted("grok-cli", 429, FREE_TIER_ERROR)).toBe(false);
    // Only 429
    expect(isTokenHarborFreeTierExhausted("tokenharbor", 500, FREE_TIER_ERROR)).toBe(false);
    expect(isTokenHarborFreeTierExhausted("tokenharbor", 402, FREE_TIER_ERROR)).toBe(false);
    // Plain rate-limit 429 must NOT disable
    expect(isTokenHarborFreeTierExhausted("tokenharbor", 429, "rate limited, retry later")).toBe(false);
  });

  it("parses the rolling-period reset timestamp from the error body", () => {
    expect(parseTokenHarborFreeTierResetsAt(FREE_TIER_ERROR)).toBe("2026-08-30T14:17:40.804Z");
    expect(parseTokenHarborFreeTierResetsAt("rate limited")).toBeNull();
    expect(parseTokenHarborFreeTierResetsAt(null)).toBeNull();
  });

  it("builds a disable update that removes the connection from rotation", () => {
    const now = new Date("2026-08-26T00:00:00Z");
    const update = buildTokenHarborFreeTierExhaustedUpdate(
      { providerSpecificData: { existing: true } },
      429,
      FREE_TIER_ERROR,
      now
    );
    expect(update).toMatchObject({
      isActive: false,
      testStatus: "quota_exhausted",
      lastErrorType: "quota_exhausted",
      errorCode: 429,
      quotaExhaustedAt: "2026-08-26T00:00:00.000Z",
    });
    expect(update.providerSpecificData).toMatchObject({
      existing: true, // preserves prior provider data
      quotaExhausted: true,
      quotaErrorCode: "free_tier_limit_reached",
      freeTierResetsAt: "2026-08-30T14:17:40.804Z",
    });
  });
});

describe("Token Harbor flagged-account policy", () => {
  it("classifies 402 'can't serve our models on this account' as flagged", () => {
    expect(isTokenHarborAccountFlagged("tokenharbor", 402, FLAGGED_ERROR)).toBe(true);
    // Only tokenharbor provider
    expect(isTokenHarborAccountFlagged("kimchi", 402, FLAGGED_ERROR)).toBe(false);
    // Only 402 status
    expect(isTokenHarborAccountFlagged("tokenharbor", 429, FLAGGED_ERROR)).toBe(false);
    expect(isTokenHarborAccountFlagged("tokenharbor", 500, FLAGGED_ERROR)).toBe(false);
    // Other tokenharbor errors must NOT be treated as flagged
    expect(isTokenHarborAccountFlagged("tokenharbor", 402, FREE_TIER_ERROR)).toBe(false);
    expect(isTokenHarborAccountFlagged("tokenharbor", 402, "payment required")).toBe(false);
  });

  it("matches variants of the flagged wording", () => {
    expect(isTokenHarborAccountFlagged("tokenharbor", 402, '{"error":{"message":"We cannot serve our models on this account right now."}}')).toBe(true);
    expect(isTokenHarborAccountFlagged("tokenharbor", 402, "can't serve our models on this account")).toBe(true);
  });
});
