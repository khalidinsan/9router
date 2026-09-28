import { describe, expect, it } from "vitest";
import {
  checkFallbackError,
  isContextLengthError,
} from "../../open-sse/services/accountFallback.js";

/** Exact shape of Grok CLI / cli-chat-proxy context overflow */
const GROK_CLI_MAX_PROMPT =
  'This model\'s maximum prompt length is 500000 but the request contains 504988 tokens.';

const GROK_CLI_JSON = JSON.stringify({
  code: "invalid-argument",
  error: GROK_CLI_MAX_PROMPT,
});

describe("context length errors must not rotate accounts", () => {
  it("matches Grok CLI maximum prompt length (plain text)", () => {
    const r = checkFallbackError(400, GROK_CLI_MAX_PROMPT);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(isContextLengthError(400, GROK_CLI_MAX_PROMPT)).toBe(true);
  });

  it("matches Grok CLI error when embedded in JSON body", () => {
    const r = checkFallbackError(400, GROK_CLI_JSON);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(isContextLengthError(400, GROK_CLI_JSON)).toBe(true);
  });

  it("matches alternate token-count wording", () => {
    const msg =
      "This model's maximum prompt length is 500000 but the request contains 504928 tokens.";
    expect(checkFallbackError(400, msg).shouldFallback).toBe(false);
  });

  it("matches common OpenAI-style context_length_exceeded", () => {
    const msg = "context_length_exceeded: This model's maximum context length is 128000 tokens";
    expect(checkFallbackError(400, msg).shouldFallback).toBe(false);
    expect(isContextLengthError(400, msg)).toBe(true);
  });

  it("still rotates on auth / quota / rate-limit errors", () => {
    expect(checkFallbackError(401, "unauthorized").shouldFallback).toBe(true);
    expect(checkFallbackError(402, "free-usage-exhausted").shouldFallback).toBe(true);
    expect(checkFallbackError(429, "rate limit exceeded").shouldFallback).toBe(true);
    expect(checkFallbackError(403, "permission-denied").shouldFallback).toBe(true);
  });

  it("does not rotate an unmatched 400 (request-scoped client error)", () => {
    // A 400 that matches no account rule describes the request, not the
    // credential, so the account stays in rotation and the upstream error is
    // returned for this request only (upstream 20a43f5a).
    const r = checkFallbackError(400, "bad request: malformed tool schema");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(isContextLengthError(400, "bad request: malformed tool schema")).toBe(false);
  });

  it("does not treat invalid-argument alone as context overflow", () => {
    // Avoid over-matching: only size-related text triggers the context rule.
    const msg = '{"code":"invalid-argument","error":"unknown field foo"}';
    expect(isContextLengthError(400, msg)).toBe(false);
    // No size text → no account cooldown either; the error passes through.
    expect(checkFallbackError(400, msg).shouldFallback).toBe(false);
  });
});
