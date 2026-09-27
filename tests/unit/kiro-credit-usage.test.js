// Regression: a Kiro turn that reports credits but no token counts must still
// be recorded and surfaced.
//
// Kiro bills in credits. It reports the charge in a `meteringEvent` and token
// counts in a `metricsEvent` — but it does not always send the latter. Before
// this, such a turn produced `usage: {kiro_credits}` with 0 tokens, and three
// separate layers then erased it:
//
//   1. saveUsageStats dropped any row whose tokens were both 0, so the request
//      never reached /dashboard/usage — not shown as zero, but absent, which
//      reads as "the model was never used".
//   2. normalizeUsage / extractUsage / filterUsageForFormat each rebuilt the
//      usage object from a whitelist of token fields, discarding kiro_credits.
//   3. The non-streaming path received `usage: {}` and had no fallback, so the
//      client was told the request cost nothing.
//
// These tests pin the contract at each layer.
import { describe, it, expect } from "vitest";
import {
  normalizeUsage,
  extractUsage,
  canonicalizeUsage,
  filterUsageForFormat,
  hasValidUsage,
} from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { extractUsageFromResponse, fillEstimatedTokens } from "../../open-sse/handlers/chatCore/requestDetail.js";

const CREDIT_ONLY = { kiro_credits: 0.02514997744610282, kiro_credit_unit: "credit" };

describe("Kiro credit-only usage survives every normalization layer", () => {
  it("normalizeUsage keeps the credit fields", () => {
    const out = normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, ...CREDIT_ONLY });
    expect(out.kiro_credits).toBe(CREDIT_ONLY.kiro_credits);
    expect(out.kiro_credit_unit).toBe("credit");
  });

  it("canonicalizeUsage keeps the credit fields", () => {
    const out = canonicalizeUsage({ prompt_tokens: 10, completion_tokens: 2, ...CREDIT_ONLY });
    expect(out.kiro_credits).toBe(CREDIT_ONLY.kiro_credits);
  });

  it("filterUsageForFormat keeps the credit fields for OpenAI-shaped clients", () => {
    const out = filterUsageForFormat({ prompt_tokens: 10, completion_tokens: 2, ...CREDIT_ONLY }, FORMATS.OPENAI);
    expect(out.kiro_credits).toBe(CREDIT_ONLY.kiro_credits);
    expect(out.kiro_credit_unit).toBe("credit");
  });

  it("extractUsage recognises a usage object that carries only credits", () => {
    // Without the credit-only branch this returned null, so the stream merge
    // replaced Kiro's usage with one that had no charge recorded.
    const out = extractUsage({ usage: { ...CREDIT_ONLY, prompt_tokens: 0, completion_tokens: 0 } });
    expect(out).not.toBeNull();
    expect(out.kiro_credits).toBe(CREDIT_ONLY.kiro_credits);
  });

  it("extractUsage keeps credits on an OpenAI-shaped usage object", () => {
    const out = extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 3, ...CREDIT_ONLY } });
    expect(out.prompt_tokens).toBe(12);
    expect(out.kiro_credits).toBe(CREDIT_ONLY.kiro_credits);
  });

  it("extractUsageFromResponse surfaces a credit-only response instead of null", () => {
    // Returning null here discarded the whole usage object, so a billed turn
    // was recorded as if it never happened.
    const out = extractUsageFromResponse({ usage: { ...CREDIT_ONLY } });
    expect(out).not.toBeNull();
    expect(out.kiro_credits).toBe(CREDIT_ONLY.kiro_credits);
  });

  it("hasValidUsage still reports credit-only usage as having no token data", () => {
    // hasValidUsage is a token check, and that stays true. The point of the fix
    // is that callers no longer treat "no tokens" as "no usage".
    expect(hasValidUsage({ ...CREDIT_ONLY })).toBe(false);
    expect(hasValidUsage({ prompt_tokens: 1 })).toBe(true);
  });
});

describe("fillEstimatedTokens", () => {
  const body = { messages: [{ role: "user", content: "x".repeat(400) }] };

  it("fills token counts a provider omitted, without dropping the charge", () => {
    const out = fillEstimatedTokens({ ...CREDIT_ONLY, prompt_tokens: 0, completion_tokens: 0 }, body, 40);
    expect(out.prompt_tokens).toBeGreaterThan(0);
    expect(out.completion_tokens).toBeGreaterThan(0);
    expect(out.kiro_credits).toBe(CREDIT_ONLY.kiro_credits);
    expect(out.estimated).toBe(true);
  });

  it("never overwrites a real token count", () => {
    const out = fillEstimatedTokens({ prompt_tokens: 1234, completion_tokens: 56, ...CREDIT_ONLY }, body, 40);
    expect(out.prompt_tokens).toBe(1234);
    expect(out.completion_tokens).toBe(56);
    expect(out.estimated).toBeUndefined();
  });

  it("passes null through unchanged", () => {
    expect(fillEstimatedTokens(null, body, 10)).toBeNull();
  });
});
