import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { isMistralVibeKey, detectMistralKeyType } from "../../open-sse/services/mistralSignIn.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Mistral key families", () => {
  beforeEach(() => proxyAwareFetch.mockReset());

  it("recognises the Vibe key prefix", () => {
    expect(isMistralVibeKey("mstrl_abc123")).toBe(true);
    expect(isMistralVibeKey("  mstrl_abc123  ")).toBe(true);
    expect(isMistralVibeKey("4ZxQsomeConsoleKeyWithoutPrefix")).toBe(false);
    expect(isMistralVibeKey("")).toBe(false);
    expect(isMistralVibeKey(null)).toBe(false);
  });

  it("confirms a Vibe key against the console and returns its plan", async () => {
    proxyAwareFetch.mockResolvedValue(json({ plan_name: "INDIVIDUAL", plan_type: "CHAT", customer_id: "cust-1" }));
    await expect(detectMistralKeyType("mstrl_abc")).resolves.toEqual({
      keyType: "vibe",
      plan: "INDIVIDUAL",
      planType: "CHAT",
      customerId: "cust-1",
    });
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://console.mistral.ai/api/vibe/whoami");
  });

  it("classifies a rejected key as a console key", async () => {
    proxyAwareFetch.mockResolvedValue(json({ detail: "Unauthorized" }, 401));
    await expect(detectMistralKeyType("console-key")).resolves.toEqual({ keyType: "api" });
  });

  it("reports nothing when the console cannot answer, so callers fall back to the prefix", async () => {
    proxyAwareFetch.mockRejectedValue(new Error("network down"));
    await expect(detectMistralKeyType("mstrl_abc")).resolves.toBeNull();
    proxyAwareFetch.mockResolvedValue(json({ detail: "nope" }, 500));
    await expect(detectMistralKeyType("mstrl_abc")).resolves.toBeNull();
  });
});
